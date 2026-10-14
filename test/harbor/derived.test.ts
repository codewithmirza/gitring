/**
 * Derived data of main (src/harbor/derived.ts) on the git test double and node:sqlite: the changes of
 * main in order, line blame that a merge computes from its parent, path history, the search index with
 * FTS5 (and the plain scan when SQLite has no FTS5), and a compare of two versions.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DerivedHistory, diffTrees, lineCount, type DerivedSource, type WorkCopyFiles } from "../../src/harbor/derived";
import { readSnapshot } from "../../src/core/git/snapshot";
import type { RepoBackend } from "../../src/platform/repo/backend";
import { backendOf, author } from "../github/fake";
import { sqliteCtx } from "../support/sqlite-storage";
import { mulberry32 } from "./world";
import { steViolations } from "../coord/ste";
import type * as T from "../../src/core/types";

const REPO = "robin-shop";
const decoder = new TextDecoder();

/** A project in miniature: a repository, main, merges with notes, and the source that the derived data reads. */
class Project {
  backend: RepoBackend = backendOf();
  db = sqliteCtx();
  main = { sha: "", tree: "" };
  landings: T.Landing[] = [];
  notes = new Map<string, string>();
  work = new Map<string, WorkCopyFiles>();
  treeReads = 0;
  textReads = 0;
  commitReads = 0;
  pending: Promise<unknown>[] = [];
  /** Every commit of main, in order: the files after it. */
  versions: { sha: string; files: Map<string, string> }[] = [];
  files = new Map<string, string>();
  noFts = false;

  source(): DerivedSource {
    const sql = this.db.storage.sql as unknown as SqlStorage;
    const noFts = this.noFts;
    return {
      sql: noFts
        ? ({
            exec: (q: string, ...b: unknown[]) => {
              if (/VIRTUAL TABLE/i.test(q)) throw new Error("no such module: fts5");
              return sql.exec(q, ...(b as never[]));
            },
          } as unknown as SqlStorage)
        : sql,
      main: () => (this.main.sha ? { repo: REPO, ...this.main } : undefined),
      landings: () => this.landings,
      note: (id) => this.notes.get(id) ?? null,
      callsign: (id) => `Robin-${id}`,
      title: (id) => `Task ${id}`,
      commit: (sha) => {
        this.commitReads++;
        return this.backend.readCommit(REPO, sha);
      },
      readTree: (tree) => {
        this.treeReads++;
        return this.backend.readTree(REPO, tree);
      },
      text: async (sha) => {
        this.textReads++;
        const bytes = await this.backend.readBlob(REPO, sha);
        return bytes ? decoder.decode(bytes) : null;
      },
      treeText: async (tree) => {
        const snapshot = await readSnapshot(this.backend, REPO, tree);
        const text = new Map<string, string>();
        for (const [path, e] of snapshot) text.set(path, decoder.decode((await this.backend.readBlob(REPO, e.sha))!));
        return { snapshot, text };
      },
      workCopy: async (id) => this.work.get(id),
      background: (p) => void this.pending.push(p),
    };
  }

  async start(files: Record<string, string>): Promise<string> {
    await this.backend.ensureRepo(REPO);
    return this.commit(files, { merge: false, message: "Start shop" });
  }

  /** A commit on main: a merge of gitring (with a landing and a note) or a move of main without a merge. */
  async commit(files: Record<string, string | null>, o: { merge?: boolean; message?: string } = {}): Promise<string> {
    const before = this.main.sha;
    const c = await this.backend.commit({
      repo: REPO,
      branch: "main",
      parent: before,
      changes: Object.entries(files).map(([path, content]) => ({ path, content })),
      message: o.message ?? "Outside change",
      author,
    });
    this.main = { sha: c.sha, tree: c.tree };
    for (const [p, t] of Object.entries(files)) {
      if (t === null) this.files.delete(p);
      else this.files.set(p, t);
    }
    this.versions.push({ sha: c.sha, files: new Map(this.files) });
    if (o.merge ?? true) {
      const n = this.landings.length + 1;
      const id = `ld_${n}`;
      this.landings.push({ id, attemptId: `a_${n}`, intentId: `in${n}`, agentId: `${n}`, method: "merge", mainBefore: before, mainAfter: c.sha, checks: { passed: n, failed: 0 } as T.CheckRun, correctionsApplied: 0, at: 1_000 + n, message: `Task in${n}` });
      this.notes.set(id, JSON.stringify({ schema: "gitring.logbook/v1", intent: { id: `in${n}`, title: `Task in${n}`, goal: `Goal ${n}.` }, attempt: { course: { plan: [`Step ${n}`], files: Object.keys(files), approach: "Small." } }, agent: { callsign: `Robin-${n}` }, method: "merge", corrections: [], courseChecks: [], checks: { passed: n, failed: 0, cases: [] } }));
    }
    return c.sha;
  }

