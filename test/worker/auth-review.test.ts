/**
 * Review findings on sign-in and the OAuth server, against the real Worker routes and the real Directory
 * (node:sqlite). Provider HTTP calls are stubbed like test/accounts/directory.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Directory } from "../../src/directory/directory";
import worker from "../../src/worker/index";
import { s256 } from "../../src/directory/oauth";
import { sqliteCtx } from "../support/sqlite-storage";

const ORIGIN = "https://gitring.example.workers.dev";
const VERIFIER = "v".repeat(20) + "-verifier-0123456789abcdefghijklmnop";

type Fake = { status?: number; json: unknown };
let routes: Record<string, Fake | ((url: string, init?: RequestInit) => Fake)> = {};

beforeEach(() => {
  routes = {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: "not stubbed" }), { status: 599 });
    const r = routes[key];
    const f = typeof r === "function" ? r(url, init) : r;
    return new Response(JSON.stringify(f.json), { status: f.status ?? 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup(extra: Record<string, unknown> = {}) {
  const ctx = sqliteCtx();
  const env: Record<string, unknown> = { GITRING_SECRET: "test-secret-0123456789abcdef", ...extra };
  const dir = new Directory(ctx as never, env as never);
  env.DIRECTORY = { idFromName: () => "directory", get: () => dir };
  env.HARBOR = { idFromName: (n: string) => n, get: () => ({ closeSockets: async () => 0 }) };
  return { env, dir };
}

async function call(env: Record<string, unknown>, path: string, init: RequestInit & { cookie?: string; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  headers.set("cf-connecting-ip", init.ip ?? "198.51.100.7");
  const req = new Request(ORIGIN + path, { method: init.method, body: init.body, headers, redirect: "manual" });
  return worker.fetch(req, env as never, { waitUntil() {}, passThroughOnException() {}, props: {} } as never);
}

async function withGithubApp(dir: Directory) {
  routes["https://api.github.com/app-manifests/"] = {
    json: { id: 42, slug: "git-ring-example", client_id: "Iv1.abc", client_secret: "shh", webhook_secret: "whsec", pem: "x", html_url: "https://github.com/apps/git-ring-example" },
  };
  const m = await dir.githubManifest(ORIGIN);
  await dir.githubManifestDone("code-1", new URL(m.postUrl).searchParams.get("state")!);
}

function cookieFrom(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0].slice(name.length + 1);
  return null;
}

/** A browser sign-in through the Worker routes (start → GitHub → callback). */
async function browserGithubSignIn(env: Record<string, unknown>, ghUser: { id: number; login: string; email?: string }, returnTo = "/") {
  routes["https://github.com/login/oauth/access_token"] = { json: { access_token: `gho_${ghUser.login}`, expires_in: 28800, refresh_token: "ghr_x" } };
  routes["https://api.github.com/user"] = { json: { id: ghUser.id, login: ghUser.login, name: null, email: ghUser.email ?? null } };
  const start = await call(env, `/auth/github/start?return=${encodeURIComponent(returnTo)}`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const signin = cookieFrom(start, "__Host-gitring-signin")!;
  const cb = await call(env, `/auth/github/callback?code=c&state=${state}`, { cookie: `__Host-gitring-signin=${signin}` });
  return { cb, session: cookieFrom(cb, "__Host-gitring") };
}

async function registerClient(env: Record<string, unknown>, body: Record<string, unknown>, ip?: string) {
  const reg = await call(env, "/oauth/register", { method: "POST", ip, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: reg.status, ...((await reg.json()) as { client_id: string }) };
}

describe("return paths after sign-in", () => {
  it("stay on this site, also with dot segments that browsers fold into //", async () => {
    const { env, dir } = setup();
    await withGithubApp(dir);
    for (const ret of ["/.//evil.example/login", "/%2e//evil.example/login", "/a/..//evil.example/login", "/\t/evil.example"]) {
      const { cb } = await browserGithubSignIn(env, { id: 7, login: "victim" }, ret);
      expect(cb.status).toBe(302);
      expect(cb.headers.get("location")).toBe("/");
    }
    const { cb } = await browserGithubSignIn(env, { id: 7, login: "victim" }, "/projects?new=1&q=shop");
    expect(cb.headers.get("location")).toBe("/projects?new=1&q=shop");
  });
});

describe("authorization requests that cannot go on", () => {
  it("show a page with the problem instead of sending the browser to the app's address", async () => {
    const { env } = setup();
    const { client_id } = await registerClient(env, { client_name: "x", redirect_uris: ["https://evil.example/landing"] });
    const res = await call(env, `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent("https://evil.example/landing")}&response_type=token`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("gitring cannot connect x");
    expect(html).toContain("response_type=code");
    // The person can still send the answer to the app, with one click.
    expect(html).toContain('href="https://evil.example/landing?error=unsupported_response_type');
  });

  it("answer at once for an app that this person allowed before", async () => {
    const { env, dir } = setup();
    await withGithubApp(dir);
    const { session } = await browserGithubSignIn(env, { id: 9, login: "mira" });
    const { client_id } = await registerClient(env, { client_name: "Claude Code", redirect_uris: ["http://localhost:4567/callback"] });
    const q = new URLSearchParams({ client_id, redirect_uri: "http://localhost:4567/callback", response_type: "code", code_challenge: await s256(VERIFIER), code_challenge_method: "S256" });
    const consent = await call(env, `/oauth/authorize?${q}`, { cookie: `__Host-gitring=${session}` });
    const req = cookieFrom(consent, "__Host-gitring-oauth")!;
    await call(env, "/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin" },
      body: `req=${req}&decision=allow`,
      cookie: `__Host-gitring=${session}; __Host-gitring-oauth=${req}`,
    });
    const bad = await call(env, `/oauth/authorize?client_id=${client_id}&response_type=token`, { cookie: `__Host-gitring=${session}` });
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toContain("http://localhost:4567/callback?error=unsupported_response_type");
  });
});

describe("the consent page", () => {
  it("names the address that gets the code, not the name the app gave itself, and arms Allow after a moment", async () => {
    const { env, dir } = setup();
    await withGithubApp(dir);
    const { session } = await browserGithubSignIn(env, { id: 9, login: "mira" });
    const { client_id } = await registerClient(env, { client_name: "Claude", client_uri: "https://claude.ai", redirect_uris: ["https://evil.example/cb"] });
    const q = new URLSearchParams({ client_id, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: await s256(VERIFIER), code_challenge_method: "S256", state: "s" });
    const page = await call(env, `/oauth/authorize?${q}`, { cookie: `__Host-gitring=${session}` });
    const html = await page.text();
    const h1 = /<h1>(.*?)<\/h1>/.exec(html)![1];
    expect(h1).toBe("Allow the app at <code>evil.example</code> to use gitring as mira?");
    expect(html).toContain("calls itself “Claude” and says that it is from <code>claude.ai</code>; gitring did not check this");
    expect(html).not.toContain("autofocus");
    expect(html).toContain("button[value=allow]{animation:arm 1s step-end forwards;pointer-events:none}");
    expect(html).toContain("sends the app's access code to <code>evil.example</code>");
  });

  it("names a metadata document client by the host of its document", async () => {
    const { env, dir } = setup();
    await withGithubApp(dir);
    const { session } = await browserGithubSignIn(env, { id: 9, login: "mira" });
    routes["https://agent.example.com/client.json"] = { json: { client_id: "https://agent.example.com/client.json", client_name: "Agent", redirect_uris: ["https://agent.example.com/cb"] } };
    const q = new URLSearchParams({ client_id: "https://agent.example.com/client.json", redirect_uri: "https://agent.example.com/cb", response_type: "code", code_challenge: await s256(VERIFIER), code_challenge_method: "S256" });
    const page = await call(env, `/oauth/authorize?${q}`, { cookie: `__Host-gitring=${session}` });
    const html = await page.text();
    expect(/<h1>(.*?)<\/h1>/.exec(html)![1]).toBe("Allow the app at <code>agent.example.com</code> to use gitring as mira?");
    expect(html).toContain("The app's details come from its own site.");
  });
});

describe("caps on new clients", () => {
  it("stop one address, and leave other addresses alone", async () => {
    const { env } = setup();
    for (let i = 0; i < 30; i++) expect((await registerClient(env, { redirect_uris: ["https://evil.example/cb"] }, "203.0.113.66")).status).toBe(201);
    expect((await registerClient(env, { redirect_uris: ["https://evil.example/cb"] }, "203.0.113.66")).status).toBe(429);
    expect((await registerClient(env, { client_name: "Claude Code", redirect_uris: ["http://localhost:4567/callback"] }, "192.0.2.10")).status).toBe(201);
  });

  it("count metadata documents per address too", async () => {
    const { env } = setup();
    routes["https://attacker.example.com/c/"] = (url) => ({ json: { client_id: url, client_name: "x", redirect_uris: ["https://attacker.example.com/cb"] } });
    routes["https://new-agent.example.com/client.json"] = { json: { client_id: "https://new-agent.example.com/client.json", client_name: "New Agent", redirect_uris: ["https://new-agent.example.com/cb"] } };
    for (let i = 0; i < 40; i++) {
      await call(env, "/oauth/token", {
        method: "POST",
        ip: "203.0.113.66",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=refresh_token&refresh_token=x&client_id=${encodeURIComponent(`https://attacker.example.com/c/${i}.json`)}`,
      });
    }
    const q = new URLSearchParams({ client_id: "https://new-agent.example.com/client.json", redirect_uri: "https://new-agent.example.com/cb", response_type: "code", code_challenge: await s256(VERIFIER), code_challenge_method: "S256" });
    const res = await call(env, `/oauth/authorize?${q}`, { ip: "192.0.2.10" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connect New Agent to gitring");
  });
});

describe("the setup pages", () => {
  it("show the install link of the saved GitHub App only, whatever the link says", async () => {
    const { env, dir } = setup();
    const before = await (await call(env, "/setup/github/ready?slug=git-ring-examp1e")).text();
    expect(before).not.toContain("installations/new");
    await withGithubApp(dir);
    const after = await (await call(env, "/setup/github/ready?slug=git-ring-examp1e")).text();
    expect(after).toContain('href="https://github.com/apps/git-ring-example/installations/new"');
    expect(after).not.toContain("examp1e");
  });
});

describe("credential lookups", () => {
  it("are limited per address before gitring looks the credential up", async () => {
    let limiterCalls = 0;
    const RL_CRED = {
      async limit() {
        limiterCalls++;
        return { success: limiterCalls <= 3 };
      },
    };
    const { env, dir } = setup({ RL_CRED });
    let lookups = 0;
    const orig = dir.keyUser.bind(dir);
    (dir as unknown as { keyUser: typeof dir.keyUser }).keyUser = async (k: string) => (lookups++, orig(k));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call(env, "/api/projects", { headers: { authorization: `Bearer gk_${i}` } })).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
    expect(lookups).toBe(3);
    // Requests without a credential do not count against it.
    expect((await call(env, "/api/projects")).status).not.toBe(429);
    expect(limiterCalls).toBe(6);
  });
});
