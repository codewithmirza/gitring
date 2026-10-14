/**
 * A task (code name intent): its goal, its checks, its status and its amendments.
 *
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Actor, Millis } from "./basics";

export type IntentStatus =
  | "draft" // written, checks not approved yet
  | "open" // ready; agents can take it
  | "underway" // at least one attempt is active
  | "judging" // attempts are ready; a human pick is necessary
  | "landing" // in the landing queue
  | "landed"
  | "parked" // human stopped it
  | "merged-into"; // a duplicate; merged into another intent

export interface CheckSpec {
  id: string;
  /** Repo-relative path of the test file, for example `tests/dark-mode.test.js`. */
  path: string;
  /** Test source. gitring writes it into each attempt's working tree. */
  content: string;
  description: string;
}

export interface Amendment {
  version: number;
  at: Millis;
  by: Actor;
  /** Why the intent changed (a human edit, a correction, a merged duplicate). */
  reason: string;
  /** The text added to the goal or constraints. */
  text: string;
}

export interface Intent {
  id: string;
  title: string;
  /** Markdown. The living spec. */
  goal: string;
  /** Extra constraints that corrections or humans add. Agents must follow them. */
  constraints: string[];
  checks: CheckSpec[];
  scope?: { paths?: string[]; symbols?: string[] };
  priority: "normal" | "high";
  status: IntentStatus;
  version: number;
  amendments: Amendment[];
  createdBy: Actor;
  createdAt: Millis;
  updatedAt: Millis;
  parentId?: string;
  mergedInto?: string;
  chosenAttemptId?: string;
  landedSha?: string;
  /** How many built-in agents a launch starts by default (best-of-N). */
  suggestedFanout?: number;
  source: { kind: "ui" | "mcp" | "webhook" | "seed"; ref?: string };
}
