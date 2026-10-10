/**
 * OAuth 2.1 for MCP clients: registration (RFC 7591), client ID metadata documents, authorization with
 * PKCE, the token endpoint (codes, rotating refresh tokens with reuse detection), revocation (RFC 7009),
 * resource binding (RFC 8707) and the grants a person sees. The store runs on node:sqlite.
 */
import { describe, expect, it } from "vitest";
import { basicAuth, isCimdId, OAuthStore, redirectMatches, redirectOk, s256, withParams, ACCESS_TTL_S, REFRESH_TTL_S } from "../../src/directory/oauth";
import { authorizationServerMetadata, mcpChallenge, protectedResourceMetadata } from "../../src/worker/oauth";
import { sqliteCtx } from "../support/sqlite-storage";

const O = "https://gitring.example.workers.dev";
const VERIFIER = "v".repeat(20) + "-verifier-0123456789abcdefghijklmnop";
const CB = "https://claude.ai/api/mcp/auth_callback";

function store(opts: { fetch?: typeof fetch } = {}) {
  let now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const ctx = sqliteCtx();
  const s = new OAuthStore({ sql: ctx.storage.sql as never, now: () => now, fetch: opts.fetch });
  return { s, tick: (ms: number) => (now += ms), now: () => now };
}

async function register(s: OAuthStore, body: Record<string, unknown> = {}) {
  const res = await s.register({ client_name: "Claude", redirect_uris: [CB], ...body });
  expect(res.status).toBe(201);
  return res.body as { client_id: string; client_secret?: string };
}

async function authorize(s: OAuthStore, clientId: string, extra: Record<string, string> = {}) {
  const res = await s.startRequest(
    { response_type: "code", client_id: clientId, redirect_uri: CB, code_challenge: await s256(VERIFIER), code_challenge_method: "S256", state: "st-1", resource: `${O}/mcp`, ...extra },
    O,
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  return res.request;
}

async function codeFor(s: OAuthStore, clientId: string, user = "u_1", extra: Record<string, string> = {}) {
  const req = await authorize(s, clientId, extra);
  const url = new URL((await s.approve(req.id, user, O))!);
  return url.searchParams.get("code")!;
}

async function tokens(s: OAuthStore, clientId: string, user = "u_1") {
  const code = await codeFor(s, clientId, user);
  const res = await s.token({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: CB, resource: `${O}/mcp` }, null, O);
  expect(res.status).toBe(200);
  return res.body as { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };
}

describe("metadata", () => {
  it("points MCP clients from the 401 to the resource metadata, and from there to the server", () => {
    expect(mcpChallenge(O, false)).toBe(`Bearer realm="gitring", resource_metadata="${O}/.well-known/oauth-protected-resource/mcp", scope="mcp"`);
    expect(mcpChallenge(O, true)).toContain('error="invalid_token"');
    const pr = protectedResourceMetadata(O);
    expect(pr.resource).toBe(`${O}/mcp`);
    expect(pr.authorization_servers).toEqual([O]);
    const as = authorizationServerMetadata(O);
    expect(as.issuer).toBe(O);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.registration_endpoint).toBe(`${O}/oauth/register`);
  });
});

