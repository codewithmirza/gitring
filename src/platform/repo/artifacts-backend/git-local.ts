/**
 * Git helpers of the Artifacts backend: read and write objects in an in-memory git directory, find notes, build packs.
 *
 * Used by the clone path and by the note code. The changeset path needs only packObjects and fannedNotePath.
 */
import git from "isomorphic-git";
import type { PreparedChangeset } from "../../../core/git/changeset";
import { EMPTY_TREE_SHA, decodeCommit, decodeTree, utf8 } from "../../../core/git/objects";
import type { CommitMeta, TreeEntry } from "../backend";
import type { PackObject } from "../pack";
import { gitErrorCode } from "./errors";
import type { GitSession, ObjectIO } from "./types";

/** The objects a prepared changeset sends: its blobs, the trees on the changed paths, the commit. */
export function packObjects(p: Pick<PreparedChangeset, "blobs" | "trees" | "sha" | "commit">): PackObject[] {
  const out: PackObject[] = [];
  for (const [, body] of p.blobs) out.push({ type: "blob", body });
  for (const [, body] of p.trees) out.push({ type: "tree", body });
  out.push({ type: "commit", body: p.commit });
  return out;
}

/** The path of a note in the fan-out layout of a notes tree (`ab/cdef…`). */
export function fannedNotePath(commitSha: string): string {
  return `${commitSha.slice(0, 2)}/${commitSha.slice(2)}`;
}

/** Find the note for `name` in a notes tree: flat (`<sha>`) or fanned out (`ab/cdef…`). */
export async function findNote(io: ObjectIO, treeSha: string, name: string): Promise<string | null> {
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
export function localObjects(s: GitSession) {
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
export async function writeLocalObjects(s: GitSession, objects: Iterable<["blob" | "tree" | "commit", string, Uint8Array]>): Promise<void> {
  for (const [type, sha, body] of objects) {
    const oid = await git.writeObject({ fs: s.fs, dir: s.dir, type, object: body, format: "content" });
    if (oid !== sha) throw new Error(`object id mismatch for ${type} ${sha}: isomorphic-git computed ${oid}`);
  }
}

/** New objects of a prepared commit; trees in `present` (already in the clone) are skipped. */
export function* preparedObjects(
  p: { blobs: Map<string, Uint8Array>; trees: Map<string, Uint8Array>; sha: string; commit: Uint8Array },
  present: ReadonlySet<string> = new Set(),
) {
  for (const [sha, body] of p.blobs) yield ["blob", sha, body] as ["blob", string, Uint8Array];
  for (const [sha, body] of p.trees) if (!present.has(sha)) yield ["tree", sha, body] as ["tree", string, Uint8Array];
  yield ["commit", p.sha, p.commit] as ["commit", string, Uint8Array];
}