  async settle(): Promise<void> {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }
}

let p: Project;
afterEach(() => {
  p?.db.close();
  p = undefined as unknown as Project;
});

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");

describe("search engine", () => {
  it("has FTS5 with the trigram tokenizer in the SQLite of the tests (Durable Object SQLite has FTS5 too)", () => {
    p = new Project();
    expect(new DerivedHistory(p.source()).searchEngine).toBe("fts5");
  });

  it("falls back to a plain scan when SQLite has no FTS5", () => {
    p = new Project();
    p.noFts = true;
    expect(new DerivedHistory(p.source()).searchEngine).toBe("scan");
  });
});

describe("the changes of main", () => {
  it("lists the root, the merges and the moves of main without a merge, the newest first", async () => {
    p = new Project();
    const root = await p.start({ "README.md": lines("# Shop") });
    const m1 = await p.commit({ "src/price.js": lines("export const price = 1;") });
    const out = await p.commit({ "docs/a.md": lines("hello") }, { merge: false, message: "Pull of outside changes\n\nMore text." });
    const m2 = await p.commit({ "src/price.js": lines("export const price = 2;") });
    const h = new DerivedHistory(p.source());
    const all = await h.history({});
    expect(all.steps.map((s) => [s.sha, s.kind])).toEqual([
      [m2, "merge"],
      [out, "outside"],
      [m1, "merge"],
      [root, "root"],
    ]);
    expect(all.steps[1].subject).toBe("Pull of outside changes");
    expect(all.steps[0]).toMatchObject({ subject: "Task in2", files: 1, merge: { landingId: "ld_2", callsign: "Robin-2", tests: { passed: 2, failed: 0 } } });
    expect(all.more).toBe(false);
    expect(steViolations(all.summary)).toEqual([]);
    const two = await h.history({ limit: 2 });
    expect(two.steps).toHaveLength(2);
    expect(two.more).toBe(true);
  });

  it("gives the changes of a file and of a folder, with the root when the file was there at the start", async () => {
    p = new Project();
    await p.start({ "src/a.js": lines("a") });
    await p.commit({ "src/a.js": lines("a", "b") });
    await p.commit({ "src/b.js": lines("x"), "src/a.js": null });
    const h = new DerivedHistory(p.source());
    const a = await h.history({ path: "src/a.js" });
    expect(a.steps.map((s) => [s.kind, s.change?.status ?? null])).toEqual([
      ["merge", "D"],
      ["merge", "M"],
      ["root", null],
    ]);
    expect(a.steps[1].change).toMatchObject({ additions: 1, deletions: 0 });
    const dir = await h.history({ path: "src/" });
    expect(dir.steps.map((s) => s.change?.paths ?? null)).toEqual([2, 1, null]);
    expect(dir.steps[0].change?.status).toBe("M");
    // A path that never changed and was never there.
    const none = await h.history({ path: "nope.js" });
    expect(none.steps).toEqual([]);
    expect(none.summary).toBe("gitring has no change of nope.js in the history of main.");
  });
});

