/**
 * RepoBackend over Cloudflare Artifacts (production).
 *
 * Control plane and reads go through the Workers binding (`get`, `create`, `fork`, `delete`,
 * `info`, `createToken`, `log`, `readCommit`, `readTree`, `readBlob`). `get()` returns a
 * disposable RPC stub: every use is wrapped in try/finally + `[Symbol.dispose]()`.
 *
 * Writes: `git push` is the only write path. A commit is made with isomorphic-git on an
 * in-memory filesystem, like the Artifacts docs example, with these choices:
 *   1. optimistic check of the branch tip through the binding (`log({ ref, limit: 1 })`);
 *   2. shallow clone of the branch (`depth: 1, singleBranch: true, noCheckout: true`) with a
 *      short-lived write token; an empty branch (parent "") starts from `init` + `addRemote`;
 *   3. verify the cloned tip === `input.parent`, else RepoConflictError;
 *   4. build blobs + trees + commit with the same code as the emulator (`prepareCommit`) and write
 *      them as loose objects. No checkout and no index: memory stays ~1× the packed branch, and
 *      exec bits, symlinks and gitlinks of untouched files survive exactly;
 *   5. if `input.note`: fetch `refs/notes/gitring` (depth 1), add the note, push the notes ref
 *      (retried on a lost race). The note goes first, so a landed commit always has its note;
 *   6. push the branch without force. isomorphic-git refuses a non-fast-forward and the server
 *      compare-and-swaps the ref on the advertised old id; a rejected push whose tip moved
 *      becomes RepoConflictError.
 *
 * See ARTIFACTS_TODO at the end of this file for what must be verified against the real service.
 */
import git, { type HttpClient } from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import { EMPTY_TREE_SHA, decodeCommit, decodeTree, isSha, isValidBranchName, utf8 } from "../../core/git/objects";
import { MemoryTreeCache, type Snapshot, type TreeCache, prepareCommit, readSnapshot } from "../../core/git/snapshot";
import {
  type CommitInput,
  type CommitMeta,
  type CommitResult,
  type FileChange,
  type ForkResult,
  type RepoBackend,
  RepoConflictError,
  type RepoHandle,
  type TreeEntry,
} from "./backend";
import { MemoryFS } from "./memory-fs";

/** Notes ref for logbook records. */
export const NOTES_REF = "refs/notes/gitring";
const DEFAULT_BRANCH = "main";
/** TTL of the internal write token used for clone/fetch/push. */
const GIT_TOKEN_TTL_S = 600;
/** Re-mint the internal token when it has less than this left. */
const GIT_TOKEN_MARGIN_MS = 120_000;
const RETRIABLE = new Set(["CREATE_IN_PROGRESS", "FORK_IN_PROGRESS", "IMPORT_IN_PROGRESS"]);

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
  treeCache?: TreeCache;
}

/** The token secret for HTTP Basic auth: the token without its `?expires=…` suffix. */
export function tokenSecret(token: string): string {
  const i = token.indexOf("?expires=");
  return i < 0 ? token : token.slice(0, i);
}

const MESSAGE_CODES: [RegExp, string][] = [
  [/FORK_IN_PROGRESS|fork(ing)? (is )?(already )?in progress|still forking/i, "FORK_IN_PROGRESS"],
  [/CREATE_IN_PROGRESS|still being created/i, "CREATE_IN_PROGRESS"],
  [/IMPORT_IN_PROGRESS|still importing/i, "IMPORT_IN_PROGRESS"],
  [/ALREADY_EXISTS|already exists/i, "ALREADY_EXISTS"],
  [/NOT_FOUND|not found|does not exist/i, "NOT_FOUND"],
];

/** `ArtifactsError.code`, or a code guessed from the message (RPC can drop custom fields). */
export function artifactsErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (e && typeof e.code === "string") return e.code;
  const message = typeof e?.message === "string" ? e.message : "";
  for (const [re, code] of MESSAGE_CODES) if (re.test(message)) return code;
  return undefined;
}

function gitErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function dispose(handle: unknown): void {
  const key = (Symbol as { dispose?: symbol }).dispose;
  if (!key || !handle) return;
  const fn = (handle as Record<symbol, unknown>)[key];
  if (typeof fn === "function") {
    try {
      fn.call(handle);
    } catch {
      /* already disposed */
    }
  }
}

function branchConflict(input: Pick<CommitInput, "repo" | "branch" | "parent">, actual: string | null): RepoConflictError {
  return new RepoConflictError(
    `branch ${input.branch} of ${input.repo} is at ${actual ?? "(no commit)"}, expected ${input.parent || "(no commit)"}`,
    input.parent,
    actual,
  );
}

/** `refs/heads/x` → `x` (the binding takes branch names); everything else as is. */
function bindingRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function toCommitMeta(c: ArtifactsCommitMetadata): CommitMeta {
  return {
    hash: c.hash,
    treeHash: c.treeHash,
    message: c.message,
    author: { name: c.author.name, email: c.author.email },
    committer: { name: c.committer.name, email: c.committer.email },
    parents: [...c.parents],
    authoredAt: c.authoredAt,
    committedAt: c.committedAt,
  };
}

function cloneCommit(c: CommitMeta): CommitMeta {
  return { ...c, author: { ...c.author }, committer: { ...c.committer }, parents: [...c.parents] };
}

class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

/** One in-memory git directory plus credentials for one remote. */
interface GitSession {
  fs: MemoryFS;
  dir: string;
  cache: object;
  url: string;
  secret: string;
}

interface ObjectIO {
  readTree(sha: string): Promise<TreeEntry[] | null>;
  readBlob(sha: string): Promise<Uint8Array | null>;
}

/** Find the note for `name` in a notes tree: flat (`<sha>`) or fanned out (`ab/cdef…`). */
async function findNote(io: ObjectIO, treeSha: string, name: string): Promise<string | null> {
  const entries = await io.readTree(treeSha);
  if (!entries) return null;
  const exact = entries.find((e) => e.name === name && e.type !== "tree");
  if (exact) {
    const bytes = await io.readBlob(exact.hash);
    return bytes ? utf8.decode(bytes) : null;
  }
  if (name.length > 2) {
    const fan = entries.find((e) => e.type === "tree" && e.name === name.slice(0, 2));
    if (fan) return findNote(io, fan.hash, name.slice(2));
  }
  return null;
}

/** Read objects from the in-memory git directory (packed or loose). */
function localObjects(s: GitSession) {
  const read = async (oid: string) => {
    try {
      return (await git.readObject({ fs: s.fs, dir: s.dir, oid, format: "content", cache: s.cache })) as {
        type: string;
        object: Uint8Array;
      };
    } catch (err) {
      if (gitErrorCode(err) === "NotFoundError") return null;
      throw err;
    }
  };
  return {
    async readTree(_repo: string, sha: string): Promise<TreeEntry[] | null> {
      if (sha === EMPTY_TREE_SHA) return [];
      const o = await read(sha);
      return o && o.type === "tree" ? decodeTree(o.object) : null;
    },
    async readCommit(sha: string): Promise<CommitMeta | null> {
      const o = await read(sha);
      return o && o.type === "commit" ? decodeCommit(sha, o.object) : null;
    },
    async readBlob(sha: string): Promise<Uint8Array | null> {
      const o = await read(sha);
      return o && o.type === "blob" ? o.object : null;
    },
  };
}

/** Write prepared objects as loose objects, checking isomorphic-git agrees on every id. */
async function writeLocalObjects(s: GitSession, objects: Iterable<["blob" | "tree" | "commit", string, Uint8Array]>): Promise<void> {
  for (const [type, sha, body] of objects) {
    const oid = await git.writeObject({ fs: s.fs, dir: s.dir, type, object: body, format: "content" });
    if (oid !== sha) throw new Error(`object id mismatch for ${type} ${sha}: isomorphic-git computed ${oid}`);
  }
}

