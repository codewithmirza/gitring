/**
 * The result of one test run, and the rule that tells whether any test really ran.
 *
 * Reached through `src/core/types.ts`, the front door.
 */
import type { Millis } from "./basics";

export interface CheckCaseResult {
  file: string;
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface CheckRun {
  id: string;
  /** Tree hash or overlay hash that was tested. */
  subject: string;
  /** "attempt" = the attempt alone. "composed" = main + attempt (the landing candidate). "main" = main alone (after GitHub changes came in). */
  scope: "attempt" | "composed" | "main";
  ok: boolean;
  passed: number;
  failed: number;
  cases: CheckCaseResult[];
  ms: number;
  at: Millis;
  /** Runner error (syntax error, timeout). */
  error?: string;
  /** "worker" (Dynamic Worker harness) or "container" (install + test commands). Absent: worker. */
  runner?: "worker" | "container";
  /** Container runs: the end of the combined output (at most 8 KB). */
  log?: string;
  /**
   * How many tests ran (the gitring test harness). 0 means no test ran: nothing is verified, and a
   * person must decide to merge (see noTestRan). Absent on runs from before this field: passed + failed.
   */
  ran?: number;
  /**
   * The run did not happen: the hourly test budget is used. This is not a failure and not a pass.
   * gitring tries again at `retryAt`. `message` is the plain sentence for people and agents.
   */
  wait?: { retryAt: Millis; message: string };
}

/**
 * True when the run verified nothing: the gitring test harness ran no test and nothing failed. A
 * container run is not counted: its exit code decides. A run that waits for the test budget is not
 * counted either: it did not happen.
 */
export function noTestRan(run: Pick<CheckRun, "ok" | "ran" | "runner" | "passed" | "failed" | "wait"> | null | undefined): boolean {
  if (!run || run.wait || !run.ok || run.runner === "container") return false;
  return (run.ran ?? run.passed + run.failed) === 0;
}
