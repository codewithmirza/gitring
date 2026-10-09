/**
 * RepoBackend — the only way Bearing touches git storage.
 *
 * ArtifactsBackend is the implementation: the Cloudflare Artifacts binding for control-plane +
 * reads, isomorphic-git (in-memory, shallow) for writes, because `git push` is the only write path.
 * Tests use a git-object test double (test/support/git-emulator) with the same interface.
 *
 * All hashes are lowercase 40-char SHA-1 git object ids.
 */

export type TreeEntryType = "tree" | "blob" | "symlink" | "gitlink" | "exec";

export interface TreeEntry {
  name: string;
  mode: string; // "100644", "100755", "40000", "120000", "160000"
  hash: string;
  type: TreeEntryType;
}

export interface CommitMeta {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authoredAt: number; // unix seconds
  committedAt: number;
}

export interface RepoHandle {
  name: string;
  remote?: string;
  defaultBranch: string;
}

export interface ForkResult extends RepoHandle {
  /** Write token for the fork (Artifacts). Test doubles may leave it undefined. */
  token?: string;
}

export interface FileChange {
  path: string;
  /** New content (UTF-8 text or bytes). `null` deletes the file. */
  content: string | Uint8Array | null;
  /** Default "100644". */
  mode?: string;
}

export interface CommitInput {
  repo: string;
  branch: string;
  /** Parent commit. The write fails if the branch tip is not this commit (compare-and-swap). */
  parent: string;
  changes: FileChange[];
  message: string;
  author: { name: string; email: string };
  /** Optional git note attached to the new commit under refs/notes/bearing. */
  note?: string;
}

export interface CommitResult {
  sha: string;
  tree: string;
}

export class RepoConflictError extends Error {
  constructor(
    message: string,
    readonly expected: string,
    readonly actual: string | null,
  ) {
    super(message);
    this.name = "RepoConflictError";
  }
}

export interface RepoBackend {
  readonly kind: string;

  /** Create an empty repo. Idempotent: returns the existing repo if the name exists. */
  ensureRepo(name: string, opts?: { description?: string }): Promise<RepoHandle>;
  /** Fork `source` (default branch only) into a new repo named `name`. */
  fork(source: string, name: string, opts?: { description?: string }): Promise<ForkResult>;
  deleteRepo(name: string): Promise<void>;

  /** Resolve a branch/tag/sha to a commit hash, or null. */
  resolve(repo: string, ref: string): Promise<string | null>;
  readCommit(repo: string, sha: string): Promise<CommitMeta | null>;
  /** Immediate children of a tree. */
  readTree(repo: string, treeSha: string): Promise<TreeEntry[] | null>;
  readBlob(repo: string, sha: string): Promise<Uint8Array | null>;
  /** First-parent history, newest first. */
  log(repo: string, ref: string, limit?: number): Promise<CommitMeta[]>;

  /** Create one commit on `branch` from `parent` plus `changes`. Compare-and-swap on the branch tip. */
  commit(input: CommitInput): Promise<CommitResult>;
  /** Read the note for a commit under refs/notes/bearing, if any. */
  readNote(repo: string, commitSha: string): Promise<string | null>;

  /** Scoped token for an external git client (test doubles may return undefined). */
  createToken(repo: string, scope: "read" | "write", ttlSeconds: number): Promise<{ token: string; expiresAt: string } | undefined>;
  remoteUrl(repo: string): Promise<string | undefined>;
}
