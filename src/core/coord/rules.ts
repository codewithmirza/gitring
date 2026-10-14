/**
 * The rules of the road (who gives way) and the offline assessment of a pair, which uses fixed numbers.
 *
 * Called by `clef.ts` (the fallback and the hard rules) and `policy.ts`. Pure functions: they never call a model.
 * R6 always decides, so every pair has an answer.
 */

/*
 * Rules of the road (who gives way) and the deterministic rules assessment (the offline
 * stand-in for Clef, with the same output shape).
 *
 * Order of application: R1 → R2 → R3 → R5 → R4 → R6. The first rule that decides wins.
 * R6 always decides (equal sizes → the incoming vessel gives way).
 *
 * ── Rules assessment heuristics (documented; deterministic) ─────────────────────────────
 *
 *  Facts                                              P(collision)  interference (0–4)
 *  range 0, overlapping hunks or a shared symbol         0.90          2.3  (textual)
 *  range 0 with an interface hit                         0.92          2.9  (textual + semantic)
 *  range 1 with an interface hit (signature change used) 0.75          3.0  (semantic)
 *  range 1, a changed body that the other side uses      0.50          1.8
 *  range 2, same file, other lines                       0.45          1.6  (near → textual)
 *  range 3, one import apart                             0.20          0.9
 *  range 4, two imports apart                            0.08          0.4
 *  range 5, open water                                   0.02          0.1
 *
 *  Modifiers: each extra overlapping hunk pair +0.1 interference (max +0.3);
 *  a shared symbol raises interference to at least 2.4; closing (CBDR) +0.10 collision and
 *  +0.10 interference; landed traffic at range ≤ 2 +0.05 collision (main already has it).
 *  Clamped to collision ∈ [0.01, 0.97], interference ∈ [0, 4].
 *
 *  P(duplicate) from intent similarity s:
 *    s ≥ 0.6        → 0.80 + 0.25·(s − 0.6)   (0.80 … 0.90)
 *    0.4 ≤ s < 0.6  → 0.40 + 1.5·(s − 0.4)    (0.40 … 0.70)
 *    0.2 ≤ s < 0.4  → 0.10 + 1.5·(s − 0.2)    (0.10 … 0.40)
 *    s < 0.2        → 0.5·s                   (0.00 … 0.10)
 *    + 0.10 when s ≥ 0.4 and the two share files (range ≤ 2): same goal, same place.
 *
 *  Give-way confidence by deciding rule: R1 0.95 · R2 0.90 · R3 0.85 · R5 0.80 · R4 0.70 ·
 *  R6 0.60 (0.50 for an R6 tie).
 */

import type { CourseAssessment, PairFacts, Range, RuleOfTheRoad } from "../types";
import { symbolName } from "../analysis/range";
import type { VesselView } from "./facts";

export type Side = "incoming" | "other";

export interface RuleDecision {
  giveWay: Side;
  rule: RuleOfTheRoad;
  reason: string;
}

export interface RuleVerdict {
  rule: RuleOfTheRoad;
  /** null when the rule does not decide for this pair. */
  giveWay: Side | null;
  reason: string;
}

/** Order in which the rules apply. */
export const RULE_ORDER: readonly RuleOfTheRoad[] = [
  "R1-landed-has-way",
  "R2-waiting-stands-on",
  "R3-producer-stands-on",
  "R5-priority-stands-on",
  "R4-first-declared-stands-on",
  "R6-smaller-gives-way",
];

/** Rules that a decision model cannot overrule: landed work cannot adapt, waiting work has stopped. */
export const HARD_RULES: ReadonlySet<RuleOfTheRoad> = new Set<RuleOfTheRoad>(["R1-landed-has-way", "R2-waiting-stands-on"]);

export const RULE_CONFIDENCE: Readonly<Record<RuleOfTheRoad, number>> = {
  "R1-landed-has-way": 0.95,
  "R2-waiting-stands-on": 0.9,
  "R3-producer-stands-on": 0.85,
  "R5-priority-stands-on": 0.8,
  "R4-first-declared-stands-on": 0.7,
  "R6-smaller-gives-way": 0.6,
};
const R6_TIE_CONFIDENCE = 0.5;

const flip = (s: Side): Side => (s === "incoming" ? "other" : "incoming");

interface RuleContext {
  incoming: VesselView;
  other: VesselView;
  facts: PairFacts;
  /** The callsign of the incoming agent. */
  I: string;
  /** The callsign of the other agent. */
  O: string;
  otherState: VesselView["state"];
}

/** Every rule, in order, with its verdict for this pair (null = does not decide). */
export function evaluateRules(incoming: VesselView, other: VesselView, facts: PairFacts): RuleVerdict[] {
  const c: RuleContext = {
    incoming,
    other,
    facts,
    I: incoming.agent.callsign,
    O: other.agent.callsign,
    otherState: facts.otherState ?? other.state,
  };
  return [landedHasWay(c), waitingStandsOn(c), producerStandsOn(c), priorityStandsOn(c), firstDeclaredStandsOn(c), smallerGivesWay(c)];
}

