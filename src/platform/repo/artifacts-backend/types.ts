/**
 * The constants, the options and the session type of the Artifacts backend.
 *
 * Read next: src/platform/repo/artifacts.ts (the front door that re-exports the public ones).
 */
import type { HttpClient } from "isomorphic-git";
import type { TreeCache } from "../../../core/git/snapshot";
import type { TreeEntry } from "../backend";
import type { BlobCache } from "../blob-cache";
import type { MemoryFS } from "../memory-fs";

/** Notes ref for logbook records. */
export const NOTES_REF = "refs/notes/gitring";
export const DEFAULT_BRANCH = "main";
/** TTL of the internal write token used for clone/fetch/push. */
export const GIT_TOKEN_TTL_S = 600;
/** Re-mint the internal token when it has less than this left. */
export const GIT_TOKEN_MARGIN_MS = 120_000;
export const RETRIABLE = new Set(["CREATE_IN_PROGRESS", "FORK_IN_PROGRESS", "IMPORT_IN_PROGRESS"]);
/** A short problem of the service itself ("An internal error occurred."). The same call usually works a moment later. */
export const HICCUP = new Set(["INTERNAL_ERROR"]);
/** How many times a call is sent again after such an error (250 ms, then 500 ms). */
export const HICCUP_RETRIES = 2;

export interface ArtifactsBackendOptions {
  /** Identity for notes commits (commit author/committer come from CommitInput.author). */
  author?: { name: string; email: string };
  /** Clock in unix ms (tests pin it). */
  now?: () => number;
  /** Total backoff budget for *_IN_PROGRESS retries. Default 20 000 ms. */
  retryBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** isomorphic-git HTTP client. Default: isomorphic-git/http/web (fetch). */
  http?: HttpClient;
  /** Per-request timeout for git HTTP calls. Default 60 000 ms. */
  requestTimeoutMs?: number;
  /** How many times a git HTTP request is sent when the service answers 429 or 5xx, or the connection breaks. Default 3. */
  httpTries?: number;
  treeCache?: TreeCache;
  /**
   * How a commit reaches the remote. "changeset" (default): the new objects in one pack, nothing cloned.
   * "clone": the isomorphic-git path (a shallow clone, loose objects, push).
   */
  writes?: "changeset" | "clone";
  /** Cache of small blobs shared by every project object in a location. Default: the Cache API when the runtime has it; null: off. */
  blobCache?: BlobCache | null;
}

/** One in-memory git directory plus credentials for one remote. */
export interface GitSession {
  fs: MemoryFS;
  dir: string;
  cache: object;
  url: string;
  secret: string;
}

export interface ObjectIO {
  readTree(sha: string): Promise<TreeEntry[] | null>;
  readBlob(sha: string): Promise<Uint8Array | null>;
}