describe("URL rules", () => {
  it("allows https, loopback http and app schemes as redirect URIs", () => {
    expect(redirectOk(CB)).toBe(true);
    expect(redirectOk("http://localhost:33418/callback")).toBe(true);
    expect(redirectOk("http://127.0.0.1/cb")).toBe(true);
    expect(redirectOk("http://[::1]:9000/cb")).toBe(true);
    expect(redirectOk("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(redirectOk("http://evil.example/cb")).toBe(false);
    expect(redirectOk("javascript:alert(1)")).toBe(false);
    expect(redirectOk("data:text/html,x")).toBe(false);
    expect(redirectOk("https://ok.example/cb#frag")).toBe(false);
    expect(redirectOk("not a url")).toBe(false);
  });

  it("matches loopback redirects on any port, and others exactly", () => {
    expect(redirectMatches(["http://127.0.0.1/callback"], "http://127.0.0.1:51234/callback")).toBe(true);
    expect(redirectMatches(["http://localhost:3000/callback"], "http://localhost:4000/callback")).toBe(true);
    expect(redirectMatches(["http://localhost:3000/callback"], "http://localhost:4000/other")).toBe(false);
    expect(redirectMatches([CB], `${CB}?x=1`)).toBe(false);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example:8443/cb")).toBe(false);
  });

  it("accepts only clean https URLs with a path as client ID metadata documents", () => {
    expect(isCimdId("https://app.dev/oauth/client.json")).toBe(true);
    expect(isCimdId("https://app.dev")).toBe(false);
    expect(isCimdId("https://app.dev/")).toBe(false);
    expect(isCimdId("http://app.dev/client.json")).toBe(false);
    expect(isCimdId("https://user:pw@app.dev/client.json")).toBe(false);
    expect(isCimdId("https://app.dev/a/../client.json")).toBe(false);
    expect(isCimdId("https://app.dev/client.json#x")).toBe(false);
    expect(isCimdId("gitring-abc")).toBe(false);
    // Not into private networks: no IP addresses, no local names, no other ports.
    expect(isCimdId("https://10.0.0.5/x.json")).toBe(false);
    expect(isCimdId("https://[::1]/x.json")).toBe(false);
    expect(isCimdId("https://localhost/x.json")).toBe(false);
    expect(isCimdId("https://metadata.internal/x.json")).toBe(false);
    expect(isCimdId("https://intranet/x.json")).toBe(false);
    expect(isCimdId("https://app.example.com:8443/x.json")).toBe(false);
    expect(isCimdId("https://claude.ai/oauth/claude-client.json")).toBe(true);
  });

  it("decodes HTTP Basic client authentication (form-encoded parts)", () => {
    expect(basicAuth(`Basic ${btoa("my%20client:s%3Acret")}`)).toEqual({ id: "my client", secret: "s:cret" });
    expect(basicAuth("Bearer x")).toBeNull();
    expect(basicAuth(`Basic ${btoa("no-colon")}`)).toBeNull();
  });

  it("adds parameters to a redirect URI and keeps its own query", () => {
    expect(withParams("https://a.example/cb?x=1", { code: "c", state: undefined })).toBe("https://a.example/cb?x=1&code=c");
  });
});

describe("dynamic client registration", () => {
  it("registers a public client", async () => {
    const { s } = store();
    const res = await s.register({ client_name: "Claude Code", redirect_uris: ["http://localhost:4567/callback"], token_endpoint_auth_method: "none" });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^gitring-/);
    expect(res.body.client_secret).toBeUndefined();
    expect(res.body.token_endpoint_auth_method).toBe("none");
    expect((await s.client(String(res.body.client_id)))?.name).toBe("Claude Code");
  });

  it("gives a secret to a confidential client", async () => {
    const { s } = store();
    const res = await s.register({ redirect_uris: [CB], token_endpoint_auth_method: "client_secret_basic" });
    expect(res.status).toBe(201);
    expect(String(res.body.client_secret)).toMatch(/^gcs_/);
    expect(res.body.client_secret_expires_at).toBe(0);
  });

  it("refuses bad metadata", async () => {
    const { s } = store();
    expect((await s.register({ redirect_uris: [] })).body.error).toBe("invalid_redirect_uri");
    expect((await s.register({ redirect_uris: ["http://evil.example/cb"] })).body.error).toBe("invalid_redirect_uri");
    expect((await s.register({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) })).body.error).toBe("invalid_redirect_uri");
    expect((await s.register({ redirect_uris: [CB], token_endpoint_auth_method: "private_key_jwt" })).body.error).toBe("invalid_client_metadata");
    expect((await s.register({ redirect_uris: [CB], grant_types: ["client_credentials"] })).body.error).toBe("invalid_client_metadata");
    expect((await s.register({ redirect_uris: [CB], response_types: ["token"] })).body.error).toBe("invalid_client_metadata");
    expect((await s.register(null)).status).toBe(400);
  });

  it("limits registrations per hour", async () => {
    const { s, tick } = store();
    for (let i = 0; i < 300; i++) expect((await s.register({ redirect_uris: [CB] })).status).toBe(201);
    expect((await s.register({ redirect_uris: [CB] })).status).toBe(429);
    tick(3600_001);
    expect((await s.register({ redirect_uris: [CB] })).status).toBe(201);
  });
});

