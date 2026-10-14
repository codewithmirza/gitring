/**
 * The types of a replay script: the kinds of step, the stage of each kind and the shape of a step.
 * Read by build-script.ts (which makes the steps) and by every file that plays them.
 */
import type { AgentInfo, Attempt, CheckRun, Correction, CourseCheck, Landing } from "../../../../../src/core/types";
import type { TimelineIntent } from "../../../../../src/core/timeline";
import type { Stage, SubmitOutcome } from "../captions";

export type StepKind =
  | "task"
  | "launch"
  | "plan"
  | "check"
  | "request"
  | "deliver"
  | "ack"
  | "work"
  | "tests"
  | "submit"
  | "decision"
  | "lease"
  | "compose"
  | "composed"
  | "commit"
  | "replot"
  | "stale"
  | "end"
  | "note";

/** The order of kinds at the same time: a lease before its compose, the tests of main plus the work before the commit. */
export const KIND_ORDER: Record<StepKind, number> = {
  task: 0,
  launch: 1,
  plan: 2,
  check: 3,
  request: 4,
  deliver: 5,
  ack: 6,
  work: 7,
  tests: 8,
  submit: 9,
  decision: 10,
  lease: 11,
  compose: 12,
  composed: 13,
  commit: 14,
  replot: 15,
  stale: 16,
  end: 17,
  note: 18,
};

export const STAGE_OF: Record<StepKind, Stage> = {
  task: "task",
  launch: "task",
  plan: "plan",
  check: "check",
  request: "request",
  deliver: "request",
  ack: "request",
  work: "work",
  tests: "tests",
  submit: "queue",
  decision: "queue",
  lease: "queue",
  compose: "compose",
  composed: "composed",
  commit: "commit",
  replot: "replot",
  stale: "replot",
  end: "work",
  note: "note",
};

export function stageOf(kind: StepKind): Stage {
  return STAGE_OF[kind];
}

export interface TestSummary {
  scope: "attempt" | "composed";
  passed: number;
  total: number;
  ok: boolean;
  /** The cases, when the run is known in full (the latest run of a work copy, or the run of a merge). */
  cases?: CheckRun["cases"];
  ms?: number;
  /** The tests did not run: the hourly test budget is used. */
  waits?: boolean;
}

export interface ReplayStep {
  /** Unique and stable for the same history. */
  id: string;
  /** History time (ms). */
  at: number;
  kind: StepKind;
  stage: Stage;
  /** One plain sentence or two (STE). */
  caption: string;
  /** How long the step holds the screen: 1 short, 2 normal, 3 long. */
  weight: 1 | 2 | 3;
  attemptId?: string;
  intentId?: string;
  /** Files that the step touches on the map. */
  files?: string[];
  check?: CourseCheck;
  correction?: Correction;
  tests?: TestSummary;
  landing?: Landing;
  submit?: SubmitOutcome;
  /** A replot: the work copies that move onto the new main. */
  others?: string[];
  /** The words of an agent or a person (data, shown as a quote). */
  quote?: string;
  /** The sentence of gitring behind the step, when it says more than the caption. */
  detail?: string;
}

export interface ReplayScript {
  steps: ReplayStep[];
  intents: Map<string, TimelineIntent>;
  attempts: Map<string, Attempt>;
  agents: Map<string, AgentInfo>;
  corrections: Map<string, Correction>;
  checks: Map<string, CourseCheck>;
  landings: Landing[];
  /** Work copy → the work copy that redid it. */
  redoOf: Map<string, string>;
  /** History time of the first and the last step. */
  start: number;
  end: number;
}