/** New objects of a prepared commit; trees in `present` (already in the clone) are skipped. */
function* preparedObjects(
  p: { blobs: Map<string, Uint8Array>; trees: Map<string, Uint8Array>; sha: string; commit: Uint8Array },
  present: ReadonlySet<string> = new Set(),
) {
  for (const [sha, body] of p.blobs) yield ["blob", sha, body] as ["blob", string, Uint8Array];
  for (const [sha, body] of p.trees) if (!present.has(sha)) yield ["tree", sha, body] as ["tree", string, Uint8Array];
  yield ["commit", p.sha, p.commit] as ["commit", string, Uint8Array];
}

export class ArtifactsBackend implements RepoBackend {
  readonly kind = "artifacts" as const;

  private readonly author: { name: string; email: string };
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryBudgetMs: number;
  private readonly http: HttpClient;
  private readonly trees: TreeCache;
  private readonly commits = new Lru<CommitMeta>(2000);
  private readonly remotes = new Map<string, string>();
  private readonly tokens = new Map<string, { secret: string; expiresAtMs: number }>();

  constructor(
    private readonly binding: Artifacts,
    opts: ArtifactsBackendOptions = {},
  ) {
    this.author = opts.author ?? { name: "gitring", email: "logbook@gitring.invalid" };
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryBudgetMs = opts.retryBudgetMs ?? 20_000;
    this.trees = opts.treeCache ?? new MemoryTreeCache();
    const base = opts.http ?? (webHttp as HttpClient);
    const timeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.http = {
      request: (req) => base.request({ ...req, signal: req.signal ?? AbortSignal.timeout(timeoutMs) }),
    };
  }

  /* ───────────────────────────── helpers ───────────────────────────── */

