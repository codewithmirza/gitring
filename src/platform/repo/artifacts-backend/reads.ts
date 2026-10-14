/**
 * The read side of the Artifacts backend: resolve a ref, read commits, trees, blobs, history and notes.
 *
 * Reads go through the binding and are cached. A blob is cached for every repository, because its id names its bytes.
 */
import git from "isomorphic-git";
import { EMPTY_TREE_SHA, isSha } from "../../../core/git/objects";
import type { CommitMeta, TreeEntry } from "../backend";
import { DEFAULT_BRANCH, NOTES_REF } from "./types";
import { bindingRef, cloneCommit, toCommitMeta } from "./helpers";
import { findNote, localObjects } from "./git-local";
import { ArtifactsControl } from "./control";

export abstract class ArtifactsReads extends ArtifactsControl {
  // ───── Commits and trees ─────

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
    return this.withRepo(repo, (r) => this.readCommitVia(r, sha));
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

  protected async readTreeVia(r: ArtifactsRepo, sha: string): Promise<TreeEntry[] | null> {
    if (sha === EMPTY_TREE_SHA) return [];
    const hit = this.trees.get(sha);
    if (hit) return hit;
    const raw = await r.readTree(sha);
    if (!raw) return null;
    const entries = raw.map((e) => ({ name: e.name, mode: e.mode, hash: e.hash, type: e.type }));
    this.trees.set(sha, entries);
    return entries;
  }

  // ───── Blobs ─────

  /** A blob by id. A small blob read once comes from the shared cache the next time (any repository: the id names the bytes). */
  async readBlob(repo: string, sha: string): Promise<Uint8Array | null> {
    if (!isSha(sha)) return null;
    const cached = await this.blobs?.get(sha);
    if (cached) return cached;
    const bytes = await this.withRepo(repo, async (r) => {
      const blob = await r.readBlob(sha);
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    });
    if (bytes && this.blobs) await this.blobs.put(sha, bytes);
    return bytes;
  }

  // ───── History ─────

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

  // ───── Notes ─────

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
}
