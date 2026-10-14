/**
 * The types of the project client: the inputs and results of each request and the HarborClient interface.
 * Read by every view that talks to the Worker. Keep each field name: the Worker sends and reads them.
 */
import type { ApprovalAnswer, ApprovalResult, Attempt, ConnectInfo, Intent, Landing, TreeResponse } from "../../../../src/core/types";

export interface DiffFile {
  path: string;
  status: "A" | "M" | "D";
  additions: number;
  deletions: number;
  /** Unified diff text. */
  diff: string;
}

export interface DiffResult {
  files: DiffFile[];
}

export interface LandingDetail {
  landing: Landing;
  /** The merge record: a git note (JSON text or an object). */
  note: unknown;
  diff: DiffResult;
}

export interface NewIntentInput {
  title: string;
  goal: string;
  checks?: { path: string; content: string; description: string }[];
  priority?: "normal" | "high";
}

export interface AmendInput {
  goal?: string;
  constraints?: string[];
  reason: string;
}

export interface LandResult {
  status: string;
  landing?: Landing;
  message?: string;
  /** The merge waits for the hourly test budget. It is not a failure. */
  waits?: { until: number };
}

/** A person's answer to the question that a work copy asks. `approvalId` is the question the person saw. */
export interface DecideInput extends ApprovalAnswer {
  approvalId: string;
}

/** Options for reads: `signal` aborts the wait of the caller (a view that closes). */
export interface ReadOptions {
  signal?: AbortSignal;
  /** "low" for prefetches on hover or focus. */
  priority?: "high" | "low" | "auto";
}

export interface VersionedRead extends ReadOptions {
  /**
   * A version of the content that the caller knows from the live state (a commit id, a work copy's
   * `updatedAt`, the `sha` of its tree). Same version → the answer comes from memory, without a request.
   */
  version?: string | number;
}

export interface HarborClient {
  readonly projectId: string;
  createIntent(input: NewIntentInput): Promise<Intent>;
  amendIntent(id: string, input: AmendInput): Promise<Intent>;
  launch(id: string, fanout: number, models?: string[]): Promise<{ attempts: Attempt[] }>;
  park(id: string, reason: string): Promise<void>;
  land(attemptId: string, rationale: string): Promise<LandResult>;
  /**
   * Say yes ("approve") or "not yet" ("send-back") to the merge that a work copy asks for. A person who
   * may not answer gets a result with outcome "refused" and the reason in `message`: no exception.
   */
  decide(attemptId: string, input: DecideInput): Promise<ApprovalResult>;
  rederive(attemptId: string, reason: string): Promise<{ attempt: Attempt }>;
  /** The work copy against its base. With `version` (the work copy's updatedAt) the answer is reused until the work copy changes. */
  attemptDiff(attemptId: string, opts?: VersionedRead): Promise<DiffResult>;
  /** A merge record. Merges do not change, so the answer stays in memory. */
  landing(id: string, opts?: ReadOptions): Promise<LandingDetail>;
  /** Files of main, a work copy id or a commit id. Revalidates with ETag; a commit id stays in memory. */
  tree(ref: string, opts?: ReadOptions): Promise<TreeResponse>;
  /**
   * The text of one file. A commit id (40 hex) never changes: the answer stays in memory. For main and
   * work copies pass `version` (the tree `sha`): same version, no request. Rejects with status 404 for a
   * file that is not on the ref, or that gitring keeps as binary.
   */
  file(ref: string, path: string, opts?: VersionedRead): Promise<string>;
  /** The text of a file when it is in memory now (no request). */
  cachedFile(ref: string, path: string, version?: string | number): string | undefined;
  /** Start built-in AI agents on every open task (Workers AI models). */
  launchAll(): Promise<{ launched: number; queued: number }>;
  /** Endpoints of this deployment for the Connect page (kept for 5 minutes). */
  connect(opts?: ReadOptions): Promise<ConnectInfo>;
  /** Live preview URL of a work copy (iframe src). */
  previewUrl(attemptId: string): string;
}
