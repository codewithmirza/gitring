/**
 * Small helpers of the Artifacts backend: stream replay, disposal of RPC handles, commit copies and a small LRU cache.
 *
 * No network and no git here.
 */
import type { CommitMeta } from "../backend";

/** The token secret for HTTP Basic auth: the token without its `?expires=…` suffix. */
export function tokenSecret(token: string): string {
  const i = token.indexOf("?expires=");
  return i < 0 ? token : token.slice(0, i);
}

export async function* replay(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

/** Read an answer to its end, so that the connection is free again. */
export async function drain(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<void> {
  if (!body) return;
  try {
    for await (const chunk of body) void chunk;
  } catch {
    /* the answer is not needed */
  }
}

export function dispose(handle: unknown): void {
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

/** `refs/heads/x` → `x` (the binding takes branch names); everything else as is. */
export function bindingRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export function toCommitMeta(c: ArtifactsCommitMetadata): CommitMeta {
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

export function cloneCommit(c: CommitMeta): CommitMeta {
  return { ...c, author: { ...c.author }, committer: { ...c.committer }, parents: [...c.parents] };
}

export class Lru<V> {
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
