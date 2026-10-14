/**
 * The base of the Artifacts backend: the options, the HTTP client that tries again, tokens and the local git session.
 *
 * Every other layer builds on this class. See src/platform/repo/artifacts-backend/README.md for the order of the layers.
 * Never send a request twice that is not safe to repeat: see withRepo and the notes in commit.
 */
import git from "isomorphic-git";
import type { HttpClient } from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import { MemoryTreeCache, type TreeCache } from "../../../core/git/snapshot";
import type { CommitMeta } from "../backend";
import { type BlobCache, cacheApiBlobs } from "../blob-cache";
import { MemoryFS } from "../memory-fs";
import { GIT_TOKEN_MARGIN_MS, GIT_TOKEN_TTL_S, HICCUP, HICCUP_RETRIES, RETRIABLE, type ArtifactsBackendOptions, type GitSession } from "./types";
import { TRANSIENT_STATUS, artifactsErrorCode, gitErrorCode, transientNetworkError } from "./errors";
import { Lru, cloneCommit, dispose, drain, replay, toCommitMeta, tokenSecret } from "./helpers";

export abstract class ArtifactsCore {
  readonly kind = "artifacts" as const;

  protected readonly author: { name: string; email: string };
  protected readonly now: () => number;
  protected readonly sleep: (ms: number) => Promise<void>;
  protected readonly retryBudgetMs: number;
  protected readonly http: HttpClient;
  protected readonly trees: TreeCache;
  protected readonly commits = new Lru<CommitMeta>(2000);
  protected readonly remotes = new Map<string, string>();
  protected readonly tokens = new Map<string, { secret: string; expiresAtMs: number }>();
  protected readonly writes: "changeset" | "clone";
  protected readonly blobs: BlobCache | null;

  constructor(
    protected readonly binding: Artifacts,
    opts: ArtifactsBackendOptions = {},
  ) {
    this.author = opts.author ?? { name: "gitring", email: "logbook@gitring.invalid" };
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryBudgetMs = opts.retryBudgetMs ?? 20_000;
    this.trees = opts.treeCache ?? new MemoryTreeCache();
    this.writes = opts.writes ?? "changeset";
    this.blobs = opts.blobCache === undefined ? cacheApiBlobs() : opts.blobCache;
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

  // ───── Retries ─────

  /**
   * Retry `fn` while Artifacts reports *_IN_PROGRESS, with exponential backoff (budget ~20 s), and twice after a
   * short problem of the service (INTERNAL_ERROR).
   */
  protected async retrying<T>(fn: () => Promise<T>): Promise<T> {
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
  protected async hiccup(err: unknown, used: number): Promise<boolean> {
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
  protected async withRepo<T>(name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
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

  // ───── Remote URLs and tokens ─────

  protected remember(name: string, remote: string | undefined): void {
    if (remote) this.remotes.set(name, remote);
  }

  protected forget(name: string): void {
    this.remotes.delete(name);
    this.tokens.delete(name);
  }

  protected async branchTip(repo: ArtifactsRepo, branch: string): Promise<string | null> {
    const [c] = await repo.log({ ref: branch, limit: 1 });
    return c?.hash ?? null;
  }

  /** The last commits of a branch (first parents), newest first. Empty for a branch that does not exist. */
  protected async recentCommits(repo: ArtifactsRepo, branch: string, limit = 20): Promise<string[]> {
    return (await repo.log({ ref: branch, limit })).map((c) => c.hash);
  }

  /** Remote URL + a cached short-lived write token secret. */
  protected async credentials(name: string, repo: ArtifactsRepo): Promise<{ url: string; secret: string }> {
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
    return { url, secret: token.secret };
  }

  // ───── The local git directory ─────

  /** Remote URL + a cached short-lived write token secret + a fresh in-memory git dir. */
  protected async session(name: string, repo: ArtifactsRepo): Promise<GitSession> {
    const { url, secret } = await this.credentials(name, repo);
    return { fs: new MemoryFS(), dir: "/repo", cache: {}, url, secret };
  }

  /** A commit by id through an open handle (any commit of the repository, a notes commit too), cached. */
  protected async readCommitVia(r: ArtifactsRepo, sha: string): Promise<CommitMeta | null> {
    const hit = this.commits.get(sha);
    if (hit) return cloneCommit(hit);
    const c = await r.readCommit(sha);
    if (!c) return null;
    const meta = toCommitMeta(c);
    this.commits.set(sha, meta);
    return cloneCommit(meta);
  }

  /** Common isomorphic-git options. Credentials go out on the first request (no 401 round trip). */
  protected gitOpts(s: GitSession) {
    return {
      fs: s.fs,
      http: this.http,
      dir: s.dir,
      cache: s.cache,
      headers: { Authorization: `Basic ${btoa(`x:${s.secret}`)}` },
      onAuth: () => ({ username: "x", password: s.secret }),
    };
  }

  protected async initLocal(s: GitSession, defaultBranch: string): Promise<void> {
    await git.init({ fs: s.fs, dir: s.dir, defaultBranch });
    await git.addRemote({ fs: s.fs, dir: s.dir, remote: "origin", url: s.url });
  }

  /** Fetch one remote ref (depth 1) and point the same local ref at it. Null if the remote lacks it. */
  protected async fetchRef(s: GitSession, ref: string): Promise<string | null> {
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

  protected async resolveLocal(s: GitSession, ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: s.fs, dir: s.dir, ref });
    } catch (err) {
      if (gitErrorCode(err) === "NotFoundError") return null;
      throw err;
    }
  }
}
