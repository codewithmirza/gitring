/**
 * The history tools end to end through the real Worker, the real Directory and the real project object:
 * an agent merges work with the gitring tools, then any agent (also at /mcp/readonly) asks why a line is
 * there, sees the changes of a file, finds a text in main and compares two versions. No clone is needed.
 * The REST twins answer the same questions for the web app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeLoader, type NodeLoader } from "../checks/node-loader";
import { steViolations } from "../coord/ste";
import { World } from "../github/harness";
import { callTool, makeProject } from "./support";

const GREET = 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n';
const GREET_TEST = 'import { test, expect } from "../harness/test.js";\nimport { greet } from "../src/greet.js";\ntest("greets", () => expect(greet("Robin")).toBe("Hello, Robin!"));\n';
const SHOUT = 'import { greet } from "./greet.js";\nexport function shout(name) {\n  return greet(name).toUpperCase();\n}\n';
const SHOUT_TEST = 'import { test, expect } from "../harness/test.js";\nimport { shout } from "../src/shout.js";\ntest("shouts", () => expect(shout("Robin")).toBe("HELLO, ROBIN!"));\n';

let world: World;
let loader: NodeLoader;
let key: string;
let session: string;
let project: string;
let seeded: string;

const gr = (name: string, args: Record<string, unknown> = {}, path = "/mcp") => callTool(world, key, name, { project, ...args }, path);
/** The JSON block of an answer (after the first line or the change requests). */
const jsonOf = (t: string) => JSON.parse(t.slice(t.indexOf("\n{") + 1));
const headline = (t: string) => t.split("\n")[0];

/** A work copy with a new file and its test. Answers the work copy id. */
async function work(title: string, files: { path: string; content: string }[]): Promise<string> {
  const plan = await gr("gitring_declare", { newIntent: { title, goal: `${title}.` }, plan: [`Add ${files[0].path}`], files: files.map((f) => f.path), approach: "New file." });
  const id = /work copy (a_\w+)/.exec(plan.text)?.[1] ?? "";
  expect(id, plan.text).not.toBe("");
  const wrote = await gr("gitring_write", { attemptId: id, files });
  expect(wrote.isError, wrote.text).toBe(false);
  return id;
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
  seeded = await world.land(project, "tests/greet.test.js", GREET_TEST);
  // Merges go in when the tests pass (no question for a person in these tests).
  const set = await world.call("PUT", `/api/projects/${project}/settings`, { headers: { cookie: `__Host-gitring=${session}` }, body: { landing: "automatic" } });
  expect(set.status, set.text).toBe(200);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await world.settle();
  await loader.cleanup();
});