/** R1: landed work has the right of way. */
function landedHasWay(c: RuleContext): RuleVerdict {
  const { incoming, I, O, otherState } = c;
  let giveWay: Side | null = null;
  let reason = "No vessel landed. R1 does not apply.";
  if (otherState === "landed" && incoming.state !== "landed") {
    giveWay = "incoming";
    reason = `${O} landed on main. Landed work has the right of way.`;
  } else if (incoming.state === "landed" && otherState !== "landed") {
    giveWay = "other";
    reason = `${I} landed on main. Landed work has the right of way.`;
  }
  return { rule: "R1-landed-has-way", giveWay, reason };
}

/** R2: work that waits to land stands on against active work. */
function waitingStandsOn(c: RuleContext): RuleVerdict {
  const { incoming, I, O, otherState } = c;
  let giveWay: Side | null = null;
  let reason = "No vessel waits to land against active work. R2 does not apply.";
  if (incoming.state === "waiting" && otherState === "active") {
    giveWay = "other";
    reason = `${I} waits to land. Active work gives way.`;
  } else if (otherState === "waiting" && incoming.state === "active") {
    giveWay = "incoming";
    reason = `${O} waits to land. Active work gives way.`;
  }
  return { rule: "R2-waiting-stands-on", giveWay, reason };
}

/** R3: the producer of an interface change stands on. Consumers adapt. */
function producerStandsOn(c: RuleContext): RuleVerdict {
  const { facts, I, O } = c;
  const producers = new Set(facts.interfaceHits.map((h) => h.changedBy));
  let giveWay: Side | null = null;
  let reason = producers.size ? "Both vessels change an interface that the other uses. R3 does not decide." : "No interface change. R3 does not apply.";
  if (producers.size === 1) {
    const producer = [...producers][0] as Side;
    const hit = facts.interfaceHits.find((h) => h.changedBy === producer)!;
    giveWay = flip(producer);
    reason = `${producer === "incoming" ? I : O} changes the signature of ${symbolName(hit.symbol)}. The producer stands on.`;
  }
  return { rule: "R3-producer-stands-on", giveWay, reason };
}

/** R5: a high-priority intent stands on. */
function priorityStandsOn(c: RuleContext): RuleVerdict {
  const { incoming, other, I, O } = c;
  let giveWay: Side | null = null;
  let reason = "The intents have the same priority. R5 does not decide.";
  const pi = incoming.intent.priority ?? "normal";
  const po = other.intent.priority ?? "normal";
  if (pi === "high" && po !== "high") {
    giveWay = "other";
    reason = `The intent of ${I} has high priority.`;
  } else if (po === "high" && pi !== "high") {
    giveWay = "incoming";
    reason = `The intent of ${O} has high priority.`;
  }
  return { rule: "R5-priority-stands-on", giveWay, reason };
}

/** R4: the earlier course stands on. */
function firstDeclaredStandsOn(c: RuleContext): RuleVerdict {
  const { incoming, other, I, O } = c;
  let giveWay: Side | null = null;
  let reason = "The courses have the same time. R4 does not decide.";
  const di = incoming.attempt.course?.declaredAt ?? incoming.attempt.createdAt;
  const dO = other.attempt.course?.declaredAt ?? other.attempt.createdAt;
  if (di < dO) {
    giveWay = "other";
    reason = `${I} declared its course first.`;
  } else if (dO < di) {
    giveWay = "incoming";
    reason = `${O} declared its course first.`;
  }
  return { rule: "R4-first-declared-stands-on", giveWay, reason };
}

/** R6: the smaller change gives way (it costs less to adapt). A tie: the incoming vessel gives way. */
function smallerGivesWay(c: RuleContext): RuleVerdict {
  const { incoming, other, I, O } = c;
  const si = incoming.footprintSize;
  const so = other.footprintSize;
  let giveWay: Side = "incoming";
  let reason = "The two changes have the same size. The incoming vessel gives way.";
  if (si < so) reason = `${I} has the smaller change. The smaller change gives way.`;
  else if (so < si) {
    giveWay = "other";
    reason = `${O} has the smaller change. The smaller change gives way.`;
  }
  return { rule: "R6-smaller-gives-way", giveWay, reason };
}

/** The first rule that decides (R1, R2, R3, R5, R4, R6). */
export function rulesOfTheRoad(incoming: VesselView, other: VesselView, facts: PairFacts): RuleDecision {
  for (const v of evaluateRules(incoming, other, facts)) {
    if (v.giveWay) return { giveWay: v.giveWay, rule: v.rule, reason: v.reason };
  }
  // Unreachable: R6 always decides.
  return { giveWay: "incoming", rule: "R6-smaller-gives-way", reason: "The incoming vessel gives way." };
}

