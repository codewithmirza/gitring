/**
 * The control plane of the Artifacts backend: make, fork and delete a repository, and its tokens and remote URL.
 *
 * Creation and forks can still be in progress. The calls here wait with a back-off until the service is ready.
 */
import type { ForkResult, RepoHandle } from "../backend";
import { DEFAULT_BRANCH, RETRIABLE } from "./types";
import { artifactsErrorCode } from "./errors";
import { dispose } from "./helpers";
import { ArtifactsCore } from "./core";

export abstract class ArtifactsControl extends ArtifactsCore {
  // ───── Make a repository ─────

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

  // ───── Fork ─────

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

  // ───── Tokens and the remote URL ─────

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
}
