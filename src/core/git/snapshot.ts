/**
 * Snapshots: a flat view of a git tree (repo-relative path → file entry), plus the
 * operations gitring needs on top of it: read (recursive, cached, bounded concurrency),
 * diff, apply file changes, and build tree objects bottom-up.
 *
 * Pure module (WebCrypto + TextEncoder only). Runs in Node 22 and in workerd.
 */
import type { FileChange, RepoBackend, TreeEntry } from "../../platform/repo/backend";
import {
  EMPTY_TREE_SHA,
  TREE_MODE,
  encodeCommit,
  encodeTree,
  hashObject,
  isSha,
  modeToType,
  normalizeCommitMessage,
  normalizeMode,
  utf8,
} from "./objects";

export interface SnapshotEntry {
  sha: string;
  mode: string;
}

/** Repo-relative path → file entry. Files only (blobs, executables, symlinks, gitlinks); no directories. */
export type Snapshot = Map<string, SnapshotEntry>;

export interface TreeCache {
  get(sha: string): TreeEntry[] | undefined;
  set(sha: string, entries: TreeEntry[]): void;
}

/**
 * LRU cache of decoded trees by hash. Trees are immutable, so entries never go stale.
 * Cached arrays are shared: treat them as read-only.
 */
export class MemoryTreeCache implements TreeCache {
  private readonly map = new Map<string, TreeEntry[]>();

  constructor(readonly maxEntries = 5000) {}

  get(sha: string): TreeEntry[] | undefined {
    const hit = this.map.get(sha);
    if (hit !== undefined) {
      this.map.delete(sha);
      this.map.set(sha, hit);
    }
    return hit;
  }

  set(sha: string, entries: TreeEntry[]): void {
    if (this.map.has(sha)) this.map.delete(sha);
    this.map.set(sha, entries);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/** Code-unit order; the order of the git index for ASCII paths. */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Concurrent readTree calls per readSnapshot. */
const READ_CONCURRENCY = 8;

/**
 * Read every file under `treeSha` (recursively). Subtrees are read in parallel with a small
 * concurrency limit; decoded trees go through `cache`. The result is sorted by path.
 * Throws if a tree is missing.
 */
export async function readSnapshot(
  backend: Pick<RepoBackend, "readTree">,
  repo: string,
  treeSha: string,
  cache?: TreeCache,
): Promise<Snapshot> {
  const files: [string, SnapshotEntry][] = [];
  const load = async (sha: string, prefix: string): Promise<TreeEntry[]> => {
    if (sha === EMPTY_TREE_SHA) return [];
    const hit = cache?.get(sha);
    if (hit) return hit;
    const entries = await backend.readTree(repo, sha);
    if (!entries) throw new Error(`tree ${sha} not found in ${repo}${prefix ? ` (at ${prefix}/)` : ""}`);
    cache?.set(sha, entries);
    return entries;
  };
  await runPool<{ sha: string; prefix: string }>([{ sha: treeSha, prefix: "" }], READ_CONCURRENCY, async (job, push) => {
    const entries = await load(job.sha, job.prefix);
    for (const e of entries) {
      const path = job.prefix ? `${job.prefix}/${e.name}` : e.name;
      if (e.type === "tree") push({ sha: e.hash, prefix: path });
      else files.push([path, { sha: e.hash, mode: e.mode }]);
    }
  });
  files.sort((a, b) => comparePaths(a[0], b[0]));
  return new Map(files);
}

/** Run `worker` over a growing job queue with at most `limit` jobs in flight. */
async function runPool<T>(initial: T[], limit: number, worker: (job: T, push: (job: T) => void) => Promise<void>): Promise<void> {
  const queue = [...initial];
  let head = 0;
  let active = 0;
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const pump = (): void => {
      if (failed) return;
      if (head >= queue.length && active === 0) {
        resolve();
        return;
      }
      while (active < limit && head < queue.length) {
        const job = queue[head++];
        active++;
        worker(job, (next) => queue.push(next)).then(
          () => {
            active--;
            pump();
          },
          (err: unknown) => {
            failed = true;
            reject(err);
          },
        );
      }
    };
    pump();
  });
}

export interface SnapshotChange {
  path: string;
  status: "A" | "M" | "D";
  oldSha?: string;
  newSha?: string;
  /** New mode for A/M, old mode for D. */
  mode?: string;
}

/** File-level diff, sorted by path. A mode-only change counts as "M". */
export function diffSnapshots(base: Snapshot, head: Snapshot): SnapshotChange[] {
  const out: SnapshotChange[] = [];
  for (const [path, b] of base) {
    const h = head.get(path);
    if (!h) out.push({ path, status: "D", oldSha: b.sha, mode: b.mode });
    else if (h.sha !== b.sha || h.mode !== b.mode) out.push({ path, status: "M", oldSha: b.sha, newSha: h.sha, mode: h.mode });
  }
  for (const [path, h] of head) {
    if (!base.has(path)) out.push({ path, status: "A", newSha: h.sha, mode: h.mode });
  }
  out.sort((a, b) => comparePaths(a.path, b.path));
  return out;
}

/** Why `path` is not a valid repo-relative file path, or null if it is. */
export function pathProblem(path: string): string | null {
  if (typeof path !== "string" || path === "") return "path is empty";
  if (path.startsWith("/")) return "path must be relative (no leading /)";
  if (path.endsWith("/")) return "path must name a file (no trailing /)";
  if (/[\0\\]/.test(path)) return "path contains NUL or backslash";
  for (const seg of path.split("/")) {
    if (seg === "") return "path contains an empty segment (//)";
    if (seg === "." || seg === "..") return "path contains . or .. segments";
    if (seg.toLowerCase() === ".git") return "path contains a .git segment";
  }
  return null;
}

