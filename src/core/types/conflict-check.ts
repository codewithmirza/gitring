/**
 * The conflict check (code name course check): distance 0 to 5, facts about a pair, assessments and the verdict.
 *
 * The code that makes these values is in `src/core/coord/` and `src/core/analysis/range.ts`.
 * Reached through `src/core/types.ts`, the front door.
 */
import type { Millis } from "./basics";
import type { LineRange, SymbolKey } from "./plan-and-changes";

/**
 * Range: the distance between two pieces of work in the code graph.
 *   0 same lines or same symbol body changed by both
 *   1 one changes a symbol (or its signature) that the other uses
 *   2 same file, different symbols
 *   3 files linked by a direct import
 *   4 files two imports apart
 *   5 unrelated (open water)
 */
export type Range = 0 | 1 | 2 | 3 | 4 | 5;

export interface PairFacts {
  otherAttemptId: string;
  otherAgentId: string;
  otherIntentId: string;
  /** Status of the other vessel: in flight, waiting to land, or landed after our base. */
  otherState: "active" | "waiting" | "landed";
  sharedFiles: string[];
  /** Symbols both sides define or modify. */
  sharedSymbols: SymbolKey[];
  /** Signature changes on one side that the other side references. */
  interfaceHits: { changedBy: "incoming" | "other"; symbol: SymbolKey; usedAt: string[] }[];
  /** Base-line hunks that overlap on a shared file. */
  hunkOverlaps: { path: string; incoming: LineRange; other: LineRange }[];
  range: Range;
  previousRange?: Range;
  /** Constant bearing, decreasing range: the two are closing on each other. */
  closing: boolean;
  /** Intent title similarity, 0–1 (duplicate signal). */
  intentSimilarity: number;
}

export interface CourseAssessment {
  otherAttemptId: string;
  /** P(the two collide if both continue unchanged). */
  collision: number;
  /** Probability-weighted interference level 0–4 (see INTERFERENCE_LEVELS). */
  interference: number;
  /** P(the incoming intent duplicates the other intent). */
  duplicate: number;
  giveWay: "incoming" | "other";
  giveWayConfidence: number;
  rule: RuleOfTheRoad;
}

export type Verdict = "clear" | "correct" | "merge-intents" | "escalate";

export type RuleOfTheRoad =
  | "R1-landed-has-way" // main always stands on; in-flight work adapts
  | "R2-waiting-stands-on" // work waiting to land stands on against active work
  | "R3-producer-stands-on" // the side that changes an interface stands on; consumers adapt
  | "R4-first-declared-stands-on" // earlier course stands on
  | "R5-priority-stands-on" // high-priority intent stands on
  | "R6-smaller-gives-way"; // smaller footprint adapts (cheaper)

export interface CourseCheck {
  id: string;
  attemptId: string;
  trigger: "declare" | "log" | "write" | "push" | "main-advanced" | "intent-amended";
  verdict: Verdict;
  assessments: CourseAssessment[];
  facts: PairFacts[];
  source: "clef" | "clef-flash" | "rules";
  confidence: number;
  latencyMs: number;
  at: Millis;
  /** Raw decision-model answers, kept for the logbook. */
  raw?: unknown;
}

export const INTERFERENCE_LEVELS = [
  "none: the changes are independent",
  "near: same area, no shared lines or interfaces",
  "textual: the changes edit the same lines and will conflict as text",
  "semantic: one change breaks an interface or behavior the other depends on",
  "contradictory: the intents want opposite outcomes",
] as const;
