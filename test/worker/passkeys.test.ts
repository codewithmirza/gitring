/**
 * Passkey routes (/auth/passkey/*, /api/me/passkeys) against the real Worker and the real Directory
 * (node:sqlite), with a software authenticator in the place of the browser. Also the server pages that
 * offer passkeys first: the sign-in page of "connect an app" and the setup page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Directory } from "../../src/directory/directory";
import worker from "../../src/worker/index";
import { s256 } from "../../src/directory/oauth";
import type { PasskeyCreationOptions, PasskeyRequestOptions, UserInfo } from "../../src/core/accounts";
import { sqliteCtx } from "../support/sqlite-storage";
import { SoftAuthenticator, type Tamper } from "../support/passkey-authenticator";
import { steViolations } from "../coord/ste";

const ORIGIN = "https://gitring.example.workers.dev";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";

beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "not stubbed" }), { status: 599 }));
});
afterEach(() => vi.unstubAllGlobals());

function setup(extra: Record<string, unknown> = {}) {
  const env: Record<string, unknown> = { GITRING_SECRET: "test-secret-0123456789abcdef", ...extra };
  const dir = new Directory(sqliteCtx() as never, env as never);
  env.DIRECTORY = { idFromName: () => "directory", get: () => dir };
  env.HARBOR = { idFromName: (n: string) => n, get: () => ({ closeSockets: async () => 0 }) };
  return { env, dir };
}

/** A browser: it keeps the cookies that the Worker sets, and sends gitring's own Origin. */
class Browser {
  cookies = new Map<string, string>();
  constructor(private readonly env: Record<string, unknown>) {}

  async call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers = new Headers({ "cf-connecting-ip": "198.51.100.7", "user-agent": UA, ...(init.headers ?? {}) });
    if (init.method && init.method !== "GET" && !headers.has("origin")) {
      headers.set("origin", ORIGIN);
      headers.set("sec-fetch-site", "same-origin");
    }
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const jar = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (jar) headers.set("cookie", jar);
    const req = new Request(ORIGIN + path, { method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.stringify(init.body), headers, redirect: "manual" });
    const res = await worker.fetch(req, this.env as never, { waitUntil() {}, passThroughOnException() {}, props: {} } as never);
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      if (attrs.some((a) => /max-age=0\b/i.test(a.trim())) || pair.slice(i + 1) === "") this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(i + 1));
    }
    return res;
  }

  async json<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T }> {
    const res = await this.call(path, init);
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json()) as T };
  }

  async createAccount(key: SoftAuthenticator, name = "Robin", t: Tamper = {}) {
    const opt = await this.json<{ options: PasskeyCreationOptions; mode: string }>("/auth/passkey/register/options", { method: "POST", body: { name } });
    expect(opt.status).toBe(200);
    return this.json<{ user: UserInfo; passkey: { id: string; name: string }; error?: string }>("/auth/passkey/register/verify", { method: "POST", body: { credential: await key.register(opt.body.options, ORIGIN, t) } });
  }

  async signIn(key: SoftAuthenticator, t: Tamper = {}) {
    const opt = await this.json<{ options: PasskeyRequestOptions }>("/auth/passkey/login/options", { method: "POST", body: {} });
    expect(opt.status).toBe(200);
    return this.json<{ user: UserInfo; error?: string }>("/auth/passkey/login/verify", { method: "POST", body: { credential: await key.login(opt.body.options, ORIGIN, t) } });
  }
}

const said: string[] = [];

