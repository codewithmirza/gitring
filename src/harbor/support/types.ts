/**
 * The types of the project coordinator, and the one error class that stops a train when the test budget ends.
 * Imported by the layers in ../master/ and, through harbor.ts, by the Worker and the MCP tools.
 * Never change a field of CallInfo or Brief without a change in the callers: other programs depend on them.
 */
import type * as T from "../../core/types";
import { type Role } from "../../core/accounts";
import { type ComposeResult } from "../../core/land/compose";
import { type NotCarried } from "../../core/land/carry";
import { type UpstreamMark } from "../../platform/github/sync";
import { type AttemptView } from "../views";

/** Reads blobs for a merge (see HarborFiles.blobReader in master/files.ts). */
export interface BlobReader {
  /** Exact text, or null for a blob that is not text (or not exactly text). */
  readText(sha: string): Promise<string | null>;
  readBytes(sha: string): Promise<Uint8Array | null>;
  /** Like readText, from what gitring holds only: undefined when gitring must read a repository for it. */
  knownText(sha: string): Promise<string | null | undefined>;
}

/** The merge run in progress (meta "landing"): written before the landing work starts, cleared when it ends. */
export interface LandingRun {
  /** The work copy that merges. */
  id: string;
  startedAt: number;
  /** The object instance that started the run (see bootId). */
  boot: string;
  /** How many times this merge started. */
  tries: number;
  /** A train: every work copy that merges in this run (the first one is `id`). */
  train?: string[];
}

/**
 * The tests of main in post-merge test mode (meta "mainTests"): the last main that passed, the last main
 * that was tested, and the last result. A main that is not `tested` yet gets its run when the object wakes.
 */
export interface MainTests {
  lastGreen?: string;
  tested?: string;
  last?: { sha: string; ok: boolean; at: number; passed: number; failed: number };
  /** The test budget is used: gitring tests main again at this time. */
  retryAt?: number;
}

/** One work copy of a train, composed onto main. */
export interface TrainPiece {
  a: T.Attempt;
  view: AttemptView;
  result: ComposeResult;
  left: NotCarried[];
}

/** How a work copy of a train ended: merged or finished ("done"), left the queue early ("early"), or stays queued ("wait"). */
export type TrainOutcome = "done" | "wait" | "early";

/** The test budget ran out in the middle of a train or a search: the work waits for the next window. */
export class TestsWait extends Error {
  constructor(readonly wait: NonNullable<T.CheckRun["wait"]>) {
    super(wait.message);
  }
}

export interface LaunchInput {
  fanout?: number;
  models?: string[];
}

/**
 * What the Worker tells the project object about one call (the MCP tools use it): the address of this
 * deployment, for links in answers, and the person who calls, with the role that the Worker checked.
 */
export interface CallInfo {
  origin?: string;
  viewer?: { id: string; role: Role };
  /**
   * Change requests that an earlier answer of the same tool call delivered (submit, then status). The answer
   * holds them again until the agent confirms them: the agent reads them only in the last answer of the call.
   */
  again?: string[];
}

export interface Brief {
  attemptId?: string;
  intent: T.Intent;
  files: { path: string; size: number }[];
  /** Full text of the small files the agent likely needs. */
  context: Record<string, string>;
  checks: { path: string; description: string; content: string }[];
  constraints: string[];
  traffic: T.TrafficVessel[];
  /** How the checks run: the gitring harness, or the project's install and test commands in a container. */
  runner: T.CheckSettings;
}

/** GitHub state of one linked repository (meta "gh:<owner/name>"). */
export interface GithubRepoState {
  /** gitring commit → GitHub commit (the import, and commits that sync made). */
  known: Record<string, string>;
  /** The GitHub commit that gitring brought in or made last. */
  last?: string;
  /** gitring commits that brought GitHub changes in → GitHub's commit (and its submodule pointers). */
  upstreamOf: Record<string, UpstreamMark>;
  /** Open conflict: GitHub's head then, the conflicting files (GitHub's blob ids) and the task. */
  conflict?: { head: string; files: Record<string, string | null>; intentId: string };
  pull?: T.GithubPullStatus;
  /**
   * The person whose GitHub rights gitring re-checks, and the last answer. `gone`: the person left the
   * project; the sentence says so, and nothing is pushed or read for a private repository until an
   * owner saves the GitHub settings again.
   */
  actor?: { userId: string; checkedAt: number; read: boolean; push: boolean; gone?: string };
  /** Whether GitHub showed the repository as private the last time gitring asked. */
  private?: boolean;
}