describe("line blame", () => {
  it("names the merge that wrote a line, with its why-record, and the root for old lines", async () => {
    p = new Project();
    const root = await p.start({ "src/price.js": lines("one", "two", "three") });
    const m1 = await p.commit({ "src/price.js": lines("one", "TWO", "three", "four") });
    const h = new DerivedHistory(p.source());
    const l2 = await h.why({ path: "src/price.js", line: 2 });
    expect(l2).toMatchObject({ path: "src/price.js", ref: "main", line: 2, text: "TWO", step: { sha: m1, kind: "merge" } });
    expect(l2.record).toMatchObject({ task: { title: "Task in1", goal: "Goal 1." }, plan: { steps: ["Step 1"], approach: "Small." }, agent: { callsign: "Robin-1" } });
    expect(l2.summary).toBe(`Line 2 of src/price.js on main. It came from the task "Task in1". Robin-1 merged it on 1970-01-01 (commit ${m1.slice(0, 7)}).`);
    const l1 = await h.why({ path: "src/price.js", line: 1 });
    expect(l1.step).toMatchObject({ sha: root, kind: "root" });
    expect(l1.record).toBeUndefined();
    for (const a of [l1, l2]) expect(steViolations(a.summary)).toEqual([]);
  });

  it("follows every line through many random merges, computed at once or later", async () => {
    p = new Project();
    const rng = mulberry32(7);
    const h = new DerivedHistory(p.source());
    let id = 0;
    const made = (c: number, n: number) => Array.from({ length: n }, () => `c${c}:${id++}`);
    await p.start({ "a.txt": lines(...made(0, 10)), "lib/b.txt": lines(...made(0, 4)) });
    for (let c = 1; c <= 24; c++) {
      const changes: Record<string, string | null> = {};
      for (const path of ["a.txt", "lib/b.txt", "lib/c.txt"]) {
        if (rng() < 0.4) continue;
        const now = (p.files.get(path) ?? "").split("\n").filter(Boolean);
        if (path === "lib/c.txt" && now.length && rng() < 0.2) {
          changes[path] = null;
          continue;
        }
        const at = Math.floor(rng() * (now.length + 1));
        now.splice(at, Math.floor(rng() * 3), ...made(c, Math.floor(rng() * 3) + (now.length ? 0 : 1)));
        changes[path] = now.length ? lines(...now) : null;
      }
      if (!Object.keys(changes).length) changes["a.txt"] = lines(...(p.files.get("a.txt") ?? "").split("\n").filter(Boolean), ...made(c, 1));
      await p.commit(changes, { merge: rng() < 0.8, message: `Commit ${c}` });
      // Sometimes the history is computed right after the merge, sometimes later: the result is the same.
      if (rng() < 0.5) await h.catchUp();
    }
    // Each line names the commit that wrote it ("c<n>:"): the answer must name the same commit.
    for (const [path, text] of p.files) {
      const ls = text.split("\n").filter(Boolean);
      for (let i = 0; i < ls.length; i++) {
        const want = p.versions[Number(ls[i].slice(1, ls[i].indexOf(":")))].sha;
        const got = await h.why({ path, line: i + 1 });
        expect(got.step?.sha, `${path}:${i + 1} "${ls[i]}"`).toBe(want);
      }
    }
    // The same at an older commit of main.
    const old = p.versions[12];
    for (const [path, text] of old.files) {
      const ls = text.split("\n").filter(Boolean);
      for (let i = 0; i < ls.length; i++) {
        const got = await h.why({ path, line: i + 1, ref: old.sha });
        expect(got.step?.sha, `${path}:${i + 1} at commit 12`).toBe(p.versions[Number(ls[i].slice(1, ls[i].indexOf(":")))].sha);
      }
    }
  });

  it("answers the changes of a file without a line, and refuses a line outside the file", async () => {
    p = new Project();
    await p.start({ "a.js": lines("a") });
    await p.commit({ "a.js": lines("a", "b") });
    const h = new DerivedHistory(p.source());
    const file = await h.why({ path: "./a.js" });
    expect(file.changes?.map((s) => s.kind)).toEqual(["merge", "root"]);
    expect(file.summary).toBe('1 change of main touched a.js. The last is the task "Task in1". Give a line to see the change that wrote it.');
    await expect(h.why({ path: "a.js", line: 3 })).rejects.toThrow("a.js has 2 lines on main. Give a line from 1 to 2.");
    await expect(h.why({ path: "a.js", line: 0 })).rejects.toThrow("Give a line number of 1 or more.");
  });

  it("says which commit deleted a file that is not on main", async () => {
    p = new Project();
    await p.start({ "a.js": lines("a"), "b.js": lines("b") });
    const gone = await p.commit({ "a.js": null });
    const h = new DerivedHistory(p.source());
    await expect(h.why({ path: "a.js", line: 1 })).rejects.toThrow(`a.js is not on main. Commit ${gone.slice(0, 7)} ("Task in1") deleted it.`);
  });

  it("answers a line of a work copy: the work wrote it, or the change of main at the base", async () => {
    p = new Project();
    await p.start({ "a.js": lines("one", "two") });
    const m1 = await p.commit({ "a.js": lines("one", "TWO") });
    const base = { sha: p.main.sha, tree: p.main.tree };
    p.work.set("a_w", {
      attempt: { id: "a_w", baseSha: base.sha, baseTree: base.tree, status: "underway", course: { plan: ["Add three"], files: ["a.js"], symbols: [], approach: "Append.", declaredAt: 1 } } as unknown as T.Attempt,
      files: new Map([["a.js", lines("zero", "one", "TWO")]]),
      deleted: [],
      callsign: "Robin-9",
      title: "Count from zero",
    });
    const h = new DerivedHistory(p.source());
    const added = await h.why({ path: "a.js", line: 1, ref: "a_w" });
    expect(added.work).toMatchObject({ attemptId: "a_w", callsign: "Robin-9", title: "Count from zero", approach: "Append." });
    expect(added.summary).toBe('Line 1 of a.js on the work copy of Robin-9. The work copy of Robin-9 wrote it for the task "Count from zero". It is not merged yet.');
    const kept = await h.why({ path: "a.js", line: 3, ref: "a_w" });
    expect(kept.work).toBeUndefined();
    expect(kept.step?.sha).toBe(m1);
    await expect(h.why({ path: "a.js", ref: "a_nope" })).rejects.toThrow('Unknown version "a_nope". Use main, a commit id or a work copy id.');
  });

  it("answers a line of a merged work copy from its merge, and says when a work copy stopped", async () => {
    p = new Project();
    await p.start({ "a.js": lines("one") });
    const base = { sha: p.main.sha, tree: p.main.tree };
    const merged = await p.commit({ "a.js": lines("one", "two") });
    // The work copy of the first merge (a_1), with its files as they were at the merge.
    const wc = (status: string, id: string): WorkCopyFiles => ({
      attempt: { id, baseSha: base.sha, baseTree: base.tree, status, course: { plan: ["Add two"], files: ["a.js"], symbols: [], approach: "Append.", declaredAt: 1 } } as unknown as T.Attempt,
      files: new Map([["a.js", lines("one", "two")]]),
      deleted: [],
      callsign: "Robin-1",
      title: "Task in1",
    });
    p.work.set("a_1", wc("landed", "a_1"));
    p.work.set("a_x", wc("abandoned", "a_x"));
    const h = new DerivedHistory(p.source());
    const done = await h.why({ path: "a.js", line: 2, ref: "a_1" });
    expect(done.ref).toBe("a_1");
    expect(done.work).toBeUndefined();
    expect(done.step).toMatchObject({ sha: merged, kind: "merge" });
    expect(done.record?.task.title).toBe("Task in1");
    expect(done.summary).toBe(`The work copy of Robin-1 merged in commit ${merged.slice(0, 7)}. Line 2 of a.js on commit ${merged.slice(0, 7)}. It came from the task "Task in1". Robin-1 merged it on 1970-01-01 (commit ${merged.slice(0, 7)}).`);
    const stopped = await h.why({ path: "a.js", line: 2, ref: "a_x" });
    expect(stopped.summary).toBe('Line 2 of a.js on the work copy of Robin-1. The work copy of Robin-1 wrote it for the task "Task in1". That work did not merge.');
    for (const t of [done.summary, stopped.summary]) expect(steViolations(t)).toEqual([]);
  });
});