/** Give-way confidence of a rule decision (R6 tie → 0.5). */
export function ruleConfidence(incoming: VesselView, other: VesselView, decision: RuleDecision): number {
  if (decision.rule === "R6-smaller-gives-way" && incoming.footprintSize === other.footprintSize) return R6_TIE_CONFIDENCE;
  return RULE_CONFIDENCE[decision.rule];
}

/* ───────────────────────────── assessment ───────────────────────────── */

const BASE_BY_RANGE: Readonly<Record<Range, { collision: number; interference: number }>> = {
  0: { collision: 0.9, interference: 2.3 },
  1: { collision: 0.5, interference: 1.8 },
  2: { collision: 0.45, interference: 1.6 },
  3: { collision: 0.2, interference: 0.9 },
  4: { collision: 0.08, interference: 0.4 },
  5: { collision: 0.02, interference: 0.1 },
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** P(duplicate) from intent similarity and shared files (see the table above). */
export function duplicateFromSimilarity(s: number, sharesFiles: boolean): number {
  let p: number;
  if (s >= 0.6) p = 0.8 + 0.25 * (s - 0.6);
  else if (s >= 0.4) p = 0.4 + 1.5 * (s - 0.4);
  else if (s >= 0.2) p = 0.1 + 1.5 * (s - 0.2);
  else p = 0.5 * Math.max(0, s);
  if (s >= 0.4 && sharesFiles) p += 0.1;
  return round3(clamp(p, 0, 0.97));
}

/** Collision and interference from facts alone (see the table above). */
export function riskFromFacts(facts: PairFacts): { collision: number; interference: number } {
  const range = (facts.range in BASE_BY_RANGE ? facts.range : 5) as Range;
  let { collision, interference } = BASE_BY_RANGE[range];
  const hasInterfaceHit = facts.interfaceHits.length > 0;
  if (range === 0) {
    if (hasInterfaceHit) {
      collision = 0.92;
      interference = 2.9;
    }
    if (facts.sharedSymbols.length > 0) interference = Math.max(interference, 2.4);
    if (facts.hunkOverlaps.length > 1) interference += Math.min(0.3, 0.1 * (facts.hunkOverlaps.length - 1));
  } else if (range === 1 && hasInterfaceHit) {
    collision = 0.75;
    interference = 3.0;
  }
  if (facts.closing) {
    collision += 0.1;
    interference += 0.1;
  }
  if (facts.otherState === "landed" && range <= 2) collision += 0.05;
  return { collision: round3(clamp(collision, 0.01, 0.97)), interference: round3(clamp(interference, 0, 4)) };
}

/** Deterministic assessment with the same shape as a Clef answer. */
export function rulesAssessment(incoming: VesselView, other: VesselView, facts: PairFacts): CourseAssessment {
  const { collision, interference } = riskFromFacts(facts);
  const decision = rulesOfTheRoad(incoming, other, facts);
  return {
    otherAttemptId: facts.otherAttemptId,
    collision,
    interference,
    duplicate: duplicateFromSimilarity(facts.intentSimilarity, facts.sharedFiles.length > 0 && facts.range <= 2),
    giveWay: decision.giveWay,
    giveWayConfidence: ruleConfidence(incoming, other, decision),
    rule: decision.rule,
  };
}

/* ───────────────────────────── aggregate (shared with clef.ts) ───────────────────────────── */

/** A candidate "carries risk" at or above these values; the overall confidence looks at those first. */
export const RISK_GATE = { collision: 0.3, interference: 1.2 } as const;

/**
 * Overall confidence of one course check: the minimum confidence among candidates that carry
 * risk (the weakest link where it matters); when no candidate carries risk, the mean over all
 * candidates; 1 when there are no candidates.
 */
export function aggregateConfidence(items: { assessment: CourseAssessment; confidence: number }[]): number {
  if (!items.length) return 1;
  const risky = items.filter((x) => x.assessment.collision >= RISK_GATE.collision || x.assessment.interference >= RISK_GATE.interference);
  const pool = risky.length ? risky : items;
  const value = risky.length ? Math.min(...pool.map((x) => x.confidence)) : pool.reduce((s, x) => s + x.confidence, 0) / pool.length;
  return round3(clamp(value, 0, 1));
}

/**
 * Offline course check (addition): rules assessment for every candidate, with the same
 * output shape as parseClefResponse.
 */
export function assessWithRules(
  incoming: VesselView,
  cands: { view: VesselView; facts: PairFacts }[],
): { assessments: CourseAssessment[]; confidence: number; duplicate: number } {
  const assessments = cands.map((c) => rulesAssessment(incoming, c.view, c.facts));
  return {
    assessments,
    confidence: aggregateConfidence(assessments.map((a) => ({ assessment: a, confidence: a.giveWayConfidence }))),
    duplicate: assessments.reduce((m, a) => Math.max(m, a.duplicate), 0),
  };
}
