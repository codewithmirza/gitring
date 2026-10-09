/**
 * GitStore (the emulator's logic) over both object stores. The SQL store runs on node:sqlite
 * through an adapter that mimics Durable Object `ctx.storage` (`sql.exec(...).toArray()`,
 * `transactionSync`). Stored objects are exported into a real git repo and checked with
 * `git fsck --strict` and `git log`.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_TREE_SHA, utf8 } from "../../src/core/git/objects";
import { RepoConflictError } from "../../src/platform/repo/backend";
import {
  GitStore,
  MemoryObjectStore,
  type ObjectStore,
  SqlObjectStore,
  type SqlStorageLike,
} from "../support/git-emulator/store";
import { git, tempDir } from "./helpers";

type NodeSqlite = typeof import("node:sqlite");

/** Durable Object storage look-alike over node:sqlite (in memory). */
export function sqliteStorage(): SqlStorageLike & { close(): void } {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as NodeSqlite;
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as never[];
        const rows = db.prepare(query).all(...args) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}

const T0 = 1_760_000_000_000;
const author = { name: "Kestrel", email: "kestrel@bearing.dev" };

function makeStores(): [string, () => ObjectStore][] {
  return [
    ["MemoryObjectStore", () => new MemoryObjectStore()],
    ["SqlObjectStore", () => new SqlObjectStore(sqliteStorage())],
  ];
}

let tmp: ReturnType<typeof tempDir>;
beforeAll(() => {
  tmp = tempDir();
});
afterAll(() => tmp.cleanup());