describe("cost and order", () => {
  it("reads only the subtrees on the path of a change", async () => {
    p = new Project();
    const big: Record<string, string> = {};
    for (let d = 0; d < 12; d++) for (let f = 0; f < 6; f++) big[`dir${d}/sub/f${f}.txt`] = lines(`${d}.${f}`);
    await p.start(big);
    const before = p.main.tree;
    await p.commit({ "dir3/sub/f2.txt": lines("changed") });
    p.treeReads = 0;
    const { changes } = await diffTrees((t) => p.source().readTree(t).then((e) => e ?? []), before, p.main.tree);
    expect(changes.map((c) => [c.path, c.status])).toEqual([["dir3/sub/f2.txt", "M"]]);
    // Two roots, two dir3 trees, two dir3/sub trees: 6 reads, not one per folder.
    expect(p.treeReads).toBe(6);
  });

  it("computes a small merge after it lands, and waits for the first question for an old history", async () => {
    p = new Project();
    await p.start({ "a.js": lines("a") });
    await p.commit({ "a.js": lines("a", "b") });
    const h = new DerivedHistory(p.source());
    // The first merge of a new history: computed at once.
    h.landed(1);
    await p.settle();
    expect((p.db.storage.sql.exec("SELECT COUNT(*) AS n FROM dd_steps").one() as { n: number }).n).toBe(2);
    // A big merge waits.
    await p.commit({ "a.js": lines("a", "b", "c") });
    h.landed(500);
    await p.settle();
    expect((p.db.storage.sql.exec("SELECT COUNT(*) AS n FROM dd_steps").one() as { n: number }).n).toBe(2);
    expect((await h.history({})).steps).toHaveLength(3);
  });

  it("does not compute a long old history in the background after a merge: it waits for the first question", async () => {
    p = new Project();
    await p.start({ "a.js": lines("a") });
    for (let i = 0; i < 10; i++) await p.commit({ "a.js": lines("a", `${i}`) }, { merge: i % 2 === 0 });
    const h = new DerivedHistory(p.source());
    h.landed(1);
    await p.settle();
    expect((p.db.storage.sql.exec("SELECT COUNT(*) AS n FROM dd_steps").one() as { n: number }).n).toBe(0);
  });

  it("answers that the history is still in progress when the time is up, and continues later", async () => {
    p = new Project();
    await p.start({ "a.js": lines("a") });
    for (let i = 0; i < 4; i++) await p.commit({ "a.js": lines("a", `${i}`) });
    const h = new DerivedHistory(p.source());
    const first = await h.catchUp(0);
    expect(first).toEqual({ behind: 4, total: 5 });
    const next = await h.catchUp();
    expect(next.behind).toBe(0);
    expect((await h.history({})).steps).toHaveLength(5);
  });

  it("answers in plain words that the history is not ready when a question cannot wait, and finishes it after the answer", async () => {
    p = new Project();
    await p.start({ "a.js": lines("a") });
    for (let i = 0; i < 4; i++) await p.commit({ "a.js": lines("a", `${i}`) });
    const h = new DerivedHistory(p.source(), 0);
    const err = await h.history({}).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(err).toBe("gitring builds the history of this project now (1 of 5 changes). Ask again in a minute.");
    expect(steViolations(err)).toEqual([]);
    await p.settle();
    expect((await h.history({})).steps).toHaveLength(5);
  });

  it("reads nothing of the repository for a question when the history already has main", async () => {
    p = new Project();
    await p.start({ "a.js": lines("a") });
    await p.commit({ "a.js": lines("a", "b") });
    const h = new DerivedHistory(p.source());
    await h.history({});
    p.commitReads = 0;
    p.treeReads = 0;
    expect((await h.history({ path: "a.js" })).steps).toHaveLength(2);
    expect(p.commitReads).toBe(0);
    // Only the root tree: was the file there at the start of the history?
    expect(p.treeReads).toBe(1);
  });

  it("starts again for a new repository of the project", async () => {
    p = new Project();
    await p.start({ "a.js": lines("a") });
    await p.commit({ "a.js": lines("a", "b") });
    const src = p.source();
    const h = new DerivedHistory(src);
    expect((await h.history({})).steps).toHaveLength(2);
    // The same commits in a new repository with no merges: the old rows (a merge) are gone.
    const moved = new DerivedHistory({ ...src, main: () => ({ repo: "robin-shop-2", sha: p.main.sha, tree: p.main.tree }), landings: () => [] });
    expect((await moved.history({})).steps.map((s) => s.kind)).toEqual(["outside", "root"]);
  });
});

