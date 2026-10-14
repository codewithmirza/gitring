/**
 * Changesets: a commit built from the base tree and the changed paths only. The trees on a changed path
 * are read (through the caller's cached reader) and written again; every other subtree keeps its id and
 * is never read. So the work of a commit grows with the size of the change, not with the size of the
 * repository. The ids are the same as `prepareCommit` (snapshot.ts) gives for the same input.
 *
 * Pure module (WebCrypto + TextEncoder only). Runs in Node 22 and in workerd.
 */
import type { FileChange, TreeEntry } from "../../platform/repo/backend";
import { EMPTY_TREE_SHA, TREE_MODE, encodeCommit, encodeTree, hashObject, isSha, modeToType, normalizeCommitMessage, normalizeMode, utf8 } from "./objects";
import { assertValidPath } from "./snapshot";

/** One path to set (a blob id and a mode) or to delete (null). A missing mode keeps the file's mode, else 100644. */
export interface PathEdit {
  path: string;
  entry: { sha: string; mode?: string } | null;
}

export interface TreeReader {
  readTree(sha: string): Promise<TreeEntry[] | null>;
}

export interface Changeset {
  /** The new root tree id. */
  root: string;
  /** Every tree object that the base does not have (id → encoded body). */
  trees: Map<string, Uint8Array>;
  /** How many trees of the base were read. */
  read: number;
}

/** Modes a PathEdit may set (the same as a FileChange). Gitlinks (160000) are kept but cannot be written. */
const WRITABLE_MODES = new Set(["100644", "100755", "120000"]);

interface EditNode {
  files: Map<string, PathEdit["entry"]>;
  dirs: Map<string, EditNode>;
}

/** The edits as a tree of folders. A later edit of the same path replaces an earlier one. */
function editTree(edits: readonly PathEdit[]): EditNode {
  const root: EditNode = { files: new Map(), dirs: new Map() };
  for (const edit of edits) {
    assertValidPath(edit.path);
    if (edit.entry && !isSha(edit.entry.sha)) throw new Error(`invalid object id for ${edit.path}: ${String(edit.entry.sha)}`);
    const parts = edit.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], edit.entry);
  }
  return root;
}

/**
 * Apply `edits` to the tree `baseTree` (null: an empty base) and build the new trees. Only the folders on
 * an edited path are read and written. A folder that ends up empty leaves its parent, as in git. A path
 * that is a file in the base and a folder in the edits (or the other way round) is an error, unless the
 * edits delete the file first.
 */
export async function buildChangeset(reader: TreeReader, baseTree: string | null, edits: readonly PathEdit[]): Promise<Changeset> {
  const trees = new Map<string, Uint8Array>();
  let read = 0;
  const load = async (sha: string, at: string): Promise<TreeEntry[]> => {
    if (sha === EMPTY_TREE_SHA) return [];
    read += 1;
    const entries = await reader.readTree(sha);
    if (!entries) throw new Error(`tree ${sha} not found${at ? ` (at ${at}/)` : ""}`);
    return entries;
  };
  const build = async (sha: string | null, node: EditNode, at: string): Promise<string | null> => {
    const entries = new Map<string, TreeEntry>();
    if (sha) for (const e of await load(sha, at)) entries.set(e.name, e);
    const pathOf = (name: string) => (at ? `${at}/${name}` : name);
    // 1. Deletes first: a file may make way for a folder of the same name.
    for (const [name, entry] of node.files) {
      if (entry === null && entries.get(name)?.type !== "tree") entries.delete(name);
    }
    // 2. The folders on edited paths.
    for (const [name, sub] of node.dirs) {
      const existing = entries.get(name);
      if (existing && existing.type !== "tree") throw new Error(`path conflict: ${pathOf(name)} is both a file and a directory`);
      const subSha = await build(existing?.hash ?? null, sub, pathOf(name));
      if (subSha === null) entries.delete(name);
      else entries.set(name, { name, mode: TREE_MODE, hash: subSha, type: "tree" });
    }
    // 3. Files set by the edits.
    for (const [name, entry] of node.files) {
      if (entry === null) continue;
      const existing = entries.get(name);
      if (existing?.type === "tree") throw new Error(`path conflict: ${pathOf(name)} is both a file and a directory`);
      const mode = entry.mode !== undefined ? normalizeMode(entry.mode) : (existing?.mode ?? "100644");
      if (!WRITABLE_MODES.has(mode)) throw new Error(`unsupported file mode ${String(entry.mode ?? mode)} for ${pathOf(name)}`);
      entries.set(name, { name, mode, hash: entry.sha, type: modeToType(mode) });
    }
    if (entries.size === 0) return null;
    const body = encodeTree([...entries.values()]);
    const id = await hashObject("tree", body);
    if (id !== sha) trees.set(id, body);
    return id;
  };
  let root = await build(baseTree, editTree(edits), "");
  if (root === null) {
    root = EMPTY_TREE_SHA;
    if (baseTree !== EMPTY_TREE_SHA) trees.set(EMPTY_TREE_SHA, new Uint8Array(0));
  }
  return { root, trees, read };
}

export interface PreparedChangeset {
  /** Commit id. */
  sha: string;
  /** Root tree id. */
  tree: string;
  /** Encoded commit body. */
  commit: Uint8Array;
  /** New blobs (id → bytes). */
  blobs: Map<string, Uint8Array>;
  /** New trees (id → encoded body): the trees on the changed paths only. */
  trees: Map<string, Uint8Array>;
  /** How many trees of the base were read. */
  read: number;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === "string") return utf8.encode(content);
  if (content instanceof Uint8Array) return content;
  throw new Error("file content must be a string, Uint8Array or null");
}

/**
 * Everything a backend needs to push one commit as a changeset: the blobs of `changes`, the trees on the
 * changed paths over `baseTree`, and the commit (author = committer, given timestamp, tz "+0000" by default).
 * The same input and timestamp give the same commit id as `prepareCommit`.
 */
export async function prepareChangeset(args: {
  reader: TreeReader;
  /** The root tree of the parent commit; null for a root commit. */
  baseTree: string | null;
  changes: readonly FileChange[];
  parents: string[];
  author: { name: string; email: string };
  message: string;
  /** Unix seconds. */
  timestamp: number;
  tzOffset?: string;
}): Promise<PreparedChangeset> {
  const blobs = new Map<string, Uint8Array>();
  const edits: PathEdit[] = [];
  for (const change of args.changes) {
    assertValidPath(change.path);
    if (change.content === null) {
      edits.push({ path: change.path, entry: null });
      continue;
    }
    const bytes = toBytes(change.content);
    const sha = await hashObject("blob", bytes);
    blobs.set(sha, bytes);
    const entry: { sha: string; mode?: string } = { sha };
    if (change.mode !== undefined) entry.mode = normalizeMode(change.mode);
    edits.push({ path: change.path, entry });
  }
  const { root, trees, read } = await buildChangeset(args.reader, args.baseTree, edits);
  const ident = { name: args.author.name, email: args.author.email, timestamp: args.timestamp, tzOffset: args.tzOffset ?? "+0000" };
  const commit = encodeCommit({ tree: root, parents: args.parents, author: ident, committer: ident, message: normalizeCommitMessage(args.message) });
  const sha = await hashObject("commit", commit);
  return { sha, tree: root, commit, blobs, trees, read };
}
