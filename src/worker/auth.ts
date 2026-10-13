/**
 * Who is calling: a browser session (cookie), a personal API key (`Authorization: Bearer gk_…`), or the
 * operator key (GITRING_KEY, for scripts). Plus the sign-in routes (passkeys first, then the optional
 * providers Google and GitHub) and the setup page.
 */
import type { Context, Hono } from "hono";
import type { Env } from "./env";
import type * as A from "../core/accounts";
import type * as T from "../core/types";
import { randomToken, sameString } from "../directory/crypto";
import type { ManifestConversion } from "../directory/directory";
import { passkeyLabel } from "../directory/passkeys";
import { privacyBody, termsBody } from "./legal";
import { isCrossSiteWrite } from "./csrf";
import { clientAddress, overLimit, tooMany } from "./limits";

export const SESSION_COOKIE = "__Host-gitring";
const SESSION_MAX_AGE_S = 30 * 24 * 3600;

export interface Principal {
  user: A.UserInfo | null;
  via: "session" | "key" | "operator" | "oauth" | null;
  /** OAuth only: the MCP client that acts for the person. */
  clientId?: string;
  /** OAuth only: what the token may do. "mcp:read": only the tools that read. Anything else: all tools. */
  scope?: string;
  /** The session token (cookie), for logout. */
  session?: string;
  /** A Bearer token was sent but it is not valid. */
  badKey?: boolean;
}

export function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
}

/**
 * Close the live connections of a person on every project of theirs (sign-out, a revoked key, a lost
 * role). Each connection comes back through the Worker, which checks the access again.
 */
export async function closeUserSockets(env: Env, userId: string, code: 4401 | 4403 = 4401): Promise<void> {
  const projects = await directory(env)
    .listProjects(userId)
    .catch(() => [] as A.ProjectInfo[]);
  await Promise.all(projects.map((p) => env.HARBOR.get(env.HARBOR.idFromName(p.id)).closeSockets({ userId }, code).catch(() => undefined)));
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/*
 * A short cache of token lookups in this isolate. An agent sends many MCP calls with the same token and a
 * page sends many API calls with the same cookie; without the cache, each call is one more round trip to
 * the Directory. A removed key, session or app grant stops working everywhere within PRINCIPAL_TTL_MS
 * (at once in this isolate: see forgetPrincipal).
 */
const PRINCIPAL_TTL_MS = 30_000;
const PRINCIPAL_MAX = 5000;
const principals = new Map<string, { until: number; p: Principal }>();

function cached(key: string): Principal | null {
  const hit = principals.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.until) {
    principals.delete(key);
    return null;
  }
  return hit.p;
}

/** Cache a lookup for PRINCIPAL_TTL_MS, or until `expiresAt` (a token that expires sooner). */
function remember(key: string, p: Principal, expiresAt = Infinity): Principal {
  if (principals.size >= PRINCIPAL_MAX) {
    // Drop the oldest tenth (Map keeps insertion order).
    let n = Math.ceil(PRINCIPAL_MAX / 10);
    for (const k of principals.keys()) {
      principals.delete(k);
      if (--n <= 0) break;
    }
  }
  principals.set(key, { until: Math.min(Date.now() + PRINCIPAL_TTL_MS, expiresAt), p });
  return p;
}

/** Forget cached lookups: a session at sign-out, or everything of a person (keys, grants) after a change. */
export function forgetPrincipal(opts: { session?: string; userId?: string; all?: boolean }): void {
  if (opts.all) return principals.clear();
  if (opts.session) principals.delete(`s:${opts.session}`);
  if (opts.userId) for (const [k, v] of principals) if (v.p.user?.id === opts.userId) principals.delete(k);
}

/**
 * Who sends this request. `oauth: true` (the MCP endpoints only) also accepts OAuth access tokens: they
 * are for one MCP endpoint (RFC 8707), not for the rest of the API. `resource` is the endpoint that gets
 * this request (default <origin>/mcp): a token works only at the resource it was issued for.
 */
