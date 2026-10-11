/**
 * A course check does not call the decision model for pairs that it cannot change (one import apart or more).
 * The fixed rules decide then, and every verdict stays the same. The model stays in the loop for every other case.
 */
import { describe, expect, it } from "vitest";
import type { CourseCheck } from "../../src/core/types";
import { CrashWorld } from "./crash-world";

/** b.js imports a.js: work in a.js and work in b.js are one import apart (range 3). */
const FILES = [
  { path: "src/a.js", text: "export const a = 1;\n" },
  { path: "src/b.js", text: 'import { a } from "./a.js";\nexport const b = a + 1;\n' },
  { path: "tests/a.test.js", text: 'import { test, expect } from "../harness/test.js";\ntest("a", () => expect(1).toBe(1));\n' },
];

/** Tasks with no words in common, and one that shares some words with BANNER. */
const BANNER = { title: "Show a sale banner", goal: "Put a banner above the product list." };
const ROUNDING = { title: "Round the prices", goal: "Format every price with two decimals." };
const LOG = { title: "Log each request", goal: "Write one log line for each request." };
const BADGE = { title: "Show a sale badge", goal: "Mark each product card." };

/** What the fake model answers for every pair. */
const CALM = { collision: 0.05, interference: 0 };
const WILD = { collision: 0.99, interference: 4 };

/** A fake decision model: it counts its calls and gives the same answer for every pair. */
function fakeModel(answer: { collision: number; interference: number }) {
  const calls: string[] = [];
  const ai = {
    run: async (name: string, req: { questions?: Record<string, unknown> }) => {
      if (!req.questions) return { response: "" };
      calls.push(name);
      const answers: Record<string, unknown> = { duplicate: { type: "noul", noul: 0.05 } };
      for (const id of Object.keys(req.questions)) {
        if (id.startsWith("collide.")) answers[id] = { type: "noul", noul: answer.collision };
        else if (id.startsWith("interfere.")) answers[id] = { type: "score", score: answer.interference, confidence: 0.9 };
        else if (id.startsWith("giveway.")) answers[id] = { type: "choice", choice: "incoming", probabilities: { incoming: 0.9, other: 0.1 }, confidence: 0.9 };
      }
      return { answers };
    },
  };
  return { ai, calls };
}

async function project(answer: { collision: number; interference: number }, settings: Record<string, unknown> = {}) {
  const model = fakeModel(answer);
  const world = new CrashWorld({ AI: model.ai });
  await world.start({ files: FILES, settings: { decisionModel: "clef-flash", ...settings } });
  return { world, model };
}

/** An agent sends a plan for a new task that will edit these files. */
async function declare(world: CrashWorld, task: { title: string; goal: string }, files: string[]): Promise<string> {
  const d = await world.harbor.declare({
    agent: { client: "test" },
    newIntent: task,
    plan: [`Edit ${files.join(", ")}`],
    files,
    symbols: [],
    approach: `Edit ${files.join(", ")}.`,
  });
  await world.settle();
  return d.attemptId;
}

/** The newest course check of a work copy. */
async function lastCheck(world: CrashWorld, attemptId: string): Promise<CourseCheck> {
  const { checks } = await world.harbor.state();
  const mine = checks.filter((c) => c.attemptId === attemptId);
  return mine[mine.length - 1];
}

describe("the course check and the decision model", () => {
  it("makes no model call for a pair one import apart: the fixed rules clear it", async () => {
    const { world, model } = await project(WILD);
    await declare(world, BANNER, ["src/a.js"]);
    const b = await declare(world, ROUNDING, ["src/b.js"]);
    const check = await lastCheck(world, b);
    expect(check.facts.map((f) => [f.range, f.closing, f.intentSimilarity])).toEqual([[3, false, 0]]);
    expect(check).toMatchObject({ verdict: "clear", source: "rules" });
    expect(model.calls).toHaveLength(0);
  });

  it("gives the same verdict when the model is called for such a pair: the model cannot raise it", async () => {
    const { world, model } = await project(WILD);
    await declare(world, BANNER, ["src/a.js"]);
    const b = await declare(world, BADGE, ["src/b.js"]);
    const check = await lastCheck(world, b);
    // The two tasks share some words, so the model may call them one task: it is asked.
    expect(check.facts[0].range).toBe(3);
    expect(check.facts[0].intentSimilarity).toBeGreaterThanOrEqual(0.2);
    expect(check.facts[0].intentSimilarity).toBeLessThan(0.6);
    expect(model.calls).toHaveLength(1);
    // It says "collision 0.99, interference 4". The facts cap that at 0.45 and 1.4, and the verdict is clear.
    expect(check).toMatchObject({ verdict: "clear", source: "clef-flash" });
    expect(check.assessments[0]).toMatchObject({ collision: 0.45, interference: 1.4 });
  });

  it("asks the model for a pair that edits the same file", async () => {
    const { world, model } = await project(CALM);
    await declare(world, BANNER, ["src/a.js"]);
    const b = await declare(world, ROUNDING, ["src/a.js"]);
    const check = await lastCheck(world, b);
    expect(check.facts[0].range).toBe(2);
    expect(model.calls).toHaveLength(1);
    expect(check).toMatchObject({ verdict: "clear", source: "clef-flash" });
  });

  it("asks the model when the pair comes closer", async () => {
    const { world, model } = await project(CALM);
    await declare(world, BANNER, ["src/a.js"]);
    const b = await declare(world, ROUNDING, ["src/b.js"]);
    expect(model.calls).toHaveLength(0);
    // The agent of b.js now writes in a.js: the range goes from 3 to 2.
    await world.harbor.write({ attemptId: b, files: [{ path: "src/a.js", content: "export const a = 1;\nexport const extra = 2;\n" }] });
    await world.settle();
    const check = await lastCheck(world, b);
    expect(check.facts[0]).toMatchObject({ range: 2, closing: true });
    expect(model.calls).toHaveLength(1);
    expect(check.source).toBe("clef-flash");
  });

  it("asks the model once for a set with a near pair, the pair at distance 3 included", async () => {
    const { world, model } = await project(CALM);
    await declare(world, BANNER, ["src/a.js"]);
    await declare(world, LOG, ["src/b.js"]);
    expect(model.calls).toHaveLength(0);
    const b = await declare(world, ROUNDING, ["src/b.js"]);
    const check = await lastCheck(world, b);
    expect(check.facts.map((f) => f.range).sort()).toEqual([2, 3]);
    expect(model.calls).toHaveLength(1);
    expect(check.source).toBe("clef-flash");
  });

  it("asks the model when a threshold lies at the cap: its answer counts then", async () => {
    const { world, model } = await project(WILD, { thresholds: { collision: 0.45 } });
    await declare(world, BANNER, ["src/a.js"]);
    const b = await declare(world, ROUNDING, ["src/b.js"]);
    const check = await lastCheck(world, b);
    expect(check.facts[0].range).toBe(3);
    expect(model.calls).toHaveLength(1);
    expect(check).toMatchObject({ verdict: "correct", source: "clef-flash" });
  });

  it("makes no model call when the project uses the fixed rules", async () => {
    const { world, model } = await project(WILD, { decisionModel: "rules" });
    await declare(world, BANNER, ["src/a.js"]);
    const b = await declare(world, ROUNDING, ["src/a.js"]);
    expect((await lastCheck(world, b)).facts[0].range).toBe(2);
    expect(model.calls).toHaveLength(0);
  });
});
