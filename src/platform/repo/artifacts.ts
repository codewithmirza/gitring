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
 *      becomes RepoConflictError. A push that fails removes the note of step 5 again (best
 *      effort, a second notes commit), so no note names a commit that never landed. When the
 *      branch holds the commit after all (the answer got lost), the commit counts and keeps its note.
 *
 * See ARTIFACTS_CHECKS at the end of this file for what the real service answered.
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
/** A short problem of the service itself ("An internal error occurred."). The same call usually works a moment later. */
const HICCUP = new Set(["INTERNAL_ERROR"]);
/** How many times a call is sent again after such an error (250 ms, then 500 ms). */
const HICCUP_RETRIES = 2;

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
  [/INTERNAL_ERROR|internal error occurred/i, "INTERNAL_ERROR"],
];

/** `ArtifactsError.code`, or a code guessed from the message (RPC can drop custom fields). */
export function artifactsErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (e && typeof e.code === "string") return e.code;
  const message = typeof e?.message === "string" ? e.message : "";
  for (const [re, code] of MESSAGE_CODES) if (re.test(message)) return code;
  return undefined;
}

/** Answers of a service that has a short problem. A second request usually works (the first real run saw one 500 in about 300 requests). */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

/** A connection that broke (not our own time limit: waiting a second time for a slow request would take too long). */
function transientNetworkError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return false;
  return e instanceof TypeError || /network|connection|socket|reset|fetch failed|ECONN|EAI_AGAIN/i.test(String(e?.message ?? ""));
}

