/**
 * Test double for Cloudflare Artifacts: real git objects in memory or SQLite, for tests only.
 *
 * LocalArtifacts is a Durable Object that stores real git objects (same SHA-1 ids as git) for
 * every repo of one namespace in its SQLite storage. Bind it as EMULATOR (class LocalArtifacts,
 * a `new_sqlite_classes` migration) and talk to it through EmulatorBackend.
 *
 * The logic lives in ./emulator/store.ts (GitStore over an ObjectStore) and
 * ./emulator/service.ts (RPC surface + client); this file only binds them to the DO runtime.
 */
import { DurableObject } from "cloudflare:workers";
import type { CommitInput, CommitMeta, ForkResult, RepoHandle, TreeEntry } from "../../../src/platform/repo/backend";
import { type EmulatorCommitOutcome, type EmulatorRpc, EmulatorService } from "./service";
import { GitStore, type RepoInfo, SqlObjectStore } from "./store";

export { EmulatorBackend, EmulatorService, type EmulatorCommitOutcome, type EmulatorRpc } from "./service";
export { GitStore, MemoryObjectStore, SqlObjectStore, type ObjectStore, type RepoInfo, type RepoRecord } from "./store";

/** Durable Object that stores git objects for many repos (one namespace). Bind as EMULATOR. */
export class LocalArtifacts extends DurableObject implements EmulatorRpc {
  private readonly service: EmulatorService;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.service = new EmulatorService(new GitStore(new SqlObjectStore(ctx.storage)));
  }

  async ensureRepo(name: string, opts?: { description?: string }): Promise<RepoHandle> {
    return this.service.ensureRepo(name, opts);
  }
  async fork(source: string, name: string, opts?: { description?: string }): Promise<ForkResult> {
    return this.service.fork(source, name, opts);
  }
  async deleteRepo(name: string): Promise<void> {
    return this.service.deleteRepo(name);
  }
  async resolve(repo: string, ref: string): Promise<string | null> {
    return this.service.resolve(repo, ref);
  }
  async readCommit(repo: string, sha: string): Promise<CommitMeta | null> {
    return this.service.readCommit(repo, sha);
  }
  async readTree(repo: string, treeSha: string): Promise<TreeEntry[] | null> {
    return this.service.readTree(repo, treeSha);
  }
  async readBlob(repo: string, sha: string): Promise<Uint8Array | null> {
    return this.service.readBlob(repo, sha);
  }
  async log(repo: string, ref: string, limit?: number): Promise<CommitMeta[]> {
    return this.service.log(repo, ref, limit);
  }
  /** Compare-and-swap failures come back as `{ ok: false, conflict }` (see EmulatorBackend.commit). */
  async commit(input: CommitInput): Promise<EmulatorCommitOutcome> {
    return this.service.commit(input);
  }
  async readNote(repo: string, commitSha: string): Promise<string | null> {
    return this.service.readNote(repo, commitSha);
  }
  async listRepos(): Promise<RepoInfo[]> {
    return this.service.listRepos();
  }
  async listRefs(repo: string): Promise<Record<string, string>> {
    return this.service.listRefs(repo);
  }
}