describe("authorization", () => {
  it("checks the client and the redirect URI before it redirects anywhere", async () => {
    const { s } = store();
    const c = await register(s);
    const unknown = await s.startRequest({ client_id: "gitring-nope", redirect_uri: CB, response_type: "code" }, O);
    expect(unknown).toMatchObject({ ok: false, page: expect.any(String) });
    const wrong = await s.startRequest({ client_id: c.client_id, redirect_uri: "https://evil.example/cb", response_type: "code" }, O);
    expect(wrong).toMatchObject({ ok: false, page: expect.stringContaining("did not register") });
  });

  it("sends later errors back to the client with state and iss", async () => {
    const { s } = store();
    const c = await register(s);
    const base = { client_id: c.client_id, redirect_uri: CB, response_type: "code", state: "xyz" };
    const noPkce = await s.startRequest(base, O);
    expect("redirect" in noPkce && new URL(noPkce.redirect).searchParams.get("error")).toBe("invalid_request");
    const plain = await s.startRequest({ ...base, code_challenge: await s256(VERIFIER), code_challenge_method: "plain" }, O);
    expect("redirect" in plain && new URL(plain.redirect).searchParams.get("error")).toBe("invalid_request");
    const token = await s.startRequest({ ...base, response_type: "token", code_challenge: await s256(VERIFIER), code_challenge_method: "S256" }, O);
    const u = new URL("redirect" in token ? token.redirect : "https://x/");
    expect(u.searchParams.get("error")).toBe("unsupported_response_type");
    expect(u.searchParams.get("state")).toBe("xyz");
    expect(u.searchParams.get("iss")).toBe(O);
    const target = await s.startRequest({ ...base, code_challenge: await s256(VERIFIER), code_challenge_method: "S256", resource: "https://other.example/mcp" }, O);
    expect("redirect" in target && new URL(target.redirect).searchParams.get("error")).toBe("invalid_target");
    const scope = await s.startRequest({ ...base, code_challenge: await s256(VERIFIER), code_challenge_method: "S256", scope: "admin" }, O);
    expect("redirect" in scope && new URL(scope.redirect).searchParams.get("error")).toBe("invalid_scope");
  });

  it("uses the only registered redirect URI when the request has none", async () => {
    const { s } = store();
    const c = await register(s);
    const res = await s.startRequest({ client_id: c.client_id, response_type: "code", code_challenge: await s256(VERIFIER), code_challenge_method: "S256" }, O);
    expect(res.ok && res.request.redirectUri).toBe(CB);
  });

  it("keeps a pending request for 15 minutes", async () => {
    const { s, tick } = store();
    const c = await register(s);
    const req = await authorize(s, c.client_id);
    expect(s.request(req.id)?.clientName).toBe("Claude");
    tick(15 * 60_000 + 1);
    expect(s.request(req.id)).toBeNull();
    expect(await s.approve(req.id, "u_1", O)).toBeNull();
  });

  it("answers access_denied when the person says no", async () => {
    const { s } = store();
    const c = await register(s);
    const req = await authorize(s, c.client_id);
    const u = new URL(s.deny(req.id, O)!);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(s.request(req.id)).toBeNull();
  });

  it("remembers a grant, and prompt=consent asks again", async () => {
    const { s } = store();
    const c = await register(s);
    expect(s.hasGrant("u_1", c.client_id)).toBe(false);
    await codeFor(s, c.client_id);
    expect(s.hasGrant("u_1", c.client_id)).toBe(true);
    expect((await authorize(s, c.client_id, { prompt: "consent" })).forceConsent).toBe(true);
    expect((await authorize(s, c.client_id)).forceConsent).toBe(false);
  });
});

