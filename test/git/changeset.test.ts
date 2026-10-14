/**
 * Changesets: the same ids as prepareCommit, with reads and new trees on the changed paths only.
 */
import { describe, expect, it } from "vitest";
import { type PathEdit, buildChangeset, prepareChangeset } from "../../src/core/git/changeset";
import { EMPTY_TREE_SHA, decodeTree, hashObject, utf8 } from "../../src/core/git/objects";
import { type Snapshot, prepareCommit, readSnapshot } from "../../src/core/git/snapshot";
import type { FileChange } from "../../src/platform/repo/backend";
import { GitStore, MemoryObjectStore } from "../support/git-emulator/store";

const author = { name: "Robin", email: "robin@gitring.dev" };
const NOW = 1_760_000_000;

/** A store with one commit of `files` on main; returns the store and the commit. */
async function seeded(files: Record<string, string> | FileChange[]) {
  const store = new MemoryObjectStore();
  const g = new GitStore(store, { now: () => NOW * 1000 });
  await g.ensureRepo("demo");
  const changes = Array.isArray(files) ? files : Object.entries(files).map(([path, content]) => ({ path, content }));
  const c = await g.commit({ repo: "demo", branch: "main", parent: "", message: "seed", author, changes });
  return { store, g, sha: c.sha, tree: c.tree };
}

/** A tree reader over the store that counts reads. */
function readerOf(store: MemoryObjectStore) {
  const reads: string[] = [];
  return {
    reads,
    async readTree(sha: string) {
      reads.push(sha);
      const o = await store.getObject(sha);
      return o && o.type === "tree" ? decodeTree(o.body) : null;
    },
  };
}

/** A small tree, and the same tree with 120 more files under vendor/ (the same folders on every other path). */
const SMALL: Record<string, string> = {
  "README.md": "# Demo\n",
  "src/app/index.ts": "export const a = 1;\n",
  "src/app/util.ts": "export const u = 2;\n",
  "src/other/x.ts": "export const x = 3;\n",
  "vendor/a.js": "1\n",
};
const BIG: Record<string, string> = {
  ...SMALL,
  ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`vendor/lib${i % 6}/pkg${i % 10}/file${i}.js`, `module.exports = ${i};\n`])),
};

