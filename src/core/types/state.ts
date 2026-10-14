/**
 * The whole state of a project, and the live events that the web app and the webhooks receive.
 *
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Approval } from "./approvals";
import type { AgentInfo, Millis } from "./basics";
import type { Correction } from "./change-requests";
import type { CourseCheck, Range, Verdict } from "./conflict-check";
import type { GithubSyncStatus } from "./github";
import type { FileNode, Project } from "./projects";
import type { Question } from "./questions";
import type { Decision, Landing, LandingMethod, LogEntry } from "./records";
import type { Intent } from "./tasks";
import type { Attempt } from "./work-copies";

export interface RadarPair {
  a: string; // attempt id
  b: string;
  range: Range;
  closing: boolean;
  /** Last course-check verdict that involved both ("clear" for a pair that is too far apart to collide). */
  verdict?: Verdict;
  updatedAt: Millis;
}

export interface ProjectState {
  project: Project;
  intents: Intent[];
  attempts: Attempt[];
  agents: AgentInfo[];
  corrections: Correction[];
  checks: CourseCheck[];
  landings: Landing[];
  decisions: Decision[];
  /** Questions for a person (open ones, and the latest answered ones). Absent from old project objects. */
  questions?: Question[];
  logs: LogEntry[];
  radar: RadarPair[];
  /** Files of main (the chart's land mass). */
  files: FileNode[];
  /** Import edges of main, as [from, to] paths. */
  imports: [string, string][];
  stats: HarborStats;
}

export interface HarborStats {
  courseChecks: number;
  clear: number;
  corrections: number;
  correctionsAcknowledged: number;
  escalations: number;
  landings: number;
  landedByMethod: Record<LandingMethod, number>;
  rederives: number;
  /** Times gitring moved in-flight work onto a new main (re-plot). */
  replots?: number;
  /** Merges that gitring took back because the tests of main failed after them (post-merge test mode). */
  reverts?: number;
  /** Trains: times several independent work copies merged in one go. */
  trains?: number;
  medianCheckLatencyMs: number;
}

export type GitringEventType =
  | "snapshot"
  | "intent"
  | "attempt"
  | "agent"
  | "correction"
  | "check"
  | "landing"
  | "decision"
  | "log"
  | "radar"
  | "main"
  | "stats"
  | "github"
  | "approval"
  | "question";

export type GitringEvent =
  | { type: "snapshot"; state: ProjectState }
  | { type: "intent"; intent: Intent }
  | { type: "attempt"; attempt: Attempt }
  | { type: "agent"; agent: AgentInfo }
  | { type: "correction"; correction: Correction }
  | { type: "check"; check: CourseCheck }
  | { type: "landing"; landing: Landing }
  | { type: "decision"; decision: Decision }
  | { type: "log"; log: LogEntry }
  | { type: "radar"; pairs: RadarPair[] }
  | { type: "main"; sha: string; tree: string; files: FileNode[]; imports: [string, string][] }
  | { type: "stats"; stats: HarborStats }
  | { type: "github"; github: GithubSyncStatus }
  /** Webhooks only: an approval was asked, answered or withdrawn. The UI reads `attempt.approval` from "attempt" events. */
  | { type: "approval"; attemptId: string; approval: Approval }
  /** A question for a person was asked, answered or closed. */
  | { type: "question"; question: Question };
