/**
 * The conflict check keeps its promises, end to end in the project object:
 *   - the radar stores every pair, so a pair that comes closer from far away is checked;
 *   - a plan can name the functions it calls (uses): range 1 before any code exists;
 *   - only the pairs that need a change request decide the doubt of the decision model;
 *   - "same task as other work" still sends the change requests of the other pairs;
 *   - a redo is traffic, and a new plan or a redo keeps the time of the first plan (R4);
 *   - the project setting "clef" asks the large model first;
 *   - the imports of a work copy, tsconfig paths, and plan names without a path count right.
 */
import { describe, expect, it } from "vitest";
import type { CourseCheck } from "../../src/core/types";
import { CrashWorld } from "./crash-world";

/** c.js imports b.js, b.js imports a.js: a.js and c.js are two imports apart. */
const FILES = [
  { path: "src/a.js", text: "export function f(x) {\n  return x + 1;\n}\n\nexport function helper() {\n  return 1;\n}\n" },
  { path: "src/b.js", text: 'import { f } from "./a.js";\nexport const b = f(1);\n' },
  { path: "src/c.js", text: 'import { b } from "./b.js";\nexport const c = b + 1;\n\nexport function helper() {\n  return 2;\n}\n' },
  { path: "src/z.js", text: "export const z = 1;\nexport const y = 2;\nexport const w = 3;\n" },
  { path: "README.md", text: "# Shop\n" },
  { path: "tests/a.test.js", text: 'import { test, expect } from "../harness/test.js";\ntest("a", () => expect(1).toBe(1));\n' },
];

/** A Vessel stand-in: a redo starts a built-in agent, which this test does not run. */
const VESSEL = { idFromName: (n: string) => n, get: () => ({ start: async () => undefined, stop: async () => undefined }) };

async function project(settings: Record<string, unknown> = {}, env: Record<string, unknown> = {}, files = FILES) {
  const world = new CrashWorld({ VESSEL, ...env });
  await world.start({ files, settings: { decisionModel: "rules", ...settings } });
  return world;
}

let tasks = 0;
/** An agent sends a plan for a new task. */
async function declare(world: CrashWorld, plan: { files?: string[]; symbols?: string[]; uses?: string[]; title?: string; intentId?: string }): Promise<string> {
  tasks += 1;
  const d = await world.harbor.declare({
    agent: { client: "test" },
    ...(plan.intentId ? { intentId: plan.intentId } : { newIntent: { title: plan.title ?? `Task ${tasks} ${"qwxzvbnmkp".slice(tasks % 7, (tasks % 7) + 3)}`, goal: `Goal number ${tasks}.` } }),
    plan: ["Edit"],
    files: plan.files ?? [],
    symbols: plan.symbols ?? [],
    ...(plan.uses ? { uses: plan.uses } : {}),
    approach: "Edit.",
  });
  await world.settle();
  return d.attemptId;
}

async function write(world: CrashWorld, attemptId: string, path: string, content: string): Promise<void> {
  await world.harbor.write({ attemptId, files: [{ path, content }] });
  await world.settle();
}

async function lastCheck(world: CrashWorld, attemptId: string): Promise<CourseCheck> {
  const { checks } = await world.harbor.state();
  const mine = checks.filter((c) => c.attemptId === attemptId);
  return mine[mine.length - 1];
}

describe("the radar and closing pairs", () => {
  it("stores far pairs, so that a pair that comes closer from range 5 is checked at range 4", async () => {
    const world = await project();
    const a = await declare(world, { files: ["src/a.js"] });
    const r = await declare(world, { files: ["README.md"] });
    const state = await world.harbor.state();
    const pair = state.radar.find((p) => [p.a, p.b].sort().join() === [a, r].sort().join());
    expect(pair).toMatchObject({ range: 5, closing: false });
    // The README agent now writes c.js: two imports from a.js, closer than before.
    await write(world, r, "src/c.js", 'import { b } from "./b.js";\nexport const c = b + 2;\n\nexport function helper() {\n  return 2;\n}\n');
    const check = await lastCheck(world, r);
    expect(check.facts.map((f) => [f.otherAttemptId, f.range, f.closing, f.previousRange])).toEqual([[a, 4, true, 5]]);
  });

  it("marks a far pair as clear, and forgets the pairs of stopped work when the radar is full", async () => {
    const world = await project();
    const a = await declare(world, { files: ["src/a.js"] });
    const r = await declare(world, { files: ["README.md"] });
    const z = await declare(world, { files: ["src/z.js"] });
    const pairOf = async (x: string, y: string) => (await world.harbor.state()).radar.find((p) => [p.a, p.b].sort().join() === [x, y].sort().join());
    // Far pairs are measured, not checked: no conflict is possible, so the people see "No conflict".
    expect(await pairOf(a, r)).toMatchObject({ range: 5, closing: false, verdict: "clear" });
    expect(await pairOf(z, r)).toMatchObject({ range: 5, verdict: "clear" });
    await world.harbor.giveUp(r, "Done.");
    // Under the limit, the radar keeps every pair.
    (world.harbor as unknown as { trimRadar(max?: number): void }).trimRadar();
    expect(await pairOf(a, r)).toBeDefined();
    // Over the limit, it forgets the pairs of the stopped work only, also in storage.
    (world.harbor as unknown as { trimRadar(max?: number): void }).trimRadar(0);
    expect(await pairOf(a, r)).toBeUndefined();
    expect(await pairOf(z, r)).toBeUndefined();
    expect(await pairOf(a, z)).toBeDefined();
    world.restart();
    expect((await world.harbor.state()).radar.map((p) => [p.a, p.b].sort().join())).toEqual([[a, z].sort().join()]);
  });
});

