import { describe, expect, it } from "vitest";
import { decide, needsCorrection } from "../../src/core/coord/policy";
import { DEFAULT_THRESHOLDS, type CourseAssessment, type PairFacts, type PolicyThresholds } from "../../src/core/types";

// The policy tests pin their own thresholds (the product default for interference is 1.7).
const T: PolicyThresholds = { ...DEFAULT_THRESHOLDS, interference: 1.5 }; // collision 0.5, interference 1.5, duplicate 0.7, minConfidence 0.55

const a = (id: string, over: Partial<CourseAssessment> = {}): CourseAssessment => ({
  otherAttemptId: id,
  collision: 0.1,
  interference: 0.5,
  duplicate: 0.02,
  giveWay: "incoming",
  giveWayConfidence: 0.8,
  rule: "R4-first-declared-stands-on",
  ...over,
});
const f = (id: string, over: Partial<PairFacts> = {}): PairFacts => ({
  otherAttemptId: id,
  otherAgentId: `agt_${id}`,
  otherIntentId: `int_${id}`,
  otherState: "active",
  sharedFiles: [],
  sharedSymbols: [],
  interfaceHits: [],
  hunkOverlaps: [],
  range: 3,
  closing: false,
  intentSimilarity: 0.1,
  ...over,
});

describe("decide", () => {
  it("clears when no pair reaches a threshold (and when there is no pair)", () => {
    const out = decide([a("x"), a("y", { collision: 0.49, interference: 1.49 })], [f("x"), f("y")], T);
    expect(out).toEqual({ verdict: "clear", confidence: 0.8, corrections: [] });
    expect(decide([], [], T)).toEqual({ verdict: "clear", confidence: 1, corrections: [] });
  });

  it("thresholds are inclusive: collision ≥ τc or interference ≥ τi", () => {
    expect(needsCorrection(a("x", { collision: 0.5 }), T)).toBe(true);
    expect(needsCorrection(a("x", { interference: 1.5 }), T)).toBe(true);
    expect(needsCorrection(a("x", { collision: 0.499, interference: 1.499 }), T)).toBe(false);
  });

  it("corrects the flagged pairs, riskiest first, with the give-way side and rule", () => {
    const out = decide(
      [
        a("near", { collision: 0.45, interference: 1.6, giveWay: "other", rule: "R6-smaller-gives-way", giveWayConfidence: 0.6 }),
        a("far"),
        a("hit", { collision: 0.75, interference: 3, rule: "R3-producer-stands-on", giveWayConfidence: 0.85 }),
      ],
      [f("near", { range: 2 }), f("far"), f("hit", { range: 1 })],
      T,
    );
    expect(out.verdict).toBe("correct");
    expect(out.corrections.map((c) => [c.otherAttemptId, c.giveWay, c.rule])).toEqual([
      ["hit", "incoming", "R3-producer-stands-on"],
      ["near", "other", "R6-smaller-gives-way"],
    ]);
    expect(out.corrections[0].facts.range).toBe(1);
    expect(out.confidence).toBe(0.6); // the weakest flagged give-way decision
  });

  it("(h) escalates a low-confidence call when the risk is semantic (interference ≥ 3)", () => {
    const out = decide([a("x", { collision: 0.8, interference: 3.2, giveWayConfidence: 0.4 })], [f("x", { range: 1 })], T);
    expect(out.verdict).toBe("escalate");
    expect(out.confidence).toBe(0.4);
    expect(out.corrections).toHaveLength(1); // the pair at stake, for the human
  });

  it("(h) still corrects a low-confidence call when the risk is only textual (cheap and reversible)", () => {
    const out = decide([a("x", { collision: 0.9, interference: 2.3, giveWayConfidence: 0.4 })], [f("x", { range: 0 })], T);
    expect(out.verdict).toBe("correct");
  });

  it("(h) uses the model confidence when the caller passes it", () => {
    const risky = [a("x", { collision: 0.8, interference: 3.1, giveWayConfidence: 0.9 })];
    expect(decide(risky, [f("x")], T, undefined, 0.3).verdict).toBe("escalate");
    expect(decide(risky, [f("x")], T, undefined, 0.7)).toMatchObject({ verdict: "correct", confidence: 0.7 });
    // Custom thresholds: a stricter project.
    const strict: PolicyThresholds = { collision: 0.3, interference: 1, duplicate: 0.9, minConfidence: 0.95 };
    expect(decide([a("x", { collision: 0.35, giveWayConfidence: 0.9 })], [f("x")], strict).verdict).toBe("correct");
    expect(decide([a("x", { collision: 0.35, interference: 3, giveWayConfidence: 0.9 })], [f("x")], strict).verdict).toBe("escalate");
  });

  it("(f) merges intents when P(duplicate) ≥ τd and names the most similar attempt", () => {
    const out = decide(
      [
        a("darkmode", { duplicate: 0.9, collision: 0.9, interference: 2.4 }),
        a("search", { duplicate: 0.05, collision: 0.9, interference: 2.4 }),
        a("api", { duplicate: 0.01 }),
      ],
      [f("darkmode", { intentSimilarity: 0.6, range: 0 }), f("search", { range: 0 }), f("api")],
      T,
    );
    expect(out.verdict).toBe("merge-intents");
    expect(out.duplicateOf).toBe("darkmode");
    // The other flagged pair still gets its correction; the duplicate pair does not.
    expect(out.corrections.map((c) => c.otherAttemptId)).toEqual(["search"]);
    expect(out.confidence).toBe(0.9);
  });

  it("(f) a global duplicate probability (Clef's noul) decides; ties go to the most similar intent", () => {
    const out = decide([a("x", { duplicate: 0.4 }), a("y", { duplicate: 0.4 })], [f("x", { intentSimilarity: 0.2 }), f("y", { intentSimilarity: 0.7 })], T, 0.85);
    expect(out).toMatchObject({ verdict: "merge-intents", duplicateOf: "y" });
    expect(decide([a("x", { duplicate: 0.95 })], [f("x")], T, 0.1).verdict).toBe("clear");
  });

  it("works when facts are missing for an assessment", () => {
    const out = decide([a("ghost", { collision: 0.9 })], [], T);
    expect(out.verdict).toBe("correct");
    expect(out.corrections[0].facts.otherAttemptId).toBe("ghost");
  });
});