describe("prepareChangeset", () => {
  it("gives the ids of prepareCommit for a root commit and for a change on a tree", async () => {
    const changes: FileChange[] = [
      { path: "README.md", content: "# Demo\n" },
      { path: "src/index.js", content: "export default 1;\n" },
      { path: "scripts/build.sh", content: "#!/bin/sh\n", mode: "100755" },
      { path: "docs/link.md", content: "../README.md", mode: "120000" },
      { path: "assets/pixel.bin", content: new Uint8Array([0, 255, 0, 1]) },
    ];
    const reader = { readTree: async () => null };
    const root = await prepareChangeset({ reader, baseTree: null, changes, parents: [], author, message: "Seed", timestamp: NOW });
    const expected = await prepareCommit({ base: new Map(), changes, parents: [], author, message: "Seed", timestamp: NOW });
    expect([root.sha, root.tree]).toEqual([expected.sha, expected.tree]);
    expect([...root.trees.keys()].sort()).toEqual([...expected.trees.keys()].sort());
    expect([...root.blobs.keys()].sort()).toEqual([...expected.blobs.keys()].sort());
    expect(root.read).toBe(0);

    // The second commit: the same ids as the emulator (prepareCommit over the full snapshot).
    const { store, sha, tree } = await seeded(changes);
    const second: FileChange[] = [
      { path: "src/index.js", content: "export default 2;\n" },
      { path: "docs/link.md", content: null },
      { path: "tests/a.test.js", content: "// test\n" },
      { path: "scripts/build.sh", content: "#!/bin/sh\necho 2\n" },
    ];
    const r = readerOf(store);
    const got = await prepareChangeset({ reader: r, baseTree: tree, changes: second, parents: [sha], author, message: "Second", timestamp: NOW });
    const g = new GitStore(store, { now: () => NOW * 1000 });
    const base: Snapshot = await readSnapshot({ readTree: (_repo, s) => r.readTree(s) }, "demo", tree);
    const want = await prepareCommit({ base, changes: second, parents: [sha], author, message: "Second", timestamp: NOW });
    expect([got.sha, got.tree]).toEqual([want.sha, want.tree]);
    // And the emulator agrees when it writes the same commit.
    const emu = await g.commit({ repo: "demo", branch: "main", parent: sha, message: "Second", author, changes: second });
    expect(emu.sha).toBe(got.sha);
    // Only the trees on the changed paths are new: root, src, scripts, and tests (new); docs is gone, assets is untouched.
    const names = new Map<string, string>();
    for (const [id, body] of got.trees) names.set(id, decodeTree(body).map((e) => e.name).join(","));
    expect([...names.values()].sort()).toEqual(["README.md,assets,scripts,src,tests", "a.test.js", "build.sh", "index.js"]);
    // The exec bit of scripts/build.sh is kept without a mode in the change.
    const scripts = [...got.trees.values()].map(decodeTree).find((es) => es[0]?.name === "build.sh")!;
    expect(scripts[0].mode).toBe("100755");
  });

  it("reads and writes only the trees on the changed paths of a large tree", async () => {
    const { store, sha, tree } = await seeded(BIG);
    const r = readerOf(store);
    const got = await prepareChangeset({
      reader: r,
      baseTree: tree,
      changes: [{ path: "src/app/index.ts", content: "export const a = 2;\n" }],
      parents: [sha],
      author,
      message: "One line",
      timestamp: NOW,
    });
    // root, src, src/app were read (3 of the 20 trees); the vendor subtree was not.
    expect(got.read).toBe(3);
    expect(got.trees.size).toBe(3);
    expect(got.blobs.size).toBe(1);
    const all = await readSnapshot({ readTree: (_repo, s) => r.readTree(s) }, "demo", tree);
    expect(all.size).toBe(125);
    // The new root keeps the id of the vendor subtree.
    const rootEntries = decodeTree(got.trees.get(got.tree)!);
    const baseRoot = decodeTree((await store.getObject(tree))!.body);
    expect(rootEntries.find((e) => e.name === "vendor")!.hash).toBe(baseRoot.find((e) => e.name === "vendor")!.hash);
  });

  it("the same change costs the same on a small and on a large tree", async () => {
    const small = await seeded(SMALL);
    const big = await seeded(BIG);
    const change: FileChange[] = [{ path: "src/app/index.ts", content: "export const a = 3;\n" }];
    const a = await prepareChangeset({ reader: readerOf(small.store), baseTree: small.tree, changes: change, parents: [small.sha], author, message: "m", timestamp: NOW });
    const b = await prepareChangeset({ reader: readerOf(big.store), baseTree: big.tree, changes: change, parents: [big.sha], author, message: "m", timestamp: NOW });
    const bytes = (p: typeof a) => [...p.blobs.values(), ...p.trees.values(), p.commit].reduce((n, o) => n + o.byteLength, 0);
    expect([a.read, a.trees.size, a.blobs.size]).toEqual([b.read, b.trees.size, b.blobs.size]);
    expect(bytes(a)).toBe(bytes(b));
  });
});

