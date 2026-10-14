/**
 * Trains and the test mode "After merge, with automatic revert": independent work merges in one train with
 * one test run, a failed train splits, and a main that fails after a merge gets the merge reverted.
 */
import { describe, expect, it } from "vitest";
import { parseTrailers } from "../../src/core/logbook";
import { CrashWorld } from "./crash-world";

/** A Dynamic Worker that fails the tests when the tree holds the files of a rule. */
function loaderFailing(rules: string[][]) {
  return {
    get: (_id: string, getCode: () => unknown) => ({
      getEntrypoint: () => ({
        fetch: async () => {
          const code = (await getCode()) as { modules: Record<string, unknown> };
          const keys = Object.keys(code.modules);
          const fails = rules.some((r) => r.every((f) => keys.includes(f)));
          const files = keys.filter((m) => /^tests\/.+\.test\.m?js$/.test(m));
          return Response.json(files.map((file) => ({ file, name: "works", ok: !fails, ms: 1, ...(fails ? { error: "the tree is broken" } : {}) })));
        },
      }),
    }),
  };
}

/** Hold the merge queue, submit the tasks, then let the queue run once with all of them in it. */
async function submitTogether(w: CrashWorld, names: string[]): Promise<{ attemptId: string; intentId: string }[]> {
  let release!: () => void;
  w.inner.landingChain = new Promise<void>((r) => (release = r));
  const tasks = [];
  for (const name of names) {
    const t = await w.startTask(name);
    await w.harbor.submit(t.attemptId, `Add ${name}`);
    tasks.push(t);
  }
  release();
  await w.settle();
  return tasks;
}

const composedRuns = (w: CrashWorld) => w.testRuns.filter((s) => s === "composed").length;

