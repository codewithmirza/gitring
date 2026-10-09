/**
 * Offline stand-in for Cloudflare Artifacts, pure layer (no Cloudflare imports, testable in Node).
 *
 *   ObjectStore        storage contract: content-addressed objects, repos, refs (compare-and-swap), notes
 *   MemoryObjectStore  Maps (tests)
 *   SqlObjectStore     Durable Object SQLite (`ctx.storage`), used by the LocalArtifacts DO
 *   GitStore           RepoBackend semantics on top of an ObjectStore
 *
 * Objects are content-addressed and shared by every repo of a namespace: a fork copies refs,
 * never objects. Objects are never deleted (no GC).
 */
import {
  EMPTY_TREE_SHA,
  type GitObjectType,
  decodeCommit,
  decodeTree,
  isSha,
  isValidBranchName,
} from "../../../core/git/objects";
import { MemoryTreeCache, type Snapshot, type TreeCache, prepareCommit, readSnapshot } from "../../../core/git/snapshot";
import {
  type CommitInput,
  type CommitMeta,
  type CommitResult,
  type ForkResult,
  RepoConflictError,
  type RepoHandle,
  type TreeEntry,
} from "../backend";

export interface StoredObject {
  type: GitObjectType;
  body: Uint8Array;
}

export interface RepoRecord {
  name: string;
  defaultBranch: string;
  description: string | null;
  /** Source repo name for forks, null otherwise. */
  source: string | null;
  /** Unix milliseconds. */
  createdAt: number;
}

export interface ObjectStore {
  getObject(sha: string): Promise<StoredObject | null>;
  /** Idempotent (content-addressed). */
  putObject(sha: string, type: GitObjectType, body: Uint8Array): Promise<void>;

  getRepo(name: string): Promise<RepoRecord | null>;
  listRepos(): Promise<RepoRecord[]>;
  /** Atomically create a repo with initial refs. False if the name is taken. */
  createRepo(rec: RepoRecord, refs?: Record<string, string>): Promise<boolean>;
  /** Delete a repo with its refs and notes (objects stay). False if it did not exist. */
  deleteRepo(name: string): Promise<boolean>;

  getRef(repo: string, ref: string): Promise<string | null>;
  listRefs(repo: string): Promise<Record<string, string>>;
  /**
   * Atomic compare-and-swap of a ref. `expected` null means "the ref must not exist".
   * Fails (false) if the repo does not exist.
   */
  casRef(repo: string, ref: string, expected: string | null, next: string): Promise<boolean>;

  getNote(repo: string, commitSha: string): Promise<string | null>;
  putNote(repo: string, commitSha: string, note: string): Promise<void>;
}

/* ───────────────────────────── memory store ───────────────────────────── */

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  private readonly repos = new Map<string, RepoRecord>();
  private readonly refs = new Map<string, Map<string, string>>();
  private readonly notes = new Map<string, Map<string, string>>();

  async getObject(sha: string): Promise<StoredObject | null> {
    const o = this.objects.get(sha);
    return o ? { type: o.type, body: o.body.slice() } : null;
  }

  async putObject(sha: string, type: GitObjectType, body: Uint8Array): Promise<void> {
    if (!this.objects.has(sha)) this.objects.set(sha, { type, body: body.slice() });
  }

  async getRepo(name: string): Promise<RepoRecord | null> {
    const r = this.repos.get(name);
    return r ? { ...r } : null;
  }

  async listRepos(): Promise<RepoRecord[]> {
    return [...this.repos.values()].map((r) => ({ ...r })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async createRepo(rec: RepoRecord, refs: Record<string, string> = {}): Promise<boolean> {
    if (this.repos.has(rec.name)) return false;
    this.repos.set(rec.name, { ...rec });
    this.refs.set(rec.name, new Map(Object.entries(refs)));
    this.notes.set(rec.name, new Map());
    return true;
  }

  async deleteRepo(name: string): Promise<boolean> {
    this.refs.delete(name);
    this.notes.delete(name);
    return this.repos.delete(name);
  }

  async getRef(repo: string, ref: string): Promise<string | null> {
    return this.refs.get(repo)?.get(ref) ?? null;
  }

  async listRefs(repo: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.refs.get(repo) ?? []);
  }

  async casRef(repo: string, ref: string, expected: string | null, next: string): Promise<boolean> {
    const refs = this.refs.get(repo);
    if (!refs || !this.repos.has(repo)) return false;
    if ((refs.get(ref) ?? null) !== expected) return false;
    refs.set(ref, next);
    return true;
  }

  async getNote(repo: string, commitSha: string): Promise<string | null> {
    return this.notes.get(repo)?.get(commitSha) ?? null;
  }

  async putNote(repo: string, commitSha: string, note: string): Promise<void> {
    const notes = this.notes.get(repo);
    if (!notes) throw new Error(`repo not found: ${repo}`);
    notes.set(commitSha, note);
  }
}