  /** Retry `fn` while Artifacts reports *_IN_PROGRESS, with exponential backoff (budget ~20 s). */
  private async retrying<T>(fn: () => Promise<T>): Promise<T> {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const code = artifactsErrorCode(err);
        if (!code || !RETRIABLE.has(code)) throw err;
        const delay = Math.min(250 * 2 ** attempt, 4000);
        if (waited + delay > this.retryBudgetMs) throw err;
        waited += delay;
        await this.sleep(delay);
      }
    }
  }

  /** `get(name)` (retried while the repo is being created/forked/imported), use, dispose. */
  private async withRepo<T>(name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
    const repo = await this.retrying(() => this.binding.get(name));
    try {
      return await fn(repo);
    } finally {
      dispose(repo);
    }
  }

  private remember(name: string, remote: string | undefined): void {
    if (remote) this.remotes.set(name, remote);
  }

  private forget(name: string): void {
    this.remotes.delete(name);
    this.tokens.delete(name);
  }

  private async branchTip(repo: ArtifactsRepo, branch: string): Promise<string | null> {
    const [c] = await repo.log({ ref: branch, limit: 1 });
    return c?.hash ?? null;
  }

  /** Remote URL + a cached short-lived write token secret + a fresh in-memory git dir. */
  private async session(name: string, repo: ArtifactsRepo): Promise<GitSession> {
    let url = this.remotes.get(name);
    if (!url) {
      url = (await repo.info()).remote;
      this.remember(name, url);
    }
    let token = this.tokens.get(name);
    if (!token || token.expiresAtMs - this.now() < GIT_TOKEN_MARGIN_MS) {
      const minted = await repo.createToken("write", GIT_TOKEN_TTL_S);
      const exp = Date.parse(minted.expiresAt);
      token = { secret: tokenSecret(minted.plaintext), expiresAtMs: Number.isFinite(exp) ? exp : this.now() + GIT_TOKEN_TTL_S * 1000 };
      this.tokens.set(name, token);
    }
    return { fs: new MemoryFS(), dir: "/repo", cache: {}, url, secret: token.secret };
  }

  /** Common isomorphic-git options. Credentials go out on the first request (no 401 round trip). */
  private gitOpts(s: GitSession) {
    return {
      fs: s.fs,
      http: this.http,
      dir: s.dir,
      cache: s.cache,
      headers: { Authorization: `Basic ${btoa(`x:${s.secret}`)}` },
      onAuth: () => ({ username: "x", password: s.secret }),
    };
  }

  private async initLocal(s: GitSession, defaultBranch: string): Promise<void> {
    await git.init({ fs: s.fs, dir: s.dir, defaultBranch });
    await git.addRemote({ fs: s.fs, dir: s.dir, remote: "origin", url: s.url });
  }

  /** Fetch one remote ref (depth 1) and point the same local ref at it. Null if the remote lacks it. */
  private async fetchRef(s: GitSession, ref: string): Promise<string | null> {
    try {
      const res = await git.fetch({ ...this.gitOpts(s), remote: "origin", ref, remoteRef: ref, singleBranch: true, depth: 1, tags: false });
      if (!res.fetchHead) return null;
      await git.writeRef({ fs: s.fs, dir: s.dir, ref, value: res.fetchHead, force: true });
      return res.fetchHead;
    } catch (err) {
      if (gitErrorCode(err) === "NotFoundError") return null;
      throw err;
    }
  }

  private async resolveLocal(s: GitSession, ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: s.fs, dir: s.dir, ref });
    } catch (err) {
      if (gitErrorCode(err) === "NotFoundError") return null;
      throw err;
    }
  }

  /* ───────────────────────────── control plane ───────────────────────────── */

  async ensureRepo(name: string, opts: { description?: string } = {}): Promise<RepoHandle> {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.withRepoOnce(name, async (repo) => {
          const info = await repo.info();
          this.remember(info.name, info.remote);
          return { name: info.name, remote: info.remote, defaultBranch: info.defaultBranch };
        });
      } catch (err) {
        const code = artifactsErrorCode(err);
        if (code === "NOT_FOUND") {
          try {
            const created = await this.binding.create(name, {
              setDefaultBranch: DEFAULT_BRANCH,
              ...(opts.description ? { description: opts.description } : {}),
            });
            this.remember(created.name, created.remote);
            return { name: created.name, remote: created.remote, defaultBranch: created.defaultBranch || DEFAULT_BRANCH };
          } catch (createErr) {
            const createCode = artifactsErrorCode(createErr) ?? "";
            // ALREADY_EXISTS: lost a creation race, read the winner on the next round.
            if (createCode !== "ALREADY_EXISTS" && !RETRIABLE.has(createCode)) throw createErr;
          }
        } else if (!code || !RETRIABLE.has(code)) {
          throw err;
        }
        const delay = Math.min(250 * 2 ** attempt, 4000);
        if (waited + delay > this.retryBudgetMs) throw err;
        waited += delay;
        await this.sleep(delay);
      }
    }
  }

  /** `get` without retries (ensureRepo has its own loop). */
  private async withRepoOnce<T>(name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
    const repo = await this.binding.get(name);
    try {
      return await fn(repo);
    } finally {
      dispose(repo);
    }
  }

  /**
   * Fork `source` (default branch only) into `name`. Retries FORK_IN_PROGRESS / CREATE_IN_PROGRESS.
   * If `name` already exists as a fork of `source` (a retried call), it is adopted with a new token.
   */
  async fork(source: string, name: string, opts: { description?: string; allBranches?: boolean } = {}): Promise<ForkResult> {
    return this.retrying(async () => {
      const src = await this.binding.get(source);
      try {
        const res = await src.fork(name, { defaultBranchOnly: !opts.allBranches, ...(opts.description ? { description: opts.description } : {}) });
        this.remember(res.name, res.remote);
        return { name: res.name, remote: res.remote, defaultBranch: res.defaultBranch, token: res.token };
      } catch (err) {
        if (artifactsErrorCode(err) === "ALREADY_EXISTS") {
          const adopted = await this.adoptFork(source, name);
          if (adopted) return adopted;
        }
        throw err;
      } finally {
        dispose(src);
      }
    });
  }

  private async adoptFork(source: string, name: string): Promise<ForkResult | null> {
    const repo = await this.binding.get(name);
    try {
      const info = await repo.info();
      const from = info.source ?? "";
      if (from !== source && !from.endsWith(`/${source}`)) return null;
      const token = await repo.createToken("write", 86_400);
      this.remember(info.name, info.remote);
      return { name: info.name, remote: info.remote, defaultBranch: info.defaultBranch, token: token.plaintext };
    } finally {
      dispose(repo);
    }
  }

  async deleteRepo(name: string): Promise<void> {
    this.forget(name);
    await this.retrying(() => this.binding.delete(name));
  }

  async createToken(repo: string, scope: "read" | "write", ttlSeconds: number): Promise<{ token: string; expiresAt: string; id: string }> {
    const ttl = Math.min(31_536_000, Math.max(60, Math.floor(ttlSeconds)));
    return this.withRepo(repo, async (r) => {
      const res = await r.createToken(scope, ttl);
      return { token: res.plaintext, expiresAt: res.expiresAt, id: res.id };
    });
  }

  async revokeToken(repo: string, tokenOrId: string): Promise<boolean> {
    return this.withRepo(repo, (r) => r.revokeToken(tokenOrId));
  }

  async remoteUrl(repo: string): Promise<string> {
    const known = this.remotes.get(repo);
    if (known) return known;
    return this.withRepo(repo, async (r) => {
      const info = await r.info();
      this.remember(repo, info.remote);
      return info.remote;
    });
  }

  /* ───────────────────────────── reads ───────────────────────────── */

  async resolve(repo: string, ref: string): Promise<string | null> {
    if (typeof ref !== "string" || ref === "") return null;
    return this.withRepo(repo, async (r) => {
      if (isSha(ref)) {
        const c = await r.readCommit(ref);
        if (c) this.commits.set(c.hash, toCommitMeta(c));
        return c ? c.hash : null;
      }
      const [c] = await r.log({ ref: bindingRef(ref), limit: 1 });
      if (!c) return null;
      this.commits.set(c.hash, toCommitMeta(c));
      return c.hash;
    });
  }

  async readCommit(repo: string, sha: string): Promise<CommitMeta | null> {
    if (!isSha(sha)) return null;
    const hit = this.commits.get(sha);
    if (hit) return cloneCommit(hit);
    return this.withRepo(repo, async (r) => {
      const c = await r.readCommit(sha);
      if (!c) return null;
      const meta = toCommitMeta(c);
      this.commits.set(sha, meta);
      return cloneCommit(meta);
    });
  }

  async readTree(repo: string, treeSha: string): Promise<TreeEntry[] | null> {
    if (!isSha(treeSha)) return null;
    if (treeSha === EMPTY_TREE_SHA) return [];
    const hit = this.trees.get(treeSha);
    if (hit) return hit.map((e) => ({ ...e }));
    return this.withRepo(repo, async (r) => {
      const entries = await this.readTreeVia(r, treeSha);
      return entries ? entries.map((e) => ({ ...e })) : null;
    });
  }

  private async readTreeVia(r: ArtifactsRepo, sha: string): Promise<TreeEntry[] | null> {
    if (sha === EMPTY_TREE_SHA) return [];
    const hit = this.trees.get(sha);
    if (hit) return hit;
    const raw = await r.readTree(sha);
    if (!raw) return null;
    const entries = raw.map((e) => ({ name: e.name, mode: e.mode, hash: e.hash, type: e.type }));
    this.trees.set(sha, entries);
    return entries;
  }

  async readBlob(repo: string, sha: string): Promise<Uint8Array | null> {
    if (!isSha(sha)) return null;
    return this.withRepo(repo, async (r) => {
      const blob = await r.readBlob(sha);
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    });
  }

  /** First-parent history, newest first (pages through the binding's 1000-commit cap). */
  async log(repo: string, ref: string, limit = 50): Promise<CommitMeta[]> {
    if (limit <= 0) return [];
    return this.withRepo(repo, async (r) => {
      const out: CommitMeta[] = [];
      let offset = 0;
      while (out.length < limit) {
        const want = Math.min(1000, limit - out.length);
        const page = await r.log({ ref: bindingRef(ref), limit: want, offset });
        for (const c of page) {
          const meta = toCommitMeta(c);
          this.commits.set(meta.hash, meta);
          out.push(cloneCommit(meta));
        }
        if (page.length < want) break;
        offset += page.length;
      }
      return out;
    });
  }

  /**
   * The note for a commit under refs/notes/gitring. Fast path: the binding resolves the notes ref
   * (`log`) and reads the notes tree by hash. Fallback (the binding cannot resolve the ref): fetch
   * the notes ref at depth 1 over git. Null if there is no note.
   */
  async readNote(repo: string, commitSha: string): Promise<string | null> {
    if (!isSha(commitSha)) return null;
    return this.withRepo(repo, async (r) => {
      let notesTree: string | null = null;
      try {
        const [tip] = await r.log({ ref: NOTES_REF, limit: 1 });
        notesTree = tip?.treeHash ?? null;
      } catch {
        notesTree = null;
      }
      if (notesTree) {
        return findNote(
          {
            readTree: (sha) => this.readTreeVia(r, sha),
            readBlob: async (sha) => {
              const blob = await r.readBlob(sha);
              return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
            },
          },
          notesTree,
          commitSha,
        );
      }
      const s = await this.session(repo, r);
      await this.initLocal(s, DEFAULT_BRANCH);
      const tip = await this.fetchRef(s, NOTES_REF);
      if (!tip) return null;
      const local = localObjects(s);
      const notesCommit = await local.readCommit(tip);
      if (!notesCommit) return null;
      return findNote({ readTree: (sha) => local.readTree("", sha), readBlob: (sha) => local.readBlob(sha) }, notesCommit.treeHash, commitSha);
    });
  }

  /* ───────────────────────────── writes ───────────────────────────── */

  async commit(input: CommitInput): Promise<CommitResult> {
    if (!isValidBranchName(input.branch)) throw new Error(`invalid branch name: ${String(input.branch)}`);
    if (input.parent !== "" && !isSha(input.parent)) throw new Error(`invalid parent commit id: ${String(input.parent)}`);
    const branchRef = `refs/heads/${input.branch}`;
    const expected = input.parent || null;

    return this.withRepo(input.repo, async (repo) => {
      // 1. Cheap optimistic check (no git traffic when the caller is already stale).
      const tip = await this.branchTip(repo, input.branch);
      if (tip !== expected) throw branchConflict(input, tip);

      // 2–3. Local repository at the parent.
      const s = await this.session(input.repo, repo);
      if (input.parent) {
        try {
          await git.clone({ ...this.gitOpts(s), url: s.url, ref: input.branch, singleBranch: true, depth: 1, noCheckout: true, noTags: true });
        } catch (err) {
          if (gitErrorCode(err) === "NotFoundError") throw branchConflict(input, await this.branchTip(repo, input.branch));
          throw err;
        }
        const head = await this.resolveLocal(s, `refs/remotes/origin/${input.branch}`);
        if (head !== input.parent) throw branchConflict(input, head);
      } else {
        await this.initLocal(s, input.branch);
      }

      // 4. Objects (same encoding as the emulator). Trees read from the clone are not rewritten.
      const local = localObjects(s);
      const cloned = new Set<string>();
      let base: Snapshot = new Map();
      if (input.parent) {
        const parent = await local.readCommit(input.parent);
        if (!parent) throw new Error(`parent commit ${input.parent} is missing from the clone`);
        const reader = {
          readTree: (repo: string, sha: string) => {
            cloned.add(sha);
            return local.readTree(repo, sha);
          },
        };
        base = await readSnapshot(reader, input.repo, parent.treeHash);
      }
      const prepared = await prepareCommit({
        base,
        changes: input.changes,
        parents: input.parent ? [input.parent] : [],
        author: input.author,
        message: input.message,
        timestamp: Math.floor(this.now() / 1000),
      });
      await writeLocalObjects(s, preparedObjects(prepared, cloned));
      await git.writeRef({ fs: s.fs, dir: s.dir, ref: branchRef, value: prepared.sha, force: true });

      // 5. Note first: once the branch moves, its note already exists.
      if (input.note) await this.pushNote(s.url, s.secret, prepared.sha, input.note);

      // 6. Push (no force).
      try {
        await git.push({ ...this.gitOpts(s), remote: "origin", ref: branchRef, remoteRef: branchRef });
      } catch (err) {
        const code = gitErrorCode(err);
        if (code === "PushRejectedError" || code === "GitPushError") {
          const now = await this.branchTip(repo, input.branch);
          if (now === prepared.sha) return { sha: prepared.sha, tree: prepared.tree };
          if (now !== expected) throw branchConflict(input, now);
        }
        throw err;
      }
      return { sha: prepared.sha, tree: prepared.tree };
    });
  }

  /** Add a note for `commitSha` to refs/notes/gitring and push it (3 tries on a lost race). */
  private async pushNote(url: string, secret: string, commitSha: string, note: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const s: GitSession = { fs: new MemoryFS(), dir: "/notes", cache: {}, url, secret };
      await this.initLocal(s, DEFAULT_BRANCH);
      const tip = await this.fetchRef(s, NOTES_REF);
      const local = localObjects(s);
      const fetched = new Set<string>();
      let base: Snapshot = new Map();
      let fanout = false;
      if (tip) {
        const notesCommit = await local.readCommit(tip);
        if (!notesCommit) throw new Error(`notes commit ${tip} is missing after fetch`);
        const root = (await local.readTree("", notesCommit.treeHash)) ?? [];
        fanout = root.some((e) => e.type === "tree" && /^[0-9a-f]{2}$/.test(e.name));
        const reader = {
          readTree: (repo: string, sha: string) => {
            fetched.add(sha);
            return local.readTree(repo, sha);
          },
        };
        base = await readSnapshot(reader, "notes", notesCommit.treeHash);
      }
      const flat = commitSha;
      const fanned = `${commitSha.slice(0, 2)}/${commitSha.slice(2)}`;
      const changes: FileChange[] = [
        { path: flat, content: null },
        { path: fanned, content: null },
        { path: fanout ? fanned : flat, content: note, mode: "100644" },
      ];
      const prepared = await prepareCommit({
        base,
        changes,
        parents: tip ? [tip] : [],
        author: this.author,
        message: `Notes added by gitring for ${commitSha}`,
        timestamp: Math.floor(this.now() / 1000),
      });
      await writeLocalObjects(s, preparedObjects(prepared, fetched));
      await git.writeRef({ fs: s.fs, dir: s.dir, ref: NOTES_REF, value: prepared.sha, force: true });
      try {
        await git.push({ ...this.gitOpts(s), remote: "origin", ref: NOTES_REF, remoteRef: NOTES_REF });
        return;
      } catch (err) {
        const code = gitErrorCode(err);
        if ((code === "PushRejectedError" || code === "GitPushError") && attempt < 3) continue;
        throw err;
      }
    }
  }
}

