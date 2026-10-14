import { describe, expect, it } from "vitest";
import {
  DUPLICATE_MIN_SIMILARITY,
  DUPLICATE_UNSHARED_CAP,
  SOFT_PAIR_CAP,
  decide,
  hasHardFacts,
  isSoftPair,
  modelCannotChangeVerdict,
  modelConfidence,
  needsCorrection,
  pairConfidence,
} from "../../src/core/coord/policy";
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

describe("modelCannotChangeVerdict", () => {
  // A soft pair: one import apart, not closing, no interface hit, and intents with no words in common.
  const soft = (id: string, over: Partial<PairFacts> = {}) => f(id, { range: 3, intentSimilarity: 0.05, ...over });
  const hit = { changedBy: "other" as const, symbol: "src/a.js#a", usedAt: ["src/b.js"] };

  it("a soft pair has no evidence of a clash", () => {
    expect(isSoftPair(soft("x"))).toBe(true);
    expect(isSoftPair(soft("x", { range: 4 }))).toBe(true);
    expect(isSoftPair(soft("x", { range: 2 }))).toBe(false);
    expect(isSoftPair(soft("x", { closing: true, previousRange: 4 }))).toBe(false);
    expect(isSoftPair(soft("x", { interfaceHits: [hit] }))).toBe(false);
  });

  it("is true when every pair is soft, the intents share no words and the thresholds lie above the caps", () => {
    expect(modelCannotChangeVerdict([soft("x")], DEFAULT_THRESHOLDS)).toBe(true);
    expect(modelCannotChangeVerdict([soft("x"), soft("y", { otherState: "landed" })], DEFAULT_THRESHOLDS)).toBe(true);
    // No pair: there is nothing to ask.
    expect(modelCannotChangeVerdict([], DEFAULT_THRESHOLDS)).toBe(true);
  });

  it("is false when one pair is not soft", () => {
    for (const over of [{ range: 2 }, { range: 1 }, { range: 0 }, { closing: true, previousRange: 4 }, { interfaceHits: [hit] }] as Partial<PairFacts>[]) {
      expect(modelCannotChangeVerdict([soft("x"), soft("y", over)], DEFAULT_THRESHOLDS)).toBe(false);
    }
  });

  it("is false when the intents share words: the model may call two tasks one task", () => {
    expect(modelCannotChangeVerdict([soft("x", { intentSimilarity: DUPLICATE_MIN_SIMILARITY - 0.001 })], DEFAULT_THRESHOLDS)).toBe(true);
    expect(modelCannotChangeVerdict([soft("x", { intentSimilarity: DUPLICATE_MIN_SIMILARITY })], DEFAULT_THRESHOLDS)).toBe(false);
    expect(modelCannotChangeVerdict([soft("x"), soft("y", { intentSimilarity: 0.6 })], DEFAULT_THRESHOLDS)).toBe(false);
  });

  it("is false when a threshold lies at or below its cap, or is not a number", () => {
    const at = (over: Partial<PolicyThresholds>): PolicyThresholds => ({ ...DEFAULT_THRESHOLDS, ...over });
    const pair = [soft("x")];
    expect(modelCannotChangeVerdict(pair, at({ collision: SOFT_PAIR_CAP.collision }))).toBe(false);
    expect(modelCannotChangeVerdict(pair, at({ collision: SOFT_PAIR_CAP.collision + 0.01 }))).toBe(true);
    expect(modelCannotChangeVerdict(pair, at({ interference: SOFT_PAIR_CAP.interference }))).toBe(false);
    expect(modelCannotChangeVerdict(pair, at({ interference: SOFT_PAIR_CAP.interference + 0.01 }))).toBe(true);
    expect(modelCannotChangeVerdict(pair, at({ duplicate: DUPLICATE_UNSHARED_CAP }))).toBe(false);
    expect(modelCannotChangeVerdict(pair, at({ duplicate: DUPLICATE_UNSHARED_CAP + 0.01 }))).toBe(true);
    expect(modelCannotChangeVerdict(pair, at({ collision: Number.NaN }))).toBe(false);
    expect(modelCannotChangeVerdict(pair, at({ duplicate: Number.NaN }))).toBe(false);
  });

  it("keeps every verdict: the worst answer that the caps allow gives what the fixed rules give", () => {
    const facts = [soft("x"), soft("y", { intentSimilarity: DUPLICATE_MIN_SIMILARITY - 0.01, range: 4 })];
    // The model at its ceiling, with the largest duplicate score that it may give for tasks that share no words.
    const worst = facts.map((x) => a(x.otherAttemptId, { collision: SOFT_PAIR_CAP.collision, interference: SOFT_PAIR_CAP.interference, duplicate: DUPLICATE_UNSHARED_CAP }));
    const rules = facts.map((x) => a(x.otherAttemptId, { collision: 0.2, interference: 0.9, duplicate: 0.05 }));
    const sets: PolicyThresholds[] = [
      DEFAULT_THRESHOLDS,
      { ...DEFAULT_THRESHOLDS, collision: 0.46 },
      { collision: 1, interference: 4, duplicate: 1, minConfidence: 1 },
      { collision: 0.46, interference: 1.41, duplicate: 0.51, minConfidence: 0.1 },
    ];
    for (const t of sets) {
      expect(modelCannotChangeVerdict(facts, t)).toBe(true);
      expect(decide(worst, facts, t, DUPLICATE_UNSHARED_CAP).verdict).toBe("clear");
      expect(decide(rules, facts, t, 0.05).verdict).toBe("clear");
    }
    // A threshold at a cap lets the model change the verdict, so the model stays in the loop.
    for (const low of [{ collision: SOFT_PAIR_CAP.collision }, { interference: SOFT_PAIR_CAP.interference }, { duplicate: DUPLICATE_UNSHARED_CAP }]) {
      const t = { ...DEFAULT_THRESHOLDS, ...low };
      expect(modelCannotChangeVerdict(facts, t)).toBe(false);
      expect(decide(worst, facts, t, DUPLICATE_UNSHARED_CAP).verdict).not.toBe("clear");
      expect(decide(rules, facts, t, 0.05).verdict).toBe("clear");
    }
  });
});