/* ───────────────────────────── SQLite store (Durable Object) ───────────────────────────── */

/** The subset of `SqlStorage` this store uses (DO `ctx.storage.sql`, or an adapter in tests). */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** The subset of `DurableObjectStorage` this store uses. */
export interface SqlStorageLike {
  sql: SqlLike;
  transactionSync?<T>(closure: () => T): T;
}

/** DO SQLite caps a row (and a BLOB) at 2 MB; larger objects are split across rows. */
const CHUNK_BYTES = 1_000_000;

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value === null || value === undefined) return new Uint8Array(0);
  throw new Error(`unexpected BLOB value: ${typeof value}`);
}

/** Exact ArrayBuffer for a BLOB binding (DO SQL binds ArrayBuffer as BLOB). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

export class SqlObjectStore implements ObjectStore {
  private readonly sql: SqlLike;

  constructor(private readonly storage: SqlStorageLike) {
    this.sql = storage.sql;
    const ddl = [
      `CREATE TABLE IF NOT EXISTS objects (
         sha TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL,
         body BLOB, chunks INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS object_chunks (
         sha TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (sha, idx))`,
      `CREATE TABLE IF NOT EXISTS repos (
         name TEXT PRIMARY KEY, default_branch TEXT NOT NULL, description TEXT,
         source TEXT, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS refs (
         repo TEXT NOT NULL, ref TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (repo, ref))`,
      `CREATE TABLE IF NOT EXISTS notes (
         repo TEXT NOT NULL, commit_sha TEXT NOT NULL, note TEXT NOT NULL, PRIMARY KEY (repo, commit_sha))`,
    ];
    for (const stmt of ddl) this.sql.exec(stmt);
  }

  private tx<T>(fn: () => T): T {
    return this.storage.transactionSync ? this.storage.transactionSync(fn) : fn();
  }

  private rows(query: string, ...bindings: unknown[]): Record<string, unknown>[] {
    return this.sql.exec(query, ...bindings).toArray();
  }

  async getObject(sha: string): Promise<StoredObject | null> {
    const [row] = this.rows("SELECT type, size, body, chunks FROM objects WHERE sha = ?", sha);
    if (!row) return null;
    const type = row.type as GitObjectType;
    const chunks = Number(row.chunks);
    if (chunks === 0) return { type, body: toBytes(row.body).slice() };
    const out = new Uint8Array(Number(row.size));
    let at = 0;
    for (const part of this.rows("SELECT data FROM object_chunks WHERE sha = ? ORDER BY idx", sha)) {
      const bytes = toBytes(part.data);
      out.set(bytes, at);
      at += bytes.length;
    }
    if (at !== out.length) throw new Error(`object ${sha} is incomplete in storage`);
    return { type, body: out };
  }

  async putObject(sha: string, type: GitObjectType, body: Uint8Array): Promise<void> {
    this.tx(() => {
      if (body.byteLength <= CHUNK_BYTES) {
        this.rows(
          "INSERT INTO objects (sha, type, size, body, chunks) VALUES (?, ?, ?, ?, 0) ON CONFLICT(sha) DO NOTHING",
          sha,
          type,
          body.byteLength,
          toArrayBuffer(body),
        );
        return;
      }
      const inserted = this.rows(
        "INSERT INTO objects (sha, type, size, body, chunks) VALUES (?, ?, ?, NULL, ?) ON CONFLICT(sha) DO NOTHING RETURNING sha",
        sha,
        type,
        body.byteLength,
        Math.ceil(body.byteLength / CHUNK_BYTES),
      );
      if (inserted.length === 0) return;
      for (let idx = 0, at = 0; at < body.byteLength; idx++, at += CHUNK_BYTES) {
        this.rows("INSERT INTO object_chunks (sha, idx, data) VALUES (?, ?, ?)", sha, idx, toArrayBuffer(body.subarray(at, at + CHUNK_BYTES)));
      }
    });
  }

  private static repoFromRow(row: Record<string, unknown>): RepoRecord {
    return {
      name: String(row.name),
      defaultBranch: String(row.default_branch),
      description: row.description === null || row.description === undefined ? null : String(row.description),
      source: row.source === null || row.source === undefined ? null : String(row.source),
      createdAt: Number(row.created_at),
    };
  }

  async getRepo(name: string): Promise<RepoRecord | null> {
    const [row] = this.rows("SELECT name, default_branch, description, source, created_at FROM repos WHERE name = ?", name);
    return row ? SqlObjectStore.repoFromRow(row) : null;
  }

  async listRepos(): Promise<RepoRecord[]> {
    return this.rows("SELECT name, default_branch, description, source, created_at FROM repos ORDER BY name").map(SqlObjectStore.repoFromRow);
  }

  async createRepo(rec: RepoRecord, refs: Record<string, string> = {}): Promise<boolean> {
    return this.tx(() => {
      const inserted = this.rows(
        `INSERT INTO repos (name, default_branch, description, source, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO NOTHING RETURNING name`,
        rec.name,
        rec.defaultBranch,
        rec.description,
        rec.source,
        rec.createdAt,
      );
      if (inserted.length === 0) return false;
      // Clear leftovers of an older repo with the same name (defensive; deleteRepo removes them).
      this.rows("DELETE FROM refs WHERE repo = ?", rec.name);
      this.rows("DELETE FROM notes WHERE repo = ?", rec.name);
      for (const [ref, sha] of Object.entries(refs)) {
        this.rows("INSERT INTO refs (repo, ref, sha) VALUES (?, ?, ?)", rec.name, ref, sha);
      }
      return true;
    });
  }

  async deleteRepo(name: string): Promise<boolean> {
    return this.tx(() => {
      this.rows("DELETE FROM refs WHERE repo = ?", name);
      this.rows("DELETE FROM notes WHERE repo = ?", name);
      return this.rows("DELETE FROM repos WHERE name = ? RETURNING name", name).length > 0;
    });
  }

  async getRef(repo: string, ref: string): Promise<string | null> {
    const [row] = this.rows("SELECT sha FROM refs WHERE repo = ? AND ref = ?", repo, ref);
    return row ? String(row.sha) : null;
  }

  async listRefs(repo: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const row of this.rows("SELECT ref, sha FROM refs WHERE repo = ? ORDER BY ref", repo)) out[String(row.ref)] = String(row.sha);
    return out;
  }

  async casRef(repo: string, ref: string, expected: string | null, next: string): Promise<boolean> {
    return this.tx(() => {
      if (expected === null) {
        return (
          this.rows(
            `INSERT INTO refs (repo, ref, sha) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM repos WHERE name = ?)
             ON CONFLICT(repo, ref) DO NOTHING RETURNING sha`,
            repo,
            ref,
            next,
            repo,
          ).length > 0
        );
      }
      return (
        this.rows(
          `UPDATE refs SET sha = ? WHERE repo = ? AND ref = ? AND sha = ?
             AND EXISTS (SELECT 1 FROM repos WHERE name = ?) RETURNING sha`,
          next,
          repo,
          ref,
          expected,
          repo,
        ).length > 0
      );
    });
  }

  async getNote(repo: string, commitSha: string): Promise<string | null> {
    const [row] = this.rows("SELECT note FROM notes WHERE repo = ? AND commit_sha = ?", repo, commitSha);
    return row ? String(row.note) : null;
  }

  async putNote(repo: string, commitSha: string, note: string): Promise<void> {
    this.rows(
      `INSERT INTO notes (repo, commit_sha, note) VALUES (?, ?, ?)
       ON CONFLICT(repo, commit_sha) DO UPDATE SET note = excluded.note`,
      repo,
      commitSha,
      note,
    );
  }
}

/* ───────────────────────────── GitStore ───────────────────────────── */