describe("token endpoint", () => {
  it("exchanges a code with PKCE for an access token and a refresh token", async () => {
    const { s } = store();
    const c = await register(s);
    const t = await tokens(s, c.client_id);
    expect(t.access_token).toMatch(/^goa_/);
    expect(t.refresh_token).toMatch(/^gor_/);
    expect(t.token_type).toBe("Bearer");
    expect(t.expires_in).toBe(ACCESS_TTL_S);
    expect(t.scope).toBe("mcp");
    const who = await s.accessUser(t.access_token, O);
    expect(who).toMatchObject({ userId: "u_1", clientId: c.client_id });
  });

  it("refuses a wrong verifier, another client, another redirect URI and a late code", async () => {
    const { s, tick } = store();
    const c = await register(s);
    const other = await register(s, { client_name: "Other" });
    const form = (code: string) => ({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: c.client_id });
    const c1 = await codeFor(s, c.client_id);
    expect((await s.token({ ...form(c1), code_verifier: "w".repeat(50) }, null, O)).body.error).toBe("invalid_grant");
    const c2 = await codeFor(s, c.client_id);
    expect((await s.token({ ...form(c2), client_id: other.client_id }, null, O)).body.error).toBe("invalid_grant");
    const c3 = await codeFor(s, c.client_id);
    expect((await s.token({ ...form(c3), redirect_uri: "https://claude.ai/other" }, null, O)).body.error).toBe("invalid_grant");
    const c4 = await codeFor(s, c.client_id);
    tick(10 * 60_000 + 1);
    expect((await s.token(form(c4), null, O)).body.error).toBe("invalid_grant");
    expect((await s.token({ ...form("goc_nope") }, null, O)).body.error).toBe("invalid_grant");
    expect((await s.token({ grant_type: "password", client_id: c.client_id }, null, O)).body.error).toBe("unsupported_grant_type");
    expect((await s.token({ ...form(c4), client_id: "gitring-unknown" }, null, O)).status).toBe(401);
  });

  it("revokes the tokens of a code that is used twice", async () => {
    const { s } = store();
    const c = await register(s);
    const code = await codeFor(s, c.client_id);
    const form = { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: c.client_id };
    const first = await s.token(form, null, O);
    expect(first.status).toBe(200);
    const second = await s.token(form, null, O);
    expect(second.body.error).toBe("invalid_grant");
    expect(await s.accessUser(String(first.body.access_token), O)).toBeNull();
  });

  it("rotates refresh tokens and lets a quick retry through", async () => {
    const { s, tick } = store();
    const c = await register(s);
    const t1 = await tokens(s, c.client_id);
    const r = (refresh: string) => s.token({ grant_type: "refresh_token", refresh_token: refresh, client_id: c.client_id }, null, O);
    const t2 = await r(t1.refresh_token);
    expect(t2.status).toBe(200);
    expect(t2.body.refresh_token).not.toBe(t1.refresh_token);
    // The client lost the answer and sends the same refresh token again within the grace time.
    tick(5_000);
    const retry = await r(t1.refresh_token);
    expect(retry.status).toBe(200);
    // The newest refresh token works.
    const t3 = await r(String(retry.body.refresh_token));
    expect(t3.status).toBe(200);
    expect(await s.accessUser(String(t3.body.access_token), O)).not.toBeNull();
  });

  it("keeps one chain per sign-in: the token that a retry replaced ends the sign-in when it comes back", async () => {
    const { s, tick } = store();
    const c = await register(s);
    const t1 = await tokens(s, c.client_id);
    const r = (refresh: string) => s.token({ grant_type: "refresh_token", refresh_token: refresh, client_id: c.client_id }, null, O);
    const first = await r(t1.refresh_token); // the answer reaches someone
    tick(1_000);
    const second = await r(t1.refresh_token); // a second use within the grace time
    expect(second.status).toBe(200);
    // The first successor is no longer the newest: using it ends the whole sign-in (both chains).
    tick(1_000);
    const replay = await r(String(first.body.refresh_token));
    expect(replay.body.error).toBe("invalid_grant");
    expect(await s.accessUser(String(second.body.access_token), O)).toBeNull();
    expect((await r(String(second.body.refresh_token))).body.error).toBe("invalid_grant");
  });

  it("keeps sign-ins of one app on two devices apart", async () => {
    const { s, tick } = store();
    const c = await register(s);
    const laptop = await tokens(s, c.client_id);
    const phone = await tokens(s, c.client_id);
    const r = (refresh: string) => s.token({ grant_type: "refresh_token", refresh_token: refresh, client_id: c.client_id }, null, O);
    const l2 = await r(laptop.refresh_token);
    const p2 = await r(phone.refresh_token);
    expect(l2.status).toBe(200);
    expect(p2.status).toBe(200);
    // A replay on the laptop ends the laptop's sign-in only.
    tick(31_000);
    expect((await r(laptop.refresh_token)).body.error).toBe("invalid_grant");
    expect(await s.accessUser(String(l2.body.access_token), O)).toBeNull();
    expect(await s.accessUser(String(p2.body.access_token), O)).not.toBeNull();
    expect((await r(String(p2.body.refresh_token))).status).toBe(200);
  });

  it("ends the sign-in when a rotated refresh token comes back later (stolen token)", async () => {
    const { s, tick } = store();
    const c = await register(s);
    const t1 = await tokens(s, c.client_id);
    const r = (refresh: string) => s.token({ grant_type: "refresh_token", refresh_token: refresh, client_id: c.client_id }, null, O);
    const t2 = await r(t1.refresh_token);
    tick(31_000);
    const replay = await r(t1.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect(await s.accessUser(String(t2.body.access_token), O)).toBeNull();
    expect((await r(String(t2.body.refresh_token))).body.error).toBe("invalid_grant");
    // The person's consent stays: signing in again needs no second question.
    expect(s.hasGrant("u_1", c.client_id)).toBe(true);
  });

  it("expires access tokens after an hour and refresh tokens after 30 days without use", async () => {
    const { s, tick } = store();
    const c = await register(s);
    const t = await tokens(s, c.client_id);
    tick(ACCESS_TTL_S * 1000 + 1);
    expect(await s.accessUser(t.access_token, O)).toBeNull();
    tick(REFRESH_TTL_S * 1000);
    const late = await s.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.client_id }, null, O);
    expect(late.body.error).toBe("invalid_grant");
  });

  it("refuses a refresh token of another client", async () => {
    const { s } = store();
    const c = await register(s);
    const other = await register(s, { client_name: "Other" });
    const t = await tokens(s, c.client_id);
    const res = await s.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: other.client_id }, null, O);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("binds tokens to the MCP endpoint (RFC 8707)", async () => {
    const { s } = store();
    const c = await register(s);
    const t = await tokens(s, c.client_id);
    expect(await s.accessUser(t.access_token, "https://other.example")).toBeNull();
    const code = await codeFor(s, c.client_id);
    const res = await s.token({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: c.client_id, resource: "https://other.example/mcp" }, null, O);
    expect(res.body.error).toBe("invalid_target");
  });

  it("checks the secret of a confidential client (Basic and post)", async () => {
    const { s } = store();
    const c = await register(s, { token_endpoint_auth_method: "client_secret_basic" });
    const code = await codeFor(s, c.client_id);
    const form = { grant_type: "authorization_code", code, code_verifier: VERIFIER };
    const none = await s.token({ ...form, client_id: c.client_id }, null, O);
    expect(none.status).toBe(401);
    expect(none.body.error).toBe("invalid_client");
    const wrong = await s.token(form, { id: c.client_id, secret: "gcs_wrong" }, O);
    expect(wrong.status).toBe(401);
    expect(wrong.headers?.["www-authenticate"]).toContain("Basic");
    const ok = await s.token(form, { id: c.client_id, secret: c.client_secret! }, O);
    expect(ok.status).toBe(200);
    const code2 = await codeFor(s, c.client_id);
    const post = await s.token({ grant_type: "authorization_code", code: code2, code_verifier: VERIFIER, client_id: c.client_id, client_secret: c.client_secret }, null, O);
    expect(post.status).toBe(200);
  });

  it("never stores tokens or codes in clear text", async () => {
    const ctx = sqliteCtx();
    const s = new OAuthStore({ sql: ctx.storage.sql as never });
    const c = await register(s);
    const t = await tokens(s, c.client_id);
    const dump = JSON.stringify([
      ...ctx.storage.sql.exec("SELECT * FROM oauth_tokens").toArray(),
      ...ctx.storage.sql.exec("SELECT * FROM oauth_codes").toArray(),
    ]);
    expect(dump).not.toContain(t.access_token);
    expect(dump).not.toContain(t.refresh_token);
    expect(dump).not.toContain("goc_");
  });
});