describe("modelConfidence (the doubt of the decision model)", () => {
  // x: a flagged semantic pair with hard facts (an interface that the other side uses).
  const semantic = { facts: f("x", { range: 1, interfaceHits: [{ changedBy: "incoming" as const, symbol: "src/a.js#f", usedAt: ["src/b.js"] }] }), assessment: a("x", { collision: 0.8, interference: 3.2 }) };
  // y: an unrelated pair where the model answered with a coin flip.
  const coinFlip = { facts: f("y", { range: 2, sharedFiles: ["src/c.js"] }), assessment: a("y", { collision: 0.48, interference: 1.0 }) };

  it("counts hard facts and how far a collision answer lies from a coin flip", () => {
    expect(hasHardFacts(semantic.facts)).toBe(true);
    expect(hasHardFacts(coinFlip.facts)).toBe(false);
    expect(pairConfidence(semantic.facts, semantic.assessment)).toBe(0.9);
    expect(pairConfidence(coinFlip.facts, coinFlip.assessment)).toBe(0.3);
    expect(pairConfidence(coinFlip.facts, a("y", { collision: 0.95 }))).toBeCloseTo(0.9);
  });

  it("looks only at the pairs that need a change request: one unrelated coin flip does not send the check to a person", () => {
    const conf = modelConfidence([semantic, coinFlip], T);
    expect(conf).toBe(0.9);
    expect(decide([semantic.assessment, coinFlip.assessment], [semantic.facts, coinFlip.facts], T, 0.02, conf).verdict).toBe("correct");
    // Before, the minimum over all pairs (0.3) made the same check "escalate".
    expect(decide([semantic.assessment, coinFlip.assessment], [semantic.facts, coinFlip.facts], T, 0.02, 0.3).verdict).toBe("escalate");
  });

  it("uses the weakest pair of all when no pair needs a change request, and 1 without assessments", () => {
    expect(modelConfidence([coinFlip], T)).toBe(0.3);
    expect(modelConfidence([{ facts: f("z") }], T)).toBe(1);
    expect(modelConfidence([], T)).toBe(1);
    // A flagged pair without hard facts and with a coin-flip answer still counts.
    const doubtful = { facts: f("w", { range: 2 }), assessment: a("w", { collision: 0.55, interference: 3.1 }) };
    expect(modelConfidence([semantic, doubtful], T)).toBeCloseTo(0.3);
  });
});
