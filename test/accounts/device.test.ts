/**
 * The device authorization grant (RFC 8628) of the OAuth server: the user codes, the start, the person's
 * answer, and the token requests of the program (pending, slow down, denied, expired, used twice). The store
 * runs on node:sqlite.
 */
import { describe, expect, it } from "vitest";
import { OAuthStore, s256 } from "../../src/directory/oauth";
import { CLI_CLIENT_ID, DEVICE_GRANT, DEVICE_INTERVAL_S, DEVICE_TTL_S, formatUserCode, newUserCode, normalizeUserCode } from "../../src/directory/device";
import { sqliteCtx } from "../support/sqlite-storage";

const O = "https://gitring.example.workers.dev";

function store() {
  let now = Date.UTC(2026, 9, 13, 12, 0, 0);
  const ctx = sqliteCtx();
  const s = new OAuthStore({ sql: ctx.storage.sql as never, now: () => now });
  return { s, ctx, tick: (ms: number) => (now += ms) };
}

async function start(s: OAuthStore, form: Record<string, string> = {}, address = "203.0.113.9") {
  const res = await s.deviceStart({ client_id: CLI_CLIENT_ID, scope: "mcp", resource: `${O}/mcp`, ...form }, null, O, address);
  return res as { status: number; body: Record<string, any> };
}

const poll = (s: OAuthStore, deviceCode: string, clientId = CLI_CLIENT_ID) => s.token({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId }, null, O);

describe("user codes", () => {
  it("have 8 consonants, read as two groups of four, and accept the ways people type them", () => {
    for (let i = 0; i < 200; i++) {
      const c = newUserCode();
      expect(c).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
      expect(normalizeUserCode(formatUserCode(c))).toBe(c);
    }
    expect(formatUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
    expect(normalizeUserCode(" bcdf-ghjk ")).toBe("BCDFGHJK");
    expect(normalizeUserCode("BCDF GHJK")).toBe("BCDFGHJK");
    // Vowels and digits are never part of a code; a short or long code is refused.
    expect(normalizeUserCode("ABCD-EFGH")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJ1")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJKL")).toBeNull();
    expect(normalizeUserCode(undefined)).toBeNull();
  });
});

