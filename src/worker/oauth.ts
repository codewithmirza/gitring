/**
 * OAuth 2.1 routes for MCP clients (Claude, Claude Code, Cursor, Codex and other agents):
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp[/github|/readonly]]
 *                                                      RFC 9728: an MCP endpoint and its server (one resource each)
 *   GET  /.well-known/oauth-authorization-server       RFC 8414: endpoints and abilities
 *   POST /oauth/register                               RFC 7591: dynamic client registration
 *   GET  /oauth/authorize                              sign in, then allow the app (consent)
 *   POST /oauth/authorize                              the decision (same-origin form)
 *   POST /oauth/token                                  codes (PKCE S256) and rotating refresh tokens
 *   POST /oauth/revoke                                 RFC 7009
 *   POST /oauth/device_authorization, GET/POST /device RFC 8628: the device grant (src/worker/device.ts)
 *   GET/DELETE /api/oauth/grants[/:id]                 the apps a person allowed
 *
 * The logic lives in the Directory (src/directory/oauth.ts). A pending authorization is bound to the
 * browser that started it with a short-lived cookie, so that a link to it does not work elsewhere.
 */
import type { Context, Hono } from "hono";
import type { Env } from "./env";
import { directory, esc, forgetPrincipal, lastProvider, page, providerButtons, readCookie, type Principal } from "./auth";
import { basicAuth, isCimdId, MCP_PATH, resourceOf, SCOPE, SCOPE_READ } from "../directory/oauth";
import { DEVICE_GRANT } from "../directory/device";
import { sameString } from "../directory/crypto";
import { clientAddress } from "./limits";

type HonoEnv = { Bindings: Env; Variables: { principal: Principal } };
type C = Context<HonoEnv>;

const REQUEST_COOKIE = "__Host-gitring-oauth";

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