export async function resolvePrincipal(env: Env, req: Request, opts: { oauth?: boolean; resource?: string } = {}): Promise<Principal> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (m) {
    const token = m[1].trim();
    if (env.GITRING_KEY && sameString(token, env.GITRING_KEY)) return { user: null, via: "operator" };
    if (token.startsWith("gk_")) {
      const hit = cached(`k:${token}`);
      if (hit) return hit;
      const user = await directory(env).keyUser(token);
      if (user) return remember(`k:${token}`, { user, via: "key" });
    }
    if (opts.oauth && token.startsWith("goa_")) {
      const origin = new URL(req.url).origin;
      // The lookup depends on the endpoint: the same token can be valid at one and not at another.
      const resource = opts.resource ?? `${origin}/mcp`;
      const hit = cached(`o:${resource}:${token}`);
      if (hit) return hit;
      const found = await directory(env).oauthUser(token, origin, resource);
      // OAuth tokens are cached for at most 15 seconds: a revoked token stops working soon everywhere.
      if (found) return remember(`o:${resource}:${token}`, { user: found.user, via: "oauth", clientId: found.clientId, scope: found.scope }, Math.min(found.expiresAt, Date.now() + 15_000));
    }
    return { user: null, via: null, badKey: true };
  }
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) {
    const hit = cached(`s:${cookie}`);
    if (hit) return hit;
    const user = await directory(env).sessionUser(cookie);
    if (user) return remember(`s:${cookie}`, { user, via: "session", session: cookie });
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
  const want = c.env.GITRING_SETUP_TOKEN;
  return Boolean(want && token && sameString(String(token), want));
}

/* ───────────── pages (setup and sign-in errors) ───────────── */

export interface PageOptions {
  /** Nonce of the page's inline script, if it has one (<script nonce="…">). */
  nonce?: string;
  /** Extra hosts that the page's script may call. */
  connect?: string[];
  /** Extra form targets, and the places a form's answer may redirect to (an OAuth client). */
  formAction?: string[];
}

/** A strict Content Security Policy for server pages: no scripts unless a page names one by nonce. */
function pagePolicy(o: PageOptions): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com https://*.googleusercontent.com",
    `form-action 'self'${o.formAction?.length ? ` ${o.formAction.join(" ")}` : ""}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    ...(o.nonce ? [`script-src 'nonce-${o.nonce}'`] : []),
    ...(o.connect?.length ? [`connect-src ${o.connect.join(" ")}`] : []),
  ].join("; ");
}

export function page(title: string, body: string, status = 200, extraHeaders: Record<string, string> = {}, opts: PageOptions = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · gitring</title><meta name="robots" content="noindex">
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
.providers{display:flex;flex-direction:column;gap:10px;max-width:340px}
.provider{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;border:1px solid #747775;background:#fff;color:#1f1f1f;font:500 15px/20px system-ui,-apple-system,"Segoe UI",sans-serif;text-decoration:none}
.provider:hover{background:#f2f2f2}.provider:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.provider svg,.provider img{width:20px;height:20px;flex:none}.provider .last{margin-left:auto;font-size:12px;color:#5f6368}
@media (prefers-color-scheme:dark){.provider{background:#131314;border-color:#8e918f;color:#e3e3e3}.provider:hover{background:#1f1f20}.provider svg{fill:#fff}.provider .last{color:#9aa0a6}}
.provider svg.pk{fill:none;stroke:currentColor}summary.provider{list-style:none;cursor:pointer}summary.provider::-webkit-details-marker{display:none}
.pk-new form{padding:4px 2px 0}.or{display:flex;align-items:center;gap:10px;max-width:340px;color:var(--muted);font-size:13px;margin:14px 0}.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": pagePolicy(opts),
      "referrer-policy": "same-origin",
      ...extraHeaders,
    },
  });
}

function appReadyPage(slug: string): Response {
  const safe = /^[a-z0-9-]{1,80}$/.test(slug) ? slug : "";
  return page(
    "GitHub App ready",
    `<h1>The GitHub App is ready</h1>${safe ? `<p class="ok">${esc(safe)}</p>` : ""}
