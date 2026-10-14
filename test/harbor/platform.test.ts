/**
 * Platform rules of the project object, on the real Worker routes and the real HarborMaster (world.ts):
 * the agent models (GLM 5.3), the size of the brief per model, signed webhooks, the git command of
 * gitring_update, and the id prefix of check runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetWait, containerRun, gitPullCommand } from "../../src/harbor/harbor";
import { hmacSha256Hex, unseal } from "../../src/directory/crypto";
import { SECRET_SEAL, secretHint } from "../../src/harbor/webhooks";
import { DEFAULT_SETTINGS } from "../../src/core/types";
import { World } from "./world";
import { steViolations } from "../coord/ste";

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

async function newWorld(env: Record<string, unknown> = {}) {
  const world = new World();
  worlds.push(world);
  await world.init({ env });
  const { key } = await world.signIn("robin", 1);
  return { world, key };
}

const CHECK = { path: "tests/robin.test.js", content: 'import "../src/a.js";\n', description: "Robin's test" };

describe("agent models", () => {
  it("a new project uses GLM 5.3 Flash and GLM 5.3", async () => {
    const { world, key } = await newWorld();
    const p = await world.createProject(key, "books", { "src/a.js": "export const a = 1;\n" });
    expect((await world.harbor(p.id).state()).project.settings.agentModels).toEqual(DEFAULT_SETTINGS.agentModels);
  });

  it("a project whose models left the deployment starts its agents on the models of the deployment", async () => {
    const started: { model: string }[] = [];
    const vessels = { idFromName: (n: string) => n, get: () => ({ start: async (c: { model: string }) => void started.push(c), stop: async () => undefined }) };
    const { world, key } = await newWorld({ VESSEL: vessels });
    const p = await world.createProject(key, "books", { "src/a.js": "export const a = 1;\n" });
    const task = await world.addTask(key, p.id, { title: "Show prices", goal: "Show the price of each book.", checks: [CHECK] });
    const h = world.harbor(p.id);
    // Settings from before the deployment moved to GLM 5.3.
    (h as unknown as { project: { settings: { agentModels: string[] } } }).project.settings.agentModels = ["@cf/moonshotai/kimi-k2.7-code"];
    await h.launch(task, { fanout: 1 });
    expect(started.map((s) => s.model)).toEqual(["@cf/zai-org/glm-5.3-flash"]);
  });
});

describe("the brief of a built-in agent", () => {
  it("holds far more file text for a model with a 1M-token context", async () => {
    const { world, key } = await newWorld();
    const files: Record<string, string> = { "src/big.js": `// ${"b".repeat(50_000)}\n` };
    for (let i = 1; i <= 5; i++) files[`src/part${i}.js`] = `// ${"p".repeat(18_000)}\n`;
    const p = await world.createProject(key, "books", files);
    const task = await world.addTask(key, p.id, { title: "Show prices", goal: "Show the price of each book.", checks: [CHECK] });
    const h = world.harbor(p.id);
    const small = await h.brief(undefined, task, { model: "@cf/moonshotai/kimi-k2.7-code" });
    const large = await h.brief(undefined, task, { model: "@cf/zai-org/glm-5.3-flash" });
    const chars = (ctx: Record<string, string>) => Object.values(ctx).reduce((n, t) => n + t.length, 0);
    // The old budget: at most 60,000 characters, no file over 20,000.
    expect(chars(small.context)).toBeLessThanOrEqual(60_000);
    expect(Object.keys(small.context)).not.toContain("src/big.js");
    expect(Object.keys(small.context).filter((f) => f.startsWith("src/part"))).toHaveLength(3);
    // GLM 5.3: every file of this project.
    expect(Object.keys(large.context).sort()).toEqual(["src/big.js", "src/part1.js", "src/part2.js", "src/part3.js", "src/part4.js", "src/part5.js"]);
    // Without a model, the old budget.
    expect(Object.keys((await h.brief(undefined, task)).context)).toEqual(Object.keys(small.context));
  });
});

describe("outbound webhooks", () => {
  /** Requests to the webhook host; other requests go to the world (the GitHub sign-in). */
  function catchHooks() {
    const got: { url: string; headers: Headers; body: string }[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://hooks.robin.dev/")) return inner(input, init);
      got.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response("ok");
    }) as typeof fetch;
    return got;
  }

  const hook = { id: "wh_robin", url: "https://hooks.robin.dev/gitring", events: ["intent"], format: "json", enabled: true };

  async function verify(secret: string, req: { headers: Headers; body: string }) {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers.get("gitring-signature") ?? "");
    expect(m).not.toBeNull();
    expect(m![2]).toBe(await hmacSha256Hex(secret, `${m![1]}.${req.body}`));
  }

  it("makes a secret per webhook, shows it once, keeps it out of the settings, and signs each request", async () => {
    const { world, key } = await newWorld();
    const p = await world.createProject(key, "books", { "src/a.js": "export const a = 1;\n" });
    const got = catchHooks();

    const put = await world.call("PUT", `/api/projects/${p.id}/settings`, { key, body: { webhooks: [hook] } });
    expect(put.status).toBe(200);
    const secret = put.json.webhookSecrets.wh_robin as string;
    expect(secret).toMatch(/^whsec_/);
    expect(put.json.webhooks[0].secretHint).toBe(`${secret.slice(0, 10)}…`);
    // Only that answer holds the secret: not the settings, not the live state of the project.
    const read = await world.call("GET", `/api/projects/${p.id}/settings`, { key });
    expect(read.text).not.toContain(secret);
    expect(read.json.webhooks[0].secretHint).toBe(put.json.webhooks[0].secretHint);
    expect(JSON.stringify(await world.harbor(p.id).state())).not.toContain(secret);

    await world.addTask(key, p.id, { title: "Show prices", goal: "Show the price of each book.", checks: [CHECK] });
    await world.settle();
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0].body).event).toBe("intent");
    await verify(secret, got[0]);

    // A save of the same list keeps the secret (and a hint from the client changes nothing).
    const again = await world.call("PUT", `/api/projects/${p.id}/settings`, { key, body: { webhooks: [{ ...read.json.webhooks[0], secretHint: "whsec_robin…" }] } });
    expect(again.json.webhookSecrets).toBeUndefined();
    expect(again.json.webhooks[0].secretHint).toBe(put.json.webhooks[0].secretHint);

    // "Make a new secret": the old one stops.
    const fresh = await world.call("PUT", `/api/projects/${p.id}/settings`, { key, body: { webhooks: [{ ...hook, newSecret: true }] } });
    const secret2 = fresh.json.webhookSecrets.wh_robin as string;
    expect(secret2).not.toBe(secret);
    await world.addTask(key, p.id, { title: "Show covers", goal: "Show the cover of each book.", checks: [CHECK] });
    await world.settle();
    await verify(secret2, got[1]);

    // A new URL gets a new secret too.
    const moved = await world.call("PUT", `/api/projects/${p.id}/settings`, { key, body: { webhooks: [{ ...hook, url: "https://hooks.robin.dev/other" }] } });
    expect(moved.json.webhookSecrets.wh_robin).toMatch(/^whsec_/);

    // A removed webhook takes its secret with it.
    await world.call("PUT", `/api/projects/${p.id}/settings`, { key, body: { webhooks: [] } });
    expect((world.harbor(p.id) as unknown as { db: { getMeta(k: string): unknown } }).db.getMeta("webhookSecrets")).toBeUndefined();
  });

  it("sends a webhook from before signatures without a signature, until the owner makes a secret", async () => {
    const { world, key } = await newWorld();
    const p = await world.createProject(key, "books", { "src/a.js": "export const a = 1;\n" });
    const got = catchHooks();
    const h = world.harbor(p.id) as unknown as { project: { settings: { webhooks: unknown[] } } };
    h.project.settings.webhooks = [hook];
    await world.addTask(key, p.id, { title: "Show prices", goal: "Show the price of each book.", checks: [CHECK] });
    await world.settle();
    expect(got[0].headers.get("gitring-signature")).toBeNull();
    const same = await world.call("PUT", `/api/projects/${p.id}/settings`, { key, body: { webhooks: [hook] } });
    expect(same.json.webhookSecrets).toBeUndefined();
    expect(same.json.webhooks[0].secretHint).toBeUndefined();
  });

  it("keeps the hint and the stored secret together when two changes of the webhooks come at the same time", async () => {
    const { world, key } = await newWorld();
    const p = await world.createProject(key, "books", { "src/a.js": "export const a = 1;\n" });
    const h = world.harbor(p.id);
    const first = await h.updateSettings({ webhooks: [hook] } as never);
    const robinHook = first.webhooks[0];
    // The first seal of change A waits; change B runs to its end in that time.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hold = true;
    const subtle = crypto.subtle;
    const real = subtle.encrypt.bind(subtle);
    const spy = vi.spyOn(subtle, "encrypt").mockImplementation(async (...args: Parameters<SubtleCrypto["encrypt"]>) => {
      if (hold) {
        hold = false;
        await held;
      }
      return real(...args);
    });
    try {
      const a = h.updateSettings({ webhooks: [robinHook, { ...hook, id: "wh_two", url: "https://hooks.robin.dev/two" }] } as never);
      await new Promise((r) => setTimeout(r, 5));
      const b = await h.updateSettings({ webhooks: [{ ...robinHook, newSecret: true }] } as never);
      expect(b.webhookSecrets?.wh_robin).toMatch(/^whsec_/);
      release();
      const done = await a;
      // Change A came last: it keeps the secret of change B for wh_robin, with its hint, and makes one for wh_two.
      expect(Object.keys(done.webhookSecrets ?? {})).toEqual(["wh_two"]);
      const stored = (h as unknown as { db: { getMeta(k: string): Record<string, string> } }).db.getMeta("webhookSecrets");
      const secret = await unseal<string>("concurrency-secret-0123456789abcdef", stored.wh_robin, SECRET_SEAL);
      expect(secret).toBe(b.webhookSecrets!.wh_robin);
      expect(done.webhooks.find((w) => w.id === "wh_robin")!.secretHint).toBe(secretHint(secret));
    } finally {
      spy.mockRestore();
      release();
    }
  });

  it("gives each webhook its own id", async () => {
    const { world, key } = await newWorld();
    const p = await world.createProject(key, "books", { "src/a.js": "export const a = 1;\n" });
    const put = await world.call("PUT", `/api/projects/${p.id}/settings`, { key, body: { webhooks: [hook, { ...hook, url: "https://hooks.robin.dev/two" }] } });
    const ids = put.json.webhooks.map((w: { id: string }) => w.id);
    expect(new Set(ids).size).toBe(2);
    expect(Object.keys(put.json.webhookSecrets).sort()).toEqual([...ids].sort());
  });
});

