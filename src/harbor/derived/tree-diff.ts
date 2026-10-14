/**
 * The file changes between two trees. A subtree with the same id on both sides is never read.
 * Called by update.ts and compare.ts. The cost grows with the change, not with the tree.
 */
import type { TreeEntry } from "../../platform/repo/backend";
import { EMPTY_TREE_SHA } from "../../core/git/objects";
import { MAX_STEP_FILES } from "./constants";
import type { TreeChange } from "./types";

/**
 * The file changes between two trees. A subtree with the same id on both sides is never read: the cost
 * grows with the change, not with the tree. At most `cap` changes ("cut": there are more). `prefix`: the
 * path of the two trees in the repository (the paths of the changes start with it).
 */
export async function diffTrees(read: (tree: string) => Promise<TreeEntry[]>, a: string, b: string, cap = MAX_STEP_FILES, prefix = ""): Promise<{ changes: TreeChange[]; cut: boolean }> {
  const changes: TreeChange[] = [];
  let cut = false;
  const add = (c: TreeChange) => {
    if (changes.length >= cap) cut = true;
    else changes.push(c);
  };
  const all = async (tree: string, prefix: string, status: "A" | "D"): Promise<void> => {
    for (const e of await read(tree)) {
      if (cut) return;
      const path = `${prefix}/${e.name}`;
      if (e.type === "tree") await all(e.hash, path, status);
      else add(status === "A" ? { path, status, now: e } : { path, status, old: e });
    }
  };
  const walk = async (x: string, y: string, prefix: string): Promise<void> => {
    if (x === y || cut) return;
    const [ex, ey] = await Promise.all([read(x), read(y)]);
    const mx = new Map(ex.map((e) => [e.name, e]));
    const my = new Map(ey.map((e) => [e.name, e]));
    for (const name of [...new Set([...mx.keys(), ...my.keys()])].sort()) {
      if (cut) return;
      const o = mx.get(name);
      const n = my.get(name);
      if (o && n && o.hash === n.hash && o.mode === n.mode) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const oTree = o?.type === "tree" ? o : undefined;
      const nTree = n?.type === "tree" ? n : undefined;
      const oFile = o && !oTree ? o : undefined;
      const nFile = n && !nTree ? n : undefined;
      if (oTree && nTree) {
        await walk(oTree.hash, nTree.hash, path);
        continue;
      }
      if (oFile && nFile) add({ path, status: "M", old: oFile, now: nFile });
      else if (oFile) add({ path, status: "D", old: oFile });
      else if (nFile) add({ path, status: "A", now: nFile });
      if (oTree) await all(oTree.hash, path, "D");
      if (nTree) await all(nTree.hash, path, "A");
    }
  };
  await walk(a || EMPTY_TREE_SHA, b || EMPTY_TREE_SHA, prefix);
  return { changes, cut };
}
