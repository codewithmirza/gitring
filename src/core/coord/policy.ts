/**
 * Course-check policy: turn assessments into a verdict.
 *
 *   duplicate ≥ τ.duplicate                               → merge-intents (duplicateOf = most similar)
 *   a pair needs a correction when collision ≥ τ.collision OR interference ≥ τ.interference
 *     any pair needs one, confidence ≥ τ.minConfidence    → correct
 *     confidence < τ.minConfidence, max interference ≥ 3  → escalate (a human decides)
 *     confidence < τ.minConfidence, interference < 3      → correct (cheap and reversible)
 *   else                                                  → clear
 *
 * Confidence = min(model confidence if given, give-way confidence of every pair that needs a
 * correction). With no flagged pair: the model confidence, else the mean give-way confidence.
 * For escalate, `corrections` still lists the pairs at stake (the caller holds or sends them).
 * For merge-intents, `corrections` lists the other flagged pairs (not the duplicate pair).
 */
import type { CourseAssessment, PairFacts, PolicyThresholds, RuleOfTheRoad, Verdict } from "../types";

export interface PolicyOutcome {
  verdict: Verdict;
  confidence: number;
  /** Pairs that need a correction, with the give-way side. */
  corrections: { otherAttemptId: string; giveWay: "incoming" | "other"; rule: RuleOfTheRoad; assessment: CourseAssessment; facts: PairFacts }[];
  duplicateOf?: string; // other attempt id when verdict = merge-intents
}

/** Interference at or above this is "semantic" (level 3): a low-confidence call goes to a human. */
export const ESCALATE_INTERFERENCE = 3;

export function needsCorrection(a: CourseAssessment, t: PolicyThresholds): boolean {
  return a.collision >= t.collision || a.interference >= t.interference;
}

/**
 * A soft pair has no evidence of a clash: the two works are one import apart or more (range 3 and up),
 * the range is not closing, and no interface that one changes is used by the other.
 */
export function isSoftPair(f: PairFacts): boolean {
  return f.range >= 3 && !f.closing && f.interfaceHits.length === 0;
}

/** The ceiling of a soft pair. The decision model cannot raise a soft pair above these scores. */
export const SOFT_PAIR_CAP = { collision: 0.45, interference: 1.4 } as const;

/** The decision model may call two tasks one task only when the words of the two tasks overlap this much. */
export const DUPLICATE_MIN_SIMILARITY = 0.2;
/** Without that overlap, the duplicate score of the decision model counts at most this much. */
export const DUPLICATE_UNSHARED_CAP = 0.5;

/**
 * True when a call to the decision model cannot change the verdict. The fixed rules give the same verdict.
 *
 * Every pair must be soft, so its scores stay under the caps above, and both thresholds must lie above
 * those caps. Then no pair needs a correction, with the model or without it. The model could still
 * call the tasks a duplicate. It cannot when the words of the tasks do not overlap and the duplicate
 * threshold lies above the cap that applies then. A threshold that is not a number never passes.
 */
export function modelCannotChangeVerdict(facts: readonly PairFacts[], t: PolicyThresholds): boolean {
  const thresholdsAbove = SOFT_PAIR_CAP.collision < t.collision && SOFT_PAIR_CAP.interference < t.interference && DUPLICATE_UNSHARED_CAP < t.duplicate;
  return thresholdsAbove && facts.every((f) => isSoftPair(f) && f.intentSimilarity < DUPLICATE_MIN_SIMILARITY);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function placeholderFacts(otherAttemptId: string): PairFacts {
  return {
    otherAttemptId,
    otherAgentId: "",
    otherIntentId: "",
    otherState: "active",
    sharedFiles: [],
    sharedSymbols: [],
    interfaceHits: [],
    hunkOverlaps: [],
    range: 5,
    closing: false,
    intentSimilarity: 0,
  };
}

/** Risk order: collision, then interference, then the lower range. */
function byRisk(x: { assessment: CourseAssessment; facts: PairFacts }, y: { assessment: CourseAssessment; facts: PairFacts }): number {
  return (
    y.assessment.collision - x.assessment.collision ||
    y.assessment.interference - x.assessment.interference ||
    x.facts.range - y.facts.range ||
    (x.assessment.otherAttemptId < y.assessment.otherAttemptId ? -1 : 1)
  );
}

/**
 * Decide the verdict. `duplicate` is the global P(duplicate) (Clef's noul); without it the
 * maximum per-pair duplicate is used. `modelConfidence` (optional extension) is the overall
 * confidence from parseClefResponse.
 */
export function decide(
  assessments: CourseAssessment[],
  facts: PairFacts[],
  thresholds: PolicyThresholds,
  duplicate?: number,
  modelConfidence?: number,
): PolicyOutcome {
  const factsById = new Map(facts.map((f) => [f.otherAttemptId, f]));
  const pairs = assessments.map((assessment) => ({
    assessment,
    facts: factsById.get(assessment.otherAttemptId) ?? placeholderFacts(assessment.otherAttemptId),
  }));
  const model = typeof modelConfidence === "number" && Number.isFinite(modelConfidence) ? modelConfidence : undefined;

  if (!pairs.length) return { verdict: "clear", confidence: round3(model ?? 1), corrections: [] };

  const flagged = pairs.filter((p) => needsCorrection(p.assessment, thresholds)).sort(byRisk);
  const toCorrection = (p: { assessment: CourseAssessment; facts: PairFacts }) => ({
    otherAttemptId: p.assessment.otherAttemptId,
    giveWay: p.assessment.giveWay,
    rule: p.assessment.rule,
    assessment: p.assessment,
    facts: p.facts,
  });

  // 1. Duplicate intents.
  const dup = typeof duplicate === "number" && Number.isFinite(duplicate) ? duplicate : Math.max(0, ...pairs.map((p) => p.assessment.duplicate));
  if (dup >= thresholds.duplicate) {
    const best = [...pairs].sort(
      (x, y) =>
        y.assessment.duplicate - x.assessment.duplicate ||
        y.facts.intentSimilarity - x.facts.intentSimilarity ||
        x.facts.range - y.facts.range ||
        (x.assessment.otherAttemptId < y.assessment.otherAttemptId ? -1 : 1),
    )[0];
    return {
      verdict: "merge-intents",
      confidence: round3(Math.min(model ?? 1, dup)),
      corrections: flagged.filter((p) => p !== best).map(toCorrection),
      duplicateOf: best.assessment.otherAttemptId,
    };
  }

  // 2. Nothing needs a correction.
  if (!flagged.length) {
    const mean = pairs.reduce((s, p) => s + p.assessment.giveWayConfidence, 0) / pairs.length;
    return { verdict: "clear", confidence: round3(model ?? mean), corrections: [] };
  }

  // 3. Corrections, or a human when the call is uncertain and the risk is semantic.
  const confidence = Math.min(model ?? 1, ...flagged.map((p) => p.assessment.giveWayConfidence));
  const maxInterference = Math.max(...flagged.map((p) => p.assessment.interference));
  const verdict: Verdict =
    confidence >= thresholds.minConfidence ? "correct" : maxInterference >= ESCALATE_INTERFERENCE ? "escalate" : "correct";
  return { verdict, confidence: round3(confidence), corrections: flagged.map(toCorrection) };
}
