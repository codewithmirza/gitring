/**
 * The write side of the Artifacts backend: a commit with its note, as a changeset or with a shallow clone.
 *
 * A push is the only write path. The branch moves only if it is still at the parent that the caller read.
 * Never leave a note for a commit that did not land.
 */
import git from "isomorphic-git";
import { type PathEdit, buildChangeset, prepareChangeset } from "../../../core/git/changeset";
import { EMPTY_TREE_SHA, encodeCommit, hashObject, isSha, isValidBranchName, normalizeCommitMessage, utf8 } from "../../../core/git/objects";
import { type Snapshot, prepareCommit, readSnapshot } from "../../../core/git/snapshot";
import { type CommitInput, type CommitResult, type FileChange, RepoConflictError } from "../backend";
import { MemoryFS } from "../memory-fs";
import { writePack } from "../pack";
import { PushRejectedError, advertisedRefs, pushPack } from "../push";
import { DEFAULT_BRANCH, NOTES_REF, type GitSession } from "./types";
import { ChangesetError, branchConflict, fallsBack, gitErrorCode } from "./errors";
import { fannedNotePath, localObjects, packObjects, preparedObjects, writeLocalObjects } from "./git-local";
import { ArtifactsReads } from "./reads";

/*
 * How a commit is written (the plan that the steps below follow).
 * Writes: `git push` is the only write path. A commit is a changeset: its cost grows with the size
 * of the change, not with the size of the repository, and nothing is cloned:
 *   1. optimistic check of the branch tip through the binding (`log({ ref, limit: 1 })`);
 *   2. one request for the ref advertisement of the remote (`info/refs?service=git-receive-pack`,
 *      push.ts): the tips of the branch and of `refs/notes/gitring`. Tip ≠ `input.parent` →
 *      RepoConflictError;
 *   3. the new objects only: the blobs of the changes and the trees on the changed paths, built
 *      over the parent's tree through the cached `readTree` of the binding (changeset.ts). Every
 *      other subtree keeps its id and is never read. The ids are the ones `prepareCommit` gives;
 *   4. if `input.note`: a notes commit with one blob, one `ab/` subtree and one root tree in the
 *      fan-out layout (a flat notes tree moves to it on the first write), pushed first, so a landed
 *      commit always has its note. A lost race on the notes ref is tried again;
 *   5. one pack (pack.ts: version 2, whole objects, zlib through CompressionStream) in one
 *      receive-pack request with `<parent> <commit> <branch>`. The server compare-and-swaps the ref
 *      on the old id; `ng` with a moved tip becomes RepoConflictError. A push that fails removes the
 *      note of step 4 again (best effort), so no note names a commit that never landed. When the
 *      branch holds the commit after all (the answer got lost), the commit counts and keeps its note.
 *
 * The clone path stays: isomorphic-git on an in-memory filesystem (shallow clone of the branch,
 * loose objects, push). `writes: "clone"` selects it, and a changeset push that fails for a reason
 * that is not a conflict (the server could not use the pack, an answer that is not git's) falls
 * back to it on its own.
 */

export abstract class ArtifactsWrites extends ArtifactsReads {
  async commit(input: CommitInput): Promise<CommitResult> {
    if (!isValidBranchName(input.branch)) throw new Error(`invalid branch name: ${String(input.branch)}`);
    if (input.parent !== "" && !isSha(input.parent)) throw new Error(`invalid parent commit id: ${String(input.parent)}`);
    const expected = input.parent || null;

    return this.withRepo(input.repo, async (repo) => {
      // 1. Cheap optimistic check (no git traffic when the caller is already stale).
      const tip = await this.branchTip(repo, input.branch);
      if (tip !== expected) throw branchConflict(input, tip);
      if (this.writes === "changeset") {
        try {
          return await this.commitChangeset(repo, input);
        } catch (err) {
          if (!fallsBack(err)) throw err;
          console.warn(`changeset push to ${input.repo} did not work (${String((err as Error).message ?? err)}); gitring pushes with a clone instead`);
        }
      }
      return this.commitWithClone(repo, input);
    });
  }

