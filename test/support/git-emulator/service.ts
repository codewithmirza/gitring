/**
 * The emulator's RPC surface and its RepoBackend client. No Cloudflare runtime imports here,
 * so both halves can be tested in Node; `../emulator.ts` binds them to a Durable Object.
 *
 *   EmulatorService  what the LocalArtifacts DO exposes over RPC (wraps a GitStore)
 *   EmulatorBackend  RepoBackend that calls ONE LocalArtifacts instance per namespace
 *
 * Workers RPC does not keep custom error classes or their fields, so `commit` returns a tagged
 * result for compare-and-swap failures and EmulatorBackend turns it back into RepoConflictError.
 */
import type { LocalArtifacts } from "./local-artifacts";
import {
  type CommitInput,
  type CommitMeta,
  type CommitResult,
  type ForkResult,
  type RepoBackend,
  RepoConflictError,
  type RepoHandle,
  type TreeEntry,
} from "../../../src/platform/repo/backend";
import type { GitStore, RepoInfo } from "./store";

export type EmulatorCommitOutcome =
  | { ok: true; sha: string; tree: string }
  | { ok: false; conflict: { message: string; expected: string; actual: string | null } };

/** RPC methods of the LocalArtifacts Durable Object (all async). */
export interface EmulatorRpc {
  ensureRepo(name: string, opts?: { description?: string }): Promise<RepoHandle>;
  fork(source: string, name: string, opts?: { description?: string; allBranches?: boolean }): Promise<ForkResult>;
  deleteRepo(name: string): Promise<void>;
  resolve(repo: string, ref: string): Promise<string | null>;
  readCommit(repo: string, sha: string): Promise<CommitMeta | null>;
  readTree(repo: string, treeSha: string): Promise<TreeEntry[] | null>;
  readBlob(repo: string, sha: string): Promise<Uint8Array | null>;
  log(repo: string, ref: string, limit?: number): Promise<CommitMeta[]>;
  commit(input: CommitInput): Promise<EmulatorCommitOutcome>;
  readNote(repo: string, commitSha: string): Promise<string | null>;
  listRepos(): Promise<RepoInfo[]>;
  listRefs(repo: string): Promise<Record<string, string>>;
}

export class EmulatorService implements EmulatorRpc {
  constructor(readonly git: GitStore) {}

  ensureRepo(name: string, opts?: { description?: string }): Promise<RepoHandle> {
    return this.git.ensureRepo(name, opts);
  }
  fork(source: string, name: string, opts?: { description?: string; allBranches?: boolean }): Promise<ForkResult> {
    return this.git.fork(source, name, opts);
  }
  deleteRepo(name: string): Promise<void> {
    return this.git.deleteRepo(name);
  }
  resolve(repo: string, ref: string): Promise<string | null> {
    return this.git.resolve(repo, ref);
  }
  readCommit(repo: string, sha: string): Promise<CommitMeta | null> {
    return this.git.readCommit(repo, sha);
  }
  readTree(repo: string, treeSha: string): Promise<TreeEntry[] | null> {
    return this.git.readTree(repo, treeSha);
  }
  readBlob(repo: string, sha: string): Promise<Uint8Array | null> {
    return this.git.readBlob(repo, sha);
  }
  log(repo: string, ref: string, limit?: number): Promise<CommitMeta[]> {
    return this.git.log(repo, ref, limit);
  }
  async commit(input: CommitInput): Promise<EmulatorCommitOutcome> {
    try {
      const res = await this.git.commit(input);
      return { ok: true, sha: res.sha, tree: res.tree };
    } catch (err) {
      if (err instanceof RepoConflictError) {
        return { ok: false, conflict: { message: err.message, expected: err.expected, actual: err.actual } };
      }
      throw err;
    }
  }
  readNote(repo: string, commitSha: string): Promise<string | null> {
    return this.git.readNote(repo, commitSha);
  }
  listRepos(): Promise<RepoInfo[]> {
    return this.git.listRepos();
  }
  listRefs(repo: string): Promise<Record<string, string>> {
    return this.git.listRefs(repo);
  }
}

/**
 * RepoBackend over the LocalArtifacts Durable Object. All repos of `namespaceName` live in ONE
 * DO instance (`idFromName(namespaceName)`), so objects are shared and forks are cheap.
 */
export class EmulatorBackend implements RepoBackend {
  readonly kind = "emulator" as const;
  private readonly id: DurableObjectId;

  constructor(
    private readonly ns: DurableObjectNamespace<LocalArtifacts>,
    readonly namespaceName: string,
  ) {
    this.id = ns.idFromName(namespaceName);
  }

  /** A fresh stub per call: a stub that saw an exception should not be reused. */
  private rpc(): EmulatorRpc {
    return this.ns.get(this.id) as unknown as EmulatorRpc;
  }

  ensureRepo(name: string, opts?: { description?: string }): Promise<RepoHandle> {
    return this.rpc().ensureRepo(name, opts);
  }
  fork(source: string, name: string, opts?: { description?: string; allBranches?: boolean }): Promise<ForkResult> {
    return this.rpc().fork(source, name, opts);
  }
  deleteRepo(name: string): Promise<void> {
    return this.rpc().deleteRepo(name);
  }
  resolve(repo: string, ref: string): Promise<string | null> {
    return this.rpc().resolve(repo, ref);
  }
  readCommit(repo: string, sha: string): Promise<CommitMeta | null> {
    return this.rpc().readCommit(repo, sha);
  }
  readTree(repo: string, treeSha: string): Promise<TreeEntry[] | null> {
    return this.rpc().readTree(repo, treeSha);
  }
  readBlob(repo: string, sha: string): Promise<Uint8Array | null> {
    return this.rpc().readBlob(repo, sha);
  }
  log(repo: string, ref: string, limit?: number): Promise<CommitMeta[]> {
    return this.rpc().log(repo, ref, limit);
  }
  async commit(input: CommitInput): Promise<CommitResult> {
    const res = await this.rpc().commit(input);
    if (!res.ok) throw new RepoConflictError(res.conflict.message, res.conflict.expected, res.conflict.actual);
    return { sha: res.sha, tree: res.tree };
  }
  readNote(repo: string, commitSha: string): Promise<string | null> {
    return this.rpc().readNote(repo, commitSha);
  }
  /** The emulator has no git remote: no tokens. */
  async revokeToken(_repo: string, _tokenOrId: string): Promise<boolean> {
    return false;
  }

  async createToken(_repo: string, _scope: "read" | "write", _ttlSeconds: number): Promise<undefined> {
    return undefined;
  }
  async remoteUrl(_repo: string): Promise<undefined> {
    return undefined;
  }

  /* Emulator extras (not part of RepoBackend). */
  listRepos(): Promise<RepoInfo[]> {
    return this.rpc().listRepos();
  }
  listRefs(repo: string): Promise<Record<string, string>> {
    return this.rpc().listRefs(repo);
  }
}
