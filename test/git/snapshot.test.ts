/** Snapshot read / diff / apply / build, with git as the reference for tree ids. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_TREE_SHA, decodeTree, hashObject, utf8 } from "../../src/core/git/objects";
import {
  MemoryTreeCache,
  type Snapshot,
  applyFileChanges,
  buildTrees,
  diffSnapshots,
  pathProblem,
  prepareCommit,
  readSnapshot,
} from "../../src/core/git/snapshot";
import type { TreeEntry } from "../../src/platform/repo/backend";
import { git, tempDir } from "./helpers";

async function snap(files: Record<string, string | { content: string; mode: string }>): Promise<Snapshot> {
  const s: Snapshot = new Map();
  for (const [path, v] of Object.entries(files)) {
    const content = typeof v === "string" ? v : v.content;
    const mode = typeof v === "string" ? "100644" : v.mode;
    s.set(path, { sha: await hashObject("blob", utf8.encode(content)), mode });
  }
  return s;
}

/** Tree id git computes for the same files (fresh index, `git write-tree`). */
function gitTreeOf(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(["init", "-q", dir]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(["add", "-A"], { cwd: dir });
  return git(["write-tree"], { cwd: dir });
}

/** An in-memory readTree backend that counts calls and concurrency. */
function treeBackend(trees: Map<string, Uint8Array>, delayMs = 2) {
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };
  return {
    stats,
    async readTree(_repo: string, sha: string): Promise<TreeEntry[] | null> {
      stats.calls++;
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      stats.inFlight--;
      const body = trees.get(sha);
      return body ? decodeTree(body) : null;
    },
  };
}

let tmp: ReturnType<typeof tempDir>;
beforeAll(() => {
  tmp = tempDir();
});
afterAll(() => tmp.cleanup());

describe("MemoryTreeCache", () => {
  it("evicts the least recently used tree", () => {
    const c = new MemoryTreeCache(2);
    c.set("a", []);
    c.set("b", []);
    expect(c.get("a")).toEqual([]); // a is now most recent
    c.set("c", []);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBeDefined();
    expect(c.get("c")).toBeDefined();
    expect(c.size).toBe(2);
  });
});

describe("buildTrees + readSnapshot", () => {
  it("round-trips a nested snapshot with bounded parallel reads and caching", async () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 12; d++) for (let f = 0; f < 3; f++) files[`pkg${d}/sub/file${f}.js`] = `// ${d}/${f}\n`;
    files["README.md"] = "# x\n";
    const s = await snap(files);
    const { root, trees } = await buildTrees(s);
    expect(root).toBe(gitTreeOf(tmp.path, "nested", files));
    expect(trees.size).toBe(1 + 12 * 2);

    const backend = treeBackend(trees);
    const cache = new MemoryTreeCache();
    const read = await readSnapshot(backend, "r", root, cache);
    expect([...read.keys()]).toEqual([...s.keys()].sort());
    expect(read).toEqual(new Map([...s].sort((a, b) => (a[0] < b[0] ? -1 : 1))));
    expect(backend.stats.calls).toBe(trees.size);
    expect(backend.stats.maxInFlight).toBeGreaterThan(1);
    expect(backend.stats.maxInFlight).toBeLessThanOrEqual(8);

    // Second read: served from the cache.
    await readSnapshot(backend, "r", root, cache);
    expect(backend.stats.calls).toBe(trees.size);
  });

  it("empty snapshot ↔ empty tree", async () => {
    const { root, trees } = await buildTrees(new Map());
    expect(root).toBe(EMPTY_TREE_SHA);
    expect(trees.get(EMPTY_TREE_SHA)).toEqual(new Uint8Array(0));
    const backend = treeBackend(new Map());
    expect(await readSnapshot(backend, "r", EMPTY_TREE_SHA)).toEqual(new Map());
    expect(backend.stats.calls).toBe(0);
  });

  it("throws when a tree is missing", async () => {
    const s = await snap({ "a/b.txt": "x" });
    const { root, trees } = await buildTrees(s);
    const sub = decodeTree(trees.get(root)!)[0].hash;
    trees.delete(sub);
    await expect(readSnapshot(treeBackend(trees), "r", root)).rejects.toThrow(/not found in r \(at a\/\)/);
  });

  it("deleting every file of a directory removes the directory", async () => {
    const before = await snap({ "keep.txt": "k", "gone/a.txt": "a", "gone/deep/b.txt": "b", "src/x.js": "x" });
    const { snapshot } = await applyFileChanges(before, [
      { path: "gone/a.txt", content: null },
      { path: "gone/deep/b.txt", content: null },
      { path: "src/y.js", content: "y" },
    ]);
    const { root, trees } = await buildTrees(snapshot);
    expect(root).toBe(gitTreeOf(tmp.path, "emptied", { "keep.txt": "k", "src/x.js": "x", "src/y.js": "y" }));
    expect(decodeTree(trees.get(root)!).map((e) => e.name)).toEqual(["keep.txt", "src"]);
  });

  it("reports file/directory path conflicts", async () => {
    const s = await snap({ a: "file" });
    const { snapshot } = await applyFileChanges(s, [{ path: "a/b", content: "nested" }]);
    await expect(buildTrees(snapshot)).rejects.toThrow(/path conflict: a is both a file and a directory/);
    // Delete + add in the same change set is fine, in any order.
    const ok = await applyFileChanges(s, [{ path: "a/b", content: "nested" }, { path: "a", content: null }]);
    expect((await buildTrees(ok.snapshot)).root).toBe(gitTreeOf(tmp.path, "file-to-dir", { "a/b": "nested" }));
  });
});