async function* replay(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

/** Read an answer to its end, so that the connection is free again. */
async function drain(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<void> {
  if (!body) return;
  try {
    for await (const chunk of body) void chunk;
  } catch {
    /* the answer is not needed */
  }
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
    const tries = Math.max(1, Math.round(opts.httpTries ?? 3));
    this.http = {
      request: async (req) => {
        // The body of a request is read once. Keep it, so that a second try can send it again.
        let body: Uint8Array[] | undefined;
        if (req.body) {
          body = [];
          for await (const chunk of req.body) body.push(chunk);
        }
        for (let attempt = 1; ; attempt++) {
          const last = attempt >= tries;
          try {
            const res = await base.request({ ...req, ...(body ? { body: replay(body) } : {}), signal: req.signal ?? AbortSignal.timeout(timeoutMs) });
            if (last || !TRANSIENT_STATUS.has(res.statusCode)) return res;
            await drain(res.body);
          } catch (err) {
            if (last || !transientNetworkError(err)) throw err;
          }
          // A push that the service did apply before it failed shows as a rejected push on the next try:
          // commit() reads the branch then and takes it as done.
          await this.sleep(Math.min(200 * 2 ** (attempt - 1), 2000));
        }
      },
    };
  }

  /* ───────────────────────────── helpers ───────────────────────────── */

  /**
   * Retry `fn` while Artifacts reports *_IN_PROGRESS, with exponential backoff (budget ~20 s), and twice after a
   * short problem of the service (INTERNAL_ERROR).
   */
  private async retrying<T>(fn: () => Promise<T>): Promise<T> {
    let waited = 0;
    let hiccups = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (await this.hiccup(err, hiccups)) {
          hiccups += 1;
          continue;
        }
        const code = artifactsErrorCode(err);
        if (!code || !RETRIABLE.has(code)) throw err;
        const delay = Math.min(250 * 2 ** attempt, 4000);
        if (waited + delay > this.retryBudgetMs) throw err;
        waited += delay;
        await this.sleep(delay);
      }
    }
  }

  /** True after a short wait when `err` is a short problem of the service and the caller has tries left (`used` so far). */
  private async hiccup(err: unknown, used: number): Promise<boolean> {
    const code = artifactsErrorCode(err);
    if (!code || !HICCUP.has(code) || used >= HICCUP_RETRIES) return false;
    await this.sleep(250 * (used + 1));
    return true;
  }

  /**
   * `get(name)` (retried while the repo is being created/forked/imported), use, dispose. A short problem of the
   * service while `fn` runs sends `fn` again, up to twice: every `fn` below reads, mints a token, or ends with a
   * push that a second run finds already done (see commit).
   */
  private async withRepo<T>(name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
    for (let hiccups = 0; ; hiccups++) {
      const repo = await this.retrying(() => this.binding.get(name));
      try {
        return await fn(repo);
      } catch (err) {
        if (!(await this.hiccup(err, hiccups))) throw err;
      } finally {
        dispose(repo);
      }
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
    let hiccups = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.withRepoOnce(name, async (repo) => {
          const info = await repo.info();
          this.remember(info.name, info.remote);
          return { name: info.name, remote: info.remote, defaultBranch: info.defaultBranch };
        });
      } catch (err) {
        if (await this.hiccup(err, hiccups)) {
          hiccups += 1;
          continue;
        }
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
            if (await this.hiccup(createErr, hiccups)) {
              hiccups += 1;
              continue;
            }
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
        const rejected = code === "PushRejectedError" || code === "GitPushError";
        // undefined: the tip cannot be read now. Then the note stays: an extra note is better than a merge without its note.
        const now = await this.branchTip(repo, input.branch).catch(() => undefined);
        if (now === prepared.sha) return { sha: prepared.sha, tree: prepared.tree };
        // The commit did not land: its note names a commit that no branch holds. Remove it again (best effort).
        if (input.note && now !== undefined) await this.pushNote(s.url, s.secret, prepared.sha, null).catch(() => undefined);
        if (rejected && now !== undefined && now !== expected) throw branchConflict(input, now);
        throw err;
      }
      return { sha: prepared.sha, tree: prepared.tree };
    });
  }

  /**
   * Add a note for `commitSha` to refs/notes/gitring and push it (3 tries on a lost race). `null` removes the
   * note of `commitSha` (nothing to push when it has none).
   */
  private async pushNote(url: string, secret: string, commitSha: string, note: string | null): Promise<void> {
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
      if (note === null && !base.has(flat) && !base.has(fanned)) return;
      const changes: FileChange[] = [
        { path: flat, content: null },
        { path: fanned, content: null },
        ...(note === null ? [] : [{ path: fanout ? fanned : flat, content: note, mode: "100644" }]),
      ];
      const prepared = await prepareCommit({
        base,
        changes,
        parents: tip ? [tip] : [],
        author: this.author,
        message: note === null ? `Notes removed by gitring for ${commitSha}` : `Notes added by gitring for ${commitSha}`,
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
 * ARTIFACTS_CHECKS: what the real service answered. The unit tests use a fake binding over bare repositories
 * served by `git http-backend`. On 11 October 2026 a copy of gitring with its own namespace ran 11 load runs
 * (up to 60 agents, 562 merged tasks) and a probe against the real Artifacts service. All 11 points are answered,
 * with two corrections (points 4 and 8). The numbers are in the Load bullet of README.md.
 *   1. An isomorphic-git shallow clone (`depth: 1, singleBranch`, protocol v1) works. Every merge uses it.
 *   2. Basic auth `x:<secret>` on the first request is accepted. No answer had status 401 in 7,248 git requests.
 *   3. A push that starts from an old commit is refused. The answer has status 200 and says `unpack ok` and
 *      `ng refs/heads/main stale ref`. isomorphic-git throws GitPushError, commit() reads the branch and throws
 *      RepoConflictError, and the branch keeps the commit of the other writer. Test: two writers, and the second
 *      one sends its push after the first one has moved the branch.
 *   4. CORRECTION: `log({ ref: "refs/notes/gitring" })` gives [] (the binding knows branch names only). So readNote
 *      always uses the git fallback: one binding.get, one log and two git requests, 0.25 to 1 s.
 *   5. `log({ ref })` of a missing branch gives [] and not an error, also on an empty repository
 *      (tested with `main`, `nope` and `refs/heads/nope`).
 *   6. A push of `refs/notes/gitring` (a ref that is not a branch) is accepted. Forks use `defaultBranchOnly: true`
 *      and start without notes.
 *   7. ArtifactsError.code arrives through the binding call: NOT_FOUND and ALREADY_EXISTS (no need for the message).
 *   8. CORRECTION: fork() does not return before the copy is ready (2 to 4 s) and the copy can be used at once. No
 *      FORK_IN_PROGRESS and no CREATE_IN_PROGRESS in 580 forks, so the 20 s retry budget stays unused.
 *   9. readTree gives the modes "100644", "40000" and "120000" (type "symlink"). A file with mode 100755 and a
 *      gitlink were not read back (the harbor reads the mode).
 *  10. A root commit to an empty repository, and a root commit to a new branch of a repository that has commits, work.
 *  11. A repository of 47 MB in 6,000 files: the first commit takes 17 s, and a merge (clone of the whole latest
 *      tree, one changed file, push) takes 9 s. Smaller: 12 MB 4 s, 23 MB 7 s. No limit was hit (128 MB of memory,
 *      cpu_ms 300000). The clone of the whole latest tree is the cost that grows with the size of the repository.
 */