describe("revocation and grants", () => {
  it("revokes an access token alone, and a refresh token with its sign-in", async () => {
    const { s } = store();
    const c = await register(s);
    const t = await tokens(s, c.client_id);
    expect((await s.revoke({ token: t.access_token, client_id: c.client_id }, null)).status).toBe(200);
    expect(await s.accessUser(t.access_token, O)).toBeNull();
    const fresh = await s.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.client_id }, null, O);
    expect(fresh.status).toBe(200);
    const revoked = await s.revoke({ token: String(fresh.body.refresh_token) }, null);
    expect(revoked).toMatchObject({ status: 200, userId: "u_1" });
    expect(await s.accessUser(String(fresh.body.access_token), O)).toBeNull();
    expect(s.hasGrant("u_1", c.client_id)).toBe(true);
    expect((await s.revoke({ token: "gor_unknown" }, null)).status).toBe(200);
  });

  it("refuses to revoke a token of another client", async () => {
    const { s } = store();
    const c = await register(s);
    const other = await register(s, { client_name: "Other" });
    const t = await tokens(s, c.client_id);
    const res = await s.revoke({ token: t.access_token, client_id: other.client_id }, null);
    expect(res.status).toBe(400);
    expect(res.body?.error).toBe("unauthorized_client");
    expect(await s.accessUser(t.access_token, O)).not.toBeNull();
  });

  it("lists a person's apps and removes one", async () => {
    const { s } = store();
    const c = await register(s);
    const t = await tokens(s, c.client_id, "u_1");
    await tokens(s, c.client_id, "u_2");
    const mine = s.grants("u_1");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ clientId: c.client_id, clientName: "Claude", scope: "mcp" });
    expect(s.revokeUserGrant("u_2", mine[0].id)).toBe(false);
    expect(s.revokeUserGrant("u_1", mine[0].id)).toBe(true);
    expect(s.grants("u_1")).toHaveLength(0);
    expect(await s.accessUser(t.access_token, O)).toBeNull();
    expect(s.grants("u_2")).toHaveLength(1);
    s.revokeAllOf("u_2");
    expect(s.grants("u_2")).toHaveLength(0);
  });
});

