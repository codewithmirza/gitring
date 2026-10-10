/**
 * OAuth 2.1 routes for MCP clients (Claude, Claude Code, Cursor, Codex and other agents):
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728: the MCP endpoint and its server
 *   GET  /.well-known/oauth-authorization-server       RFC 8414: endpoints and abilities
 *   POST /oauth/register                               RFC 7591: dynamic client registration
 *   GET  /oauth/authorize                              sign in, then allow the app (consent)
 *   POST /oauth/authorize                              the decision (same-origin form)
 *   POST /oauth/token                                  codes (PKCE S256) and rotating refresh tokens
 *   POST /oauth/revoke                                 RFC 7009
 *   GET/DELETE /api/oauth/grants[/:id]                 the apps a person allowed
 *
 * The logic lives in the Directory (src/directory/oauth.ts). A pending authorization is bound to the
 * browser that started it with a short-lived cookie, so that a link to it does not work elsewhere.
 */
import type { Context, Hono } from "hono";
import type { Env } from "./env";
import { directory, esc, forgetPrincipal, page, readCookie, type Principal } from "./auth";
import { basicAuth } from "../directory/oauth";
import { sameString } from "../directory/crypto";

type HonoEnv = { Bindings: Env; Variables: { principal: Principal } };
type C = Context<HonoEnv>;

const REQUEST_COOKIE = "__Host-gitring-oauth";

const CORS: Record<string, string> = {
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
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["mcp"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${o}/connect`,
  };
}

export function protectedResourceMetadata(o: string) {
  return {
    resource: `${o}/mcp`,
    authorization_servers: [o],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "gitring",
    resource_documentation: `${o}/connect`,
  };
}

/** The WWW-Authenticate header of a 401 from /mcp (MCP authorization spec, RFC 9728 §5.1). */
export function mcpChallenge(o: string, invalidToken: boolean): string {
  return `Bearer realm="gitring", resource_metadata="${o}/.well-known/oauth-protected-resource/mcp", scope="mcp"${invalidToken ? ', error="invalid_token", error_description="The access token is not valid or expired."' : ""}`;
}

async function formOf(c: C): Promise<Record<string, string | undefined>> {
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

async function signInPage(c: C, clientName: string, reqId: string): Promise<Response> {
  const providers = await directory(c.env)
    .providers()
    .catch(() => ({ github: null, google: null }));
  const back = encodeURIComponent(`/oauth/authorize?req=${reqId}`);
  const buttons = [
    providers.github ? `<a class="btn" href="/auth/github/start?return=${back}">Continue with GitHub</a>` : "",
    providers.google ? `<a class="btn secondary" href="/auth/google/start?return=${back}">Continue with Google</a>` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return page(
    "Connect an app",
    `<h1>Connect ${esc(clientName)} to gitring</h1>
<p class="muted">Sign in to gitring first. Then gitring asks you to allow the app.</p>
<div class="card"><p>${buttons || "Sign-in is not set up on this gitring yet."}</p></div>`,
    200,
    { "set-cookie": requestCookie(reqId) },
  );
}

function consentPage(user: NonNullable<Principal["user"]>, r: { id: string; clientName: string; clientUri?: string; redirectUri: string }): Response {
  const who = user.identities.find((i) => i.login)?.login ?? user.email ?? user.name;
  const site = r.clientUri ? `<p class="muted">The app says that it is from <code>${esc(hostOf(r.clientUri))}</code>. gitring did not check this.</p>` : "";
  return page(
    "Allow the app",
    `<h1>Allow ${esc(r.clientName)} to use gitring as you?</h1>
<p class="muted">You are signed in as ${esc(user.name)} (${esc(who)}).</p>
<div class="card">
<h2>It can</h2>
<p>Read the projects that you can see, and their tasks. In projects where you are a member: send plans, write code to work copies, run tests, and ask gitring to merge the work.</p>
<h2>It cannot</h2>
<p>Change project settings or members, see your API keys, or act after you remove it. Remove it at any time in Account → Connected apps.</p>
</div>
${site}
<p class="muted">After you allow it, you go back to <code>${esc(hostOf(r.redirectUri))}</code>.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="req" value="${esc(r.id)}">
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny" class="btn secondary">Cancel</button>
</form>`,
    200,
    { "set-cookie": requestCookie(r.id) },
  );
}

function expiredPage(): Response {
  return page("Connect an app", `<h1>This sign-in link expired</h1><p>Go back to the app and connect gitring again.</p>`, 400, { "set-cookie": CLEAR_REQUEST_COOKIE });
}

export function oauthRoutes(app: Hono<HonoEnv>): void {
  for (const path of ["/.well-known/*", "/oauth/register", "/oauth/token", "/oauth/revoke"]) {
    app.options(path, () => new Response(null, { status: 204, headers: CORS }));
  }

  const asMeta = (c: C) => json(authorizationServerMetadata(originOf(c)), 200, { ...CORS, "cache-control": "public, max-age=3600" });
  const prMeta = (c: C) => json(protectedResourceMetadata(originOf(c)), 200, { ...CORS, "cache-control": "public, max-age=3600" });
  app.get("/.well-known/oauth-authorization-server", asMeta);
  app.get("/.well-known/oauth-authorization-server/mcp", asMeta);
  app.get("/.well-known/oauth-protected-resource", prMeta);
  app.get("/.well-known/oauth-protected-resource/mcp", prMeta);

  app.post("/oauth/register", async (c) => {
    const body = await c.req.json().catch(() => null);
    const res = await directory(c.env).oauthRegister(body);
    return json(res.body, res.status, { ...CORS, "cache-control": "no-store" });
  });

  app.get("/oauth/authorize", async (c) => {
    const dir = directory(c.env);
    const o = originOf(c);
    // A plain object: Hono's query object has no prototype, and RPC cannot send that.
    const q: Record<string, string> = { ...Object.fromEntries(Object.entries(c.req.query())) };
    let request: { id: string; clientId: string; clientName: string; clientUri?: string; redirectUri: string; forceConsent: boolean } | null;
    if (q.req) {
      request = await dir.oauthRequest(q.req);
      if (!request) return expiredPage();
      // The pending request belongs to the browser that started it.
      const bound = readCookie(c.req.raw, REQUEST_COOKIE) ?? "";
      if (!sameString(bound, request.id)) {
        return page("Connect an app", `<h1>Open this link in the same browser</h1><p>Start again from the app that wants to connect.</p>`, 400);
      }
    } else {
      const res = await dir.oauthStart(q, o);
      if (!res.ok) {
        if ("page" in res) return page("Connect an app", `<h1>gitring cannot connect this app</h1><p>${esc(res.page)}</p>`, 400);
        return redirect(res.redirect);
      }
      request = res.request;
    }
    const p = c.get("principal");
    if (p.via !== "session" || !p.user) return signInPage(c, request.clientName, request.id);
    if (!request.forceConsent && (await dir.oauthHasGrant(p.user.id, request.clientId))) {
      // The person allowed this app before: no second question.
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
    const res = await directory(c.env).oauthToken(form, basicAuth(c.req.header("authorization")), originOf(c));
    return json(res.body, res.status, { ...CORS, ...(res.headers ?? {}) });
  });

  app.post("/oauth/revoke", async (c) => {
    const form = await formOf(c);
    const res = await directory(c.env).oauthRevoke(form, basicAuth(c.req.header("authorization")));
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