<p>Next: sign in with GitHub as an owner, then install the app on the repositories that gitring may import.</p>
<p><a class="btn" href="/auth/github/start?return=%2Fsetup">Sign in with GitHub</a>${safe ? ` <a class="btn secondary" href="https://github.com/apps/${esc(safe)}/installations/new">Install on repositories</a>` : ""}</p>`,
  );
}

/**
 * GitHub limits unauthenticated API calls per address, and Workers share addresses. This page asks
 * GitHub for the app credentials from the owner's browser instead, then sends them to gitring, which
 * checks them with GitHub before it seals them.
 */
function browserConversionPage(code: string, state: string): Response {
  const data = JSON.stringify({ code, state }).replace(/</g, "\\u003c");
  const nonce = randomToken(16);
  return page(
    "GitHub App",
    `<h1>Saving the GitHub App</h1><p id="msg" class="muted">Your browser gets the app credentials from GitHub. Keep this page open.</p>
<script nonce="${nonce}">
(async () => {
  const { code, state } = ${data};
  const msg = document.getElementById("msg");
  try {
    const gh = await fetch("https://api.github.com/app-manifests/" + encodeURIComponent(code) + "/conversions", { method: "POST", headers: { Accept: "application/vnd.github+json" } });
    if (!gh.ok) throw new Error("GitHub answered " + gh.status + ". Start again from the setup page.");
    const app = await gh.json();
    const res = await fetch("/setup/github/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, app }) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "gitring did not save the app.");
    location.replace("/setup/github/ready");
  } catch (e) {
    msg.className = "warn";
    msg.textContent = "The GitHub App was not saved. " + (e && e.message ? e.message : e);
  }
})();
</script>`,
    200,
    {},
    { nonce, connect: ["'self'", "https://api.github.com"] },
  );
}

/*
 * GitHub mark ("mark-github", 16 px) from @primer/octicons (MIT, Copyright GitHub Inc.), unchanged.
 * Rules: https://github.com/logos (no changes to shape, proportions or color).
 */
const GITHUB_MARK =
  "M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656";

/**
 * "Continue with GitHub" and "Continue with Google" for server pages, with the providers' own marks
 * (the Google "G" from Google's sign-in assets is /brand/google-g.svg). The provider used last comes first.
 */
export function providerButtons(providers: { github: boolean; google: boolean }, returnPath: string, last?: string | null): string {
  const back = encodeURIComponent(returnPath);
  const items = [
    providers.github
      ? { id: "github", html: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${GITHUB_MARK}"/></svg><span>Continue with GitHub</span>` }
      : null,
    providers.google ? { id: "google", html: `<img src="/brand/google-g.svg" alt="" width="20" height="20"><span>Continue with Google</span>` } : null,
  ].filter((x): x is { id: string; html: string } => Boolean(x));
  items.sort((a, b) => Number(b.id === last) - Number(a.id === last));
  return `<div class="providers">${items
    .map((x) => `<a class="provider" href="/auth/${x.id}/start?return=${back}">${x.html}${x.id === last && items.length > 1 ? '<span class="last">Last used</span>' : ""}</a>`)
    .join("")}</div>`;
}

export function lastProvider(req: Request): A.SignInKind | null {
  const v = readCookie(req, LAST_PROVIDER_COOKIE);
  return v === "github" || v === "google" || v === "passkey" ? v : null;
}

/** A key (passkeys), drawn for gitring. */
const PASSKEY_ICON = `<svg class="pk" viewBox="0 0 24 24" aria-hidden="true" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8 20 3M16.5 6.5l3 3M14 9l2.5 2.5"/></svg>`;

