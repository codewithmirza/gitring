/**
 * The compact Clef brief: the facts of each pair in plain words, and the task facts that the rules of
 * the road need (R5 reads the priority).
 */
import { describe, expect, it } from "vitest";
import { buildBriefClefRequest, factsLines, taskLine } from "../../src/core/coord/clef-brief";
import type { PairFacts } from "../../src/core/types";
import { currencyVessel, darkModeVessel, intents, searchVessel } from "./fixtures";

const facts = (over: Partial<PairFacts>): PairFacts => ({
  otherAttemptId: "att_x",
  otherAgentId: "agt_x",
  otherIntentId: "int_x",
  otherState: "active",
  sharedFiles: [],
  sharedSymbols: [],
  interfaceHits: [],
  hunkOverlaps: [],
  range: 5,
  closing: false,
  intentSimilarity: 0,
  ...over,
});

describe("factsLines", () => {
  it("names the import distance only where it is true", () => {
    expect(factsLines(facts({ range: 3 }), "v0")).toContain("They edit different files that are one import apart.");
    expect(factsLines(facts({ range: 4 }), "v0")).toContain("They edit different files that are two imports apart.");
    expect(factsLines(facts({ range: 5 }), "v0")).toContain("They edit unrelated files.");
    for (const range of [0, 1, 2] as const) {
      const lines = factsLines(facts({ range, sharedSymbols: range === 0 ? ["src/a.js#f"] : [] }), "v0");
      expect(lines.some((l) => l.includes("import"))).toBe(false);
      expect(lines).toContain(range === 1 ? "They edit different files. One changes code that the other uses." : "They edit different files.");
    }
    // Range 1 with an interface hit: the hit line says it already.
    const hit = factsLines(facts({ range: 1, interfaceHits: [{ changedBy: "other", symbol: "src/a.js#f", usedAt: ["src/b.js"] }] }), "v0");
    expect(hit).toContain("They edit different files.");
    expect(hit).toContain("v0 changes the interface of f; the incoming agent uses it in src/b.js.");
  });

  it("does not add a distance line for a shared file", () => {
    const lines = factsLines(facts({ range: 2, sharedFiles: ["src/render.js"] }), "v0");
    expect(lines).toContain("Both edit src/render.js, in different lines.");
    expect(lines.some((l) => l.startsWith("They edit"))).toBe(false);
  });
});

describe("the brief", () => {
  it("gives each task its priority and its constraints (short)", () => {
    const urgent = searchVessel({ intent: { ...intents.search, priority: "high", constraints: ["Keep the header under 60 px.", "Use the existing CSS tokens."] } });
    expect(taskLine(urgent)).toBe("priority high; constraints: Keep the header under 60 px., Use the existing CSS tokens.");
    expect(taskLine(currencyVessel())).toBe("priority normal");
    const long = searchVessel({ intent: { ...intents.search, constraints: ["x".repeat(300), "a", "b", "c"] } });
    expect(taskLine(long)).toMatch(/^priority normal; constraints: x{99}…, a, b and 1 more$/);
  });

  it("puts the task line of the incoming work and of each vessel into the state", () => {
    const incoming = searchVessel({ intent: { ...intents.search, priority: "high" } });
    const other = darkModeVessel();
    const req = buildBriefClefRequest("clef", incoming, [{ view: other, facts: facts({ otherAttemptId: other.attempt.id, range: 0, sharedFiles: ["src/render.js"] }) }]);
    const state = String(req.state);
    expect(req.model).toBe("clef");
    expect(state).toContain("Incoming task: priority high.");
    expect(state).toContain("v0 task: priority normal.");
  });
});