describe("search", () => {
  async function shop(noFts = false) {
    p = new Project();
    p.noFts = noFts;
    await p.start({
      "src/price.js": lines("export function priceOf(item) {", "  return item.price * 2;", "}"),
      "src/cart.js": lines('import { priceOf } from "./price.js";', "export const total = (xs) => xs.map(priceOf);"),
      "README.md": lines("# Shop", "Prices: see priceOf."),
    });
    return new DerivedHistory(p.source());
  }

  for (const noFts of [false, true]) {
    it(`finds a text in the files of main, with line numbers (${noFts ? "scan" : "fts5"})`, async () => {
      const h = await shop(noFts);
      const res = await h.search({ query: "priceof" });
      expect(res.engine).toBe(noFts ? "scan" : "fts5");
      expect(res.files.map((f) => f.path).sort()).toEqual(["README.md", "src/cart.js", "src/price.js"]);
      expect(res.files.find((f) => f.path === "src/cart.js")!.matches).toEqual([
        { line: 1, text: 'import { priceOf } from "./price.js";' },
        { line: 2, text: "export const total = (xs) => xs.map(priceOf);" },
      ]);
      expect(res.total).toBe(4);
      expect(res.summary).toBe('4 lines in 3 files of the files of main have "priceof".');
      expect(steViolations(res.summary)).toEqual([]);
      const inSrc = await h.search({ query: "priceOf", path: "src" });
      expect(inSrc.files.map((f) => f.path).sort()).toEqual(["src/cart.js", "src/price.js"]);
      const one = await h.search({ query: "priceOf", path: "src/price.js" });
      expect(one.files.map((f) => f.path)).toEqual(["src/price.js"]);
      // A text of two characters (shorter than a trigram) scans.
      const short = await h.search({ query: "*" });
      expect(short.engine).toBe("scan");
      expect(short.files.map((f) => f.path)).toEqual(["src/price.js"]);
      // Quotes in the text are not FTS5 syntax.
      expect((await h.search({ query: '"./price.js"' })).files.map((f) => f.path)).toEqual(["src/cart.js"]);
    });

    it(`updates only the touched files when main moves (${noFts ? "scan" : "fts5"})`, async () => {
      const h = await shop(noFts);
      expect((await h.search({ query: "discount" })).total).toBe(0);
      await p.commit({ "src/price.js": lines("export function priceOf(item) {", "  return discount(item.price);", "}"), "README.md": null });
      p.textReads = 0;
      const after = await h.search({ query: "discount" });
      // One touched text file to read; the deleted file has nothing to read.
      expect(p.textReads).toBe(1);
      expect(after.files.map((f) => f.path)).toEqual(["src/price.js"]);
      expect((await h.search({ query: "Prices: see" })).total).toBe(0);
      expect((p.db.storage.sql.exec("SELECT COUNT(*) AS n FROM dd_text").one() as { n: number }).n).toBe(2);
    });
  }

  it("refuses an empty text", async () => {
    const h = await shop();
    await expect(h.search({ query: "  " })).rejects.toThrow("Give a text to find.");
  });
});