/**
 * The sign-in choices of a server page (connect an app): passkeys first, then the providers that this
 * gitring has, the provider used last first. The passkey buttons need the page's script nonce. After a
 * passkey sign-in the browser opens `returnPath` (a path on this site).
 */
export function signInChoices(providers: { github: boolean; google: boolean }, returnPath: string, last: A.SignInKind | null, nonce: string): string {
  const others = providers.github || providers.google ? `<p class="or">or</p>${providerButtons(providers, returnPath, last === "passkey" ? null : last)}` : "";
  const tag = last === "passkey" && others ? '<span class="last">Last used</span>' : "";
  const back = returnPath.startsWith("/") && !returnPath.startsWith("//") ? returnPath : "/";
  return `<div id="pk" class="providers" data-back="${esc(back)}">
<button type="button" class="provider" id="pk-in">${PASSKEY_ICON}<span>Sign in with a passkey</span>${tag}</button>
<details class="pk-new"><summary class="provider">${PASSKEY_ICON}<span>Create an account with a passkey</span></summary>
<form id="pk-form"><label for="pk-name">Your name</label><input id="pk-name" name="name" required maxlength="80" autocomplete="name">
<p class="muted">Your device keeps the passkey. gitring keeps only its public key.</p><p><button type="submit">Create the account</button></p></form></details>
<p id="pk-msg" class="warn" role="alert" hidden></p></div>${others}
<script nonce="${nonce}">${PASSKEY_PAGE_JS}</script>`;
}

/**
 * The script of the passkey buttons on server pages. It asks /auth/passkey/* for options, calls the
 * browser's WebAuthn API, sends the answer, then opens the path in data-back (signed in). It is static:
 * nothing from the request goes into it.
 */
const PASSKEY_PAGE_JS = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const msg = $("pk-msg");
  const say = (t) => { msg.textContent = t; msg.hidden = !t; };
  if (!window.PublicKeyCredential || !navigator.credentials) {
    for (const el of $("pk").querySelectorAll("button, input")) el.disabled = true;
    say("This browser cannot use passkeys. Use another browser or another sign-in.");
    return;
  }
  const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
  const text = (b) => { let s = ""; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const ids = (list) => (list || []).map((d) => Object.assign({}, d, { id: bytes(d.id) }));
  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || "gitring did not answer. Try again.");
    return out;
  }
  async function run(button, task) {
    say("");
    button.disabled = true;
    try {
      await task();
      location.assign($("pk").dataset.back || "/");
    } catch (e) {
      button.disabled = false;
      say(e && (e.name === "NotAllowedError" || e.name === "AbortError") ? "You stopped the passkey. gitring made no change." : (e && e.message) || String(e));
    }
  }
  $("pk-in").addEventListener("click", (ev) => run(ev.currentTarget, async () => {
    const o = (await post("/auth/passkey/login/options")).options;
    const c = await navigator.credentials.get({ publicKey: Object.assign({}, o, { challenge: bytes(o.challenge), allowCredentials: ids(o.allowCredentials) }) });
    const r = c.response;
    await post("/auth/passkey/login/verify", { credential: { id: c.id, rawId: text(c.rawId), type: c.type, response: { clientDataJSON: text(r.clientDataJSON), authenticatorData: text(r.authenticatorData), signature: text(r.signature), userHandle: r.userHandle ? text(r.userHandle) : null } } });
  }));
  $("pk-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    run(ev.submitter || $("pk-form").querySelector("button"), async () => {
      const o = (await post("/auth/passkey/register/options", { name: $("pk-name").value })).options;
      const c = await navigator.credentials.create({ publicKey: Object.assign({}, o, { challenge: bytes(o.challenge), user: Object.assign({}, o.user, { id: bytes(o.user.id) }), excludeCredentials: ids(o.excludeCredentials) }) });
      const r = c.response;
      await post("/auth/passkey/register/verify", { credential: { id: c.id, rawId: text(c.rawId), type: c.type, response: { clientDataJSON: text(r.clientDataJSON), attestationObject: text(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } } });
    });
  });
})();
`;

export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

async function setupPage(c: C, token: string | null, note?: string): Promise<Response> {
  const dir = directory(c.env);
  const providers = await dir.providers();
  const o = origin(c);
  const owners = (c.env.GITRING_OWNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const tokenField = token ? `<input type="hidden" name="token" value="${esc(token)}">` : "";
  let gh: string;
  if (providers.github) {
    gh = `<p class="ok">Connected: ${esc(providers.github.slug)}</p>