describe("passkey routes", () => {
  it("create an account, sign out, and sign in again with the passkey only", async () => {
    const { env } = setup();
    const b = new Browser(env);
    const key = await SoftAuthenticator.create();
    const opt = await b.json<{ options: PasskeyCreationOptions; mode: string }>("/auth/passkey/register/options", { method: "POST", body: { name: "Robin" } });
    expect(opt.status).toBe(200);
    expect(opt.body.mode).toBe("create");
    expect(opt.body.options.rp.id).toBe("gitring.example.workers.dev");
    expect(b.cookies.get("__Host-gitring-passkey")).toBeTruthy();
    const made = await b.json<{ user: UserInfo; passkey: { name: string } }>("/auth/passkey/register/verify", { method: "POST", body: { credential: await key.register(opt.body.options, ORIGIN) } });
    expect(made.status).toBe(200);
    expect(made.body.user).toMatchObject({ name: "Robin", identities: [], passkeys: 1 });
    // The name comes from the browser's User-Agent.
    expect(made.body.passkey.name).toBe("Passkey (Windows)");
    expect(b.cookies.has("__Host-gitring-passkey")).toBe(false);
    expect(b.cookies.get("gitring_last")).toBe("passkey");
    expect((await b.json<{ user: UserInfo }>("/api/me")).body.user?.id).toBe(made.body.user.id);

    expect((await b.call("/auth/logout", { method: "POST" })).status).toBe(204);
    expect((await b.json<{ user: UserInfo | null }>("/api/me")).body.user).toBeNull();

    const back = await b.signIn(key);
    expect(back.status).toBe(200);
    expect(back.body.user.id).toBe(made.body.user.id);
    expect((await b.json<{ user: UserInfo }>("/api/me")).body.user?.id).toBe(made.body.user.id);
  });

  it("refuse an answer without this browser's cookie, and a challenge of another browser", async () => {
    const { env } = setup();
    const robin = new Browser(env);
    const key = await SoftAuthenticator.create();
    await robin.createAccount(key);
    await robin.call("/auth/logout", { method: "POST" });

    // A sign-in answer from another browser (the attacker's challenge) does not count here.
    const attacker = new Browser(env);
    const opt = await attacker.json<{ options: PasskeyRequestOptions }>("/auth/passkey/login/options", { method: "POST", body: {} });
    const answer = await key.login(opt.body.options, ORIGIN);
    const own = await robin.json<{ options: PasskeyRequestOptions }>("/auth/passkey/login/options", { method: "POST", body: {} });
    expect(own.status).toBe(200);
    const wrong = await robin.json<{ error: string }>("/auth/passkey/login/verify", { method: "POST", body: { credential: answer } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/another request/);
    said.push(wrong.body.error);

    const none = new Browser(env);
    const lost = await none.json<{ error: string }>("/auth/passkey/login/verify", { method: "POST", body: { credential: answer } });
    expect(lost.status).toBe(400);
    expect(lost.body.error).toMatch(/expired/);
    said.push(lost.body.error);

    // The state works once: the same answer with the same cookie again is refused.
    const cookie = attacker.cookies.get("__Host-gitring-passkey")!;
    expect((await attacker.call("/auth/passkey/login/verify", { method: "POST", body: { credential: answer } })).status).toBe(200);
    attacker.cookies.set("__Host-gitring-passkey", cookie);
    const replay = await attacker.json<{ error: string }>("/auth/passkey/login/verify", { method: "POST", body: { credential: answer } });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toMatch(/expired or was used/);
    said.push(replay.body.error);
  });

  it("refuse posts from other sites, with or without a session", async () => {
    const { env } = setup();
    const b = new Browser(env);
    for (const path of ["/auth/passkey/register/options", "/auth/passkey/register/verify", "/auth/passkey/login/options", "/auth/passkey/login/verify"]) {
      const res = await b.call(path, { method: "POST", body: { name: "x" }, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
      expect(res.status, path).toBe(403);
    }
    await b.createAccount(await SoftAuthenticator.create());
    const res = await b.call("/auth/passkey/register/options", { method: "POST", body: {}, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
  });

  it("are limited per address like the other sign-in starts", async () => {
    let n = 0;
    const RL_AUTH = { limit: async () => ({ success: ++n <= 2 }) };
    const { env } = setup({ RL_AUTH });
    const b = new Browser(env);
    expect((await b.call("/auth/passkey/login/options", { method: "POST", body: {} })).status).toBe(200);
    expect((await b.call("/auth/passkey/login/options", { method: "POST", body: {} })).status).toBe(200);
    expect((await b.call("/auth/passkey/login/options", { method: "POST", body: {} })).status).toBe(429);
    expect((await b.call("/auth/passkey/register/options", { method: "POST", body: { name: "x" } })).status).toBe(429);
  });

  it("add a passkey for the signed-in person, then list, rename and remove", async () => {
    const { env } = setup();
    const b = new Browser(env);
    const first = await SoftAuthenticator.create();
    const made = await b.createAccount(first);
    const opt = await b.json<{ options: PasskeyCreationOptions; mode: string }>("/auth/passkey/register/options", { method: "POST", body: { name: "ignored" } });
    expect(opt.body.mode).toBe("add");
    expect(opt.body.options.excludeCredentials.map((d) => d.id)).toEqual([first.credentialId]);
    const second = await SoftAuthenticator.create(-8);
    const added = await b.json<{ user: UserInfo; passkey: { id: string } }>("/auth/passkey/register/verify", { method: "POST", body: { credential: await second.register(opt.body.options, ORIGIN), label: "Security key" } });
    expect(added.status).toBe(200);
    expect(added.body.user).toMatchObject({ id: made.body.user.id, passkeys: 2 });
    // The cached lookup of the session shows the new count at once.
    expect((await b.json<{ user: UserInfo }>("/api/me")).body.user?.passkeys).toBe(2);

    const list = await b.json<{ id: string; name: string }[]>("/api/me/passkeys");
    expect(list.body.map((p) => p.name)).toEqual(["Passkey (Windows)", "Security key"]);
    const renamed = await b.json<{ name: string }>(`/api/me/passkeys/${second.credentialId}`, { method: "PATCH", body: { name: "Blue key" } });
    expect(renamed.body.name).toBe("Blue key");
    expect((await b.call(`/api/me/passkeys/${first.credentialId}`, { method: "DELETE" })).status).toBe(204);
    const last = await b.json<{ error: string }>(`/api/me/passkeys/${second.credentialId}`, { method: "DELETE" });
    expect(last.status).toBe(409);
    expect(last.body.error).toMatch(/only way to sign in/);
    said.push(last.body.error);
    expect((await b.call("/api/me/passkeys/nope", { method: "DELETE" })).status).toBe(404);
    // The remaining passkey still signs in.
    await b.call("/auth/logout", { method: "POST" });
    expect((await b.signIn(second)).status).toBe(200);
    expect((await b.signIn(first)).status).toBe(400);
  });

  it("let only the browser session change passkeys, not an API key", async () => {
    const { env, dir } = setup();
    const b = new Browser(env);
    const key = await SoftAuthenticator.create();
    const made = await b.createAccount(key);
    const { key: apiKey } = await dir.createKey(made.body.user.id, "script");
    const script = new Browser(env);
    const auth = { authorization: `Bearer ${apiKey}` };
    expect((await script.json<unknown[]>("/api/me/passkeys", { headers: auth })).body).toHaveLength(1);
    const res = await script.json<{ error: string }>(`/api/me/passkeys/${key.credentialId}`, { method: "DELETE", headers: auth });
    expect(res.status).toBe(403);
    said.push(res.body.error);
    expect((await script.call("/api/me/passkeys")).status).toBe(401);
  });

  it("send plain reasons for a refused passkey", async () => {
    const { env } = setup();
    const b = new Browser(env);
    const key = await SoftAuthenticator.create();
    const bad = await b.createAccount(key, "Robin", { origin: "https://evil.example" });
    expect(bad.status).toBe(400);
    said.push(bad.body.error!);
    const noName = await b.json<{ error: string }>("/auth/passkey/register/options", { method: "POST", body: { name: " " } });
    expect(noName.status).toBe(400);
    said.push(noName.body.error);
    await b.createAccount(key);
    const counter = await b.signIn(key, { signCount: 1 });
    expect(counter.status).toBe(400);
    said.push(counter.body.error!);
    for (const m of said) expect(steViolations(m), m).toEqual([]);
  });
});

describe("server pages", () => {
  it("offer passkeys first on the sign-in page of an app connection, with a script that the CSP allows", async () => {
    const { env } = setup();
    const b = new Browser(env);
    const reg = await b.json<{ client_id: string }>("/oauth/register", { method: "POST", body: { client_name: "Claude Code", redirect_uris: ["http://localhost:4567/callback"] }, headers: { origin: "" } });
    const q = new URLSearchParams({ client_id: reg.body.client_id, redirect_uri: "http://localhost:4567/callback", response_type: "code", code_challenge: await s256("v".repeat(50)), code_challenge_method: "S256" });
    const res = await b.call(`/oauth/authorize?${q}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with a passkey");
    expect(html).toContain("Create an account with a passkey");
    // No outside provider on this gitring: no "or" and no provider buttons, but sign-in works.
    expect(html).not.toContain("Continue with");
    expect(html).not.toContain("not set up");
    const nonce = /<script nonce="([^"]+)">/.exec(html)![1];
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).toContain("connect-src 'self'");
    // The script's own messages follow the STE rules.
    for (const m of ["This browser cannot use passkeys. Use another browser or another sign-in.", "You stopped the passkey. gitring made no change.", "Your device keeps the passkey. gitring keeps only its public key."]) {
      expect(html).toContain(m);
      expect(steViolations(m)).toEqual([]);
    }
    // After the passkey, the browser comes back to this request.
    const req = b.cookies.get("__Host-gitring-oauth")!;
    expect(html).toContain(`data-back="/oauth/authorize?req=${req}"`);

    // Signed in with a passkey, the same request shows the consent page.
    await b.createAccount(await SoftAuthenticator.create());
    const consent = await (await b.call(`/oauth/authorize?req=${req}`)).text();
    expect(consent).toContain("to use gitring as Robin?");
  });

  it("put the passkey before the providers, and show the providers last used first", async () => {
    const { env, dir } = setup();
    await dir.setGoogle({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" });
    const b = new Browser(env);
    const reg = await b.json<{ client_id: string }>("/oauth/register", { method: "POST", body: { client_name: "x", redirect_uris: ["http://localhost:4567/callback"] }, headers: { origin: "" } });
    const q = new URLSearchParams({ client_id: reg.body.client_id, redirect_uri: "http://localhost:4567/callback", response_type: "code", code_challenge: await s256("v".repeat(50)), code_challenge_method: "S256" });
    const html = await (await b.call(`/oauth/authorize?${q}`)).text();
    expect(html.indexOf("Sign in with a passkey")).toBeLessThan(html.indexOf("Continue with Google"));
    b.cookies.set("gitring_last", "passkey");
    const again = await (await b.call(`/oauth/authorize?${q}`)).text();
    expect(again).toMatch(/Sign in with a passkey<\/span><span class="last">Last used<\/span>/);
  });

  it("list passkeys first on the setup page, and the providers as optional extras", async () => {
    const { env } = setup({ GITRING_SETUP_TOKEN: "setup-token-123" });
    const b = new Browser(env);
    const html = await (await b.call("/setup?token=setup-token-123")).text();
    const at = (s: string) => html.indexOf(s);
    expect(at("1. Passkeys")).toBeGreaterThan(0);
    expect(at("1. Passkeys")).toBeLessThan(at("2. Owners"));
    expect(at("2. Owners")).toBeLessThan(at("3. Optional: sign in with Google"));
    expect(at("3. Optional: sign in with Google")).toBeLessThan(at("4. Optional: GitHub"));
    expect(html).toContain("user:u_0123456789");
  });
});