describe("start of a device sign-in", () => {
  it("gives a device code, a user code, the page and the timing (gitring's own command line)", async () => {
    const { s } = store();
    const res = await start(s);
    expect(res.status).toBe(200);
    expect(res.body.device_code).toMatch(/^god_/);
    expect(res.body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(res.body.verification_uri).toBe(`${O}/device`);
    expect(res.body.verification_uri_complete).toBe(`${O}/device?code=${res.body.user_code}`);
    expect(res.body.expires_in).toBe(DEVICE_TTL_S);
    expect(res.body.interval).toBe(DEVICE_INTERVAL_S);
  });

  it("refuses an unknown client, a client without the device grant, a bad scope and another server's resource", async () => {
    const { s } = store();
    expect((await start(s, { client_id: "gitring-nope" })).status).toBe(401);
    const codeOnly = await s.register({ client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] });
    const refused = await start(s, { client_id: String(codeOnly.body.client_id) });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("unauthorized_client");
    expect((await start(s, { scope: "admin" })).body.error).toBe("invalid_scope");
    expect((await start(s, { resource: "https://other.example/mcp" })).body.error).toBe("invalid_target");
  });

  it("limits new sign-ins per address and hour", async () => {
    const { s, tick } = store();
    for (let i = 0; i < 30; i++) expect((await start(s, {}, "203.0.113.66")).status).toBe(200);
    expect((await start(s, {}, "203.0.113.66")).status).toBe(429);
    expect((await start(s, {}, "192.0.2.10")).status).toBe(200);
    tick(3600_001);
    expect((await start(s, {}, "203.0.113.66")).status).toBe(200);
  });

  it("lets a registered app use the device grant when it says so, also with no redirect URI", async () => {
    const { s } = store();
    const reg = await s.register({ client_name: "Agent on a server", grant_types: [DEVICE_GRANT, "refresh_token"] });
    expect(reg.status).toBe(201);
    expect(reg.body.grant_types).toEqual([DEVICE_GRANT, "refresh_token"]);
    expect(reg.body.response_types).toEqual([]);
    const id = String(reg.body.client_id);
    const res = await start(s, { client_id: id });
    expect(res.status).toBe(200);
    // It has no redirect URI, so it cannot use the authorization code flow.
    const code = await s.startRequest({ client_id: id, response_type: "code", code_challenge: await s256("v".repeat(50)), code_challenge_method: "S256" }, O);
    expect(code.ok).toBe(false);
    // The code flow still needs a redirect URI, and unknown grant types are still refused.
    expect((await s.register({ grant_types: ["authorization_code"] })).body.error).toBe("invalid_redirect_uri");
    expect((await s.register({ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials", DEVICE_GRANT] })).body.error).toBe("invalid_client_metadata");
  });

  it("knows gitring's own command line, which has no redirect URI and cannot use the code flow", async () => {
    const { s } = store();
    const cli = await s.client(CLI_CLIENT_ID);
    expect(cli).toMatchObject({ clientId: CLI_CLIENT_ID, name: "gitring command line", kind: "builtin", redirectUris: [] });
    const code = await s.startRequest({ client_id: CLI_CLIENT_ID, response_type: "code", code_challenge: await s256("v".repeat(50)), code_challenge_method: "S256" }, O);
    expect(code).toMatchObject({ ok: false, page: expect.any(String) });
  });
});

describe("the person's answer and the program's token requests", () => {
  it("answers 'pending', asks a program that polls too fast to slow down, and gives tokens after Allow", async () => {
    const { s, tick } = store();
    const d = (await start(s)).body;
    const first = await poll(s, d.device_code);
    expect(first.status).toBe(400);
    expect(first.body.error).toBe("authorization_pending");
    // Too soon: wait 5 seconds more from now on (10 seconds). The old interval is not enough any more.
    tick(1000);
    const fast = await poll(s, d.device_code);
    expect(fast.body.error).toBe("slow_down");
    expect(fast.body.error_description).toContain(`${DEVICE_INTERVAL_S + 5} seconds`);
    tick(DEVICE_INTERVAL_S * 1000 + 1);
    expect((await poll(s, d.device_code)).body.error).toBe("slow_down");
    tick((DEVICE_INTERVAL_S + 10) * 1000 + 1);
    expect((await poll(s, d.device_code)).body.error).toBe("authorization_pending");

    const seen = await s.deviceLookup(d.user_code, "u_1");
    expect(seen).toMatchObject({ ok: true, device: { userCode: d.user_code, clientId: CLI_CLIENT_ID, clientName: "gitring command line", builtin: true, scope: "mcp", address: "203.0.113.9" } });
    const allowed = await s.deviceDecide(d.user_code.toLowerCase(), "u_1", true);
    expect(allowed?.builtin).toBe(true);
    // A second answer finds no waiting code.
    expect(await s.deviceDecide(d.user_code, "u_1", false)).toBeNull();
    expect((await s.deviceLookup(d.user_code, "u_1")).ok).toBe(false);

    tick(20_000);
    const ok = await poll(s, d.device_code);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: "Bearer", scope: "mcp" });
    expect(String(ok.body.access_token)).toMatch(/^goa_/);
    expect(String(ok.body.refresh_token)).toMatch(/^gor_/);
    expect(ok.headers?.["cache-control"]).toBe("no-store");
    // The token is for /mcp only (RFC 8707), and it belongs to the person who allowed it.
    expect(await s.accessUser(String(ok.body.access_token), O)).toMatchObject({ userId: "u_1", clientId: CLI_CLIENT_ID, scope: "mcp" });
    expect(await s.accessUser(String(ok.body.access_token), O, `${O}/mcp/github`)).toBeNull();
    // The refresh token rotates like any other.
    const fresh = await s.token({ grant_type: "refresh_token", refresh_token: String(ok.body.refresh_token), client_id: CLI_CLIENT_ID }, null, O);
    expect(fresh.status).toBe(200);
    expect(await s.accessUser(String(fresh.body.access_token), O)).toMatchObject({ userId: "u_1" });
    // The person sees the command line in Connected apps.
    expect(s.grants("u_1")).toEqual([expect.objectContaining({ clientId: CLI_CLIENT_ID, clientName: "gitring command line", scope: "mcp" })]);
  });

  it("ends the sign-in when the device code comes back after it gave tokens", async () => {
    const { s } = store();
    const d = (await start(s)).body;
    await s.deviceDecide(d.user_code, "u_1", true);
    const ok = await poll(s, d.device_code);
    expect(ok.status).toBe(200);
    const again = await poll(s, d.device_code);
    expect(again.body.error).toBe("invalid_grant");
    expect(await s.accessUser(String(ok.body.access_token), O)).toBeNull();
  });

  it("answers access_denied after Cancel, and expired_token after 10 minutes", async () => {
    const { s, tick } = store();
    const denied = (await start(s)).body;
    expect((await s.deviceDecide(denied.user_code, "u_1", false))?.userCode).toBe(denied.user_code);
    expect((await poll(s, denied.device_code)).body.error).toBe("access_denied");
    const late = (await start(s)).body;
    tick(DEVICE_TTL_S * 1000 + 1);
    expect((await s.deviceLookup(late.user_code, "u_1")).ok).toBe(false);
    expect(await s.deviceDecide(late.user_code, "u_1", true)).toBeNull();
    expect((await poll(s, late.device_code)).body.error).toBe("expired_token");
  });

  it("refuses a device code of another client and a code that is not valid", async () => {
    const { s } = store();
    const other = await s.register({ client_name: "Other", grant_types: [DEVICE_GRANT] });
    const d = (await start(s)).body;
    await s.deviceDecide(d.user_code, "u_1", true);
    expect((await poll(s, d.device_code, String(other.body.client_id))).body.error).toBe("invalid_grant");
    expect((await poll(s, "god_nope")).body.error).toBe("invalid_grant");
    // A client that may not use the device grant cannot ask with it.
    const codeOnly = await s.register({ client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] });
    expect((await poll(s, d.device_code, String(codeOnly.body.client_id))).body.error).toBe("unauthorized_client");
    // The right client still gets its tokens.
    expect((await poll(s, d.device_code)).status).toBe(200);
  });

  it("gives no tokens when the person removed the app before the program asked", async () => {
    const { s } = store();
    const d = (await start(s)).body;
    await s.deviceDecide(d.user_code, "u_1", true);
    const [grant] = s.grants("u_1");
    expect(s.revokeUserGrant("u_1", grant.id)).toBe(true);
    expect((await poll(s, d.device_code)).body.error).toBe("invalid_grant");
  });

  it("keeps the read-only scope that the program asked for", async () => {
    const { s } = store();
    const d = (await start(s, { scope: "mcp:read" })).body;
    await s.deviceDecide(d.user_code, "u_1", true);
    const ok = await poll(s, d.device_code);
    expect(ok.body.scope).toBe("mcp:read");
  });

  it("stops a person who types many wrong codes for 10 minutes", async () => {
    const { s, tick } = store();
    const d = (await start(s)).body;
    for (let i = 0; i < 9; i++) expect(await s.deviceLookup("BBBB-BBBB", "u_guess")).toEqual({ ok: false, reason: "unknown" });
    expect(await s.deviceLookup("BBBB-BBBB", "u_guess")).toEqual({ ok: false, reason: "locked" });
    // Locked: even the right code waits now. Other people are not affected.
    expect(await s.deviceLookup(d.user_code, "u_guess")).toEqual({ ok: false, reason: "locked" });
    expect((await s.deviceLookup(d.user_code, "u_1")).ok).toBe(true);
    tick(10 * 60_000 + 1);
    const later = (await start(s)).body;
    expect((await s.deviceLookup(later.user_code, "u_guess")).ok).toBe(true);
  });

  it("never stores the device code or the user code in clear text", async () => {
    const { s, ctx } = store();
    const d = (await start(s)).body;
    const dump = JSON.stringify(ctx.storage.sql.exec("SELECT * FROM oauth_devices").toArray());
    expect(dump).not.toContain(d.device_code);
    expect(dump).not.toContain(String(d.user_code).replace("-", ""));
    expect(dump).not.toContain(d.user_code);
  });
});
