/**
 * The blob cache in front of Artifacts reads: a blob read once comes from the cache the next time, for
 * every backend that shares the cache; large blobs and a broken cache never get in the way.
 */
import { describe, expect, it } from "vitest";
import { hashObjectSync, utf8 } from "../../src/core/git/objects";
import { ArtifactsBackend } from "../../src/platform/repo/artifacts";
import { BLOB_CACHE_MAX_BYTES, type CacheLike, blobCacheKey, cacheApiBlobs, defaultCache } from "../../src/platform/repo/blob-cache";

/** A Cache API stand-in: a Map of responses, with switches to break it. */
function fakeCache(opts: { broken?: boolean } = {}): CacheLike & { store: Map<string, Uint8Array>; puts: number; matches: number } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    puts: 0,
    matches: 0,
    async match(key: string) {
      this.matches += 1;
      if (opts.broken) throw new Error("cache down");
      const hit = store.get(key);
      return hit ? new Response(hit.slice() as unknown as ArrayBuffer) : undefined;
    },
    async put(key: string, res: Response) {
      this.puts += 1;
      if (opts.broken) throw new Error("cache down");
      store.set(key, new Uint8Array(await res.arrayBuffer()));
    },
  };
}

/** An Artifacts binding with two blobs, counting reads. */
function stubBinding(blobs: Map<string, Uint8Array>) {
  const reads: string[] = [];
  const binding = {
    reads,
    async get() {
      return {
        async readBlob(hash: string) {
          reads.push(hash);
          const b = blobs.get(hash);
          return b ? new Blob([b as unknown as ArrayBuffer]) : null;
        },
        [Symbol.dispose]() {},
      };
    },
  };
  return binding;
}

describe("blob cache", () => {
  const small = utf8.encode("export const a = 1;\n");
  const smallSha = hashObjectSync("blob", small);
  const huge = new Uint8Array(BLOB_CACHE_MAX_BYTES + 1);
  const hugeSha = hashObjectSync("blob", huge);

  it("is off without the Cache API", () => {
    expect(defaultCache()).toBeUndefined();
    expect(cacheApiBlobs(undefined)).toBeNull();
    expect(blobCacheKey(smallSha)).toBe(`https://blobs.gitring.internal/${smallSha}`);
  });

  it("serves a blob read once to every backend that shares the cache, by id", async () => {
    const cache = fakeCache();
    const blobs = new Map([
      [smallSha, small],
      [hugeSha, huge],
    ]);
    const one = stubBinding(blobs);
    const two = stubBinding(blobs);
    const a = new ArtifactsBackend(one as unknown as Artifacts, { blobCache: cacheApiBlobs(cache) });
    const b = new ArtifactsBackend(two as unknown as Artifacts, { blobCache: cacheApiBlobs(cache) });
    expect(await a.readBlob("p1", smallSha)).toEqual(small);
    expect(await a.readBlob("p1", smallSha)).toEqual(small);
    expect(one.reads).toEqual([smallSha]);
    // Another project object, another repository: the id names the bytes, so the cache answers.
    expect(await b.readBlob("p2", smallSha)).toEqual(small);
    expect(two.reads).toEqual([]);
    expect(cache.store.size).toBe(1);
    expect(cache.store.get(blobCacheKey(smallSha))).toEqual(small);

    // A large blob is read from Artifacts every time and never stored.
    expect((await a.readBlob("p1", hugeSha))?.byteLength).toBe(huge.byteLength);
    expect((await a.readBlob("p1", hugeSha))?.byteLength).toBe(huge.byteLength);
    expect(one.reads).toEqual([smallSha, hugeSha, hugeSha]);
    expect(cache.store.size).toBe(1);
    // A missing blob is not cached as anything.
    expect(await a.readBlob("p1", "f".repeat(40))).toBeNull();
    expect(cache.store.size).toBe(1);
  });

  it("a cache that fails is a miss, never an error", async () => {
    const cache = fakeCache({ broken: true });
    const one = stubBinding(new Map([[smallSha, small]]));
    const a = new ArtifactsBackend(one as unknown as Artifacts, { blobCache: cacheApiBlobs(cache) });
    expect(await a.readBlob("p1", smallSha)).toEqual(small);
    expect(await a.readBlob("p1", smallSha)).toEqual(small);
    expect(one.reads).toEqual([smallSha, smallSha]);
    expect(cache.matches).toBe(2);
    expect(cache.puts).toBe(2);
  });

  it("`blobCache: null` turns the cache off", async () => {
    const one = stubBinding(new Map([[smallSha, small]]));
    const a = new ArtifactsBackend(one as unknown as Artifacts, { blobCache: null });
    await a.readBlob("p1", smallSha);
    await a.readBlob("p1", smallSha);
    expect(one.reads).toHaveLength(2);
  });
});