/** Repo metadata returned by `listRepos` (emulator extra; Artifacts has `list()`). */
export interface RepoInfo extends RepoHandle {
  description: string | null;
  source: string | null;
  createdAt: number;
}

export const DEFAULT_BRANCH = "main";
/** Artifacts repo-name rule (OpenAPI pattern). */
const REPO_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function assertRepoName(name: string): void {
  if (typeof name !== "string" || !REPO_NAME_RE.test(name)) {
    throw new Error(`INVALID_REPO_NAME: ${JSON.stringify(name)} (use letters, digits, ".", "_", "-"; start with a letter or digit)`);
  }
}

export function branchConflict(input: Pick<CommitInput, "repo" | "branch" | "parent">, actual: string | null): RepoConflictError {
  return new RepoConflictError(
    `branch ${input.branch} of ${input.repo} is at ${actual ?? "(no commit)"}, expected ${input.parent || "(no commit)"}`,
    input.parent,
    actual,
  );
}

export interface GitStoreOptions {
  /** Clock in unix milliseconds (tests pin it). */
  now?: () => number;
  treeCache?: TreeCache;
}

/** RepoBackend semantics over an ObjectStore. Every method validates the repo exists (throws if not). */
export class GitStore {
  readonly treeCache: TreeCache;
  private readonly now: () => number;
  private readonly treeReader: { readTree: (repo: string, sha: string) => Promise<TreeEntry[] | null> };