describe("plans that name the functions they call (uses)", () => {
  it("puts a plan that calls f and a plan that changes the signature of f at range 1, before any code exists", async () => {
    const world = await project();
    const changer = await declare(world, { files: ["src/a.js"], symbols: ["src/a.js#f(x, y)"] });
    const user = await declare(world, { files: ["src/z.js"], uses: ["src/a.js#f"] });
    const { attempts } = await world.harbor.state();
    expect(attempts.find((x) => x.id === user)?.course.uses).toEqual(["src/a.js#f"]);
    const check = await lastCheck(world, user);
    expect(check.facts).toHaveLength(1);
    expect(check.facts[0]).toMatchObject({ otherAttemptId: changer, range: 1, interfaceHits: [{ changedBy: "other", symbol: "src/a.js#f" }] });
    // R3: the agent that changes the interface stands on; the agent that calls it adapts.
    expect(check.verdict).toBe("correct");
    expect(world.inner.attempts.get(user)?.corrections.length).toBe(1);
  });
});

describe("the doubt of the decision model", () => {
  /** A fake model: the first candidate (v0) is a clear semantic risk; the second (v1) gets a coin-flip answer. */
  function model() {
    const calls: string[] = [];
    const ai = {
      run: async (name: string, req: { questions?: Record<string, unknown> }) => {
        if (!req.questions) return { response: "" };
        calls.push(name);
        const answers: Record<string, unknown> = { duplicate: { type: "noul", noul: 0.02 } };
        for (const id of Object.keys(req.questions)) {
          const first = id.endsWith(".v0");
          if (id.startsWith("collide.")) answers[id] = { type: "noul", noul: first ? 0.85 : 0.45 };
          else if (id.startsWith("interfere.")) answers[id] = { type: "score", score: first ? 3.4 : 1, confidence: 0.9 };
          else if (id.startsWith("giveway.")) answers[id] = { type: "choice", choice: "incoming", probabilities: { incoming: 0.9, other: 0.1 }, confidence: 0.9 };
        }
        return { answers };
      },
    };
    return { ai, calls };
  }

  it("does not send a clear semantic pair to a person because of a coin flip on an unrelated pair", async () => {
    const m = model();
    const world = await project({ decisionModel: "clef-flash" }, { AI: m.ai });
    // v0: another plan changes the signature of f, and the incoming code calls f (range 1, an interface hit).
    await declare(world, { files: ["src/a.js"], symbols: ["src/a.js#f(x, y)"] });
    // v1: another plan edits z.js (range 2 with the incoming work, no hard facts).
    await declare(world, { files: ["src/z.js"] });
    const incoming = await declare(world, { files: ["src/z.js"] });
    await write(world, incoming, "src/z.js", 'import { f } from "./a.js";\nexport const z = f(1);\nexport const y = 2;\nexport const w = 3;\n');
    const check = await lastCheck(world, incoming);
    expect(check.facts.map((f) => f.range)).toEqual([1, 2]);
    expect(m.calls.length).toBeGreaterThan(0);
    // Before, the minimum over all pairs (0.3 for the coin flip) made this "escalate".
    expect(check.verdict).toBe("correct");
    expect(check.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it("asks the large model first when the project says clef", async () => {
    const m = model();
    const world = await project({ decisionModel: "clef" }, { AI: m.ai });
    await declare(world, { files: ["src/z.js"] });
    await declare(world, { files: ["src/z.js"] });
    expect(m.calls).toEqual(["@cf/cloudflare/clef"]);
    const flash = model();
    const other = await project({ decisionModel: "clef-flash" }, { AI: flash.ai });
    await declare(other, { files: ["src/z.js"] });
    await declare(other, { files: ["src/z.js"] });
    expect(flash.calls[0]).toBe("@cf/cloudflare/clef-flash");
  });
});

describe("same task as other work", () => {
  it("also sends the change requests of the other pairs that collide", async () => {
    const world = await project();
    // X: a dark mode task. Y: another task that edits the first lines of z.js.
    await declare(world, { files: ["src/z.js"], title: "Add dark mode to the shop" });
    const y = await declare(world, { files: ["src/z.js"], title: "Round every price" });
    await write(world, y, "src/z.js", "export const z = 10;\nexport const y = 20;\nexport const w = 3;\n");
    // Z joins an existing task that is the same as X, and edits the same lines as Y.
    const same = await world.harbor.createIntent({ title: "Add dark mode to the shop", goal: "A dark mode." });
    const z = await declare(world, { files: ["src/z.js"], intentId: same.id });
    await write(world, z, "src/z.js", "export const z = 11;\nexport const y = 21;\nexport const w = 3;\n");
    const check = await lastCheck(world, z);
    expect(check.verdict).toBe("merge-intents");
    const kinds = world.inner.attempts.get(z)!.corrections.map((id) => (world.harbor as unknown as { corrections: Map<string, { kind: string; standOnAttemptId?: string }> }).corrections.get(id)!);
    expect(kinds.map((c) => c.kind).sort()).toEqual(["duplicate", "region"]);
    expect(kinds.find((c) => c.kind === "region")?.standOnAttemptId).toBe(y);
  });
});

describe("redo copies and the time of a plan (R4)", () => {
  it("keeps the time of the first plan when a work copy sends a new plan", async () => {
    const world = await project();
    const a = await declare(world, { files: ["src/a.js"] });
    const first = world.inner.attempts.get(a)!.course.declaredAt;
    await new Promise((r) => setTimeout(r, 5));
    await world.harbor.declare({ attemptId: a, intentId: world.inner.attempts.get(a)!.intentId, agent: { client: "test" }, plan: ["Edit again"], files: ["src/a.js", "src/b.js"], symbols: [], approach: "Edit again." });
    expect(world.inner.attempts.get(a)!.course.declaredAt).toBe(first);
    expect(world.inner.attempts.get(a)!.course.files).toEqual(["src/a.js", "src/b.js"]);
  });

  it("gives a redo the time of the work it redoes, and other agents see the redo as traffic", async () => {
    const world = await project();
    const old = await declare(world, { files: ["src/a.js"] });
    const first = world.inner.attempts.get(old)!.course.declaredAt;
    await new Promise((r) => setTimeout(r, 5));
    const { attempt: redo } = await world.harbor.rederive(old, "Main moved.");
    await world.settle();
    expect(redo.status).toBe("rederiving");
    expect(redo.course.declaredAt).toBe(first);
    const other = await declare(world, { files: ["src/a.js"] });
    const check = await lastCheck(world, other);
    expect(check.facts.map((f) => f.otherAttemptId)).toEqual([redo.id]);
  });
});

describe("the import graph and plan names", () => {
  it("counts the imports of a new file of a work copy", async () => {
    const world = await project();
    const x = await declare(world, { files: ["src/new.js"] });
    await write(world, x, "src/new.js", 'import { w } from "./z.js";\nexport const n = w;\n');
    const y = await declare(world, { files: ["src/z.js"] });
    const check = await lastCheck(world, y);
    // new.js imports z.js: one import apart, although main has no new.js.
    expect(check.facts.map((f) => [f.otherAttemptId, f.range])).toEqual([[x, 3]]);
  });

  it("adds no edges for the check files that gitring writes into a work copy", async () => {
    const world = await project();
    // The check of the task imports a.js and z.js. It is not the work of the agent.
    const task = await world.harbor.createIntent({
      title: "Round the prices",
      goal: "Round every price.",
      checks: [{ path: "tests/round.test.js", content: 'import { f } from "../src/a.js";\nimport { z } from "../src/z.js";\nexport const t = f(z);\n' }],
    });
    const x = await declare(world, { files: ["src/a.js"], intentId: task.id });
    const y = await declare(world, { files: ["src/z.js"] });
    const pair = (await world.harbor.state()).radar.find((p) => [p.a, p.b].sort().join() === [x, y].sort().join());
    // With the edges of the check file, a.js and z.js would be two imports apart (range 4).
    expect(pair).toMatchObject({ range: 5 });
  });

  it("follows tsconfig paths on main", async () => {
    const files = [
      { path: "tsconfig.json", text: '{\n  // aliases\n  "compilerOptions": { "paths": { "@/*": ["src/*"] } },\n}\n' },
      { path: "src/money.ts", text: "export const cents = (n: number) => n * 100;\n" },
      { path: "src/view.ts", text: 'import { cents } from "@/money";\nexport const price = cents(2);\n' },
    ];
    const world = await project({}, {}, files);
    const x = await declare(world, { files: ["src/money.ts"] });
    const y = await declare(world, { files: ["src/view.ts"] });
    expect((await lastCheck(world, y)).facts.map((f) => [f.otherAttemptId, f.range])).toEqual([[x, 3]]);
  });

  it("places a plan symbol without a path in the plan's own files: no false range 0", async () => {
    const world = await project();
    // Both a.js and c.js define helper. One plan changes helper in a.js; the other names "helper" for z.js only.
    await declare(world, { files: ["src/a.js"], symbols: ["src/a.js#helper"] });
    const y = await declare(world, { files: ["src/z.js"], symbols: ["helper"] });
    expect((await lastCheck(world, y)).facts).toEqual([]);
    // A plan with no files names the one main file that defines the name: f lives in a.js only.
    const z = await declare(world, { symbols: ["f"] });
    expect((await lastCheck(world, z)).facts.map((f) => f.range)).toContain(2);
  });
});
