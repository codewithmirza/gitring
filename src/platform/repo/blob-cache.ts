/**
 * A content-addressed cache of blobs in front of Artifacts reads. A blob never changes (its id is the hash of
 * its bytes), so a copy in the Workers Cache API is good for ever and needs no coordination: every project
 * object in a location shares it, under a URL made of the blob id. Small blobs only; the rest always come
 * from Artifacts. Without the Cache API (Node tests) the cache is off.
 */

export interface BlobCache {
  get(sha: string): Promise<Uint8Array | null>;
  put(sha: string, bytes: Uint8Array): Promise<void>;
}

/** The subset of the Cache API this module uses. */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** Blobs above this size are not cached (text that agents edit is far smaller). */
export const BLOB_CACHE_MAX_BYTES = 2 * 1024 * 1024;

/** The key of a blob: a URL that names the blob by id. The host is never contacted. */
export function blobCacheKey(sha: string): string {
  return `https://blobs.gitring.internal/${sha}`;
}

/** `caches.default` when the runtime has it (Workers), else undefined. */
export function defaultCache(): CacheLike | undefined {
  try {
    const caches = (globalThis as { caches?: { default?: CacheLike } }).caches;
    return caches?.default ?? undefined;
  } catch {
    return undefined;
  }
}

/** A BlobCache over the Cache API, or null when there is no cache to use. Every problem of the cache is a miss. */
export function cacheApiBlobs(cache: CacheLike | undefined = defaultCache()): BlobCache | null {
  if (!cache) return null;
  return {
    async get(sha) {
      try {
        const res = await cache.match(blobCacheKey(sha));
        if (!res) return null;
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        return null;
      }
    },
    async put(sha, bytes) {
      if (bytes.byteLength > BLOB_CACHE_MAX_BYTES) return;
      try {
        await cache.put(
          blobCacheKey(sha),
          new Response(bytes.slice() as unknown as ArrayBuffer, {
            headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Length": String(bytes.byteLength), "Content-Type": "application/octet-stream" },
          }),
        );
      } catch {
        /* a blob that the cache does not take comes from Artifacts next time */
      }
    },
  };
}