  constructor(
    readonly store: ObjectStore,
    opts: GitStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.treeCache = opts.treeCache ?? new MemoryTreeCache();
    this.treeReader = { readTree: (repo, sha) => this.readTreeUnchecked(sha) };
  }

  private async requireRepo(name: string): Promise<RepoRecord> {
    const rec = await this.store.getRepo(name);
    if (!rec) throw new Error(`NOT_FOUND: repo ${name} does not exist`);
    return rec;
  }

  private static handle(rec: RepoRecord): RepoHandle {
    return { name: rec.name, defaultBranch: rec.defaultBranch };
  }

  async ensureRepo(name: string, opts: { description?: string; defaultBranch?: string } = {}): Promise<RepoHandle> {
    assertRepoName(name);
    const existing = await this.store.getRepo(name);
    if (existing) return GitStore.handle(existing);
    const defaultBranch = opts.defaultBranch ?? DEFAULT_BRANCH;
    if (!isValidBranchName(defaultBranch)) throw new Error(`invalid branch name: ${defaultBranch}`);
    const rec: RepoRecord = { name, defaultBranch, description: opts.description ?? null, source: null, createdAt: this.now() };
    if (await this.store.createRepo(rec)) return GitStore.handle(rec);
    return GitStore.handle(await this.requireRepo(name)); // lost a race; someone else created it
  }

  /**
   * Fork `source` into `name`: copies the default-branch ref only (like Artifacts with
   * `defaultBranchOnly: true`). Notes are not copied. If `name` already exists as a fork of
   * `source` (a retried call), it is returned; any other existing repo is an error.
   */
  async fork(source: string, name: string, opts: { description?: string } = {}): Promise<ForkResult> {
    const src = await this.requireRepo(source);
    assertRepoName(name);
    const existing = await this.store.getRepo(name);
    if (existing) {
      if (existing.source === source) return GitStore.handle(existing);
      throw new Error(`ALREADY_EXISTS: repo ${name} already exists`);
    }
    const branchRef = `refs/heads/${src.defaultBranch}`;
    const tip = await this.store.getRef(source, branchRef);
    const rec: RepoRecord = {
      name,
      defaultBranch: src.defaultBranch,
      description: opts.description ?? null,
      source,
      createdAt: this.now(),
    };
    if (await this.store.createRepo(rec, tip ? { [branchRef]: tip } : {})) return GitStore.handle(rec);
    const raced = await this.requireRepo(name);
    if (raced.source === source) return GitStore.handle(raced);
    throw new Error(`ALREADY_EXISTS: repo ${name} already exists`);
  }

  /** Idempotent. Objects stay (they are shared). */
  async deleteRepo(name: string): Promise<void> {
    await this.store.deleteRepo(name);
  }

  async listRepos(): Promise<RepoInfo[]> {
    return (await this.store.listRepos()).map((r) => ({
      name: r.name,
      defaultBranch: r.defaultBranch,
      description: r.description,
      source: r.source,
      createdAt: r.createdAt,
    }));
  }

  async listRefs(repo: string): Promise<Record<string, string>> {
    await this.requireRepo(repo);
    return this.store.listRefs(repo);
  }

  /**
   * Resolve "main", "refs/heads/main", "refs/tags/x", "HEAD" (the default branch) or an existing
   * 40-hex commit id to a commit id. Null if it does not resolve.
   */
  async resolve(repo: string, ref: string): Promise<string | null> {
    const rec = await this.requireRepo(repo);
    if (typeof ref !== "string" || ref === "") return null;
    if (isSha(ref)) {
      const obj = await this.store.getObject(ref);
      return obj?.type === "commit" ? ref : null;
    }
    if (ref === "HEAD") return this.store.getRef(repo, `refs/heads/${rec.defaultBranch}`);
    if (ref.startsWith("refs/")) return this.store.getRef(repo, ref);
    return (await this.store.getRef(repo, `refs/heads/${ref}`)) ?? (await this.store.getRef(repo, `refs/tags/${ref}`));
  }