<p>People sign in with GitHub through this app. Install it on a repository to open tasks from its issues and to send merged code to it (Settings → GitHub in a project).</p>
<p><a class="btn" href="${esc(providers.github.installUrl)}">Install on repositories</a> <a class="btn secondary" href="${esc(providers.github.htmlUrl)}">App settings</a></p>`;
  } else {
    const m = await dir.githubManifest(o);
    gh = `<p class="warn">Not set up.</p>
<p>One click creates a GitHub App for this gitring with the right callback URLs, webhook and permissions (contents write, issues read, metadata read). GitHub shows it to you before it creates it.</p>
<form method="post" action="${esc(m.postUrl)}"><input type="hidden" name="manifest" value="${esc(m.manifest)}"><button type="submit">Create the gitring GitHub App</button></form>`;
  }
  const gg = providers.google
    ? `<p class="ok">Connected: <code>${esc(providers.google.clientId)}</code></p><p class="muted">Paste a new client below to replace it.</p>`
    : `<p class="warn">Not set up.</p>`;
  return page(
    "Set up gitring",
    `<h1>Set up gitring</h1><p class="muted">${esc(o)}</p>${note ? `<div class="card"><p>${note}</p></div>` : ""}
<div class="card"><h2>1. Passkeys</h2><p class="ok">Ready. Passkeys need no setup.</p>
<p>People create an account with a passkey on their own device: a fingerprint, a face, a PIN or a security key. gitring keeps only the public key of each passkey.</p></div>
<div class="card"><h2>2. Owners</h2>${
      owners.length
        ? `<p>These people own this gitring (they may open this page after they sign in):</p><ul>${owners.map((x) => `<li><code>${esc(x)}</code></li>`).join("")}</ul>`
        : `<p class="warn">No owner is set.</p><p>Set the secret GITRING_OWNERS, for example <code>user:u_0123456789</code>. Each person finds their account id on the Account page. You can also use <code>google:you@example.com</code> or <code>github:your-login</code>.</p>`
    }