describe("buildChangeset", () => {
  async function blob(text: string) {
    return hashObject("blob", utf8.encode(text));
  }

  it("a delete that empties a folder removes the folder; a missing path is a no-op", async () => {
    const { store, tree } = await seeded({ "a/b/c.txt": "c", "a/d.txt": "d" });
    const r = readerOf(store);
    const got = await buildChangeset(r, tree, [
      { path: "a/b/c.txt", entry: null },
      { path: "nope/x.txt", entry: null },
    ]);
    const root = decodeTree(got.trees.get(got.root)!);
    expect(root.map((e) => e.name)).toEqual(["a"]);
    const a = decodeTree(got.trees.get(root[0].hash)!);
    expect(a.map((e) => e.name)).toEqual(["d.txt"]);
    // root, a and a/b were read; the folder "nope" was never read or made. New trees: root and a (a/b is gone).
    expect(r.reads).toHaveLength(3);
    expect(got.trees.size).toBe(2);
  });

  it("a tree that becomes empty is the empty tree", async () => {
    const { store, tree } = await seeded({ "only.txt": "x" });
    const got = await buildChangeset(readerOf(store), tree, [{ path: "only.txt", entry: null }]);
    expect(got.root).toBe(EMPTY_TREE_SHA);
    expect(got.trees.get(EMPTY_TREE_SHA)).toEqual(new Uint8Array(0));
    // Nothing changes: the root keeps its id and no tree is new.
    const same = await buildChangeset(readerOf(store), tree, [{ path: "gone.txt", entry: null }]);
    expect(same.root).toBe(tree);
    expect(same.trees.size).toBe(0);
  });

  it("a file may make way for a folder when the edits delete it; otherwise a path conflict is an error", async () => {
    const { store, tree } = await seeded({ "a": "file a", "b/c": "c" });
    const sha = await blob("new");
    const ok = await buildChangeset(readerOf(store), tree, [
      { path: "a", entry: null },
      { path: "a/x", entry: { sha } },
    ]);
    const root = decodeTree(ok.trees.get(ok.root)!);
    expect(root.map((e) => `${e.type} ${e.name}`)).toEqual(["tree a", "tree b"]);
    await expect(buildChangeset(readerOf(store), tree, [{ path: "a/x", entry: { sha } }])).rejects.toThrow(/path conflict: a is both a file and a directory/);
    await expect(buildChangeset(readerOf(store), tree, [{ path: "b", entry: { sha } }])).rejects.toThrow(/path conflict: b is both a file and a directory/);
    await expect(buildChangeset(readerOf(store), tree, [{ path: "q", entry: { sha, mode: "160000" } }])).rejects.toThrow(/unsupported file mode/);
    await expect(buildChangeset(readerOf(store), tree, [{ path: "../q", entry: { sha } }])).rejects.toThrow(/invalid path/);
    await expect(buildChangeset(readerOf(store), tree, [{ path: "q", entry: { sha: "nope" } }])).rejects.toThrow(/invalid object id/);
    await expect(buildChangeset(readerOf(store), "f".repeat(40), [{ path: "q", entry: { sha } }])).rejects.toThrow(/not found/);
  });

  it("a later edit of the same path wins, and modes are kept or set", async () => {
    const { store, tree } = await seeded([{ path: "bin/run", content: "#!/bin/sh\n", mode: "100755" }]);
    const one = await blob("1");
    const two = await blob("2");
    const edits: PathEdit[] = [
      { path: "bin/run", entry: { sha: one } },
      { path: "bin/run", entry: { sha: two } },
      { path: "bin/other", entry: { sha: one, mode: "100644" } },
    ];
    const got = await buildChangeset(readerOf(store), tree, edits);
    const bin = decodeTree(got.trees.get(decodeTree(got.trees.get(got.root)!)[0].hash)!);
    expect(bin.map((e) => `${e.mode} ${e.name} ${e.hash}`)).toEqual([`100644 other ${one}`, `100755 run ${two}`]);
    // Asked for, the mode changes.
    const plain = await buildChangeset(readerOf(store), tree, [{ path: "bin/run", entry: { sha: two, mode: "100644" } }]);
    const bin2 = decodeTree(plain.trees.get(decodeTree(plain.trees.get(plain.root)!)[0].hash)!);
    expect(bin2[0].mode).toBe("100644");
  });
});