export function assertValidPath(path: string): void {
  const problem = pathProblem(path);
  if (problem) throw new Error(`invalid path ${JSON.stringify(path)}: ${problem}`);
}

interface DirNode {
  files: Map<string, SnapshotEntry>;
  dirs: Map<string, DirNode>;
}

/**
 * Build all tree objects for a snapshot, bottom-up. Returns the root tree id and every tree
 * object (id → encoded body), the root included. An empty snapshot gives the empty tree
 * 4b825dc642cb6eb9a060e54bf8d69288fbee4904. Throws if a path is both a file and a directory.
 */
export async function buildTrees(snapshot: Snapshot): Promise<{ root: string; trees: Map<string, Uint8Array> }> {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of snapshot) {
    assertValidPath(path);
    if (!isSha(entry.sha)) throw new Error(`invalid object id for ${path}: ${String(entry.sha)}`);
    if (modeToType(entry.mode) === "tree") throw new Error(`snapshot entry ${path} has a directory mode`);
    const parts = path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (dir.files.has(name)) throw new Error(`path conflict: ${parts.slice(0, i + 1).join("/")} is both a file and a directory`);
      let next = dir.dirs.get(name);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    const leaf = parts[parts.length - 1];
    if (dir.dirs.has(leaf)) throw new Error(`path conflict: ${path} is both a file and a directory`);
    dir.files.set(leaf, entry);
  }

  const trees = new Map<string, Uint8Array>();
  const build = async (dir: DirNode): Promise<string> => {
    const subdirs = [...dir.dirs];
    const subShas = await Promise.all(subdirs.map(([, sub]) => build(sub)));
    const entries: TreeEntry[] = [];
    for (const [name, e] of dir.files) entries.push({ name, mode: normalizeMode(e.mode), hash: e.sha, type: modeToType(e.mode) });
    subdirs.forEach(([name], i) => entries.push({ name, mode: TREE_MODE, hash: subShas[i], type: "tree" }));
    const body = encodeTree(entries);
    const sha = await hashObject("tree", body);
    trees.set(sha, body);
    return sha;
  };
  const rootSha = await build(root);
  return { root: rootSha, trees };
}

/** Modes a FileChange may set. Gitlinks (160000) are preserved but cannot be written. */
const WRITABLE_MODES = new Set(["100644", "100755", "120000"]);

/**
 * Apply file changes to a snapshot (a new Map is returned; `base` is not modified).
 * Text becomes a UTF-8 blob; bytes are used as is; `null` deletes the path (a no-op if absent).
 * Mode: `change.mode`, else the existing file's mode, else "100644".
 * Path conflicts (file vs directory) are reported later by `buildTrees`.
 */
export async function applyFileChanges(
  base: Snapshot,
  changes: FileChange[],
): Promise<{ snapshot: Snapshot; blobs: Map<string, Uint8Array> }> {
  const snapshot: Snapshot = new Map(base);
  const blobs = new Map<string, Uint8Array>();
  for (const change of changes) {
    assertValidPath(change.path);
    if (change.content === null) {
      snapshot.delete(change.path);
      continue;
    }
    const mode = change.mode !== undefined ? normalizeMode(change.mode) : (snapshot.get(change.path)?.mode ?? "100644");
    if (!WRITABLE_MODES.has(mode)) throw new Error(`unsupported file mode ${String(change.mode)} for ${change.path}`);
    const bytes = toBytes(change.content);
    const sha = await hashObject("blob", bytes);
    blobs.set(sha, bytes);
    snapshot.set(change.path, { sha, mode });
  }
  return { snapshot, blobs };
}

function toBytes(content: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof content === "string") return utf8.encode(content);
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    const view = content as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error("file content must be a string, Uint8Array or null");
}

export interface PreparedCommit {
  /** Commit id. */
  sha: string;
  /** Root tree id. */
  tree: string;
  /** Encoded commit body. */
  commit: Uint8Array;
  /** New blobs (id → bytes). */
  blobs: Map<string, Uint8Array>;
  /** Every tree of the new snapshot (id → encoded body). */
  trees: Map<string, Uint8Array>;
  snapshot: Snapshot;
}

/**
 * Everything a backend needs to write one commit: apply `changes` to `base`, build the trees and
 * encode the commit (author = committer, given timestamp, tz "+0000" by default). The message gets
 * a trailing newline, like `git commit -m`. Both repo backends use this, so the same input and
 * timestamp give the same commit id on the emulator and on Artifacts.
 */
export async function prepareCommit(args: {
  base: Snapshot;
  changes: FileChange[];
  parents: string[];
  author: { name: string; email: string };
  message: string;
  /** Unix seconds. */
  timestamp: number;
  tzOffset?: string;
}): Promise<PreparedCommit> {
  const { snapshot, blobs } = await applyFileChanges(args.base, args.changes);
  const { root, trees } = await buildTrees(snapshot);
  const ident = { name: args.author.name, email: args.author.email, timestamp: args.timestamp, tzOffset: args.tzOffset ?? "+0000" };
  const commit = encodeCommit({
    tree: root,
    parents: args.parents,
    author: ident,
    committer: ident,
    message: normalizeCommitMessage(args.message),
  });
  const sha = await hashObject("commit", commit);
  return { sha, tree: root, commit, blobs, trees, snapshot };
}