describe("history tools", () => {
  it("answers why a line is there with the record of its merge, and the changes of a file", async () => {
    const id = await work("Shout", [
      { path: "src/shout.js", content: SHOUT },
      { path: "tests/shout.test.js", content: SHOUT_TEST },
    ]);
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Shout added." });
    expect(sub.isError, sub.text).toBe(false);
    await world.settle();
    const st = await gr("gitring_status", { attemptId: id });
    expect(st.text, st.text).toMatch(/merged/i);
    // The merge was small: gitring computed its history when it landed, before any question.
    const sql = (world.harbor(project) as unknown as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql;
    expect(sql.exec<{ kind: string; subject: string }>("SELECT kind, subject FROM dd_steps ORDER BY seq").toArray().map((r) => `${r.kind}: ${r.subject}`)).toEqual([
      "root: Start shop",
      "outside: Task src/greet.js",
      "outside: Task tests/greet.test.js",
      "merge: Shout",
    ]);

    const why = await gr("gitring_why", { path: "src/shout.js", line: 3 });
    expect(why.isError, why.text).toBe(false);
    expect(headline(why.text)).toMatch(/^Line 3 of src\/shout\.js on main\. It came from the task "Shout"\. .+ merged it on \d{4}-\d\d-\d\d \(commit [0-9a-f]{7}\)\.$/);
    const answer = jsonOf(why.text);
    expect(answer).toMatchObject({ path: "src/shout.js", line: 3, text: "  return greet(name).toUpperCase();", step: { kind: "merge", subject: "Shout", merge: { attemptId: id } } });
    expect(answer.record).toMatchObject({ task: { title: "Shout", goal: "Shout." }, plan: { steps: ["Add src/shout.js"], approach: "New file." }, summary: "Shout added." });
    expect(answer.record.tests.passed).toBeGreaterThan(0);

    // A line from before the merge: the commit that put it on main, with no merge behind it.
    const old = await gr("gitring_why", { path: "src/greet.js", line: 2 });
    expect(old.isError, old.text).toBe(false);
    expect(jsonOf(old.text).step).toMatchObject({ kind: "outside", subject: "Task src/greet.js" });

    const file = await gr("gitring_why", { path: "src/shout.js" });
    expect(headline(file.text)).toBe('1 change of main touched src/shout.js. The last is the task "Shout". Give a line to see the change that wrote it.');

    const hist = await gr("gitring_history", { path: "src" });
    expect(hist.isError, hist.text).toBe(false);
    expect(jsonOf(hist.text).steps.map((s: { subject: string }) => s.subject)).toEqual(["Shout", "Task src/greet.js"]);
    const all = await gr("gitring_history", {});
    expect(jsonOf(all.text).steps[0]).toMatchObject({ kind: "merge", subject: "Shout" });

    for (const t of [why.text, old.text, file.text, hist.text, all.text]) expect(steViolations(headline(t)), headline(t)).toEqual([]);
  });

  it("finds a text in main, and compares main with a commit and with a work copy", async () => {
    const search = await gr("gitring_search", { query: "greet(" });
    expect(search.isError, search.text).toBe(false);
    const found = jsonOf(search.text);
    expect(found.files.map((f: { path: string }) => f.path).sort()).toEqual(["src/greet.js", "tests/greet.test.js"]);
    expect(found.files.find((f: { path: string }) => f.path === "src/greet.js").matches).toEqual([{ line: 1, text: "export function greet(name) {" }]);
    expect(steViolations(headline(search.text))).toEqual([]);

    const id = await work("Shout", [{ path: "src/shout.js", content: SHOUT }]);
    const diff = await gr("gitring_diff", { from: "main", to: id });
    expect(diff.isError, diff.text).toBe(false);
    expect(headline(diff.text)).toMatch(/^main and the work copy of \S+ differ in 1 file \(\+4 -0\)\.$/);
    expect(jsonOf(diff.text).files[0]).toMatchObject({ path: "src/shout.js", status: "A", additions: 4 });

    const back = await gr("gitring_diff", { from: seeded.slice(0, 10), to: "main" });
    expect(headline(back.text)).toBe(`commit ${seeded.slice(0, 7)} and main have the same files.`);

    // A line of the work copy: the work wrote it, and it is not merged.
    const mine = await gr("gitring_why", { path: "src/shout.js", line: 2, ref: id });
    expect(headline(mine.text)).toMatch(/It is not merged yet\.$/);
    expect(jsonOf(mine.text).work).toMatchObject({ attemptId: id, title: "Shout" });
  });

  it("works at the read-only endpoint, and answers errors in plain words", async () => {
    const ro = await gr("gitring_search", { query: "Hello" }, "/mcp/readonly");
    expect(ro.isError, ro.text).toBe(false);
    expect(jsonOf(ro.text).total).toBe(2);
    const why = await gr("gitring_why", { path: "src/greet.js", line: 1 }, "/mcp/readonly");
    expect(why.isError, why.text).toBe(false);
    const far = await gr("gitring_why", { path: "src/greet.js", line: 40 });
    expect(far.isError).toBe(true);
    expect(far.text).toBe("Error: src/greet.js has 3 lines on main. Give a line from 1 to 3.");
    const none = await gr("gitring_why", { path: "src/none.js", line: 1 });
    expect(none.text).toMatch(/^Error: src\/none\.js is not on main/);
    const bad = await gr("gitring_diff", { from: "main", to: "nope" });
    expect(bad.text).toBe('Error: Unknown version "nope". Use main, a commit id or a work copy id.');
    for (const t of [far.text, none.text, bad.text]) expect(steViolations(t.replace(/^Error: /, ""))).toEqual([]);
  });
});

describe("REST twins", () => {
  it("answers why, history, search and compare for the web app", async () => {
    const base = `/api/projects/${project}`;
    const why = await world.call("GET", `${base}/why?path=src/greet.js&line=2`, { key });
    expect(why.status, why.text).toBe(200);
    expect(why.json).toMatchObject({ path: "src/greet.js", line: 2, step: { kind: "outside" } });
    const hist = await world.call("GET", `${base}/history?path=tests&limit=5`, { key });
    expect(hist.status).toBe(200);
    expect(hist.json.steps).toHaveLength(1);
    const search = await world.call("GET", `${base}/search?q=Hello&path=src`, { key });
    expect(search.status).toBe(200);
    expect(search.json.files.map((f: { path: string }) => f.path)).toEqual(["src/greet.js"]);
    const cmp = await world.call("GET", `${base}/compare?from=main&to=main`, { key });
    expect(cmp.status).toBe(200);
    expect(cmp.json.files).toEqual([]);
    const badLine = await world.call("GET", `${base}/why?path=src/greet.js&line=two`, { key });
    expect(badLine.status).toBe(400);
    expect(badLine.json.error).toBe("Give the line as a number.");
    const noPath = await world.call("GET", `${base}/why`, { key });
    expect(noPath.status).toBe(400);
    expect(noPath.json.error).toBe("Give the path of a file.");
    const anon = await world.call("GET", `${base}/why?path=src/greet.js`);
    expect(anon.status).toBe(401);
  });
});