describe("compare", () => {
  it("compares main, a commit and a work copy", async () => {
    p = new Project();
    const root = await p.start({ "a.js": lines("a"), "b.js": lines("b") });
    await p.commit({ "a.js": lines("a", "A"), "c.js": lines("c"), "b.js": null });
    const h = new DerivedHistory(p.source());
    const res = await h.compare(root.slice(0, 8), "main");
    expect(res.from).toBe(`commit ${root.slice(0, 7)}`);
    expect(res.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.js", "M", 1, 0],
      ["b.js", "D", 0, 1],
      ["c.js", "A", 1, 0],
    ]);
    expect(res.files[0].diff).toContain("+A");
    expect(res.summary).toBe(`commit ${root.slice(0, 7)} and main differ in 3 files (+2 -1).`);
    expect(steViolations(res.summary)).toEqual([]);
    expect((await h.compare("main", p.main.sha)).summary).toBe("main and main have the same files.");
    p.work.set("a_w", { attempt: { id: "a_w", baseSha: p.main.sha, baseTree: p.main.tree } as T.Attempt, files: new Map([["a.js", lines("a", "A", "x")], ["c.js", lines("c")]]), deleted: [], callsign: "Robin-2", title: "X" });
    const wc = await h.compare("main", "a_w");
    expect(wc.to).toBe("the work copy of Robin-2");
    expect(wc.files.map((f) => [f.path, f.status])).toEqual([["a.js", "M"]]);
    await expect(h.compare("main", "nope")).rejects.toThrow('Unknown version "nope". Use main, a commit id or a work copy id.');
    await expect(h.compare("main", "0000000")).rejects.toThrow("Commit 0000000 is not in this project.");
  });
});

