/**
 * The records of what happened: log lines, merges (code name landings) and decisions of people.
 *
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Actor, Millis } from "./basics";
import type { CheckRun } from "./checks";
import type { TestsWhen } from "./settings";

export type LogKind =
  | "declare"
  | "log"
  | "write"
  | "push"
  | "check"
  | "correction"
  | "ack"
  | "submit"
  | "land"
  | "stale"
  | "rederive"
  | "replot"
  | "decision"
  | "intent"
  | "system";

export interface LogEntry {
  id: string;
  at: Millis;
  kind: LogKind;
  attemptId?: string;
  agentId?: string;
  intentId?: string;
  message: string;
  files?: string[];
  data?: Record<string, unknown>;
}

/** How work got onto main. "revert": the merge of the work was taken back (tests failed on main). */
export type LandingMethod = "fast-forward" | "merge" | "rederive" | "revert";

export interface Landing {
  id: string;
  attemptId: string;
  intentId: string;
  agentId: string;
  method: LandingMethod;
  mainBefore: string;
  mainAfter: string;
  checks: CheckRun;
  correctionsApplied: number;
  at: Millis;
  /** Commit message (with gitring trailers). */
  message: string;
  /** The merge rode in a train of independent work: its place in the train, and the size of the train. */
  train?: { id: string; place: number; size: number };
  /** When the tests of main plus the work ran: before the merge (absent on old records), or after it. */
  testsWhen?: TestsWhen;
  /** Method "revert": the merge that this commit takes back, the reason, and the tests that failed on main. */
  revert?: { of: string; mainSha: string; reason: string; failed: string[] };
}

export type DecisionKind = "pick" | "send-back" | "park" | "rederive" | "amend" | "approve-checks" | "resolve-escalation";

export interface Decision {
  id: string;
  kind: DecisionKind;
  intentId: string;
  attemptIds: string[];
  by: Actor;
  rationale: string;
  at: Millis;
}