describe("trains", () => {
  it("merges independent work in one train: one test run, one commit and one why-record for each task", async () => {
    const w = new CrashWorld();
    await w.start({ settings: { landing: "automatic" } });
    const before = (await w.repo.resolve(w.mainRepo, "main"))!;
    const tasks = await submitTogether(w, ["alpha", "beta", "gamma"]);
    for (const t of tasks) expect(w.status(t.attemptId), t.attemptId).toBe("landed");
    expect(composedRuns(w)).toBe(1);
    expect(w.mainCommits).toHaveLength(3);
    // Consecutive commits, each on the one before.
    expect(w.mainCommits[0].parent).toBe(before);
    const log = await w.repo.log(w.mainRepo, "main", 10);
    expect(log[3].hash).toBe(before);
    const places = [];
    for (const t of tasks) {
      const [commit] = await w.mergesOf(t.attemptId);
      const tr = parseTrailers(commit.message)["Gitring-Train"];
      expect(tr).toMatch(/^tr_\S+ \d\/3$/);
      places.push(Number(tr.split(" ")[1][0]));
    }
    expect(places.sort()).toEqual([1, 2, 3]);
    const landings = w.inner.landings as unknown as { train?: { id: string; place: number; size: number } }[];
    expect(new Set(landings.map((l) => l.train?.id)).size).toBe(1);
    expect(landings.every((l) => l.train?.size === 3)).toBe(true);
    expect((w.inner as unknown as { stats: { trains: number } }).stats.trains).toBe(1);
    expect(await w.harbor.file("main", "src/alpha.js")).toContain("alpha");
    expect(await w.harbor.file("main", "src/gamma.js")).toContain("gamma");
  });

  it("catches up with a main that moved under the train, and merges every task", async () => {
    const w = new CrashWorld();
    await w.start({ settings: { landing: "automatic" } });
    let release!: () => void;
    w.inner.landingChain = new Promise<void>((r) => (release = r));
    const tasks = [];
    for (const name of ["alpha", "beta", "gamma"]) {
      const t = await w.startTask(name);
      await w.harbor.submit(t.attemptId, `Add ${name}`);
      tasks.push(t);
    }
    // A commit from outside gitring lands on main while the work waits.
    const tip = (await w.repo.resolve(w.mainRepo, "main"))!;
    await w.repo.commit({ repo: w.mainRepo, branch: "main", parent: tip, changes: [{ path: "docs/outside.md", content: "Outside.\n" }], message: "Outside change", author: { name: "Robin", email: "robin@example.invalid" } });
    release();
    await w.settle();
    for (const t of tasks) expect(w.status(t.attemptId), t.attemptId).toBe("landed");
    // The train did not try again and again on the stale main: a few test runs, not one for each round.
    expect(composedRuns(w)).toBeLessThanOrEqual(6);
  });

  it("does not make a train when the setting is 1, or when the work shares a file", async () => {
    const solo = new CrashWorld();
    await solo.start({ settings: { landing: "automatic", maxTrain: 1 } });
    const t1 = await submitTogether(solo, ["alpha", "beta"]);
    for (const t of t1) expect(solo.status(t.attemptId)).toBe("landed");
    expect(composedRuns(solo)).toBe(2);
    expect((solo.inner.landings as unknown as { train?: unknown }[]).every((l) => !l.train)).toBe(true);

    // Two tasks that write the same file never ride together.
    const w = new CrashWorld();
    await w.start({ settings: { landing: "automatic" } });
    let release!: () => void;
    w.inner.landingChain = new Promise<void>((r) => (release = r));
    const a = await w.startTask("one", { "src/shared.js": "export const one = 1;\n" });
    const b = await w.startTask("two", { "src/shared.js": "export const two = 1;\n" });
    await w.harbor.submit(a.attemptId, "One");
    await w.harbor.submit(b.attemptId, "Two");
    release();
    await w.settle();
    expect((w.inner.landings as unknown as { train?: unknown }[]).every((l) => !l.train)).toBe(true);
  });

  it("splits a train that fails: the work that fails with the others waits, the rest merges", async () => {
    // Each work passes alone. "bad" and "gamma" fail together.
    const w = new CrashWorld({ LOADER: loaderFailing([["src/bad.js", "src/gamma.js"]]) });
    await w.start({ settings: { landing: "automatic" } });
    const tasks = await submitTogether(w, ["alpha", "bad", "gamma"]);
    expect(w.status(tasks[0].attemptId)).toBe("landed");
    expect(w.status(tasks[1].attemptId)).toBe("landed");
    // gamma passes alone, fails with bad: its own merge runs next, tests fail on main plus the work, and it goes back.
    expect(w.status(tasks[2].attemptId)).not.toBe("landed");
    expect(await w.mergesOf(tasks[2].attemptId)).toHaveLength(0);
    const [first] = await w.mergesOf(tasks[0].attemptId);
    expect(parseTrailers(first.message)["Gitring-Train"]).toMatch(/ \d\/2$/);
    expect(w.inner.logs.some((l) => l.message.includes("The train split"))).toBe(true);
  });
});

describe("settings", () => {
  it("keeps the defaults and ignores a wrong mode and clamps the size of a train", async () => {
    const w = new CrashWorld();
    await w.start();
    const read = async () => (await w.harbor.state()).project.settings;
    expect(await read()).toMatchObject({ testsWhen: "before", maxTrain: 8 });
    await w.harbor.updateSettings({ testsWhen: "after", maxTrain: 3 });
    expect(await read()).toMatchObject({ testsWhen: "after", maxTrain: 3 });
    await w.harbor.updateSettings({ testsWhen: "never" as never, maxTrain: 99 });
    expect(await read()).toMatchObject({ testsWhen: "after", maxTrain: 16 });
  });
});