describe("applyFileChanges", () => {
  it("handles text, bytes, deletes and modes", async () => {
    const base = await snap({ "bin/run": { content: "#!/bin/sh\n", mode: "100755" }, "a.txt": "a" });
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const { snapshot, blobs } = await applyFileChanges(base, [
      { path: "bin/run", content: "#!/bin/sh\necho changed\n" }, // keeps 100755
      { path: "new.sh", content: "#!/bin/sh\n", mode: "100755" },
      { path: "plain.txt", content: "p" }, // default 100644
      { path: "data.bin", content: bytes },
      { path: "a.txt", content: null },
      { path: "missing.txt", content: null }, // no-op
      { path: "link", content: "a.txt", mode: "120000" },
    ]);
    expect(snapshot.get("bin/run")?.mode).toBe("100755");
    expect(snapshot.get("new.sh")?.mode).toBe("100755");
    expect(snapshot.get("plain.txt")?.mode).toBe("100644");
    expect(snapshot.get("link")?.mode).toBe("120000");
    expect(snapshot.has("a.txt")).toBe(false);
    expect(base.has("a.txt")).toBe(true); // base untouched
    const binSha = snapshot.get("data.bin")!.sha;
    expect(blobs.get(binSha)).toEqual(bytes);
    expect(binSha).toBe(git(["hash-object", "--stdin"], { input: bytes }));
    expect(blobs.size).toBe(5);
  });

  it("rejects bad paths and modes", async () => {
    for (const bad of ["", "/abs", "dir/", "a//b", "./a", "a/../b", ".git/config", "x/.GIT/y", "a\\b"]) {
      expect(pathProblem(bad)).not.toBeNull();
      await expect(applyFileChanges(new Map(), [{ path: bad, content: "x" }])).rejects.toThrow(/invalid path/);
    }
    expect(pathProblem("src/.gitignore")).toBeNull();
    await expect(applyFileChanges(new Map(), [{ path: "d", content: "x", mode: "40000" }])).rejects.toThrow(/unsupported file mode/);
    await expect(applyFileChanges(new Map(), [{ path: "d", content: "x", mode: "160000" }])).rejects.toThrow(/unsupported file mode/);
  });
});

describe("diffSnapshots", () => {
  it("A/M/D sorted by path; a mode-only change is M", async () => {
    const base = await snap({ "b.txt": "b", "a.txt": "a", "z/run": "r", "same.txt": "s" });
    const head = await snap({ "a.txt": "A!", "c.txt": "c", "z/run": { content: "r", mode: "100755" }, "same.txt": "s" });
    const d = diffSnapshots(base, head);
    expect(d.map((c) => `${c.status} ${c.path}`)).toEqual(["M a.txt", "D b.txt", "A c.txt", "M z/run"]);
    const run = d.find((c) => c.path === "z/run")!;
    expect(run.oldSha).toBe(run.newSha);
    expect(run.mode).toBe("100755");
    expect(d.find((c) => c.path === "b.txt")).toEqual({ path: "b.txt", status: "D", oldSha: base.get("b.txt")!.sha, mode: "100644" });
    expect(diffSnapshots(head, head)).toEqual([]);
  });
});

describe("prepareCommit", () => {
  it("builds the same commit git commit-tree builds", async () => {
    const work = join(tmp.path, "commit");
    mkdirSync(work);
    git(["init", "-q", "-b", "main", work]);
    const p = await prepareCommit({
      base: new Map(),
      changes: [{ path: "README.md", content: "# hi\n" }, { path: "src/a.js", content: "a\n" }],
      parents: [],
      author: { name: "Vessel", email: "v@bearing.dev" },
      message: "First",
      timestamp: 1_760_000_000,
    });
    // Write blobs + trees into git, then commit-tree with the same identity and time.
    for (const body of p.blobs.values()) git(["hash-object", "-w", "--stdin"], { cwd: work, input: body });
    for (const body of p.trees.values()) git(["hash-object", "-w", "-t", "tree", "--stdin"], { cwd: work, input: body });
    const env = {
      GIT_AUTHOR_NAME: "Vessel",
      GIT_AUTHOR_EMAIL: "v@bearing.dev",
      GIT_AUTHOR_DATE: "1760000000 +0000",
      GIT_COMMITTER_NAME: "Vessel",
      GIT_COMMITTER_EMAIL: "v@bearing.dev",
      GIT_COMMITTER_DATE: "1760000000 +0000",
    };
    expect(git(["commit-tree", p.tree, "-m", "First"], { cwd: work, env })).toBe(p.sha);
  });
});