  async readCommit(repo: string, sha: string): Promise<CommitMeta | null> {
    await this.requireRepo(repo);
    return this.readCommitUnchecked(sha);
  }

  private async readCommitUnchecked(sha: string): Promise<CommitMeta | null> {
    if (!isSha(sha)) return null;
    const obj = await this.store.getObject(sha);
    if (!obj || obj.type !== "commit") return null;
    return decodeCommit(sha, obj.body);
  }

  async readTree(repo: string, sha: string): Promise<TreeEntry[] | null> {
    await this.requireRepo(repo);
    const entries = await this.readTreeUnchecked(sha);
    return entries ? entries.map((e) => ({ ...e })) : null;
  }

  /** Cached; the returned array is shared with the cache (read-only). */
  private async readTreeUnchecked(sha: string): Promise<TreeEntry[] | null> {
    if (!isSha(sha)) return null;
    const hit = this.treeCache.get(sha);
    if (hit) return hit;
    if (sha === EMPTY_TREE_SHA) return [];
    const obj = await this.store.getObject(sha);
    if (!obj || obj.type !== "tree") return null;
    const entries = decodeTree(obj.body);
    this.treeCache.set(sha, entries);
    return entries;
  }

  async readBlob(repo: string, sha: string): Promise<Uint8Array | null> {
    await this.requireRepo(repo);
    if (!isSha(sha)) return null;
    const obj = await this.store.getObject(sha);
    return obj && obj.type === "blob" ? obj.body : null;
  }

  /** First-parent history from `ref`, newest first. Empty if the ref does not resolve. */
  async log(repo: string, ref: string, limit = 50): Promise<CommitMeta[]> {
    const start = await this.resolve(repo, ref);
    const out: CommitMeta[] = [];
    let next: string | undefined = start ?? undefined;
    while (next && out.length < limit) {
      const c = await this.readCommitUnchecked(next);
      if (!c) break;
      out.push(c);
      next = c.parents[0];
    }
    return out;
  }

  /**
   * Create one commit on `branch` from `parent` + `changes`, then compare-and-swap the branch ref.
   * `parent` "" means the branch must not exist yet (root commit). RepoConflictError if the tip moved.
   */
  async commit(input: CommitInput): Promise<CommitResult> {
    await this.requireRepo(input.repo);
    if (!isValidBranchName(input.branch)) throw new Error(`invalid branch name: ${String(input.branch)}`);
    if (input.parent !== "" && !isSha(input.parent)) throw new Error(`invalid parent commit id: ${String(input.parent)}`);
    const ref = `refs/heads/${input.branch}`;
    const tip = await this.store.getRef(input.repo, ref);
    if ((tip ?? "") !== input.parent) throw branchConflict(input, tip);

    let base: Snapshot = new Map();
    if (input.parent) {
      const parent = await this.readCommitUnchecked(input.parent);
      if (!parent) throw new Error(`parent commit ${input.parent} is missing from storage`);
      base = await readSnapshot(this.treeReader, input.repo, parent.treeHash, this.treeCache);
    }
    const prepared = await prepareCommit({
      base,
      changes: input.changes,
      parents: input.parent ? [input.parent] : [],
      author: input.author,
      message: input.message,
      timestamp: Math.floor(this.now() / 1000),
    });
    for (const [sha, body] of prepared.blobs) await this.store.putObject(sha, "blob", body);
    for (const [sha, body] of prepared.trees) await this.store.putObject(sha, "tree", body);
    await this.store.putObject(prepared.sha, "commit", prepared.commit);

    if (!(await this.store.casRef(input.repo, ref, input.parent || null, prepared.sha))) {
      throw branchConflict(input, await this.store.getRef(input.repo, ref));
    }
    if (input.note) await this.store.putNote(input.repo, prepared.sha, input.note);
    return { sha: prepared.sha, tree: prepared.tree };
  }

  async readNote(repo: string, commitSha: string): Promise<string | null> {
    await this.requireRepo(repo);
    if (!isSha(commitSha)) return null;
    return this.store.getNote(repo, commitSha);
  }
}