describe("tests after the merge", () => {
  it("merges work whose own tests pass without a test run on main plus the work, then tests main", async () => {
    const w = new CrashWorld();
    await w.start({ settings: { landing: "automatic", testsWhen: "after" } });
    const t = await w.submitTask("alpha");
    await w.settle();
    expect(w.status(t.attemptId)).toBe("landed");
    expect(composedRuns(w)).toBe(0);
    const [commit] = await w.mergesOf(t.attemptId);
    expect(parseTrailers(commit.message)["Gitring-Tests"]).toBe("after");
    expect(w.testRuns).toContain("main");
    const state = w.inner.db.getMeta<{ lastGreen?: string; tested?: string }>("mainTests");
    expect(state?.lastGreen).toBe(await w.repo.resolve(w.mainRepo, "main"));
    expect((w.inner.landings as unknown as { testsWhen?: string }[])[0].testsWhen).toBe("after");
  });

  it("finds the merge that broke main, reverts it with its own record, reopens the task and sends a change request", async () => {
    // Each of the two works alone: fine. Together: the tests fail.
    const w = new CrashWorld({ LOADER: loaderFailing([["src/gamma.js", "src/delta.js"]]) });
    await w.start({ settings: { landing: "automatic", testsWhen: "after" } });
    const tasks = await submitTogether(w, ["gamma", "delta"]);
    const [gamma, delta] = tasks;
    // The newest merge whose undo makes main pass is the culprit.
    const reverts = (w.inner.landings as unknown as { method: string; attemptId: string; revert?: { reason: string; of: string; failed: string[] } }[]).filter((l) => l.method === "revert");
    expect(reverts).toHaveLength(1);
    expect(reverts[0].attemptId).toBe(delta.attemptId);
    expect(reverts[0].revert?.reason).toBe("reverted: tests failed on main");
    expect(reverts[0].revert?.failed.length).toBeGreaterThan(0);
    expect(await w.harbor.file("main", "src/gamma.js")).toContain("gamma");
    expect(await w.harbor.file("main", "src/delta.js")).toBeNull();
    const tip = (await w.repo.log(w.mainRepo, "main", 1))[0];
    expect(parseTrailers(tip.message)["Gitring-Method"]).toBe("revert");
    expect(tip.message).toContain(`Gitring-Attempt: ${delta.attemptId}`);
    // The task is open again and the agent has a change request.
    expect(w.status(gamma.attemptId)).toBe("landed");
    expect(w.status(delta.attemptId)).toBe("underway");
    expect(w.inner.intents.get(delta.intentId)?.status).toBe("underway");
    const requests = [...(w.inner as unknown as { corrections: Map<string, { attemptId: string; kind: string; message: string }> }).corrections.values()].filter((c) => c.attemptId === delta.attemptId);
    expect(requests.some((c) => c.kind === "reverted" && c.message.includes("tests failed on main"))).toBe(true);
    // The tests of the new main ran and pass.
    const state = w.inner.db.getMeta<{ lastGreen?: string }>("mainTests");
    expect(state?.lastGreen).toBe(tip.hash);
    expect((w.inner as unknown as { stats: { reverts: number } }).stats.reverts).toBe(1);
  });

  it("tells the person in the inbox when the work was approved", async () => {
    const w = new CrashWorld({ LOADER: loaderFailing([["src/gamma.js", "src/delta.js"]]) });
    await w.start({ settings: { landing: "automatic", testsWhen: "after" } });
    let release!: () => void;
    w.inner.landingChain = new Promise<void>((r) => (release = r));
    const g = await w.startTask("gamma");
    const d = await w.startTask("delta");
    await w.harbor.submit(g.attemptId, "Add gamma");
    await w.harbor.submit(d.attemptId, "Add delta");
    // A person said yes to the work of delta.
    const a = w.inner.attempts.get(d.attemptId) as unknown as { approval?: unknown };
    a.approval = { status: "approved", reason: "risky", why: [], answer: { by: { id: "u_robin", name: "Robin" }, at: Date.now() } };
    release();
    await w.settle();
    const questions = [...(w.inner as unknown as { questions: Map<string, { kind: string; status: string; facts: string[]; options: { id: string }[] }> }).questions.values()].filter((q) => q.kind === "revert");
    expect(questions).toHaveLength(1);
    expect(questions[0].status).toBe("open");
    expect(questions[0].facts[0]).toContain("Robin said yes");
    expect(questions[0].options.map((o) => o.id)).toEqual(["ok", "redo", "park"]);
  });

  it("does not revert in the usual mode: work whose tests fail on main does not merge at all", async () => {
    const w = new CrashWorld({ LOADER: loaderFailing([["src/gamma.js", "src/delta.js"]]) });
    await w.start({ settings: { landing: "automatic" } });
    const tasks = await submitTogether(w, ["gamma", "delta"]);
    expect((w.inner.landings as unknown as { method: string }[]).some((l) => l.method === "revert")).toBe(false);
    const landed = tasks.filter((t) => w.status(t.attemptId) === "landed");
    expect(landed.length).toBe(1);
  });
});