  /** Steps 2 to 5 of the plan at the top of this file: the new objects over the parent's tree, in one pack, with nothing cloned. */
  private async commitChangeset(repo: ArtifactsRepo, input: CommitInput): Promise<CommitResult> {
    const branchRef = `refs/heads/${input.branch}`;
    const expected = input.parent || null;
    const { url, secret } = await this.credentials(input.repo, repo);

    // 2. One request: the tips of the branch and of the notes ref, as the server will compare them.
    const adv = await advertisedRefs(this.http, url, secret);
    const head = adv.refs.get(branchRef) ?? null;
    if (head !== expected) throw branchConflict(input, head);

    // 3. The parent's tree, then the trees on the changed paths only (cached reads through the binding).
    let baseTree: string | null = null;
    if (input.parent) {
      const parent = await this.readCommitVia(repo, input.parent);
      if (!parent) throw new ChangesetError(`parent commit ${input.parent} cannot be read through the binding`);
      baseTree = parent.treeHash;
    }
    const prepared = await prepareChangeset({
      reader: { readTree: (sha) => this.readTreeVia(repo, sha) },
      baseTree,
      changes: input.changes,
      parents: input.parent ? [input.parent] : [],
      author: input.author,
      message: input.message,
      timestamp: Math.floor(this.now() / 1000),
    });

    // 4. Note first: once the branch moves, its note already exists.
    if (input.note) await this.pushNoteChangeset(repo, url, secret, adv.refs.get(NOTES_REF) ?? null, prepared.sha, input.note);

    // 5. One pack, one request. The server compares the branch with `expected` before it moves it.
    const pack = await writePack(packObjects(prepared));
    try {
      await pushPack(this.http, url, secret, [{ ref: branchRef, old: expected, new: prepared.sha }], pack);
    } catch (err) {
      // undefined: the branch cannot be read now. Then the note stays: an extra note is better than a merge without its note.
      const recent = await this.recentCommits(repo, input.branch).catch(() => undefined);
      // The answer got lost, but the branch holds the commit (maybe under a newer one): it landed, with its note.
      if (recent?.includes(prepared.sha)) return { sha: prepared.sha, tree: prepared.tree };
      const now = recent ? (recent[0] ?? null) : undefined;
      // The commit did not land: its note names a commit that no branch holds. Remove it again (best effort).
      if (input.note && now !== undefined) await this.pushNoteChangeset(repo, url, secret, undefined, prepared.sha, null).catch(() => undefined);
      if (err instanceof PushRejectedError && now !== undefined && now !== expected) throw branchConflict(input, now);
      throw err;
    }
    return { sha: prepared.sha, tree: prepared.tree };
  }

  /**
   * Add the note of `commitSha` to refs/notes/gitring in the fan-out layout and push it (3 tries on a lost
   * race). `tip` is the notes ref as last advertised (undefined: look it up). `null` removes the note of
   * `commitSha` (nothing to push when it has none). A flat notes tree moves to the fan-out layout on the
   * first write: a one-time cost that reads only the root tree. Every read goes through the binding, cached.
   */
  private async pushNoteChangeset(repo: ArtifactsRepo, url: string, secret: string, tip: string | null | undefined, commitSha: string, note: string | null): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (tip === undefined) tip = (await advertisedRefs(this.http, url, secret)).refs.get(NOTES_REF) ?? null;
      let baseTree: string | null = null;
      const edits: PathEdit[] = [];
      if (tip) {
        const notesCommit = await this.readCommitVia(repo, tip);
        if (!notesCommit) throw new ChangesetError(`notes commit ${tip} cannot be read through the binding`);
        baseTree = notesCommit.treeHash;
        const root = await this.readTreeVia(repo, baseTree);
        if (!root) throw new ChangesetError(`notes tree ${baseTree} cannot be read through the binding`);
        for (const e of root) {
          if (e.type === "tree" || !isSha(e.name)) continue;
          edits.push({ path: e.name, entry: null }, { path: fannedNotePath(e.name), entry: { sha: e.hash, mode: e.mode } });
        }
      }
      const blobs = new Map<string, Uint8Array>();
      if (note === null) {
        edits.push({ path: fannedNotePath(commitSha), entry: null });
      } else {
        const body = utf8.encode(note);
        const sha = await hashObject("blob", body);
        blobs.set(sha, body);
        edits.push({ path: fannedNotePath(commitSha), entry: { sha, mode: "100644" } });
      }
      const built = await buildChangeset({ readTree: (sha) => this.readTreeVia(repo, sha) }, baseTree, edits);
      if (note === null && built.root === (baseTree ?? EMPTY_TREE_SHA)) return;
      const ident = { name: this.author.name, email: this.author.email, timestamp: Math.floor(this.now() / 1000), tzOffset: "+0000" };
      const commit = encodeCommit({
        tree: built.root,
        parents: tip ? [tip] : [],
        author: ident,
        committer: ident,
        message: normalizeCommitMessage(note === null ? `Notes removed by gitring for ${commitSha}` : `Notes added by gitring for ${commitSha}`),
      });
      const sha = await hashObject("commit", commit);
      const pack = await writePack(packObjects({ blobs, trees: built.trees, sha, commit }));
      try {
        await pushPack(this.http, url, secret, [{ ref: NOTES_REF, old: tip, new: sha }], pack);
        return;
      } catch (err) {
        if (!(err instanceof PushRejectedError) || attempt >= 3) throw err;
        tip = undefined; // another writer moved the notes ref: read it again
      }
    }
  }

  /** The clone path: a shallow clone of the branch at the parent, loose objects, push (isomorphic-git). */
  private async commitWithClone(repo: ArtifactsRepo, input: CommitInput): Promise<CommitResult> {
    const branchRef = `refs/heads/${input.branch}`;
    const expected = input.parent || null;
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
      // undefined: the branch cannot be read now. Then the note stays: an extra note is better than a merge without its note.
      const recent = await this.recentCommits(repo, input.branch).catch(() => undefined);
      // The answer got lost, but the branch holds the commit (maybe under a newer one): it landed, with its note.
      if (recent?.includes(prepared.sha)) return { sha: prepared.sha, tree: prepared.tree };
      const now = recent ? (recent[0] ?? null) : undefined;
      // The commit did not land: its note names a commit that no branch holds. Remove it again (best effort).
      if (input.note && now !== undefined) await this.pushNote(s.url, s.secret, prepared.sha, null).catch(() => undefined);
      if (rejected && now !== undefined && now !== expected) throw branchConflict(input, now);
      throw err;
    }
    return { sha: prepared.sha, tree: prepared.tree };
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