/**
 * ARTIFACTS_TODO — verify against the real service (tests here use a fake binding over bare
 * repos served by `git http-backend`):
 *   1. isomorphic-git shallow clone (`depth: 1, singleBranch`, protocol v1) works against Artifacts.
 *   2. Basic auth `x:<secret>` sent up front on every request is accepted (no 401 challenge needed).
 *   3. A push with a stale old-oid is rejected (CAS) and surfaces as GitPushError / PushRejectedError.
 *   4. `log({ ref: "refs/notes/gitring" })` resolves a full ref name (the readNote fast path);
 *      if it returns [], the git fallback is used, which costs a token + a fetch per readNote.
 *   5. `log({ ref })` for a missing branch returns [] (not an error), including on an empty repo.
 *   6. Pushing `refs/notes/gitring` (a non-branch ref) is accepted; notes survive `fork()` only with
 *      `defaultBranchOnly: false` (we use true: forks start without notes, like the emulator).
 *   7. ArtifactsError.code survives the binding RPC (`artifactsErrorCode` falls back to messages).
 *   8. FORK_IN_PROGRESS / CREATE_IN_PROGRESS timing: is a 20 s retry budget enough?
 *   9. `readTree` returns canonical modes ("40000") and `type` "exec"/"symlink"/"gitlink".
 *  10. Push of a root commit to an empty repo (no refs) and to a new branch of a non-empty repo.
 *  11. Workers CPU/memory for clone + push on the demo repo size (isomorphic-git hashes in JS).
 */
