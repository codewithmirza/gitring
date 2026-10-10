/**
 * Directory: sign-in flows (GitHub App manifest + OAuth, Google OIDC with PKCE), sessions, API keys,
 * roles, invites, GitHub issue routing and the AI budget. The Durable Object runs on node:sqlite;
 * provider HTTP calls are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Directory } from "../../src/directory/directory";
import type { Env } from "../../src/worker/env";
import { sqliteCtx } from "../support/sqlite-storage";

const ORIGIN = "https://gitring.example.workers.dev";

type Fake = { status?: number; json: unknown };
let routes: Record<string, Fake | ((init?: RequestInit) => Fake)> = {};
const calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  routes = {};
  calls.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: "not stubbed" }), { status: 599 });
    const r = routes[key];
    const f = typeof r === "function" ? r(init) : r;
    return new Response(JSON.stringify(f.json), { status: f.status ?? 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => vi.unstubAllGlobals());

function make(env: Partial<Env> = {}) {
  const ctx = sqliteCtx();
  const dir = new Directory(ctx as never, { GITRING_SECRET: "test-secret-0123456789abcdef", ...env } as Env);
  return dir;
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get("state")!;
}

async function withGithubApp(dir: Directory) {
  routes["https://api.github.com/app-manifests/"] = {
    json: { id: 42, slug: "gitring-test", client_id: "Iv1.abc", client_secret: "shh", webhook_secret: "whsec", pem: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", html_url: "https://github.com/apps/gitring-test", owner: { login: "robin" } },
  };
  const m = await dir.githubManifest(ORIGIN);
  await dir.githubManifestDone("code-1", stateOf(m.postUrl));
}

async function githubSignIn(dir: Directory, user: { id: number; login: string; name?: string; email?: string | null }, returnTo = "/") {
  routes["https://github.com/login/oauth/access_token"] = { json: { access_token: `gho_${user.login}`, expires_in: 28800, refresh_token: "ghr_x" } };
  routes["https://api.github.com/user"] = { json: { id: user.id, login: user.login, name: user.name ?? null, email: user.email ?? null, avatar_url: "https://avatars.example/x" } };
  const url = await dir.signInUrl("github", ORIGIN, returnTo);
  return dir.finishSignIn("github", "code", stateOf(url));
}

async function googleSignIn(dir: Directory, p: { sub: string; email: string; verified?: boolean; name?: string }) {
  routes["https://oauth2.googleapis.com/token"] = { json: { access_token: "ya29.x" } };
  routes["https://openidconnect.googleapis.com/v1/userinfo"] = { json: { sub: p.sub, email: p.email, email_verified: p.verified ?? true, name: p.name ?? "G User" } };
  const url = await dir.signInUrl("google", ORIGIN, "/");
  return dir.finishSignIn("google", "code", stateOf(url));
}

describe("GitHub App setup and sign-in", () => {
  it("creates the app from a manifest with gitring's URLs and seals the credentials", async () => {
    const dir = make();
    const m = await dir.githubManifest(ORIGIN);
    const manifest = JSON.parse(m.manifest);
    expect(m.postUrl).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    expect(manifest.callback_urls).toEqual([`${ORIGIN}/auth/github/callback`]);
    expect(manifest.redirect_url).toBe(`${ORIGIN}/setup/github/callback`);
    expect(manifest.hook_attributes.url).toBe(`${ORIGIN}/hooks/github-app`);
    expect(manifest.default_events).toEqual(["issues", "push"]);
    expect(manifest.default_permissions).toEqual({ contents: "write", pull_requests: "write", issues: "read", metadata: "read" });
    expect((await dir.providers()).github).toBeNull();

    routes["https://api.github.com/app-manifests/"] = { json: { id: 7, slug: "gitring-x", client_id: "Iv1.c", client_secret: "s", webhook_secret: "w", pem: "p", html_url: "https://github.com/apps/gitring-x" } };
    await dir.githubManifestDone("abc", stateOf(m.postUrl));
    expect(calls.at(-1)!.url).toBe("https://api.github.com/app-manifests/abc/conversions");
    const providers = await dir.providers();
    expect(providers.github).toEqual({ slug: "gitring-x", appId: 7, htmlUrl: "https://github.com/apps/gitring-x", installUrl: "https://github.com/apps/gitring-x/installations/new", webhook: true });
    // A state works once.
    await expect(dir.githubManifestDone("abc", stateOf(m.postUrl))).rejects.toThrow(/expired or was used/);
  });

  it("makes an app without a webhook for a local dev server (GitHub cannot reach localhost)", async () => {
    const dir = make();
    const m = await dir.githubManifest("http://localhost:5173");
    const local = JSON.parse(m.manifest);
    expect(local.name).toBe("git-ring localhost");
    expect(local.callback_urls).toEqual(["http://localhost:5173/auth/github/callback"]);
    expect(local.hook_attributes).toBeUndefined();
    expect(local.default_events).toBeUndefined();
    routes["https://api.github.com/app-manifests/"] = {
      json: { id: 8, slug: "git-ring-localhost", client_id: "Iv1.l", client_secret: "s", webhook_secret: null, pem: "p", html_url: "https://github.com/apps/git-ring-localhost" },
    };
    await dir.githubManifestDone("loc", stateOf(m.postUrl));
    // No webhook secret: the webhook route refuses every delivery for this app.
    expect((await dir.githubApp())?.webhookSecret).toBe("");
    expect((await dir.providers()).github?.slug).toBe("git-ring-localhost");
  });

  it("lets the browser convert the code when GitHub refuses the Worker (429), and checks the key", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const dir = make();
    const m = await dir.githubManifest(ORIGIN);
    const state = stateOf(m.postUrl);
    routes["https://api.github.com/app-manifests/"] = { status: 429, json: { message: "rate limited" } };
    expect(await dir.githubManifestDone("code-x", state)).toEqual({ browser: true });

    const app = { id: 99, slug: "gitring-x", client_id: "Iv1.z", client_secret: "s", webhook_secret: "w", pem, html_url: "https://github.com/apps/gitring-x" };
    // A key of another app is refused.
    routes["https://api.github.com/app"] = { json: { id: 7, slug: "other" } };
    await expect(dir.githubAppSave(state, app)).rejects.toThrow(/another app/);
    // The state is used up by a save attempt: start again from the setup page.
    const m2 = await dir.githubManifest(ORIGIN);
    routes["https://api.github.com/app"] = (init) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return auth.startsWith("Bearer ey") ? { json: { id: 99, slug: "gitring-x" } } : { status: 401, json: {} };
    };
    expect(await dir.githubAppSave(stateOf(m2.postUrl), app)).toEqual({ slug: "gitring-x", htmlUrl: "https://github.com/apps/gitring-x" });
    expect((await dir.providers()).github?.slug).toBe("gitring-x");
    await expect(dir.githubAppSave(stateOf(m2.postUrl), app)).rejects.toThrow(/expired or was used/);
  });

  it("signs in with GitHub, opens a session and ends it", async () => {
    const dir = make();
    await expect(dir.signInUrl("github", ORIGIN, "/")).rejects.toThrow(/not set up/);
    await withGithubApp(dir);
    const url = await dir.signInUrl("github", ORIGIN, "/intents");
    expect(url).toContain("client_id=Iv1.abc");
    expect(url).toContain(encodeURIComponent(`${ORIGIN}/auth/github/callback`));
    const res = await githubSignIn(dir, { id: 1, login: "Robin", name: "Robin Q" }, "/intents");
    expect(res.returnTo).toBe("/intents");
    expect(res.user.name).toBe("Robin Q");
    expect(res.user.identities).toEqual([{ provider: "github", login: "Robin", email: undefined }]);
    expect((await dir.sessionUser(res.token))?.id).toBe(res.user.id);
    // The privacy page says it: gitring keeps no provider access tokens.
    const rows = (dir as unknown as { sql: { exec(q: string): { toArray(): { token: string | null }[] } } }).sql.exec("SELECT token FROM identities").toArray();
    expect(rows).toEqual([{ token: null }]);
    await dir.endSession(res.token);
    expect(await dir.sessionUser(res.token)).toBeNull();
  });

  it("keeps only same-site return paths", async () => {
    const dir = make();
    await withGithubApp(dir);
    for (const bad of ["//evil.example/x", "https://evil.example/", "/\\evil"]) {
      const res = await githubSignIn(dir, { id: 2, login: "sam" }, bad);
      expect(res.returnTo).toBe("/");
    }
  });

  it("refuses a sign-in whose state belongs to the other provider", async () => {
    const dir = make();
    await withGithubApp(dir);
    const url = await dir.signInUrl("github", ORIGIN, "/");
    await expect(dir.finishSignIn("google", "code", stateOf(url))).rejects.toThrow(/does not match/);
  });
});

describe("Google sign-in", () => {
  it("uses PKCE, needs a verified email and links accounts by that email", async () => {
    const dir = make();
    await expect(dir.setGoogle({ clientId: "nope", clientSecret: "x".repeat(12) })).rejects.toThrow(/apps\.googleusercontent\.com/);
    await dir.setGoogle({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" });
    const url = new URL(await dir.signInUrl("google", ORIGIN, "/"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("scope")).toBe("openid email profile");

    await expect(googleSignIn(dir, { sub: "g-0", email: "nobody@example.com", verified: false })).rejects.toThrow(/did not confirm/);

    const g = await googleSignIn(dir, { sub: "g-1", email: "Ada@Example.com", name: "Ada" });
    expect(g.user.email).toBe("ada@example.com");
    // The token request carries the PKCE verifier.
    const tokenCall = calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
    expect(String(tokenCall.init?.body)).toContain("code_verifier=");

    await withGithubApp(dir);
    const gh = await githubSignIn(dir, { id: 9, login: "ada-l", email: "ada@example.com" });
    expect(gh.user.id).toBe(g.user.id);
    expect(gh.user.identities.map((i) => i.provider).sort()).toEqual(["github", "google"]);
  });
});

describe("API keys", () => {
  it("creates, resolves and revokes a key; stores only a hash", async () => {
    const dir = make();
    await withGithubApp(dir);
    const { user } = await githubSignIn(dir, { id: 3, login: "kim" });
    const { key, info } = await dir.createKey(user.id, "claude code");
    expect(key).toMatch(/^gk_[A-Za-z0-9_-]{40}$/);
    expect(info.prefix).toBe(key.slice(0, 10));
    expect((await dir.keyUser(key))?.id).toBe(user.id);
    expect(await dir.keyUser("gk_wrong")).toBeNull();
    expect((await dir.listKeys(user.id)).map((k) => k.name)).toEqual(["claude code"]);
    const raw = JSON.stringify((dir as unknown as { sql: { exec(q: string): { toArray(): unknown[] } } }).sql.exec("SELECT * FROM api_keys").toArray());
    expect(raw).not.toContain(key);
    expect(await dir.revokeKey("someone-else", info.id)).toBe(false);
    expect(await dir.revokeKey(user.id, info.id)).toBe(true);
    expect(await dir.keyUser(key)).toBeNull();
  });
});

describe("projects and roles", () => {
  it("shows the public sample to everyone and private projects only to members", async () => {
    const dir = make();
    await withGithubApp(dir);
    expect(await dir.role("demo", null)).toBe("viewer");
    const { user: robin } = await githubSignIn(dir, { id: 10, login: "robin" });
    const { user: sam } = await githubSignIn(dir, { id: 11, login: "sam" });
    const p = await dir.createProject({ name: "Shop!", source: { kind: "empty" }, ownerId: robin.id });
    expect(p.id).toMatch(/^shop-[a-z0-9]{4}$/);
    expect(p.visibility).toBe("private");
    expect(p.role).toBe("owner");
    expect(await dir.role(p.id, sam.id)).toBeNull();
    expect(await dir.role(p.id, null)).toBeNull();
    expect((await dir.listProjects(sam.id)).map((x) => x.id)).toEqual(["demo"]);

    await dir.updateProject(p.id, { visibility: "public" });
    expect(await dir.role(p.id, sam.id)).toBe("viewer");
    expect(await dir.role(p.id, null)).toBe("viewer");

    await dir.archiveProject(p.id);
    expect(await dir.role(p.id, robin.id)).toBeNull();
    await expect(dir.archiveProject("demo")).rejects.toThrow(/cannot be archived/);
  });

  it("turns an invite by GitHub login or email into a membership at sign-in", async () => {
    const dir = make();
    await withGithubApp(dir);
    const { user: robin } = await githubSignIn(dir, { id: 20, login: "robin" });
    const p = await dir.createProject({ name: "Shop", source: { kind: "empty" }, ownerId: robin.id });
    let members = await dir.addMember(p.id, "@Sam", "member");
    expect(members.find((m) => m.handle === "sam")).toMatchObject({ role: "member", pending: true });
    await dir.addMember(p.id, "lee@example.com", "viewer");
    await expect(dir.addMember(p.id, "not a login!", "member")).rejects.toThrow(/not a GitHub login/);
    await expect(dir.addMember(p.id, "sam", "admin" as never)).rejects.toThrow(/owner, member or viewer/);

    const { user: sam } = await githubSignIn(dir, { id: 21, login: "sam" });
    expect(await dir.role(p.id, sam.id)).toBe("member");
    await dir.setGoogle({ clientId: "1-x.apps.googleusercontent.com", clientSecret: "GOCSPX-abcdef" });
    const { user: lee } = await googleSignIn(dir, { sub: "g-lee", email: "lee@example.com" });
    expect(await dir.role(p.id, lee.id)).toBe("viewer");

    members = await dir.members(p.id);
    expect(members.every((m) => !m.pending)).toBe(true);
    await expect(dir.removeMember(p.id, robin.id)).rejects.toThrow(/at least one owner/);
    members = await dir.removeMember(p.id, "sam");
    expect(members.some((m) => m.userId === sam.id)).toBe(false);
    expect(await dir.role(p.id, sam.id)).toBeNull();
  });

  it("gives deployment owners (GITRING_OWNERS) the owner role everywhere", async () => {
    const dir = make({ GITRING_OWNERS: "github:Boss, google:admin@example.com" });
    await withGithubApp(dir);
    const { user: robin } = await githubSignIn(dir, { id: 30, login: "robin" });
    const { user: boss } = await githubSignIn(dir, { id: 31, login: "boss" });
    expect(boss.admin).toBe(true);
    expect(robin.admin).toBe(false);
    const p = await dir.createProject({ name: "Private thing", source: { kind: "empty" }, ownerId: robin.id });
    expect(await dir.role(p.id, boss.id)).toBe("owner");
  });

  it("lets the operator key make projects that no person owns", async () => {
    const dir = make({ GITRING_OWNERS: "github:boss" });
    await withGithubApp(dir);
    const p = await dir.createProject({ name: "Scenario run", source: { kind: "sample" }, ownerId: null });
    expect(p.role).toBe("owner");
    expect(p.ownerName).toBe("gitring");
    const { user: robin } = await githubSignIn(dir, { id: 60, login: "robin" });
    const { user: boss } = await githubSignIn(dir, { id: 61, login: "boss" });
    expect(await dir.role(p.id, robin.id)).toBeNull();
    expect(await dir.role(p.id, boss.id)).toBe("owner");
  });

  it("caps projects per person", async () => {
    const dir = make();
    await withGithubApp(dir);
    const { user } = await githubSignIn(dir, { id: 40, login: "maker" });
    for (let i = 0; i < 20; i++) await dir.createProject({ name: `p${i}`, source: { kind: "empty" }, ownerId: user.id });
    await expect(dir.createProject({ name: "one more", source: { kind: "empty" }, ownerId: user.id })).rejects.toThrow(/20 projects/);
  });
});

describe("GitHub issue routing", () => {
  it("opens intents only in projects where the sender may act", async () => {
    const dir = make();
    await withGithubApp(dir);
    const { user: robin } = await githubSignIn(dir, { id: 50, login: "robin" });
    const { user: other } = await githubSignIn(dir, { id: 51, login: "other" });
    const src = { kind: "git" as const, url: "https://github.com/acme/shop", host: "github" as const };
    const mine = await dir.createProject({ name: "Shop", source: src, ownerId: robin.id });
    const theirs = await dir.createProject({ name: "Shop fork", source: { ...src, url: "https://github.com/Acme/Shop.git" }, ownerId: other.id });
    await dir.addMember(mine.id, "pat", "member");
    await dir.addMember(mine.id, "vic", "viewer");

    expect(await dir.projectsForGithubLogin("https://github.com/acme/shop", "Robin")).toEqual([mine.id]);
    expect(await dir.projectsForGithubLogin("https://github.com/acme/shop", "other")).toEqual([theirs.id]);
    expect(await dir.projectsForGithubLogin("https://github.com/acme/shop", "pat")).toEqual([mine.id]);
    expect(await dir.projectsForGithubLogin("https://github.com/acme/shop", "vic")).toEqual([]);
    expect(await dir.projectsForGithubLogin("https://github.com/acme/shop", "mallory")).toEqual([]);
    expect(await dir.projectsForGithubLogin("https://github.com/acme/other", "robin")).toEqual([]);
  });
});

describe("AI budget", () => {
  it("takes from a per-person window and a global window", async () => {
    const dir = make();
    let r = await dir.budgetTake("u_a", 2, 2, 3);
    expect(r.granted).toBe(2);
    r = await dir.budgetTake("u_a", 1, 2, 3);
    expect(r.granted).toBe(0);
    expect(r.retryAt).toBeGreaterThan(Date.now() + 3_500_000);
    r = await dir.budgetTake("u_b", 2, 2, 3);
    expect(r.granted).toBe(1);
    r = await dir.budgetTake(null, 1, 2, 3);
    expect(r.granted).toBe(0);
  });

  it("keeps the check-run pool apart from the AI pool", async () => {
    const dir = make();
    expect((await dir.budgetTake("u_a", 2, 2, 2, "checks")).granted).toBe(2);
    expect((await dir.budgetTake("u_a", 1, 2, 2, "checks")).granted).toBe(0);
    expect((await dir.budgetTake("u_a", 2, 2, 2)).granted).toBe(2);
  });

  it("frees slots after an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
      const dir = make();
      expect((await dir.budgetTake("u_a", 3, 3, 10)).granted).toBe(3);
      expect((await dir.budgetTake("u_a", 1, 3, 10)).granted).toBe(0);
      vi.setSystemTime(new Date("2026-10-09T11:00:01Z"));
      expect((await dir.budgetTake("u_a", 2, 3, 10)).granted).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