describe.each(makeStores())("GitStore over %s", (_label, makeStore) => {
  let clock = T0;
  const fresh = () => {
    clock = T0;
    const store = makeStore();
    return { store, git: new GitStore(store, { now: () => (clock += 1000) }) };
  };

  it("ensureRepo is idempotent and validates names", async () => {
    const { git: g } = fresh();
    expect(await g.ensureRepo("demo", { description: "d" })).toEqual({ name: "demo", defaultBranch: "main" });
    expect(await g.ensureRepo("demo")).toEqual({ name: "demo", defaultBranch: "main" });
    expect((await g.listRepos()).map((r) => [r.name, r.description])).toEqual([["demo", "d"]]);
    await expect(g.ensureRepo("-bad")).rejects.toThrow(/INVALID_REPO_NAME/);
    await expect(g.ensureRepo("a b")).rejects.toThrow(/INVALID_REPO_NAME/);
    await expect(g.resolve("missing", "main")).rejects.toThrow(/NOT_FOUND/);
  });

  it("root commit, second commit, resolve, log, reads", async () => {
    const { git: g } = fresh();
    await g.ensureRepo("demo");
    expect(await g.resolve("demo", "main")).toBeNull();
    expect(await g.log("demo", "main")).toEqual([]);

    const c1 = await g.commit({
      repo: "demo",
      branch: "main",
      parent: "",
      message: "Seed",
      author,
      changes: [
        { path: "README.md", content: "# Demo\n" },
        { path: "src/index.js", content: "export default {};\n" },
        { path: "src/render.js", content: "export const render = () => '';\n" },
      ],
    });
    expect(c1.sha).toMatch(/^[0-9a-f]{40}$/);
    for (const ref of ["main", "refs/heads/main", "HEAD", c1.sha]) expect(await g.resolve("demo", ref)).toBe(c1.sha);
    expect(await g.resolve("demo", "nope")).toBeNull();
    expect(await g.resolve("demo", c1.sha.slice(0, 7))).toBeNull();
    expect(await g.resolve("demo", c1.tree)).toBeNull(); // a tree is not a commit

    const c2 = await g.commit({
      repo: "demo",
      branch: "main",
      parent: c1.sha,
      message: "Change render\n\nBearing-Intent: int_1\n",
      author,
      changes: [
        { path: "src/render.js", content: "export const render = (x) => x;\n" },
        { path: "README.md", content: null },
      ],
    });
    const log = await g.log("demo", "main");
    expect(log.map((c) => c.hash)).toEqual([c2.sha, c1.sha]);
    expect(log[0]).toMatchObject({
      treeHash: c2.tree,
      parents: [c1.sha],
      message: "Change render\n\nBearing-Intent: int_1",
      author,
      committer: author,
      authoredAt: (T0 + 3000) / 1000, // the clock ticks for ensureRepo, commit 1, commit 2
      committedAt: (T0 + 3000) / 1000,
    });
    expect(log[1].message).toBe("Seed");
    expect(log[1].parents).toEqual([]);
    expect(await g.log("demo", "main", 1)).toHaveLength(1);
    expect((await g.log("demo", c1.sha)).map((c) => c.hash)).toEqual([c1.sha]);

    const root = await g.readTree("demo", c2.tree);
    expect(root?.map((e) => [e.name, e.type])).toEqual([["src", "tree"]]);
    const src = await g.readTree("demo", root![0].hash);
    const render = src!.find((e) => e.name === "render.js")!;
    expect(utf8.decode((await g.readBlob("demo", render.hash))!)).toBe("export const render = (x) => x;\n");
    expect(await g.readBlob("demo", c2.tree)).toBeNull(); // not a blob
    expect(await g.readTree("demo", "0".repeat(40))).toBeNull();
    expect(await g.readTree("demo", EMPTY_TREE_SHA)).toEqual([]);
    expect(await g.readCommit("demo", "not-a-sha")).toBeNull();
    expect((await g.readCommit("demo", c2.sha))?.hash).toBe(c2.sha);
  });

  it("compare-and-swap: stale parent, root on existing branch, parent on missing branch", async () => {
    const { git: g } = fresh();
    await g.ensureRepo("demo");
    const c1 = await g.commit({ repo: "demo", branch: "main", parent: "", message: "1", author, changes: [{ path: "a", content: "1" }] });
    const c2 = await g.commit({ repo: "demo", branch: "main", parent: c1.sha, message: "2", author, changes: [{ path: "a", content: "2" }] });

    const stale = g.commit({ repo: "demo", branch: "main", parent: c1.sha, message: "x", author, changes: [] });
    await expect(stale).rejects.toBeInstanceOf(RepoConflictError);
    await expect(stale).rejects.toMatchObject({ expected: c1.sha, actual: c2.sha });

    await expect(g.commit({ repo: "demo", branch: "main", parent: "", message: "x", author, changes: [] })).rejects.toMatchObject({
      name: "RepoConflictError",
      expected: "",
      actual: c2.sha,
    });
    await expect(g.commit({ repo: "demo", branch: "feature", parent: c2.sha, message: "x", author, changes: [] })).rejects.toMatchObject({
      expected: c2.sha,
      actual: null,
    });
    // A new branch starts with a root commit.
    const f = await g.commit({ repo: "demo", branch: "feature", parent: "", message: "f", author, changes: [{ path: "f", content: "f" }] });
    expect(await g.resolve("demo", "feature")).toBe(f.sha);
    expect(await g.resolve("demo", "main")).toBe(c2.sha);

    await expect(g.commit({ repo: "demo", branch: "bad..name", parent: "", message: "x", author, changes: [] })).rejects.toThrow(/invalid branch/);
    await expect(g.commit({ repo: "demo", branch: "main", parent: "abc", message: "x", author, changes: [] })).rejects.toThrow(/invalid parent/);
  });

  it("concurrent commits on the same parent: exactly one wins", async () => {
    const { git: g } = fresh();
    await g.ensureRepo("demo");
    const c1 = await g.commit({ repo: "demo", branch: "main", parent: "", message: "1", author, changes: [{ path: "a", content: "1" }] });
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((i) => g.commit({ repo: "demo", branch: "main", parent: c1.sha, message: `racer ${i}`, author, changes: [{ path: `r${i}`, content: `${i}` }] })),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(3);
    for (const l of lost) expect(l.reason).toBeInstanceOf(RepoConflictError);
    expect(await g.resolve("demo", "main")).toBe((won[0] as PromiseFulfilledResult<{ sha: string }>).value.sha);
  });

  it("fork copies the default branch only; forks diverge independently; notes stay per repo", async () => {
    const { git: g } = fresh();
    await g.ensureRepo("canon");
    const c1 = await g.commit({ repo: "canon", branch: "main", parent: "", message: "1", author, changes: [{ path: "a", content: "1" }], note: '{"schema":"bearing.logbook/v1"}' });
    await g.commit({ repo: "canon", branch: "side", parent: "", message: "side", author, changes: [{ path: "s", content: "s" }] });

    const fork = await g.fork("canon", "att-1", { description: "attempt 1" });
    expect(fork).toEqual({ name: "att-1", defaultBranch: "main" });
    expect(await g.listRefs("att-1")).toEqual({ "refs/heads/main": c1.sha });
    expect(await g.readNote("canon", c1.sha)).toBe('{"schema":"bearing.logbook/v1"}');
    expect(await g.readNote("att-1", c1.sha)).toBeNull(); // notes are not copied (defaultBranchOnly)

    const f2 = await g.commit({ repo: "att-1", branch: "main", parent: c1.sha, message: "work", author, changes: [{ path: "b", content: "b" }] });
    expect(await g.resolve("canon", "main")).toBe(c1.sha);
    expect(await g.resolve("att-1", "main")).toBe(f2.sha);
    // Objects are shared: canon can read the fork's commit by id (content-addressed store).
    expect((await g.readCommit("canon", f2.sha))?.hash).toBe(f2.sha);

    // Retried fork of the same source is idempotent; a name clash with another repo is an error.
    expect(await g.fork("canon", "att-1")).toEqual({ name: "att-1", defaultBranch: "main" });
    await g.ensureRepo("other");
    await expect(g.fork("canon", "other")).rejects.toThrow(/ALREADY_EXISTS/);
    await expect(g.fork("missing", "x")).rejects.toThrow(/NOT_FOUND/);

    // Fork of an empty repo is empty.
    await g.ensureRepo("empty");
    await g.fork("empty", "empty-fork");
    expect(await g.listRefs("empty-fork")).toEqual({});

    expect((await g.listRepos()).find((r) => r.name === "att-1")).toMatchObject({ source: "canon", description: "attempt 1" });
  });

  it("deleteRepo removes refs and notes; a re-created repo starts empty", async () => {
    const { git: g } = fresh();
    await g.ensureRepo("tmp");
    const c = await g.commit({ repo: "tmp", branch: "main", parent: "", message: "1", author, changes: [{ path: "a", content: "1" }], note: "n" });
    await g.deleteRepo("tmp");
    await g.deleteRepo("tmp"); // idempotent
    await expect(g.log("tmp", "main")).rejects.toThrow(/NOT_FOUND/);
    await expect(g.commit({ repo: "tmp", branch: "main", parent: c.sha, message: "x", author, changes: [] })).rejects.toThrow(/NOT_FOUND/);
    await g.ensureRepo("tmp");
    expect(await g.resolve("tmp", "main")).toBeNull();
    expect(await g.readNote("tmp", c.sha)).toBeNull();
  });

  it("executable bit: kept on edit, changed only when asked", async () => {
    const { git: g } = fresh();
    await g.ensureRepo("demo");
    const c1 = await g.commit({ repo: "demo", branch: "main", parent: "", message: "1", author, changes: [{ path: "bin/run", content: "#!/bin/sh\n", mode: "100755" }] });
    const c2 = await g.commit({ repo: "demo", branch: "main", parent: c1.sha, message: "2", author, changes: [{ path: "bin/run", content: "#!/bin/sh\necho 2\n" }] });
    const bin = async (tree: string) => (await g.readTree("demo", (await g.readTree("demo", tree))![0].hash))![0];
    expect(await bin(c2.tree)).toMatchObject({ name: "run", mode: "100755", type: "exec" });
    const c3 = await g.commit({ repo: "demo", branch: "main", parent: c2.sha, message: "3", author, changes: [{ path: "bin/run", content: "#!/bin/sh\necho 2\n", mode: "100644" }] });
    expect(await bin(c3.tree)).toMatchObject({ mode: "100644", type: "blob" });
    expect(c3.tree).not.toBe(c2.tree);
  });

  it("stores objects larger than one SQLite row", async () => {
    const { git: g } = fresh();
    await g.ensureRepo("big");
    const big = new Uint8Array(2_500_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const c = await g.commit({ repo: "big", branch: "main", parent: "", message: "big", author, changes: [{ path: "asset.bin", content: big }] });
    const entry = (await g.readTree("big", c.tree))![0];
    expect(entry.hash).toBe(git(["hash-object", "--stdin"], { input: big }));
    const back = await g.readBlob("big", entry.hash);
    expect(back?.length).toBe(big.length);
    expect(Buffer.from(back!).equals(Buffer.from(big))).toBe(true);
  });

  it("stored objects are valid git: export, fsck --strict, git log", async () => {
    const { store, git: g } = fresh();
    await g.ensureRepo("demo");
    const c1 = await g.commit({ repo: "demo", branch: "main", parent: "", message: "Seed", author, changes: [{ path: "src/a.js", content: "a\n" }, { path: "bin/x", content: "x", mode: "100755" }, { path: "l", content: "src/a.js", mode: "120000" }] });
    const c2 = await g.commit({ repo: "demo", branch: "main", parent: c1.sha, message: "Two", author, changes: [{ path: "src/b.js", content: "b\n" }, { path: "bin/x", content: null }] });
    if (!(store instanceof MemoryObjectStore)) return; // object listing is a MemoryObjectStore feature
    const dir = join(tmp.path, `fsck-${Date.now()}`);
    git(["init", "-q", "--bare", dir]);
    for (const [sha, obj] of store.objects) {
      expect(git(["hash-object", "-w", "-t", obj.type, "--stdin"], { cwd: dir, input: obj.body })).toBe(sha);
    }
    git(["update-ref", "refs/heads/main", c2.sha], { cwd: dir });
    git(["fsck", "--strict", "--no-dangling"], { cwd: dir });
    expect(git(["log", "--format=%H %s", "main"], { cwd: dir }).split("\n")).toEqual([`${c2.sha} Two`, `${c1.sha} Seed`]);
    expect(git(["ls-tree", "-r", "--format=%(objectmode) %(path)", "main"], { cwd: dir }).split("\n")).toEqual([
      "120000 l",
      "100644 src/a.js",
      "100644 src/b.js",
    ]);
  });
});

describe("stores agree", () => {
  it("memory and SQL stores produce identical commit ids for identical input", async () => {
    const run = async (store: ObjectStore) => {
      let t = T0;
      const g = new GitStore(store, { now: () => (t += 1000) });
      await g.ensureRepo("r");
      const a = await g.commit({ repo: "r", branch: "main", parent: "", message: "a", author, changes: [{ path: "x/y.txt", content: "y" }] });
      const b = await g.commit({ repo: "r", branch: "main", parent: a.sha, message: "b", author, changes: [{ path: "x/z.txt", content: "z" }] });
      return [a.sha, b.sha, b.tree];
    };
    expect(await run(new MemoryObjectStore())).toEqual(await run(new SqlObjectStore(sqliteStorage())));
  });
});
