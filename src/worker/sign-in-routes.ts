/**
 * The routes of sign-in with GitHub or Google, sign-out, and the answer about who I am (/api/me).
 *
 * A sign-in link works only in the browser that started it (the sign-in cookie holds its state).
 * Read next: src/directory/layers/sign-in.ts (the code exchange).
 */
import type { Hono } from "hono";
import type * as A from "../core/accounts";
import { sameString } from "../directory/crypto";
import { LAST_PROVIDER_COOKIE, SIGNIN_COOKIE, origin, readCookie, sessionCookie } from "./auth-kit";
import { closeUserSockets, directory, forgetPrincipal } from "./principal";
import { esc, page } from "./pages";
import type { HonoEnv } from "./http";

const SIGNIN_ERRORS: Record<string, string> = {
  stopped: "You stopped the sign-in. Nothing changed.",
  expired: "The sign-in took too long. Try again.",
  taken: "This account belongs to another gitring account.",
  failed: "The sign-in did not finish. Try again.",
};

/**
 * A sign-in that did not finish. Pages of the app get the reason as ?signin_error=<code>, and the sign-in
 * popover opens again with it. Server pages (connect an app, setup) show the reason on a page.
 */
function signInError(returnTo: string, provider: string, code: "stopped" | "expired" | "taken" | "failed", detail: string, cookie: string): Response {
  if (returnTo.startsWith("/oauth/") || returnTo.startsWith("/setup")) {
    return page(
      "Sign in",
      `<h1>${esc(SIGNIN_ERRORS[code])}</h1><p class="muted">${esc(detail)}</p><p><a class="btn" href="${esc(returnTo)}">Try again</a></p>`,
      400,
      { "set-cookie": cookie },
    );
  }
  const url = new URL(returnTo, "https://gitring.invalid");
  url.searchParams.set("signin_error", code);
  url.searchParams.set("provider", provider);
  return new Response(null, { status: 302, headers: { location: `${url.pathname}${url.search}${url.hash}`, "set-cookie": cookie, "cache-control": "no-store" } });
}

export function signInRoutes(app: Hono<HonoEnv>): void {
  app.get("/auth/:provider/start", async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "github" && provider !== "google") return c.text("Unknown provider.", 404);
    const p = c.get("principal");
    // ?link=1: a signed-in person adds this sign-in to their account (Account → Sign-ins, Connect GitHub).
    const linkUserId = c.req.query("link") === "1" && p.via === "session" && p.user ? p.user.id : undefined;
    try {
      const url = await directory(c.env).signInUrl(provider, origin(c), c.req.query("return") ?? "/", linkUserId);
      const state = new URL(url).searchParams.get("state") ?? "";
      // The state belongs to this browser: a callback link sent to someone else does not sign them in.
      const states = [state, ...(readCookie(c.req.raw, SIGNIN_COOKIE) ?? "").split(".").filter(Boolean)].slice(0, 3).join(".");
      return new Response(null, { status: 302, headers: { location: url, "set-cookie": `${SIGNIN_COOKIE}=${states}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`, "cache-control": "no-store" } });
    } catch (e) {
      return page("Sign in", `<h1>Sign-in is not ready</h1><p>${esc((e as Error).message)}</p><p><a class="btn" href="/">Open gitring</a></p>`, 503);
    }
  });

  app.get("/auth/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "github" && provider !== "google") return c.text("Unknown provider.", 404);
    const dir = directory(c.env);
    const state = c.req.query("state") ?? "";
    const states = (readCookie(c.req.raw, SIGNIN_COOKIE) ?? "").split(".").filter(Boolean);
    const rest = states.filter((s) => !sameString(s, state));
    const signinCookie = rest.length ? `${SIGNIN_COOKIE}=${rest.join(".")}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900` : `${SIGNIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    const error = c.req.query("error");
    if (error) {
      const back = state ? await dir.abandonSignIn(state) : "/";
      return signInError(back, provider, error === "access_denied" ? "stopped" : "failed", c.req.query("error_description") ?? error, signinCookie);
    }
    if (!state || rest.length === states.length) {
      return signInError("/", provider, "expired", "Start the sign-in again in this browser.", signinCookie);
    }
    const res = await dir.completeSignIn(provider, c.req.query("code") ?? "", state);
    if (!res.ok) return signInError(res.returnTo, provider, res.code, res.message, signinCookie);
    const headers = new Headers({ location: res.returnTo, "cache-control": "no-store" });
    headers.append("set-cookie", signinCookie);
    headers.append("set-cookie", `${LAST_PROVIDER_COOKIE}=${provider}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`);
    if (res.token) headers.append("set-cookie", sessionCookie(res.token));
    if (res.linked) forgetPrincipal({ userId: res.user.id });
    return new Response(null, { status: 302, headers });
  });

  app.post("/auth/logout", async (c) => {
    const p = c.get("principal");
    if (p.session) {
      forgetPrincipal({ session: p.session });
      await directory(c.env).endSession(p.session);
      // Other tabs of this browser connect again and get "sign in".
      if (p.user) c.executionCtx.waitUntil(closeUserSockets(c.env, p.user.id, 4401));
    }
    return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie("", 0) } });
  });

  /** Sign out everywhere: every browser session of the person ends. API keys and connected apps stay. */
  app.post("/auth/logout-all", async (c) => {
    const p = c.get("principal");
    if (!p.user || p.via !== "session") return c.json({ error: "Sign in first." }, 401);
    const ended = await directory(c.env).endAllSessions(p.user.id);
    forgetPrincipal({ userId: p.user.id });
    c.executionCtx.waitUntil(closeUserSockets(c.env, p.user.id, 4401));
    return new Response(JSON.stringify({ ended }), { status: 200, headers: { "content-type": "application/json", "set-cookie": sessionCookie("", 0) } });
  });

  app.get("/api/me", async (c) => {
    const user = c.get("principal").user;
    const info = await directory(c.env).meInfo(user?.id ?? null);
    const me: A.MeInfo = {
      user,
      providers: { github: Boolean(info.providers.github), google: Boolean(info.providers.google) },
      setupNeeded: !info.providers.github && !info.providers.google,
      ...(info.github ? { github: info.github } : {}),
      ...(info.waitlist ? { waitlist: info.waitlist } : {}),
      githubInstallUrl: info.providers.github?.installUrl ?? null,
    };
    return c.json(me, 200, { "cache-control": "private, no-store" });
  });
}
