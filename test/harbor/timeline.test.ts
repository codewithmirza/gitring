/**
 * The timeline of a project (GET /api/projects/:p/events): the whole history, oldest first, in pages,
 * read from storage. Two agents work through the real MCP tools, one merges, and the pages must hold every
 * record once, in order, also after the live window in memory is empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeLoader, type NodeLoader } from "../checks/node-loader";
import { World } from "../github/harness";
import { callTool, makeProject } from "../mcp/support";
import { isTimelineCursor, timelineCursor, timelineLimit, TIMELINE_PAGE, TIMELINE_PAGE_MAX, type TimelinePage, type TimelineRecord } from "../../src/core/timeline";

const GREET = 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n';
const GREET_TEST = 'import { test, expect } from "../harness/test.js";\nimport { greet } from "../src/greet.js";\ntest("greets", () => expect(greet("Robin")).toBe("Hello, Robin!"));\n';
const SHOUT = 'import { greet } from "./greet.js";\nexport function shout(name) {\n  return greet(name).toUpperCase();\n}\n';
const SHOUT_TEST = 'import { test, expect } from "../harness/test.js";\nimport { shout } from "../src/shout.js";\ntest("shouts", () => expect(shout("Robin")).toBe("HELLO, ROBIN!"));\n';

let world: World;
let loader: NodeLoader;
let key: string;
let session: string;
let project: string;

const gr = (name: string, args: Record<string, unknown>) => callTool(world, key, name, { project, ...args });

async function page(after?: string | null, limit?: number, as: { key?: string } = { key }): Promise<{ status: number; body: TimelinePage & { error?: string } }> {
  const q = new URLSearchParams();
  if (after) q.set("after", after);
  if (limit) q.set("limit", String(limit));
  const res = await world.call("GET", `/api/projects/${project}/events${q.size ? `?${q}` : ""}`, as);
  return { status: res.status, body: res.json };
}

/** Every page, `limit` records at a time. */
async function all(limit: number): Promise<{ records: TimelineRecord[]; pages: TimelinePage[] }> {
  const pages: TimelinePage[] = [];
  const records: TimelineRecord[] = [];
  let after: string | null = null;
  for (let i = 0; i < 500; i++) {
    const res = await page(after, limit);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    pages.push(res.body);
    records.push(...res.body.records);
    if (res.body.done) break;
    after = res.body.next;
  }
  return { records, pages };
}

/** Two agents on one file; the first one merges. */
async function story(): Promise<{ first: string; second: string }> {
  const a = await gr("gitring_declare", {
    agent: { id: "robin-a", client: "test" },
    newIntent: { title: "Shout", goal: "A shout function exists." },
    plan: ["Add shout"],
    files: ["src/shout.js", "tests/shout.test.js"],
    symbols: ["src/shout.js#shout"],
    approach: "New file.",
  });
  const first = /work copy (a_\w+)/.exec(a.text)?.[1] ?? "";
  expect(first, a.text).not.toBe("");
  const wrote = await gr("gitring_write", { attemptId: first, files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }], message: "Add shout." });
  expect(wrote.isError, wrote.text).toBe(false);
  const b = await gr("gitring_declare", {
    agent: { id: "robin-b", client: "test" },
    newIntent: { title: "Whisper", goal: "shout has a quiet twin." },
    plan: ["Change shout"],
    files: ["src/shout.js"],
    symbols: ["src/shout.js#shout"],
    approach: "Edit the same function.",
  });
  const second = /work copy (a_\w+)/.exec(b.text)?.[1] ?? "";
  expect(second, b.text).not.toBe("");
  const sub = await gr("gitring_submit", { attemptId: first, summary: "Add shout" });
  expect(sub.isError, sub.text).toBe(false);
  await world.settle();
  return { first, second };
}

beforeEach(async () => {
  world = new World();
  loader = nodeLoader();
  vi.stubGlobal("fetch", world.fetch);
  await world.init({ LOADER: loader });
  world.person("alice", 1);
  ({ key, session } = await world.signIn("alice"));
  project = await makeProject(world, key, "shop", { checks: { runner: "worker" } });
  await world.land(project, "src/greet.js", GREET);
  await world.land(project, "tests/greet.test.js", GREET_TEST);
  const set = await world.call("PUT", `/api/projects/${project}/settings`, { headers: { cookie: `__Host-gitring=${session}` }, body: { landing: "automatic" } });
  expect(set.status, set.text).toBe(200);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await world.settle();
  await loader.cleanup();
});