describe("gitring_update in git mode", () => {
  it("puts the token in a header, not in the remote URL", async () => {
    const { world, key } = await newWorld();
    const p = await world.createProject(key, "books", { "src/a.js": "export const a = 1;\n" });
    const task = await world.addTask(key, p.id, { title: "Show prices", goal: "Show the price of each book.", checks: [CHECK] });
    const backend = world.backend as unknown as Record<string, unknown>;
    backend.createToken = async () => ({ token: "art_robin_secret?expires=1999999999", expiresAt: Date.now() + 6 * 3600_000 });
    backend.remoteUrl = async (repo: string) => `https://artifacts.robin.dev/git/${repo}.git`;
    const d = await world.tool(key, "gitring_declare", { project: p.id, intentId: task, plan: ["Change a.js"], files: ["src/a.js"], approach: "Show prices.", mode: "git" });
    expect(d.ok).toBe(true);
    const res = await world.harbor(p.id).update(d.json.attemptId);
    expect(res.mode).toBe("git");
    if (res.mode !== "git") return;
    const pull = res.commands[0];
    expect(pull).toBe(`git -c http.extraHeader="Authorization: Basic ${btoa("x:art_robin_secret")}" pull --no-rebase ${res.remote} main`);
    expect(pull).not.toContain("art_robin_secret");
    expect(pull).not.toMatch(/https:\/\/[^ ]*@/);
    expect(res.message).toContain("lasts 6 hours");
    expect(steViolations(res.message)).toEqual([]);
    expect(gitPullCommand("https://r.dev/x.git", "tok", "main")).toBe(`git -c http.extraHeader="Authorization: Basic ${btoa("x:tok")}" pull --no-rebase https://r.dev/x.git main`);
  });
});

describe("check run ids", () => {
  it("start with ck_ (change requests keep cr_)", () => {
    expect(budgetWait("tree", "composed", Date.now() + 60_000).id).toMatch(/^ck_/);
    const run = containerRun({ ok: true, stage: "done", exitCode: 0, installMs: 1, testMs: 1, reused: false, log: "" }, { key: "tree", scope: "composed", cs: { runner: "container" }, ms: 2 });
    expect(run.id).toMatch(/^ck_/);
  });
});
