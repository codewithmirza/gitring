/**
 * The routes of passkeys: make an account, add a passkey, sign in, and the list, rename and removal of passkeys.
 *
 * A passkey post is limited per address and only from gitring's own pages. Rename and removal work in the browser only.
 * Read next: src/directory/layers/passkey-accounts.ts and src/directory/passkeys.ts.
 */
import type { Hono } from "hono";
import type * as A from "../core/accounts";
import { gateOn } from "../core/waitlist";
import { passkeyLabel } from "../directory/passkeys";
import { isCrossSiteWrite } from "./csrf";
import { clientAddress, overLimit, tooMany } from "./limits";
import { LAST_PROVIDER_COOKIE, PASSKEY_COOKIE, SESSION_COOKIE, origin, passkeyCookie, readCookie, sessionCookie } from "./auth-kit";
import { directory, forgetPrincipal } from "./principal";
import type { C, HonoEnv } from "./http";

function jsonAnswer(body: unknown, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Passkey posts: limited per address like the other sign-in starts, and only from gitring's own pages. */
async function passkeyGuard(c: C): Promise<Response | null> {
  if (await overLimit(c.env, "auth", clientAddress(c.req.raw))) return tooMany();
  if (isCrossSiteWrite(c.req.method, c.req.header("origin"), c.req.header("sec-fetch-site"), origin(c))) return jsonAnswer({ error: "Cross-site requests are not allowed." }, 403);
  return null;
}

/** Does this gitring have Google or GitHub sign-in? */
async function hasOutsideSignIn(c: C): Promise<boolean> {
  const p = await directory(c.env).providers().catch(() => null);
  return Boolean(p?.github || p?.google);
}

/** The RP id of WebAuthn is the host name of the request; the origin must match too. */
function relyingParty(c: C): { origin: string; rpId: string } {
  const u = new URL(c.req.url);
  return { origin: u.origin, rpId: u.hostname };
}

function passkeyRegisterRoutes(app: Hono<HonoEnv>): void {
  app.post("/auth/passkey/register/options", async (c) => {
    const stop = await passkeyGuard(c);
    if (stop) return stop;
    const p = c.get("principal");
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
    // A browser session adds the passkey to its person. Without one, the passkey makes a new account.
    const userId = p.via === "session" && p.user ? p.user.id : undefined;
    // With the waitlist gate on, new accounts start with Google or GitHub, when this gitring has them.
    if (!userId && gateOn(c.env) && (await hasOutsideSignIn(c))) {
      return jsonAnswer({ error: "New accounts start with Google or GitHub while gitring has a waitlist.", code: "waitlist" }, 403);
    }
    try {
      const res = await directory(c.env).passkeyRegisterOptions({ ...relyingParty(c), ...(userId ? { userId } : { name: String(body.name ?? "") }) });
      return jsonAnswer({ options: res.options, mode: userId ? "add" : "create" }, 200, [passkeyCookie(res.state)]);
    } catch (e) {
      return jsonAnswer({ error: (e as Error).message }, 400);
    }
  });

  app.post("/auth/passkey/register/verify", async (c) => {
    const stop = await passkeyGuard(c);
    if (stop) return stop;
    const clear = passkeyCookie("", 0);
    const state = readCookie(c.req.raw, PASSKEY_COOKIE) ?? "";
    if (!state) return jsonAnswer({ error: "The passkey request expired. Start again." }, 400, [clear]);
    const p = c.get("principal");
    const body = await c.req.json<{ credential?: unknown; label?: unknown }>().catch(() => ({}) as { credential?: unknown; label?: unknown });
    try {
      const res = await directory(c.env).passkeyRegister(state, body.credential, {
        origin: relyingParty(c).origin,
        ...(p.via === "session" && p.user ? { userId: p.user.id } : {}),
        label: typeof body.label === "string" && body.label.trim() ? body.label : passkeyLabel(c.req.header("user-agent")),
      });
      // The cached lookups of the person show the new passkey count.
      forgetPrincipal({ userId: res.user.id });
      const cookies = res.token ? [clear, sessionCookie(res.token), `${LAST_PROVIDER_COOKIE}=passkey; Path=/; Secure; SameSite=Lax; Max-Age=31536000`] : [clear];
      return jsonAnswer({ user: res.user, passkey: res.passkey }, 200, cookies);
    } catch (e) {
      return jsonAnswer({ error: (e as Error).message }, 400, [clear]);
    }
  });
}

function passkeyLoginRoutes(app: Hono<HonoEnv>): void {
  app.post("/auth/passkey/login/options", async (c) => {
    const stop = await passkeyGuard(c);
    if (stop) return stop;
    const res = await directory(c.env).passkeyLoginOptions(relyingParty(c));
    return jsonAnswer({ options: res.options }, 200, [passkeyCookie(res.state)]);
  });

  app.post("/auth/passkey/login/verify", async (c) => {
    const stop = await passkeyGuard(c);
    if (stop) return stop;
    const clear = passkeyCookie("", 0);
    const state = readCookie(c.req.raw, PASSKEY_COOKIE) ?? "";
    if (!state) return jsonAnswer({ error: "The passkey sign-in expired. Start again." }, 400, [clear]);
    const body = await c.req.json<{ credential?: unknown }>().catch(() => ({}) as { credential?: unknown });
    try {
      const res = await directory(c.env).passkeyLogin(state, body.credential, { origin: relyingParty(c).origin });
      return jsonAnswer({ user: res.user }, 200, [clear, sessionCookie(res.token), `${LAST_PROVIDER_COOKIE}=passkey; Path=/; Secure; SameSite=Lax; Max-Age=31536000`]);
    } catch (e) {
      return jsonAnswer({ error: (e as Error).message }, 400, [clear]);
    }
  });
}

function passkeyManageRoutes(app: Hono<HonoEnv>): void {
  app.get("/api/me/passkeys", async (c) => {
    const u = c.get("principal").user;
    if (!u) return jsonAnswer({ error: "Sign in first." }, 401);
    return jsonAnswer(await directory(c.env).listPasskeys(u.id), 200);
  });

  /** Rename and remove: in the browser only (a key or an app cannot change how the person signs in). */
  const sessionUser = (c: C): A.UserInfo | Response => {
    const p = c.get("principal");
    if (!p.user) return jsonAnswer({ error: "Sign in first." }, 401);
    if (p.via !== "session") return jsonAnswer({ error: "Change your passkeys on the Account page of gitring." }, 403);
    return p.user;
  };

  app.patch("/api/me/passkeys/:id", async (c) => {
    const u = sessionUser(c);
    if (u instanceof Response) return u;
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
    try {
      return jsonAnswer(await directory(c.env).renamePasskey(u.id, c.req.param("id"), String(body.name ?? "")), 200);
    } catch (e) {
      const message = (e as Error).message;
      return jsonAnswer({ error: message }, /no passkey with this id/.test(message) ? 404 : 400);
    }
  });

  app.delete("/api/me/passkeys/:id", async (c) => {
    const u = sessionUser(c);
    if (u instanceof Response) return u;
    try {
      await directory(c.env).removePasskey(u.id, c.req.param("id"), readCookie(c.req.raw, SESSION_COOKIE) ?? undefined);
      forgetPrincipal({ userId: u.id });
      return new Response(null, { status: 204 });
    } catch (e) {
      const message = (e as Error).message;
      return jsonAnswer({ error: message }, /no passkey with this id/.test(message) ? 404 : 409);
    }
  });
}

/**
 * Passkey routes (contract C6):
 *
 *   POST /auth/passkey/register/options   a new account (body: name), or a passkey for the signed-in person
 *   POST /auth/passkey/register/verify    keep the passkey; a new account gets a session
 *   POST /auth/passkey/login/options      a challenge for a discoverable passkey
 *   POST /auth/passkey/login/verify       check it, open the same session as other sign-ins
 *   GET/PATCH/DELETE /api/me/passkeys[/:id]  the person's passkeys (rename, remove; one sign-in stays)
 */
export function passkeyRoutes(app: Hono<HonoEnv>): void {
  passkeyRegisterRoutes(app);
  passkeyLoginRoutes(app);
  passkeyManageRoutes(app);
}