describe("cursors", () => {
  it("compare as text in time order, then kind, then id", () => {
    const a = timelineCursor(1000, "landing", "ld_1");
    const b = timelineCursor(1001, "intent", "i_1");
    const c = timelineCursor(1000, "intent", "i_9");
    expect([a, b, c].sort()).toEqual([c, a, b]);
    expect(isTimelineCursor(a)).toBe(true);
    expect(isTimelineCursor("1000.0.x")).toBe(false);
    expect(isTimelineCursor(`${a}'; DROP TABLE logs`)).toBe(false);
    // An id with other characters gets a stable hash, so the cursor stays valid.
    expect(isTimelineCursor(timelineCursor(5, "attempt", "old id/with.dots"))).toBe(true);
    expect(timelineCursor(5, "attempt", "old id/with.dots")).toBe(timelineCursor(5, "attempt", "old id/with.dots"));
  });

  it("keeps page sizes inside the limits", () => {
    expect(timelineLimit(undefined)).toBe(TIMELINE_PAGE);
    expect(timelineLimit("0")).toBe(TIMELINE_PAGE);
    expect(timelineLimit("7")).toBe(7);
    expect(timelineLimit(10 ** 9)).toBe(TIMELINE_PAGE_MAX);
  });
});

describe("GET /api/projects/:p/events", () => {
  it("has every record once, in order, across small pages", async () => {
    const { first, second } = await story();
    const big = await all(2000);
    const small = await all(3);
    expect(big.pages).toHaveLength(1);
    expect(small.pages.length).toBeGreaterThan(5);
    for (const p of small.pages) expect(p.records.length).toBeLessThanOrEqual(3);
    // Strict order, no record twice, and the same records as one big page.
    const cursors = small.records.map((r) => r.cursor);
    expect(cursors).toEqual([...cursors].sort());
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(cursors).toEqual(big.records.map((r) => r.cursor));
    expect(small.pages[small.pages.length - 1].done).toBe(true);

    const kinds = new Set(small.records.map((r) => r.kind));
    for (const k of ["intent", "attempt", "log", "check", "landing"]) expect(kinds, k).toContain(k);
    const attempts = small.records.filter((r): r is Extract<TimelineRecord, { kind: "attempt" }> => r.kind === "attempt").map((r) => r.attempt.id);
    expect(attempts).toEqual(expect.arrayContaining([first, second]));
    const landing = small.records.find((r): r is Extract<TimelineRecord, { kind: "landing" }> => r.kind === "landing")!;
    expect(landing.landing.attemptId).toBe(first);
    expect(landing.landing.checks.scope).toBe("composed");
    // Test runs alone and on main plus the work are both in the history.
    const testLogs = small.records.filter((r) => r.kind === "log" && r.log.kind === "check" && r.log.data?.checkRunId);
    expect(testLogs.length).toBeGreaterThan(0);
    // Each page names every agent.
    expect(small.pages[0].agents.map((g) => g.id)).toEqual(expect.arrayContaining(["robin-a", "robin-b"]));
  });

  it("leaves out large and raw parts: test sources, raw model answers, container output", async () => {
    await story();
    const { records } = await all(500);
    for (const r of records) {
      if (r.kind === "intent") for (const c of r.intent.checks) expect(c).not.toHaveProperty("content");
      if (r.kind === "check") expect(r.check).not.toHaveProperty("raw");
      if (r.kind === "landing") expect(r.landing.checks).not.toHaveProperty("log");
      if (r.kind === "attempt") {
        expect(r.attempt.checks ?? {}).not.toHaveProperty("log");
        expect(r.attempt.composedChecks ?? {}).not.toHaveProperty("log");
      }
    }
  });

  it("reads the log and the checks from storage, not only from the live window", async () => {
    await story();
    const before = await all(50);
    const h = world.harbor(project) as unknown as { logs: unknown[]; checks: unknown[] };
    h.logs = [];
    h.checks = [];
    const after = await all(50);
    expect(after.records.map((r) => r.cursor)).toEqual(before.records.map((r) => r.cursor));
    expect(after.records.filter((r) => r.kind === "log").length).toBeGreaterThan(5);
    // The live state has lost them; the timeline still has them.
    const st = await world.call("GET", `/api/projects/${project}/state`, { key });
    expect(st.json.logs).toEqual([]);
  });

  it("answers an empty page that is done after the last cursor", async () => {
    await story();
    const { records } = await all(500);
    const last = records[records.length - 1].cursor;
    const res = await page(last);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ records: [], next: null, done: true });
  });

  it("refuses a cursor that gitring did not make", async () => {
    const res = await page("not-a-cursor");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/);
  });

  it("is for people who may see the project", async () => {
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    const res = await page(null, undefined, { key: bob.key });
    expect(res.status).toBe(404);
    const anon = await page(null, undefined, {});
    expect(anon.status).toBe(401);
  });
});
