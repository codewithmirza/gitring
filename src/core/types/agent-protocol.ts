/**
 * The inputs and answers of the agent tools (MCP and built-in agents): declare, write, submit, wait and more.
 *
 * Every field here is part of the public protocol. Never rename one.
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Approval } from "./approvals";
import type { AgentKind, Millis } from "./basics";
import type { Correction, CorrectionKind } from "./change-requests";
import type { CheckRun } from "./checks";
import type { Verdict } from "./conflict-check";
import type { SymbolKey } from "./plans";
import type { Landing, LandingMethod } from "./records";
import type { Intent, IntentStatus } from "./tasks";
import type { TrafficVessel } from "./traffic";
import type { AttemptStatus } from "./work-copies";

export interface AgentIdentity {
  /** Stable id from the client if it has one; gitring creates one if absent. */
  id?: string;
  name?: string;
  client?: string;
  model?: string;
  kind?: AgentKind;
}

/** Answer of gitring_update: how the agent brings the new main into its work copy. */
export type UpdateResult =
  | { mode: "api"; mainSha: string; merged: string[]; readAgain: string[]; message: string }
  | { mode: "git"; mainSha: string; branch: string; remote: string; token: string; tokenExpiresAt: string; commands: string[]; message: string };

export interface DeclareInput {
  agent: AgentIdentity;
  /** Join an existing intent… */
  intentId?: string;
  /** …or bring a new intent (gitring creates it, then checks for duplicates). */
  newIntent?: { title: string; goal: string };
  plan: string[];
  files: string[];
  symbols: string[];
  /** Symbols the plan will call but not change (`path#name`), see Course.uses. */
  uses?: string[];
  approach: string;
  /** "git" asks for a fork remote + token; "api" uses gitring_read / gitring_write. */
  mode?: "api" | "git";
}

export interface CorrectionNotice {
  id: string;
  kind: CorrectionKind;
  message: string;
  constraints: Correction["constraints"];
  from?: string; // callsign of the stand-on vessel
  more?: number; // other vessels that edit the same lines (see Correction.alsoStandOn)
}

export interface Clearance {
  verdict: Verdict;
  /** New corrections since the agent last saw any. The agent must apply them. */
  corrections: CorrectionNotice[];
  /** Nearby vessels (their live context). */
  traffic: TrafficVessel[];
  /** One-line summary for the agent. */
  advice: string;
}

/** Answer of gitring_ack. */
export interface AckResult {
  correctionId: string;
  /**
   * "acknowledged": the change request is closed. "open": the code check failed, so the change request
   * stays open. "already": the agent confirmed it before, or the work merged.
   */
  outcome: "acknowledged" | "open" | "already";
  check?: Correction["check"];
  /** One sentence for the agent. */
  message: string;
  clearance: Clearance;
}

/** Something new for a work copy, for an agent that waits (gitring_wait). */
export interface WaitEvent {
  kind: "change-request" | "main-moved" | "approval" | "status";
  at: Millis;
  /** One sentence for the agent. */
  message: string;
  correctionId?: string;
  mainSha?: string;
  status?: AttemptStatus;
  approval?: Approval["status"];
}

/** Answer of gitring_wait: the news, or no news after the time ran out. */
export interface WaitResult {
  attemptId: string;
  status: AttemptStatus;
  events: WaitEvent[];
  clearance: Clearance;
  /** One sentence for the agent: what to do now. */
  message: string;
}

export interface DeclareResult {
  attemptId: string;
  agentId: string;
  callsign: string;
  intent: Pick<Intent, "id" | "title" | "goal" | "constraints" | "version"> & { checks: { path: string; description: string }[] };
  workspace: {
    mode: "api" | "git";
    baseSha: string;
    /** Git mode only. */
    remote?: string;
    token?: string;
    tokenExpiresAt?: string;
  };
  clearance: Clearance;
  /** The rules by folder that the plan touches, in plain sentences (see ProjectSettings.folderRules). */
  rules?: string[];
  /** How to work with gitring (short protocol reminder). */
  protocol: string[];
}

export interface LogInput {
  attemptId: string;
  message: string;
  files?: string[];
  symbols?: string[];
  /** Git mode: the new head commit the agent pushed to its fork. */
  headSha?: string;
}

export interface WriteInput {
  attemptId: string;
  files: { path: string; content?: string; delete?: boolean }[];
  message?: string;
}

export interface WriteResult {
  written: string[];
  /** Files that changed under the agent after its last read (main moved). gitring merged the write with those changes. */
  merged?: string[];
  /** Files that gitring did not write: the write overlaps changes that the agent did not read yet. */
  refused?: { path: string; reason: string }[];
  footprint: { files: string[]; symbols: SymbolKey[] };
  clearance: Clearance;
}

export interface SubmitResult {
  attemptId: string;
  status: AttemptStatus;
  checks?: CheckRun;
  /** Where the attempt goes next. "awaiting-approval": a person must say yes (see `approval`). */
  next: "landing-queue" | "awaiting-approval" | "fix-checks" | "landed";
  message: string;
  /** Set when next is "awaiting-approval": the approval that waits. */
  approval?: Approval;
  /** Set with `approval`, when the caller said who it is: may this person answer? */
  mayAnswer?: boolean;
  clearance: Clearance;
}

/** Answer of the status tool: where a work copy is, and what a person said about it. */
export interface WorkStatus {
  attemptId: string;
  status: AttemptStatus;
  task: { id: string; title: string; status: IntentStatus };
  approval?: Approval;
  /** Set with a question that waits, when the caller said who it is: may this person answer? */
  mayAnswer?: boolean;
  /** The size of the change and the tests, in one line. */
  line: string;
  /** Where a person answers the approval: an address in the gitring app. */
  link: string;
  mainSha: string;
  landing?: { sha: string; method: LandingMethod; at: Millis };
  mergeWait?: { until: Millis; message: string };
  /** One sentence for the agent: what to do now. */
  message: string;
  clearance: Clearance;
}

/** What the person who answers an approval sends. */
export interface ApprovalAnswer {
  answer: "approve" | "send-back";
  /** For send-back: what the agent must change. Shown to the agent as a change request. */
  note?: string;
}

/** The result of an answer. */
export interface ApprovalResult {
  attemptId: string;
  /**
   * What the answer did. "already": the approval had an answer before, nothing changed now. "withdrawn":
   * the question is closed (the agent changed the work). "refused": this person may not answer it.
   */
  outcome: "approved" | "sent-back" | "already" | "withdrawn" | "refused";
  approval: Approval;
  status: AttemptStatus;
  message: string;
  landing?: Landing;
  /** The merge waits for the hourly test budget. */
  waits?: { until: Millis };
}
