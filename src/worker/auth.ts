/**
 * Who is calling: a browser session (cookie), a personal API key (`Authorization: Bearer bk_…`), or the
 * operator key (BEARING_KEY, for scripts). Plus the sign-in and setup routes.
 */
import type { Context, Hono } from "hono";
import type { Env } from "./env";
import type * as A from "../core/accounts";
import type * as T from "../core/types";
import { sameString } from "../directory/crypto";

export const SESSION_COOKIE = "__Host-bearing";
const SESSION_MAX_AGE_S = 30 * 24 * 3600;

export interface Principal {
  user: A.UserInfo | null;
  via: "session" | "key" | "operator" | null;
  /** The session token (cookie), for logout. */
  session?: string;
  /** A Bearer token was sent but it is not valid. */
  badKey?: boolean;
}

export function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function resolvePrincipal(env: Env, req: Request): Promise<Principal> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (m) {
    const token = m[1].trim();
    if (env.BEARING_KEY && sameString(token, env.BEARING_KEY)) return { user: null, via: "operator" };
    if (token.startsWith("bk_")) {
      const user = await directory(env).keyUser(token);
      if (user) return { user, via: "key" };
    }
    return { user: null, via: null, badKey: true };
  }
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) {
    const user = await directory(env).sessionUser(cookie);
    if (user) return { user, via: "session", session: cookie };
  }
  return { user: null, via: null };
}

export function actorOf(p: Principal): T.Actor {
  if (p.user) return { kind: "human", id: p.user.id, name: p.user.name };
  if (p.via === "operator") return { kind: "system", id: "operator", name: "Operator" };
  return { kind: "human", id: "anonymous", name: "Anonymous" };
}

function sessionCookie(token: string, maxAge = SESSION_MAX_AGE_S): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

type HonoEnv = { Bindings: Env; Variables: { principal: Principal } };
type C = Context<HonoEnv>;

function origin(c: C): string {
  return new URL(c.req.url).origin;
}

function setupAllowed(c: C, token?: string | null): boolean {
  const p = c.get("principal");
  if (p.user?.admin) return true;
  const want = c.env.BEARING_SETUP_TOKEN;
  return Boolean(want && token && sameString(String(token), want));
}