describe("compare cost and files", () => {
  it("reads only the changed files and the subtrees on their paths", async () => {
    p = new Project();
    const big: Record<string, string> = {};
    for (let d = 0; d < 10; d++) for (let f = 0; f < 10; f++) big[`dir${d}/f${f}.txt`] = lines(`${d}.${f}`);
    const root = await p.start(big);
    await p.commit({ "dir3/f2.txt": lines("changed"), "dir7/new.txt": lines("new") });
    const h = new DerivedHistory(p.source());
    p.textReads = 0;
    p.treeReads = 0;
    const res = await h.compare(root, "main");
    expect(res.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["dir3/f2.txt", "M", 1, 1],
      ["dir7/new.txt", "A", 1, 0],
    ]);
    // Two roots, two dir3 trees, two dir7 trees. The old and new text of f2.txt, the text of new.txt.
    expect(p.treeReads).toBe(6);
    expect(p.textReads).toBe(3);
  });

  it("shows a file without text by its id, and the files that a work copy deletes", async () => {
    p = new Project();
    const start = await p.start({ "a.js": lines("a"), "b.js": lines("b"), "logo.png": "PNG-1" });
    const startTree = p.main.tree;
    await p.commit({ "logo.png": "PNG-2" });
    const h = new DerivedHistory(p.source());
    const pic = await h.compare(start, "main");
    expect(pic.files).toEqual([{ path: "logo.png", status: "M", additions: 0, deletions: 0, diff: "", binary: true }]);
    expect(pic.summary).toBe(`commit ${start.slice(0, 7)} and main differ in 1 file (+0 -0).`);
    p.work.set("a_d", {
      attempt: { id: "a_d", baseSha: start, baseTree: startTree } as T.Attempt,
      files: new Map([["a.js", lines("a", "more")]]),
      deleted: ["b.js"],
      callsign: "Robin-3",
      title: "Drop b",
    });
    const wc = await h.compare("main", "a_d");
    expect(wc.files.map((f) => [f.path, f.status, f.binary ?? false])).toEqual([
      ["a.js", "M", false],
      ["b.js", "D", false],
      ["logo.png", "M", true],
    ]);
    expect(wc.files[1]).toMatchObject({ deletions: 1, additions: 0 });
    expect(wc.summary).toBe("main and the work copy of Robin-3 differ in 3 files (+1 -1).");
    for (const t of [pic.summary, wc.summary]) expect(steViolations(t)).toEqual([]);
  });
});

