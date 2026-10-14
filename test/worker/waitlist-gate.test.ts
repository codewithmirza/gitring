/**
 * The waitlist gate and the waitlist endpoints, against the real Worker routes and the real Directory
 * (node:sqlite). Emails here are placeholders. Provider HTTP calls are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Directory } from "../../src/directory/directory";
import worker from "../../src/worker/index";
import { sqliteCtx } from "../support/sqlite-storage";

const ORIGIN = "https://gitring.example.workers.dev";
const IN = "allowed@example.com";
const OUT = "waiting@example.com";
const BOSS = "owner@example.com";

type Fake = { status?: number; json: unknown };
let routes: Record<string, Fake> = {};

beforeEach(() => {
  routes = {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: "not stubbed" }), { status: 599 });
    return new Response(JSON.stringify(routes[key].json), { status: routes[key].status ?? 200, headers: { "content-type": "application/json" } });
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

async function call(env: Record<string, unknown>, path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", `__Host-gitring=${init.cookie}`);
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  headers.set("cf-connecting-ip", "198.51.100.7");
  if (init.method && init.method !== "GET") {
    headers.set("origin", ORIGIN);
    headers.set("sec-fetch-site", "same-origin");
  }
  const req = new Request(ORIGIN + path, { method: init.method, body: init.body, headers, redirect: "manual" });
  return worker.fetch(req, env as never, { waitUntil() {}, passThroughOnException() {}, props: {} } as never);
}

const json = (body: unknown): RequestInit => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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

/** Sign in with a stubbed GitHub account through the real routes; the session token comes back. */
async function signIn(env: Record<string, unknown>, who: { id: number; login: string; email: string }): Promise<string> {
  routes["https://github.com/login/oauth/access_token"] = { json: { access_token: `gho_${who.login}`, expires_in: 28800, refresh_token: "ghr_x" } };
  routes["https://api.github.com/user"] = { json: { id: who.id, login: who.login, name: who.login, email: who.email } };
  const start = await call(env, "/auth/github/start?return=%2F");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const signin = cookieFrom(start, "__Host-gitring-signin")!;
  const headers = { cookie: `__Host-gitring-signin=${signin}` };
  const cb = await worker.fetch(new Request(`${ORIGIN}/auth/github/callback?code=c&state=${state}`, { headers: { ...headers, "cf-connecting-ip": "198.51.100.7" }, redirect: "manual" }), env as never, {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as never);
  const session = cookieFrom(cb, "__Host-gitring");
  expect(session).toBeTruthy();
  return session!;
}

const PEOPLE = {
  allowed: { id: 1, login: "alice", email: IN },
  waiting: { id: 2, login: "walt", email: OUT },
  boss: { id: 3, login: "olivia", email: BOSS },
};

async function gated(extra: Record<string, unknown> = {}) {
  const t = setup({ ALLOWLIST_EMAILS: ` ${IN.toUpperCase()} , other@example.com `, GITRING_OWNERS: BOSS, ...extra });
  await withGithubApp(t.dir);
  const allowed = await signIn(t.env, PEOPLE.allowed);
  const waiting = await signIn(t.env, PEOPLE.waiting);
  const boss = await signIn(t.env, PEOPLE.boss);
  return { ...t, allowed, waiting, boss };
}

describe("gate on", () => {
  it("lets an allowlisted person use the API (the email match ignores case)", async () => {
    const { env, allowed } = await gated();
    expect((await call(env, "/api/projects", { cookie: allowed })).status).toBe(200);
    const me = (await (await call(env, "/api/me", { cookie: allowed })).json()) as { user: { allowed: boolean }; waitlist: { gate: boolean; allowed: boolean } };
    expect(me.user.allowed).toBe(true);
    expect(me.waitlist).toMatchObject({ gate: true, allowed: true });
  });

  it("answers 403 with the code waitlist on every API route, live socket, preview and hook for a person who waits", async () => {
    const { env, waiting } = await gated();
    for (const path of ["/api/projects", "/api/me/prefs", "/api/keys", "/api/projects/demo/state", "/api/projects/demo/push-token", "/api/projects/demo/clone-token", "/ws/demo", "/preview/demo/main/", "/api/ops/drydock"]) {
      const res = await call(env, path, { cookie: waiting });
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { code: string }).code, path).toBe("waitlist");
    }
    for (const [path, init] of [
      ["/api/projects", { method: "POST", ...json({ name: "x" }) }],
      ["/hooks/intents?project=demo", { method: "POST", ...json({}) }],
    ] as const) {
      expect((await call(env, path, { cookie: waiting, ...init })).status, path).toBe(403);
    }
  });

  it("answers 403 on the MCP endpoints and on the git hand-out, also with an API key made before the gate", async () => {
    const { env, dir, waiting } = await gated();
    const user = (await dir.sessionUser(waiting))!;
    const { key } = await dir.createKey(user.id, "old key");
    for (const path of ["/mcp", "/mcp/github", "/mcp/readonly"]) {
      const res = await call(env, path, { method: "POST", bearer: key, ...json({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("waitlist");
    }
    expect((await call(env, "/api/projects", { bearer: key })).status).toBe(403);
    expect((await call(env, "/api/projects/demo/clone-token", { method: "POST", bearer: key })).status).toBe(403);
  });

  it("keeps health, sign-in state, plans and the waitlist open", async () => {
    const { env, waiting } = await gated();
    expect((await call(env, "/api/health")).status).toBe(200);
    expect((await call(env, "/api/plans")).status).toBe(200);
    const me = (await (await call(env, "/api/me", { cookie: waiting })).json()) as { user: { allowed: boolean }; waitlist: { allowed: boolean; entry: unknown } };
    expect(me.user.allowed).toBe(false);
    expect(me.waitlist).toMatchObject({ allowed: false, entry: null });
    expect((await call(env, "/api/waitlist", { cookie: waiting })).status).toBe(200);
    expect((await call(env, "/privacy")).status).toBe(200);
  });

  it("tells a visitor to sign in (401), and shows a visitor the waitlist state", async () => {
    const { env } = await gated();
    const res = await call(env, "/api/projects");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("sign_in");
    const me = (await (await call(env, "/api/me")).json()) as { user: null; waitlist: { gate: boolean; allowed: boolean } };
    expect(me.user).toBeNull();
    expect(me.waitlist).toMatchObject({ gate: true, allowed: false });
  });

  it("lets an owner and the operator key through", async () => {
    const { env, boss } = await gated({ GITRING_KEY: "operator-key-0123456789" });
    expect((await call(env, "/api/projects", { cookie: boss })).status).toBe(200);
    expect((await call(env, "/api/projects", { bearer: "operator-key-0123456789" })).status).toBe(200);
  });

  it("lets a person in when an owner adds them, also when their session was cached before", async () => {
    const { env, waiting, boss } = await gated();
    expect((await call(env, "/api/projects", { cookie: waiting })).status).toBe(403);
    const add = await call(env, "/api/admin/allowed", { method: "POST", cookie: boss, ...json({ email: ` ${OUT.toUpperCase()} ` }) });
    expect(add.status).toBe(201);
    expect((await call(env, "/api/projects", { cookie: waiting })).status).toBe(200);
    // Taking the access back works at once too.
    expect((await call(env, `/api/admin/allowed/${encodeURIComponent(OUT)}`, { method: "DELETE", cookie: boss })).status).toBe(204);
    expect((await call(env, "/api/projects", { cookie: waiting })).status).toBe(403);
  });

  it("lets an owner allow an account without an email by its id", async () => {
    const { env, dir, waiting, boss } = await gated();
    const user = (await dir.sessionUser(waiting))!;
    expect((await call(env, "/api/admin/allowed", { method: "POST", cookie: boss, ...json({ email: `user:${user.id}` }) })).status).toBe(201);
    expect((await call(env, "/api/projects", { cookie: waiting })).status).toBe(200);
  });

  it("turns the gate on with WAITLIST_ENABLED alone: only owners get in", async () => {
    const t = setup({ WAITLIST_ENABLED: "true", GITRING_OWNERS: BOSS });
    await withGithubApp(t.dir);
    const boss = await signIn(t.env, PEOPLE.boss);
    const other = await signIn(t.env, PEOPLE.allowed);
    expect((await call(t.env, "/api/projects", { cookie: boss })).status).toBe(200);
    expect((await call(t.env, "/api/projects", { cookie: other })).status).toBe(403);
  });

  it("turns the gate off with WAITLIST_ENABLED=false, also with an allowlist", async () => {
    const t = setup({ WAITLIST_ENABLED: "false", ALLOWLIST_EMAILS: IN });
    await withGithubApp(t.dir);
    const other = await signIn(t.env, PEOPLE.waiting);
    expect((await call(t.env, "/api/projects", { cookie: other })).status).toBe(200);
  });

  it("refuses a new passkey account while Google or GitHub sign-in exists, and keeps passkey sign-in", async () => {
    const { env, waiting } = await gated();
    const res = await call(env, "/auth/passkey/register/options", { method: "POST", ...json({ name: "Nobody" }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("waitlist");
    // A signed-in person may still add a passkey to their account.
    const add = await call(env, "/auth/passkey/register/options", { method: "POST", cookie: waiting, ...json({}) });
    expect(add.status).toBe(200);
    expect((await call(env, "/auth/passkey/login/options", { method: "POST" })).status).toBe(200);
  });
});

describe("gate off", () => {
  it("changes nothing: everybody who signs in can use gitring, and /api/me has no waitlist", async () => {
    const { env, dir } = setup();
    await withGithubApp(dir);
    const session = await signIn(env, PEOPLE.waiting);
    expect((await call(env, "/api/projects", { cookie: session })).status).toBe(200);
    const me = (await (await call(env, "/api/me", { cookie: session })).json()) as { user: { allowed: boolean }; waitlist?: unknown };
    expect(me.waitlist).toBeUndefined();
    expect(me.user.allowed).toBe(true);
    // A visitor keeps the old answer for a project that does not exist.
    expect((await call(env, "/api/projects")).status).toBe(200);
    expect((await call(env, "/api/waitlist")).status).toBe(200);
    expect(await (await call(env, "/api/waitlist", { cookie: session })).json()).toEqual({ gate: false });
    // Without a gate there is no waitlist to join.
    expect((await call(env, "/api/waitlist", { method: "PUT", cookie: session, ...json({ pack: "team" }) })).status).toBe(404);
    // New passkey accounts work as before.
    expect((await call(env, "/auth/passkey/register/options", { method: "POST", ...json({ name: "Robin" }) })).status).toBe(200);
  });
});

describe("waitlist endpoints", () => {
  it("keeps one choice for each person, changes it, and takes it back", async () => {
    const { env, waiting } = await gated();
    const bad = await call(env, "/api/waitlist", { method: "PUT", cookie: waiting, ...json({ pack: "platinum" }) });
    expect(bad.status).toBe(400);
    const none = await call(env, "/api/waitlist", { method: "PUT", cookie: waiting, ...json({}) });
    expect(none.status).toBe(400);
    expect((await call(env, "/api/waitlist", { method: "PUT", ...json({ pack: "team" }) })).status).toBe(401);

    const first = (await (await call(env, "/api/waitlist", { method: "PUT", cookie: waiting, ...json({ pack: "team", note: "  We run 12 agents.  " }) })).json()) as { id: string; pack: string; note: string; email: string; provider: string; createdAt: number; updatedAt: number };
    expect(first).toMatchObject({ pack: "team", note: "We run 12 agents.", email: OUT, provider: "github" });
    expect(first.id).toMatch(/^w_/);

    const second = (await (await call(env, "/api/waitlist", { method: "PUT", cookie: waiting, ...json({ pack: "builder", note: "" }) })).json()) as typeof first;
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ pack: "builder", note: "", createdAt: first.createdAt });

    const state = (await (await call(env, "/api/waitlist", { cookie: waiting })).json()) as { entry: { pack: string } };
    expect(state.entry.pack).toBe("builder");
    expect((await call(env, "/api/waitlist", { method: "DELETE", cookie: waiting })).status).toBe(204);
    expect(((await (await call(env, "/api/waitlist", { cookie: waiting })).json()) as { entry: unknown }).entry).toBeNull();
  });

  it("cuts a long note", async () => {
    const { env, waiting } = await gated();
    const e = (await (await call(env, "/api/waitlist", { method: "PUT", cookie: waiting, ...json({ pack: "scale", note: "x".repeat(2000) }) })).json()) as { note: string };
    expect(e.note).toHaveLength(500);
  });

  it("lists people with counts for each pack, the monthly value and a CSV, for owners only", async () => {
    const { env, allowed, waiting, boss } = await gated();
    await call(env, "/api/waitlist", { method: "PUT", cookie: waiting, ...json({ pack: "team", note: "=HYPERLINK(\"x\")" }) });
    await call(env, "/api/waitlist", { method: "PUT", cookie: allowed, ...json({ pack: "builder" }) });
    await call(env, "/api/waitlist", { method: "PUT", cookie: boss, ...json({ pack: "enterprise" }) });

    for (const who of [waiting, allowed]) {
      expect((await call(env, "/api/admin/waitlist", { cookie: who })).status).toBe(403);
      expect((await call(env, "/api/admin/allowed", { cookie: who })).status).toBe(403);
      expect((await call(env, "/admin/waitlist", { cookie: who })).status).toBe(403);
    }
    expect((await call(env, "/api/admin/waitlist")).status).toBe(403);

    const report = (await (await call(env, "/api/admin/waitlist", { cookie: boss })).json()) as { total: number; byPack: Record<string, number>; monthlyValueUsd: number; people: { email: string; allowed: boolean }[] };
    expect(report.total).toBe(3);
    expect(report.byPack).toMatchObject({ explorer: 0, builder: 1, team: 1, scale: 0, enterprise: 1 });
    expect(report.monthlyValueUsd).toBe(15 + 99 + 1500);
    expect(report.people.find((p) => p.email === OUT)?.allowed).toBe(false);
    expect(report.people.find((p) => p.email === IN)?.allowed).toBe(true);

    const csv = await call(env, "/api/admin/waitlist?format=csv", { cookie: boss });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("id,email,name,provider,pack,monthly_usd,note,allowed,created,updated");
    expect(text).toContain(OUT);
    // A note that starts with = does not run as a formula in a spreadsheet.
    expect(text).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
  });

  it("shows the owner page with the people and a form to let a person in", async () => {
    const { env, waiting, boss } = await gated();
    await call(env, "/api/waitlist", { method: "PUT", cookie: waiting, ...json({ pack: "scale", note: "<script>x</script>" }) });
    const page = await call(env, "/admin/waitlist", { cookie: boss });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(OUT);
    expect(html).toContain("Let in");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x");
    const form = await call(env, "/admin/waitlist/allow", { method: "POST", cookie: boss, headers: { "content-type": "application/x-www-form-urlencoded" }, body: `entry=${encodeURIComponent(OUT)}` });
    expect(form.status).toBe(303);
    expect((await call(env, "/api/admin/allowed", { cookie: boss }).then((r) => r.json())) as { entry: string }[]).toEqual([expect.objectContaining({ entry: OUT })]);
  });

  it("refuses an entry that is not an email or an account id", async () => {
    const { env, boss } = await gated();
    expect((await call(env, "/api/admin/allowed", { method: "POST", cookie: boss, ...json({ email: "not an email" }) })).status).toBe(400);
  });
});

describe("use counters", () => {
  it("count for each project and month, and members read them", async () => {
    const { env, dir, allowed, waiting, boss } = await gated();
    const owner = (await dir.sessionUser(allowed))!;
    const project = await dir.createProject({ name: "Shop", source: { kind: "empty" }, ownerId: owner.id });
    dir.usageAdd(project.id, "merges", 2);
    dir.usageAdd(project.id, "testRuns");
    dir.usageAdd(project.id, "agentTokens", 1500);
    dir.usageAdd(project.id, "merges", -5);
    expect(dir.usageOf(project.id)).toMatchObject({ merges: 2, testRuns: 1, agentTokens: 1500 });
    expect(dir.usageOf("other")).toMatchObject({ merges: 0, testRuns: 0, agentTokens: 0 });
    const res = await call(env, `/api/projects/${project.id}/usage`, { cookie: allowed });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ merges: 2, testRuns: 1, agentTokens: 1500 });
    // The owner of the deployment reads it too; a person who waits does not.
    expect((await call(env, `/api/projects/${project.id}/usage`, { cookie: boss })).status).toBe(200);
    expect((await call(env, `/api/projects/${project.id}/usage`, { cookie: waiting })).status).toBe(403);
  });
});
