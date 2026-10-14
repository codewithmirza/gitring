/**
 * A work copy (code name attempt): one agent's work on one task, and everything gitring keeps about it.
 *
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Approval } from "./approvals";
import type { Millis, Person } from "./basics";
import type { CheckRun } from "./checks";
import type { ChangeMeaning, Course, Footprint } from "./plan-and-changes";

export type AttemptStatus =
  | "declared" // course declared, fork ready, no edits yet
  | "underway" // edits in progress
  | "submitted" // agent says done; waiting for checks
  | "checking"
  | "ready" // checks pass; waiting for a pick or the landing queue
  | "landing"
  | "landed"
  | "stale" // could not land on the new main; re-derive scheduled
  | "rederiving"
  | "alternate" // a sibling attempt landed; this one stays visible as an alternate
  | "abandoned"
  | "failed";

export interface Attempt {
  id: string;
  intentId: string;
  agentId: string;
  fork: { repo: string; remote?: string };
  /** "api": gitring holds the working tree (MCP read/write). "git": the agent pushes to the fork. */
  mode: "api" | "git";
  baseSha: string;
  baseTree: string;
  headSha?: string;
  status: AttemptStatus;
  course: Course;
  footprint: Footprint;
  /** What the change means: comments, formatting, documentation, tests or logic (set with the footprint). */
  meaning?: ChangeMeaning;
  /** Ids of corrections sent to this attempt. */
  corrections: string[];
  checks?: CheckRun;
  composedChecks?: CheckRun;
  lineage: { generation: number; rederivedFrom?: string };
  /** Set when main moved and some files of a waiting attempt overlap the landed change: landing re-derives them. */
  drift?: { mainSha: string; overlaps: string[] };
  /** Built-in agents only: the hourly AI budget is used, so the agent starts at this time (gitring retries then). */
  waitsForBudget?: Millis;
  /**
   * Outside agents: the work could not merge and came back to its agent (redo policy). Any tool call of
   * the agent on this work copy clears it. At `until`, a built-in agent (agent-first) or a person
   * (agent-only) takes over.
   */
  returned?: { at: Millis; until: Millis; reason: string; policy: "agent-first" | "agent-only" };
  /** How many times the work came back to its agent. */
  returns?: number;
  /**
   * The merge waits: the hourly test budget is used. The work copy stays in the merge queue until `until`.
   * This is not a failure and does not count as a return. `message` is the plain sentence for people.
   */
  mergeWait?: { until: Millis; message: string };
  /**
   * How many times the merge of this work copy stopped with an error (a repository that did not answer, for
   * example). gitring tries the merge again after a short wait, and asks a person after the fourth stop.
   */
  mergeStops?: number;
  /**
   * Set when the work copy stopped and a person decides what happens next (a redo question): the plain
   * reason. The agent reads it in the answer of its next call.
   */
  stoppedFor?: string;
  summary?: string;
  /**
   * The person who sent the agent: the one who connected it, or who started the built-in agent. Absent on
   * old work copies and on work that no person started. This person answers the approval of the work.
   */
  sender?: Person;
  /**
   * The latest approval of this work copy (see Approval). A new ask replaces it; the old answers stay in
   * the decisions and the log.
   */
  approval?: Approval;
  stats: { filesChanged: number; additions: number; deletions: number; steps: number; tokens?: number };
  createdAt: Millis;
  updatedAt: Millis;
  landedAt?: Millis;
}