/* ───────────── pages (setup and sign-in errors) ───────────── */

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Bearing</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark;--bg:#f8fbfd;--ink:#17202c;--muted:#5b6672;--line:#d5dde3;--card:#fff;--accent:#0e6f7a;--ok:#1d7a46;--warn:#9a5b00}
@media (prefers-color-scheme:dark){:root{--bg:#090f16;--ink:#e0e5e9;--muted:#98a4ae;--line:#24303b;--card:#0f1721;--accent:#5fb7c2;--ok:#5cc28a;--warn:#e0a64b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:0 0 8px}
p{margin:8px 0}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:16px 0}
.ok{color:var(--ok);font-weight:600}.warn{color:var(--warn);font-weight:600}
button,.btn{display:inline-block;font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none}
.btn.secondary{background:transparent;color:var(--accent)}label{display:block;font-weight:600;margin:12px 0 4px}
input{width:100%;font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
code{font-family:ui-monospace,monospace;font-size:14px;background:color-mix(in srgb,var(--line) 40%,transparent);padding:1px 5px;border-radius:4px;word-break:break-all}
ol{padding-left:20px}li{margin:4px 0}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

async function setupPage(c: C, token: string | null, note?: string): Promise<Response> {
  const dir = directory(c.env);
  const providers = await dir.providers();
  const o = origin(c);
  const owners = (c.env.BEARING_OWNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const tokenField = token ? `<input type="hidden" name="token" value="${esc(token)}">` : "";
  let gh: string;
  if (providers.github) {
    gh = `<p class="ok">Connected: ${esc(providers.github.slug)}</p>
<p>People sign in with GitHub through this app. To import private repositories and mirror landings, install it on them.</p>
<p><a class="btn" href="${esc(providers.github.installUrl)}">Install on repositories</a> <a class="btn secondary" href="${esc(providers.github.htmlUrl)}">App settings</a></p>`;
  } else {
    const m = await dir.githubManifest(o);
    gh = `<p class="warn">Not set up.</p>
<p>One click creates a GitHub App for this Bearing with the right callback URLs, webhook and permissions (contents write, issues read, metadata read). GitHub shows it to you before it creates it.</p>
<form method="post" action="${esc(m.postUrl)}"><input type="hidden" name="manifest" value="${esc(m.manifest)}"><button type="submit">Create the Bearing GitHub App</button></form>`;
  }
  const gg = providers.google
    ? `<p class="ok">Connected: <code>${esc(providers.google.clientId)}</code></p><p class="muted">Paste a new client below to replace it.</p>`
    : `<p class="warn">Not set up.</p>`;
  return page(
    "Set up Bearing",
    `<h1>Set up Bearing</h1><p class="muted">${esc(o)}</p>${note ? `<div class="card"><p>${note}</p></div>` : ""}
<div class="card"><h2>1. Sign in with GitHub</h2>${gh}</div>
<div class="card"><h2>2. Sign in with Google</h2>${gg}
<ol><li>Open <a href="https://console.cloud.google.com/apis/credentials">Google Cloud console → Credentials</a>. Create an <b>OAuth client ID</b> of type <b>Web application</b>.</li>
<li>Authorized JavaScript origin: <code>${esc(o)}</code></li>
<li>Authorized redirect URI: <code>${esc(o)}/auth/google/callback</code></li>
<li>Paste the client ID and the client secret here. Bearing seals them; nobody can read them back.</li></ol>
<form method="post" action="/setup/google">${tokenField}<label for="cid">Client ID</label><input id="cid" name="clientId" required autocomplete="off" placeholder="…apps.googleusercontent.com">
<label for="cs">Client secret</label><input id="cs" name="clientSecret" required autocomplete="off" type="password"><p><button type="submit">Save Google sign-in</button></p></form></div>
<div class="card"><h2>3. Owners</h2>${
      owners.length
        ? `<p>These people own this Bearing (they may open this page after they sign in):</p><ul>${owners.map((x) => `<li><code>${esc(x)}</code></li>`).join("")}</ul>`
        : `<p class="warn">No owner is set. Set the secret BEARING_OWNERS, for example <code>github:your-login,google:you@example.com</code>.</p>`
    }
<p><a class="btn" href="/">Open Bearing</a></p></div>`,
  );
}

/* ───────────── routes ───────────── */

export function authRoutes(app: Hono<HonoEnv>): void {
  app.get("/setup", async (c) => {
    const token = c.req.query("token") ?? null;
    if (!setupAllowed(c, token)) return page("Setup", `<h1>Setup is closed</h1><p>Open the setup link with its token, or sign in as an owner of this Bearing.</p><p><a class="btn" href="/">Open Bearing</a></p>`, 403);
    return setupPage(c, token);
  });

  app.post("/setup/google", async (c) => {
    const form = await c.req.parseBody();
    const token = typeof form.token === "string" ? form.token : null;
    if (!setupAllowed(c, token)) return page("Setup", `<h1>Setup is closed</h1>`, 403);
    try {
      await directory(c.env).setGoogle({ clientId: String(form.clientId ?? ""), clientSecret: String(form.clientSecret ?? "") });
      return setupPage(c, token, "Google sign-in is ready.");
    } catch (e) {
      return setupPage(c, token, esc((e as Error).message));
    }
  });

  app.get("/setup/github/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return page("GitHub App", `<h1>GitHub did not send a code</h1><p>Start again from the setup page.</p>`, 400);
    try {
      const app = await directory(c.env).githubManifestDone(code, state);
      return page(
        "GitHub App ready",
        `<h1>The GitHub App is ready</h1><p class="ok">${esc(app.slug)}</p>
<p>Next: sign in with GitHub as an owner, then install the app on the repositories that Bearing may import or mirror.</p>
<p><a class="btn" href="/auth/github/start?return=%2Fsetup">Sign in with GitHub</a> <a class="btn secondary" href="https://github.com/apps/${esc(app.slug)}/installations/new">Install on repositories</a></p>`,
      );
    } catch (e) {
      return page("GitHub App", `<h1>The GitHub App was not saved</h1><p>${esc((e as Error).message)}</p>`, 400);
    }
  });

  app.get("/setup/github/installed", (c) =>
    page("Installed", `<h1>Bearing can see these repositories now</h1><p>Go back to Bearing to import one.</p><p><a class="btn" href="/projects?new=github">Open Bearing</a></p>`),
  );

  app.get("/auth/:provider/start", async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "github" && provider !== "google") return c.text("Unknown provider.", 404);
    try {
      const url = await directory(c.env).signInUrl(provider, origin(c), c.req.query("return") ?? "/");
      return c.redirect(url, 302);
    } catch (e) {
      return page("Sign in", `<h1>Sign-in is not ready</h1><p>${esc((e as Error).message)}</p><p><a class="btn" href="/">Open Bearing</a></p>`, 503);
    }
  });

  app.get("/auth/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "github" && provider !== "google") return c.text("Unknown provider.", 404);
    const error = c.req.query("error");
    if (error) return page("Sign in", `<h1>Sign-in stopped</h1><p>${esc(c.req.query("error_description") ?? error)}</p><p><a class="btn" href="/">Open Bearing</a></p>`, 400);
    try {
      const res = await directory(c.env).finishSignIn(provider, c.req.query("code") ?? "", c.req.query("state") ?? "");
      return new Response(null, { status: 302, headers: { location: res.returnTo, "set-cookie": sessionCookie(res.token), "cache-control": "no-store" } });
    } catch (e) {
      return page("Sign in", `<h1>Sign-in did not finish</h1><p>${esc((e as Error).message)}</p><p><a class="btn" href="/">Open Bearing</a></p>`, 400);
    }
  });

  app.post("/auth/logout", async (c) => {
    const p = c.get("principal");
    if (p.session) await directory(c.env).endSession(p.session);
    return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie("", 0) } });
  });

  app.get("/api/me", async (c) => {
    const providers = await directory(c.env).providers();
    const me: A.MeInfo = {
      user: c.get("principal").user,
      providers: { github: Boolean(providers.github), google: Boolean(providers.google) },
      setupNeeded: !providers.github && !providers.google,
    };
    return c.json({ ...me, githubInstallUrl: providers.github?.installUrl ?? null });
  });
}