function originOf(c: C): string {
  return new URL(c.req.url).origin;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function authorizationServerMetadata(o: string) {
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    // RFC 8628: programs without a browser (the gitring command line) sign in with a code on /device.
    device_authorization_endpoint: `${o}/oauth/device_authorization`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    // mcp: read and change. mcp:read: only the tools that read. gitring always issues a refresh token
    // (30 days, rotating), so offline_access is supported.
    scopes_supported: ["mcp", "mcp:read", "offline_access"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${o}/connect`,
  };
}

const RESOURCE_NAME: Record<string, string> = {
  [MCP_PATH.gitring]: "gitring",
  [MCP_PATH.github]: "gitring (GitHub-compatible tools)",
  [MCP_PATH.readonly]: "gitring (read only)",
};

/** RFC 9728 metadata of one MCP endpoint (each endpoint is its own resource: tokens work only where they were issued for). */
export function protectedResourceMetadata(o: string, path: string = MCP_PATH.gitring) {
  return {
    resource: resourceOf(o, path),
    authorization_servers: [o],
    scopes_supported: ["mcp", "mcp:read"],
    bearer_methods_supported: ["header"],
    resource_name: RESOURCE_NAME[path] ?? "gitring",
    resource_documentation: `${o}/connect`,
  };
}

/** The WWW-Authenticate header of a 401 from an MCP endpoint (MCP authorization spec, RFC 9728 §5.1). */
export function mcpChallenge(o: string, invalidToken: boolean, path: string = MCP_PATH.gitring): string {
  // The read-only endpoint needs the read-only scope at least. The other endpoints ask for the full scope.
  const scope = path === MCP_PATH.readonly ? "mcp:read" : "mcp";
  return `Bearer realm="gitring", resource_metadata="${o}/.well-known/oauth-protected-resource${path}", scope="${scope}"${invalidToken ? ', error="invalid_token", error_description="The access token is not valid or expired."' : ""}`;
}

/**
 * The WWW-Authenticate header of a 403: the token is good, but its scope is too small for the tool
 * (RFC 6750 §3.1, MCP scope challenge). `scope` is the scope that the call needs.
 */
export function mcpScopeChallenge(o: string, path: string = MCP_PATH.gitring, scope = "mcp"): string {
  return `Bearer realm="gitring", error="insufficient_scope", scope="${scope}", resource_metadata="${o}/.well-known/oauth-protected-resource${path}", error_description="This tool changes data. The access token has the scope mcp:read. It needs the scope ${scope}."`;
}

export async function formOf(c: C): Promise<Record<string, string | undefined>> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  const text = await c.req.text().catch(() => "");
  return Object.fromEntries(new URLSearchParams(text));
}

function requestCookie(id: string): string {
  return `${REQUEST_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`;
}

const CLEAR_REQUEST_COOKIE = `${REQUEST_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function redirect(url: string, cookie?: string): Response {
  const headers: Record<string, string> = { location: url, "cache-control": "no-store" };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(null, { status: 302, headers });
}

function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : `${u.protocol}//`;
  } catch {
    return "the app";
  }
}

/**
 * Where the app's access code goes: the only thing about a registered app that gitring can vouch for.
 * A metadata document client is known by its document's host as well.
 */
function destinationText(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    if (u.protocol === "https:") return `<code>${esc(u.host)}</code>`;
    if (u.protocol === "http:") return `an app on this computer (<code>${esc(u.host)}</code>)`;
    return `the app on this computer that opens <code>${esc(u.protocol)}//</code> links`;
  } catch {
    return "the app";
  }
}

async function signInPage(c: C, clientName: string, reqId: string): Promise<Response> {
  const providers = await directory(c.env)
    .providers()
    .catch(() => ({ github: null, google: null }));
  const buttons = providerButtons({ github: Boolean(providers.github), google: Boolean(providers.google) }, `/oauth/authorize?req=${reqId}`, lastProvider(c.req.raw));
  return page(
    "Connect an app",
    `<h1>Connect ${esc(clientName)} to gitring</h1>
<p class="muted">Sign in to gitring. Then you allow ${esc(clientName)} to work as you.</p>
<div class="card">${providers.github || providers.google ? buttons : "<p>Sign-in is not set up on this server.</p>"}</div>`,
    200,
    { "set-cookie": requestCookie(reqId) },
  );
}

/** What the app can do, in the words of the consent page. The scope mcp:read is read only. */
export function consentAccess(scope: string): { label: string; can: string } {
  return scope === SCOPE_READ
    ? { label: "Read only", can: "Read your projects, their tasks and their files. This works in projects where you are a member or a viewer. It cannot send plans, write code, run tests or ask gitring to merge." }
    : { label: "Read and change", can: "Read your projects and their tasks. Send plans and write code to work copies. Run tests and ask gitring to merge the work. This works in projects where you are a member." };
}

function consentPage(user: NonNullable<Principal["user"]>, r: { id: string; clientId: string; clientName: string; clientUri?: string; redirectUri: string; scope?: string }): Response {
  const access = consentAccess(r.scope ?? SCOPE);
  const who = user.identities.find((i) => i.login)?.login ?? user.email ?? user.name;
  // Anyone can register an app with any name: the heading names what gitring checked. A metadata
  // document client is known by the host of its document; a registered one only by where its code goes.
  const cimd = isCimdId(r.clientId);
  const known = cimd ? `<code>${esc(hostOf(r.clientId))}</code>` : destinationText(r.redirectUri);
  const says = [r.clientName && `calls itself “${esc(r.clientName)}”`, r.clientUri && `says that it is from <code>${esc(hostOf(r.clientUri))}</code>`].filter(Boolean).join(" and ");
  return page(
    "Allow the app",
    `<style>
button[value=allow]{animation:arm 1s step-end forwards;pointer-events:none}
@keyframes arm{to{pointer-events:auto}}
</style>
<h1>Allow the app at ${known} to use gitring as ${esc(user.name)}?</h1>
<p class="muted">You are signed in as ${esc(who)}. ${cimd ? `The app's details come from its own site.` : `The app ${says || "gave no name"}; gitring did not check this. Only allow it when you added gitring to this app yourself.`}</p>
<div class="card">
<h2>Access: ${access.label}</h2>
<h2>It can</h2>
<p>${access.can}</p>
<h2>It cannot</h2>
<p>Change project settings or members, see your API keys, or act after you remove it (Account → Connected apps).</p>
</div>
<p class="muted">After you allow it, gitring sends the app's access code to ${destinationText(r.redirectUri)}.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="req" value="${esc(r.id)}">
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny" class="btn secondary">Cancel</button>
</form>`,
    200,
    { "set-cookie": requestCookie(r.id) },
    // The answer to the form redirects to the app: the policy must allow that place.
    { formAction: [redirectSource(r.redirectUri)].filter(Boolean) },
  );
}

/**
 * A request that cannot go on (no PKCE, a wrong response type, an unknown scope). RFC 6749 sends the
 * error to the app's redirect URI; with open registration, that would make gitring send anyone to any
 * address. So the person sees the problem and chooses to go back; only an app that this person allowed
 * before gets the answer at once.
 */
function requestErrorPage(clientName: string, reason: string, redirect: string): Response {
  return page(
    "Connect an app",
    `<h1>gitring cannot connect ${esc(clientName || "this app")}</h1><p>${esc(reason)}</p>
<p class="muted">The app can get this answer at ${destinationText(redirect)}.</p>
<p><a class="btn secondary" href="${esc(redirect)}" rel="noreferrer">Send the answer to the app</a></p>`,
    400,
  );
}

/** A CSP source for a redirect URI: its origin (https, loopback http) or its scheme (an app). */
function redirectSource(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    return u.protocol;
  } catch {
    return "";
  }
}

function expiredPage(): Response {
  return page("Connect an app", `<h1>This sign-in link expired</h1><p>Go back to the app and connect gitring again.</p>`, 400, { "set-cookie": CLEAR_REQUEST_COOKIE });
}

export function oauthRoutes(app: Hono<HonoEnv>): void {
  for (const path of ["/.well-known/*", "/oauth/register", "/oauth/token", "/oauth/revoke"]) {
    app.options(path, () => new Response(null, { status: 204, headers: CORS }));
  }

  const asMeta = (c: C) => json(authorizationServerMetadata(originOf(c)), 200, { ...CORS, "cache-control": "public, max-age=3600" });
  const prMeta = (path: string) => (c: C) => json(protectedResourceMetadata(originOf(c), path), 200, { ...CORS, "cache-control": "public, max-age=3600" });
  app.get("/.well-known/oauth-authorization-server", asMeta);
  app.get("/.well-known/oauth-protected-resource", prMeta(MCP_PATH.gitring));
  // One resource per MCP endpoint (RFC 9728 §3.1: the endpoint's path follows the well-known name).
  for (const path of Object.values(MCP_PATH)) {
    app.get(`/.well-known/oauth-authorization-server${path}`, asMeta);
    app.get(`/.well-known/oauth-protected-resource${path}`, prMeta(path));
  }

  app.post("/oauth/register", async (c) => {
    const body = await c.req.json().catch(() => null);
    const res = await directory(c.env).oauthRegister(body, clientAddress(c.req.raw));
    return json(res.body, res.status, { ...CORS, "cache-control": "no-store" });
  });

  app.get("/oauth/authorize", async (c) => {
    const dir = directory(c.env);
    const o = originOf(c);
    // A plain object: Hono's query object has no prototype, and RPC cannot send that.
    const q: Record<string, string> = { ...Object.fromEntries(Object.entries(c.req.query())) };
    let request: { id: string; clientId: string; clientName: string; clientUri?: string; redirectUri: string; scope: string; forceConsent: boolean } | null;
    if (q.req) {
      request = await dir.oauthRequest(q.req);
      if (!request) return expiredPage();
      // The pending request belongs to the browser that started it.
      const bound = readCookie(c.req.raw, REQUEST_COOKIE) ?? "";
      if (!sameString(bound, request.id)) {
        return page("Connect an app", `<h1>Open this link in the same browser</h1><p>Start again from the app that wants to connect.</p>`, 400);
      }
    } else {
      const res = await dir.oauthStart(q, o, clientAddress(c.req.raw));
      if (!res.ok) {
        if ("page" in res) return page("Connect an app", `<h1>gitring cannot connect this app</h1><p>${esc(res.page)}</p>`, 400);
        const p = c.get("principal");
        const trusted = p.via === "session" && p.user ? await dir.oauthHasGrant(p.user.id, res.clientId) : false;
        return trusted ? redirect(res.redirect) : requestErrorPage(res.clientName, res.reason, res.redirect);
      }
      request = res.request;
    }
    const p = c.get("principal");
    if (p.via !== "session" || !p.user) return signInPage(c, request.clientName, request.id);
    if (!request.forceConsent && (await dir.oauthHasGrant(p.user.id, request.clientId, request.scope))) {
      // The person allowed this app before, for this scope or a wider one: no second question.
      const url = await dir.oauthApprove(request.id, p.user.id, o);
      return url ? redirect(url, CLEAR_REQUEST_COOKIE) : expiredPage();
    }
    return consentPage(p.user, request);
  });

  app.post("/oauth/authorize", async (c) => {
    const dir = directory(c.env);
    const o = originOf(c);
    const form = await formOf(c);
    const reqId = form.req ?? "";
    const bound = readCookie(c.req.raw, REQUEST_COOKIE) ?? "";
    if (!reqId || !sameString(bound, reqId)) return page("Connect an app", `<h1>Open this link in the same browser</h1><p>Start again from the app that wants to connect.</p>`, 400);
    const p = c.get("principal");
    if (p.via !== "session" || !p.user) return expiredPage();
    const url = form.decision === "allow" ? await dir.oauthApprove(reqId, p.user.id, o) : await dir.oauthDeny(reqId, o);
    return url ? redirect(url, CLEAR_REQUEST_COOKIE) : expiredPage();
  });

  app.post("/oauth/token", async (c) => {
    const form = await formOf(c);
    const res = await directory(c.env).oauthToken(form, basicAuth(c.req.header("authorization")), originOf(c), clientAddress(c.req.raw));
    return json(res.body, res.status, { ...CORS, ...(res.headers ?? {}) });
  });

  app.post("/oauth/revoke", async (c) => {
    const form = await formOf(c);
    const res = await directory(c.env).oauthRevoke(form, basicAuth(c.req.header("authorization")));
    // This isolate forgets the person's cached lookups at once; other isolates within 15 seconds.
    if (res.userId) forgetPrincipal({ userId: res.userId });
    if (res.body) return json(res.body, res.status, { ...CORS, "cache-control": "no-store" });
    return new Response(null, { status: res.status, headers: { ...CORS, "cache-control": "no-store" } });
  });

  app.get("/api/oauth/grants", async (c) => {
    const u = c.get("principal").user;
    if (!u) return json({ error: "Sign in first." }, 401);
    return json(await directory(c.env).oauthGrants(u.id), 200, { "cache-control": "private, no-store" });
  });

  app.delete("/api/oauth/grants/:id", async (c) => {
    const u = c.get("principal").user;
    if (!u) return json({ error: "Sign in first." }, 401);
    const ok = await directory(c.env).oauthRevokeGrant(u.id, c.req.param("id"));
    if (ok) forgetPrincipal({ userId: u.id });
    return ok ? new Response(null, { status: 204 }) : json({ error: "Unknown app." }, 404);
  });
}