describe("compare under a path, and long diffs", () => {
  it("compares one folder or one file", async () => {
    p = new Project();
    const start = await p.start({ "src/a.js": lines("a"), "src/lib/b.js": lines("b"), "docs/c.md": lines("c") });
    await p.commit({ "src/a.js": lines("a", "A"), "src/lib/b.js": null, "docs/c.md": lines("C") });
    const h = new DerivedHistory(p.source());
    const src = await h.compare(start, "main", "src/");
    expect(src.path).toBe("src");
    expect(src.files.map((f) => [f.path, f.status])).toEqual([
      ["src/a.js", "M"],
      ["src/lib/b.js", "D"],
    ]);
    expect(src.summary).toBe(`commit ${start.slice(0, 7)} and main differ in 2 files under src (+1 -1).`);
    const one = await h.compare(start, "main", "./docs/c.md");
    expect(one.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([["docs/c.md", "M", 1, 1]]);
    const gone = await h.compare(start, "main", "src/lib/b.js");
    expect(gone.files.map((f) => [f.path, f.status])).toEqual([["src/lib/b.js", "D"]]);
    const none = await h.compare(start, "main", "nope");
    expect(none.files).toEqual([]);
    expect(none.summary).toBe(`commit ${start.slice(0, 7)} and main have the same files under nope.`);
    // A work copy: only its changes under the path.
    p.work.set("a_p", { attempt: { id: "a_p", baseSha: p.main.sha, baseTree: p.main.tree } as T.Attempt, files: new Map([["src/a.js", lines("a", "A", "x")], ["docs/c.md", lines("C", "y")]]), deleted: [], callsign: "Robin-5", title: "P" });
    const wc = await h.compare("main", "a_p", "docs");
    expect(wc.files.map((f) => f.path)).toEqual(["docs/c.md"]);
  });

  it("keeps the counts but leaves out the diff of the files after the size limit", async () => {
    p = new Project();
    const long = (tag: string) => lines(...Array.from({ length: 1500 }, (_, i) => `${tag} line ${i} of a long file with some text`));
    const start = await p.start({ "a.txt": lines("a"), "big.txt": long("old"), "z.txt": lines("z") });
    await p.commit({ "a.txt": lines("A"), "big.txt": long("new"), "z.txt": lines("Z") });
    const h = new DerivedHistory(p.source());
    const res = await h.compare(start, "main");
    expect(res.files.map((f) => [f.path, f.additions, f.deletions, f.cut ?? false])).toEqual([
      ["a.txt", 1, 1, false],
      ["big.txt", 1500, 1500, true],
      ["z.txt", 1, 1, false],
    ]);
    expect(res.files[1].diff).toBe("");
    expect(res.files[2].diff).toContain("+Z");
    expect(res.summary).toBe(`commit ${start.slice(0, 7)} and main differ in 3 files (+1502 -1502). The answer has no diff for 1 of them because of its size. Give a path to see one folder or file.`);
    expect(steViolations(res.summary)).toEqual([]);
    // Asked alone, the long diff is still over the limit: the answer says so again.
    expect((await h.compare(start, "main", "big.txt")).files[0].cut).toBe(true);
    // Two 1500-line diffs are slow on a busy machine: the test has its own limit, not the 20 s default.
  }, 60_000);
});

describe("errors", () => {
  it("answers each refusal in plain words", async () => {
    p = new Project();
    const empty = new DerivedHistory(p.source());
    const messages: string[] = [];
    const refuse = async (work: Promise<unknown>) => {
      const msg = await work.then(
        () => "",
        (e: Error) => e.message,
      );
      expect(msg).not.toBe("");
      messages.push(msg);
      return msg;
    };
    expect(await refuse(empty.why({ path: "a.js" }))).toBe("The project has no main yet. Ask again when the import is done.");
    expect(await refuse(empty.search({ query: "x" }))).toBe("The project has no main yet. Ask again when the import is done.");
    await p.start({ "a.js": lines("a") });
    const h = new DerivedHistory(p.source());
    expect(await refuse(h.why({ path: " " }))).toBe("Give the path of a file.");
    expect(await refuse(h.why({ path: "a.js", ref: "0000000" }))).toBe("gitring has no history for commit 0000000. Ask about main, a commit of main or a work copy.");
    expect(await refuse(h.search({ query: "x".repeat(201) }))).toBe("Give a text of at most 200 characters.");
    expect(await refuse(h.compare("", "main"))).toBe("Give two versions: main, a commit id or a work copy id.");
    for (const m of messages) expect(steViolations(m), m).toEqual([]);
  });
});

describe("lineCount", () => {
  it("counts like the line model of the diff", () => {
    expect([lineCount(""), lineCount("a"), lineCount("a\n"), lineCount("a\nb"), lineCount("a\r\nb\r\n")]).toEqual([0, 1, 1, 2, 2]);
  });
});