describe("client ID metadata documents", () => {
  const ID = "https://agent.dev/oauth/client.json";
  const doc = { client_id: ID, client_name: "Agent", client_uri: "https://agent.dev", redirect_uris: ["https://agent.dev/cb"] };

  function fetcher(answer: () => Response | Promise<Response>) {
    const calls: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return answer();
    }) as typeof fetch;
    return { f, calls };
  }

  it("fetches the document, caches it for a day, and uses it for the whole flow", async () => {
    const { f, calls } = fetcher(() => new Response(JSON.stringify(doc)));
    const { s, tick } = store({ fetch: f });
    const res = await s.startRequest({ client_id: ID, redirect_uri: "https://agent.dev/cb", response_type: "code", code_challenge: await s256(VERIFIER), code_challenge_method: "S256" }, O);
    expect(res.ok && res.request.clientName).toBe("Agent");
    expect((await s.client(ID))?.kind).toBe("cimd");
    expect(calls).toHaveLength(1);
    tick(24 * 3600_000 + 1);
    await s.client(ID);
    expect(calls).toHaveLength(2);
  });

  it("refuses a document for another id, one with a secret, and one without redirect URIs", async () => {
    for (const bad of [{ ...doc, client_id: "https://agent.dev/other.json" }, { ...doc, client_secret: "x" }, { ...doc, redirect_uris: ["http://evil.example/cb"] }]) {
      const { f } = fetcher(() => new Response(JSON.stringify(bad)));
      const { s } = store({ fetch: f });
      expect(await s.client(ID)).toBeNull();
    }
  });

  it("keeps a cached document while the client's site is down (up to a week)", async () => {
    let up = true;
    const { f } = fetcher(() => (up ? new Response(JSON.stringify(doc)) : new Response("down", { status: 503 })));
    const { s, tick } = store({ fetch: f });
    expect(await s.client(ID)).not.toBeNull();
    up = false;
    tick(2 * 24 * 3600_000);
    expect((await s.client(ID))?.name).toBe("Agent");
    tick(6 * 24 * 3600_000);
    expect(await s.client(ID)).toBeNull();
  });

  it("drops a cached document that the client's site removed (404)", async () => {
    let gone = false;
    const { f } = fetcher(() => (gone ? new Response("nope", { status: 404 }) : new Response(JSON.stringify(doc))));
    const { s, tick } = store({ fetch: f });
    expect(await s.client(ID)).not.toBeNull();
    gone = true;
    tick(24 * 3600_000 + 1);
    expect(await s.client(ID)).toBeNull();
  });
});