<p><a class="btn" href="/">Open gitring</a></p></div>
<div class="card"><h2>3. Optional: sign in with Google</h2>${gg}
<ol><li>Open <a href="https://console.cloud.google.com/apis/credentials">Google Cloud console → Credentials</a>. Create an <b>OAuth client ID</b> of type <b>Web application</b>.</li>
<li>Authorized JavaScript origin: <code>${esc(o)}</code></li>
<li>Authorized redirect URI: <code>${esc(o)}/auth/google/callback</code></li>
<li>Paste the client ID and the client secret here. gitring seals them; nobody can read them back.</li></ol>
<form method="post" action="/setup/google">${tokenField}<label for="cid">Client ID</label><input id="cid" name="clientId" required autocomplete="off" placeholder="…apps.googleusercontent.com">
<label for="cs">Client secret</label><input id="cs" name="clientSecret" required autocomplete="off" type="password"><p><button type="submit">Save Google sign-in</button></p></form></div>
<div class="card"><h2>4. Optional: GitHub (sign-in, imports and sync)</h2>${gh}</div>`,
    200,
    {},
    { formAction: ["https://github.com"] },
  );
}

/* ───────────── routes ───────────── */

export function authRoutes(app: Hono<HonoEnv>): void {
  passkeyRoutes(app);
  // Privacy policy and terms (the Google consent screen links to them).
  const contact = (c: C): string | null => {
    const v = (c.env.GITRING_CONTACT ?? "").trim();
    if (!v) return null;
    return /^[^\s@<>"']+@[^\s@<>"']+$/.test(v) ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v);
  };
  app.get("/privacy", (c) => page("Privacy", privacyBody(contact(c))));
  app.get("/terms", (c) => page("Terms", termsBody(contact(c))));

  app.get("/setup", async (c) => {
    const token = c.req.query("token") ?? null;
    if (!setupAllowed(c, token)) return page("Setup", `<h1>Setup is closed</h1><p>Open the setup link with its token, or sign in as an owner of this gitring.</p><p><a class="btn" href="/">Open gitring</a></p>`, 403);
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
      const res = await directory(c.env).githubManifestDone(code, state);
      if ("browser" in res) return browserConversionPage(code, state);
      return appReadyPage(res.slug);
    } catch (e) {
      return page("GitHub App", `<h1>The GitHub App was not saved</h1><p>${esc((e as Error).message)}</p>`, 400);
    }
  });

  /** The owner's browser converted the manifest code (GitHub refused the Worker's call). */
  app.post("/setup/github/save", async (c) => {
    const body = await c.req.json<{ state?: string; app?: ManifestConversion }>().catch(() => ({}) as { state?: string; app?: ManifestConversion });
    try {
      const saved = await directory(c.env).githubAppSave(String(body.state ?? ""), body.app as ManifestConversion);
      return c.json(saved);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // The app's slug comes from the saved setup, never from the link: a link with another slug would send
  // the owner to install someone else's app.
  app.get("/setup/github/ready", async (c) => {
    const providers = await directory(c.env)
      .providers()
      .catch(() => ({ github: null }));
    return appReadyPage(providers.github?.slug ?? "");
  });

  // The GitHub App's setup URL: GitHub sends people here after they install the app or change its
  // repositories. The installation_id in the URL is not trusted; the app reloads the list with the
  // person's own token.
  app.get("/setup/github/installed", async (c) => {
    await directory(c.env).forgetGithubMisses().catch(() => undefined);
    return c.redirect("/projects?github=installed", 302);
  });

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
      githubInstallUrl: info.providers.github?.installUrl ?? null,
    };
    return c.json(me, 200, { "cache-control": "private, no-store" });
  });
}

const SIGNIN_COOKIE = "__Host-gitring-signin";
/** Not secret: the sign-in popover shows the provider that the person used last ("Last used"). */
const LAST_PROVIDER_COOKIE = "gitring_last";

/* ───────────── passkeys ───────────── */

/** The one-time passkey state of this browser (a challenge works only where it was asked for). */
const PASSKEY_COOKIE = "__Host-gitring-passkey";

function passkeyCookie(state: string, maxAge = 300): string {
  return `${PASSKEY_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

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

/** The RP id of WebAuthn is the host name of the request; the origin must match too. */
function relyingParty(c: C): { origin: string; rpId: string } {
  const u = new URL(c.req.url);
  return { origin: u.origin, rpId: u.hostname };
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
function passkeyRoutes(app: Hono<HonoEnv>): void {
  app.post("/auth/passkey/register/options", async (c) => {
    const stop = await passkeyGuard(c);
    if (stop) return stop;
    const p = c.get("principal");
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
    // A browser session adds the passkey to its person. Without one, the passkey makes a new account.
    const userId = p.via === "session" && p.user ? p.user.id : undefined;
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
      await directory(c.env).removePasskey(u.id, c.req.param("id"));
      forgetPrincipal({ userId: u.id });
      return new Response(null, { status: 204 });
    } catch (e) {
      const message = (e as Error).message;
      return jsonAnswer({ error: message }, /no passkey with this id/.test(message) ? 404 : 409);
    }
  });
}

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
