/**
 * Derived data of main, in the SQLite of the project object, and the history questions that read it.
 *
 * Derived data is computed per change of main from the values of the parent change, so the cost of a
 * change grows with the size of the change, not with the size of the repository:
 *
 *   dd_steps   the changes of main in order: the first one ("root"), the merges, and moves of main
 *              without a merge ("outside": an import, a pull, a seed)
 *   dd_paths   path history: path → the changes that touched it, with the line counts
 *   dd_blame   line blame: for each change and each text file that it touched, the change that wrote
 *              each line (run-length coded). The blame of a change is the blame of its parent plus the
 *              diff of the change. A file with no row has the blame of the root: all its lines are older
 *              than the history.
 *   dd_text    the text files of main, with an FTS5 index (trigram tokens: any part of a name matches)
 *              that changes only for the touched files. Without FTS5, search scans dd_text.
 *
 * The tree diff never opens a subtree whose id did not change. Small merges are computed when they land
 * (HarborMaster.recordLanding calls `landed`). Big merges, moves of main without a merge, and the merges
 * from before this module are computed at the first question (`catchUp`).
 */
import type * as T from "../core/types";
import type { CommitMeta, TreeEntry } from "../platform/repo/backend";
import type { Snapshot } from "../core/git/snapshot";
import { EMPTY_TREE_SHA } from "../core/git/objects";
import { diffHunks, lineDiff, unifiedDiff } from "../core/text/diff";
import { textEligible } from "../core/repo-rules";
import {
  applyHunks,
  compareWords,
  historyWords,
  newLineOf,
  oldLineOf,
  oneRun,
  parseWhyRecord,
  runsLength,
  searchWords,
  short,
  stepAt,
  UNKNOWN_STEP,
  versionWords,
  whyFileWords,
  whyLineWords,
  type BlameRuns,
  type CompareAnswer,
  type CompareFile,
  type HistoryAnswer,
  type HistoryStep,
  type SearchAnswer,
  type StepKind,
  type WhyAnswer,
  type WorkLine,
} from "../core/history";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS dd_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dd_steps (seq INTEGER PRIMARY KEY, sha TEXT NOT NULL UNIQUE, parent TEXT NOT NULL, tree TEXT NOT NULL, kind TEXT NOT NULL, landing_id TEXT, subject TEXT NOT NULL, files INTEGER NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dd_paths (path TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL, PRIMARY KEY (path, seq))`,
  `CREATE TABLE IF NOT EXISTS dd_blame (path TEXT NOT NULL, seq INTEGER NOT NULL, runs TEXT, PRIMARY KEY (path, seq))`,
  `CREATE TABLE IF NOT EXISTS dd_text (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, body TEXT NOT NULL)`,
];
/** The search index over dd_text (external content: the text is stored once). */
const FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS dd_fts USING fts5(path UNINDEXED, body, content='dd_text', content_rowid='id', tokenize='trigram')`;

/** A merge that touches at most this many files is computed when it lands. A bigger one waits for the first question. */
export const EAGER_FILES = 64;
/** ...and only when at most this many changes of main wait (else the history waits for the first question). */
const EAGER_STEPS = 8;
/** At most this many changed files of one change get a path history and a blame. */
const MAX_STEP_FILES = 5000;
/** A move of main without a merge: at most this many of its commits become changes of their own (the rest count as one). */
const MAX_WALK = 200;
/** A question waits this long for the history to catch up. Then the rest continues in the background. */
const QUERY_BUDGET_MS = 20_000;
const BACKGROUND_BUDGET_MS = 120_000;
/** Blob reads in flight. */
const TEXT_READS = 16;
const MAX_LIMIT = 100;
const SEARCH_FILES = 20;
const SEARCH_LINES = 5;
const COMPARE_FILES = 300;
const COMPARE_CHARS = 400_000;

/** A work copy: its files (base plus the work, text files only) and who works on it. */
export interface WorkCopyFiles {
  attempt: T.Attempt;
  files: Map<string, string>;
  /** Paths that the work deleted. */
  deleted: string[];
  callsign: string;
  title: string;
}

/** What the derived data reads from the project object. */
export interface DerivedSource {
  sql: SqlStorage;
  /** The repository and main, or undefined while the project has no main (before the start, during an import). */
  main(): { repo: string; sha: string; tree: string } | undefined;
  landings(): readonly T.Landing[];
  /** The why-record (git note) of a merge. */
  note(landingId: string): string | null;
  callsign(agentId: string): string;
  title(intentId: string): string;
  commit(sha: string): Promise<CommitMeta | null>;
  readTree(tree: string): Promise<TreeEntry[] | null>;
  /** The text of a blob. Null: binary or very large. */
  text(blob: string): Promise<string | null>;
  /** The files of a tree with the text of the text files (cached by the project object). */
  treeText(tree: string): Promise<{ snapshot: Snapshot; text: Map<string, string> }>;
  workCopy(id: string): Promise<WorkCopyFiles | undefined>;
  /** Run work after the answer (the platform keeps the object alive for it). */
  background(work: Promise<unknown>): void;
}

/** A row of dd_steps (a type, not an interface: SQL rows need an index signature). */
type StepRow = {
  seq: number;
  sha: string;
  parent: string;
  tree: string;
  kind: StepKind;
  landing_id: string | null;
  subject: string;
  files: number;
  at: number;
};

interface PlannedStep {
  sha: string;
  kind: StepKind;
  landing?: T.Landing;
}

interface TreeChange {
  path: string;
  status: "A" | "M" | "D";
  old?: TreeEntry;
  now?: TreeEntry;
}

type Engine = "fts5" | "scan";

/** Lines of a text: "a\nb\n" and "a\nb" have 2, "" has 0 (the line model of src/core/text/diff.ts). */
export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n : n + 1;
}

function linesOf(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function normPath(p: string): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

const clamp = (n: number | undefined, lo: number, hi: number, dflt: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n!))) : dflt);
const firstLine = (message: string): string => (message ?? "").split("\n")[0].trim() || "no message";
const isBlob = (e: TreeEntry | undefined): e is TreeEntry => !!e && (e.type === "blob" || e.type === "exec");

/** Run `fn` over `items` with at most `limit` calls in flight. Results keep the order of `items`. */
async function mapLimit<X, Y>(items: readonly X[], limit: number, fn: (x: X) => Promise<Y>): Promise<Y[]> {
  const out = new Array<Y>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/**
 * The file changes between two trees. A subtree with the same id on both sides is never read: the cost
 * grows with the change, not with the tree. At most `cap` changes ("cut": there are more).
 */
export async function diffTrees(read: (tree: string) => Promise<TreeEntry[]>, a: string, b: string, cap = MAX_STEP_FILES): Promise<{ changes: TreeChange[]; cut: boolean }> {
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
  await walk(a || EMPTY_TREE_SHA, b || EMPTY_TREE_SHA, "");
  return { changes, cut };
}

export class DerivedHistory {
  private readonly engine: Engine;
  private run: Promise<unknown> = Promise.resolve();
  private searchRun: Promise<unknown> = Promise.resolve();

  constructor(private readonly src: DerivedSource) {
    for (const s of SCHEMA) src.sql.exec(s);
    // Durable Object SQLite has FTS5. Keep a plain scan for a SQLite that does not.
    let engine: Engine = "fts5";
    try {
      src.sql.exec(FTS);
    } catch {
      engine = "scan";
    }
    this.engine = engine;
  }

  /** The search engine in use. */
  get searchEngine(): Engine {
    return this.engine;
  }

  /* ───────────────────────── storage ───────────────────────── */

  private get sql(): SqlStorage {
    return this.src.sql;
  }

  private meta<V>(key: string): V | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM dd_meta WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as V) : undefined;
  }

  private setMeta(key: string, value: unknown): void {
    this.sql.exec("INSERT OR REPLACE INTO dd_meta (key, value) VALUES (?, ?)", key, JSON.stringify(value));
  }

  /** The derived data belongs to one repository. A new repository of the project (a new start) starts it again. */
  private forRepo(repo: string): void {
    if (this.meta<string>("repo") === repo) return;
    for (const t of ["dd_steps", "dd_paths", "dd_blame", "dd_text", "dd_meta"]) this.sql.exec(`DELETE FROM ${t}`);
    if (this.engine === "fts5") this.sql.exec("INSERT INTO dd_fts (dd_fts) VALUES ('delete-all')");
    this.setMeta("repo", repo);
  }

  private tip(): StepRow | undefined {
    return this.sql.exec<StepRow>("SELECT * FROM dd_steps ORDER BY seq DESC LIMIT 1").toArray()[0];
  }

  private rootSeq(): number {
    return this.sql.exec<{ seq: number }>("SELECT seq FROM dd_steps ORDER BY seq ASC LIMIT 1").toArray()[0]?.seq ?? UNKNOWN_STEP;
  }

  private stepBySeq(seq: number): StepRow | undefined {
    return this.sql.exec<StepRow>("SELECT * FROM dd_steps WHERE seq = ?", seq).toArray()[0];
  }

  private stepBySha(sha: string): StepRow | undefined {
    return this.sql.exec<StepRow>("SELECT * FROM dd_steps WHERE sha = ?", sha).toArray()[0];
  }

  /** A change by a commit id or its first characters (at least 7). */
  private findStep(ref: string): StepRow | undefined {
    if (ref.length === 40) return this.stepBySha(ref);
    const rows = this.sql.exec<StepRow>("SELECT * FROM dd_steps WHERE substr(sha, 1, ?) = ? LIMIT 2", ref.length, ref).toArray();
    return rows.length === 1 ? rows[0] : undefined;
  }

  /** The blame of `path` at change `seq`, for a text of `lines` lines. */
  private runsAt(path: string, seq: number, lines: number, before = false): BlameRuns {
    const row = this.sql
      .exec<{ runs: string | null }>(`SELECT runs FROM dd_blame WHERE path = ? AND seq ${before ? "<" : "<="} ? ORDER BY seq DESC LIMIT 1`, path, seq)
      .toArray()[0];
    if (!row) return oneRun(this.rootSeq(), lines);
    const runs = row.runs ? (JSON.parse(row.runs) as BlameRuns) : null;
    // A blame that does not fit the text: gitring cannot trace these lines.
    return runs && runsLength(runs) === lines ? runs : oneRun(UNKNOWN_STEP, lines);
  }

  /* ───────────────────────── computing ───────────────────────── */

  private readTree = async (tree: string): Promise<TreeEntry[]> => {
    if (!tree || tree === EMPTY_TREE_SHA) return [];
    const entries = await this.src.readTree(tree);
    if (!entries) throw new Error(`gitring cannot read tree ${short(tree)} of this project.`);
    return entries;
  };

  /** The entry at `path` in a tree, or null. */
  private async entryAt(tree: string, path: string): Promise<TreeEntry | null> {
    let entries = await this.readTree(tree);
    const parts = path.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const e = entries.find((x) => x.name === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return e;
      if (e.type !== "tree") return null;
      entries = await this.readTree(e.hash);
    }
    return null;
  }

  /** The text of the file at `path` in a tree. Null: no such file, or no text (binary, very large). */
  private async textAt(tree: string, path: string): Promise<string | null> {
    const e = await this.entryAt(tree, path);
    return isBlob(e ?? undefined) ? this.src.text(e!.hash) : null;
  }

  /** One run at a time: each change needs the result of its parent. */
  private serial<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.run.then(fn, fn);
    this.run = next.catch(() => undefined);
    return next;
  }

  /** The changes of main that have no derived data yet, in order. */
  private async plan(m: { sha: string }): Promise<PlannedStep[]> {
    const known = new Set(this.sql.exec<{ sha: string }>("SELECT sha FROM dd_steps").toArray().map((r) => r.sha));
    const out: PlannedStep[] = [];
    const add = (s: PlannedStep) => {
      if (!s.sha || known.has(s.sha)) return;
      known.add(s.sha);
      out.push(s);
    };
    // The first parents of a commit, back to a change that gitring knows (at most MAX_WALK), oldest first.
    const back = async (sha: string): Promise<string[]> => {
      const chain: string[] = [];
      for (let at: string | undefined = sha; at && !known.has(at) && chain.length < MAX_WALK; at = (await this.src.commit(at))?.parents[0]) chain.push(at);
      return chain.reverse();
    };
    // Main moved without a merge (a pull, an import, a push): each commit of that move is a change of its own.
    const outside = async (sha: string) => {
      for (const s of await back(sha)) add({ sha: s, kind: "outside" });
    };
    const landings = [...this.src.landings()].sort((a, b) => a.at - b.at);
    if (!known.size) {
      // The history starts at the oldest commit of main that gitring can read: the start of the project,
      // or the oldest commit of an import.
      const [root, ...rest] = await back(landings[0]?.mainBefore || m.sha);
      if (root) add({ sha: root, kind: "root" });
      for (const s of rest) add({ sha: s, kind: "outside" });
    }
    for (const l of landings) {
      await outside(l.mainBefore);
      add({ sha: l.mainAfter, kind: "merge", landing: l });
    }
    await outside(m.sha);
    return out;
  }

  /**
   * Bring the derived data up to main, for at most `budgetMs`. Answers how many changes are still to do,
   * of how many in all. With `upTo`, a longer list of changes waits (nothing is computed).
   */
  catchUp(budgetMs = BACKGROUND_BUDGET_MS, upTo = Infinity): Promise<{ behind: number; total: number }> {
    return this.serial(async () => {
      const m = this.src.main();
      if (!m) return { behind: 0, total: 0 };
      this.forRepo(m.repo);
      const started = Date.now();
      const plan = await this.plan(m);
      let i = 0;
      if (plan.length <= upTo) for (; i < plan.length && (i === 0 || Date.now() - started < budgetMs); i++) await this.compute(plan[i], m);
      const done = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM dd_steps").one().n;
      return { behind: plan.length - i, total: done + plan.length - i };
    });
  }

  /** Compute one change from its parent (the last change). All reads first, then all writes in one step. */
  private async compute(s: PlannedStep, m: { sha: string; tree: string }): Promise<void> {
    const parent = this.tip();
    const commit = await this.src.commit(s.sha);
    const tree = commit?.treeHash ?? (s.sha === m.sha ? m.tree : parent?.tree ?? EMPTY_TREE_SHA);
    const kind: StepKind = parent ? s.kind : "root";
    const subject = s.landing ? this.src.title(s.landing.intentId) : firstLine(commit?.message ?? "");
    const at = s.landing?.at ?? (commit?.committedAt ? commit.committedAt * 1000 : Date.now());
    const seq = (parent?.seq ?? 0) + 1;
    const insert = (files: number) =>
      this.sql.exec(
        "INSERT OR REPLACE INTO dd_steps (seq, sha, parent, tree, kind, landing_id, subject, files, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        seq,
        s.sha,
        parent?.sha ?? "",
        tree,
        kind,
        s.landing?.id ?? null,
        subject,
        files,
        at,
      );
    // The root has no parent: its files have no blame rows (a file without a row has the blame of the root).
    if (!parent) return void insert(0);
    const { changes } = await diffTrees(this.readTree, parent.tree, tree);
    const rows = await mapLimit(changes, TEXT_READS, async (c) => {
      const eligible = textEligible(c.path);
      const before = eligible && isBlob(c.old) ? await this.src.text(c.old.hash) : null;
      const after = eligible && isBlob(c.now) ? await this.src.text(c.now.hash) : null;
      return { c, eligible, before, after };
    });
    for (const { c, eligible, before, after } of rows) {
      const d = before !== null || after !== null ? lineDiff(before ?? "", after ?? "") : { additions: 0, deletions: 0 };
      this.sql.exec("INSERT OR REPLACE INTO dd_paths (path, seq, status, additions, deletions) VALUES (?, ?, ?, ?, ?)", c.path, seq, c.status, d.additions, d.deletions);
      if (!eligible) continue;
      let runs: BlameRuns | null = null;
      if (after !== null) runs = before === null ? oneRun(seq, lineCount(after)) : applyHunks(this.runsAt(c.path, seq, lineCount(before), true), diffHunks(before, after), seq);
      this.sql.exec("INSERT OR REPLACE INTO dd_blame (path, seq, runs) VALUES (?, ?, ?)", c.path, seq, runs ? JSON.stringify(runs) : null);
    }
    insert(changes.length);
  }

  /**
   * After a merge. A small merge is computed now (after the answer), and the search index follows when it
   * exists. A big merge, or a long history that gitring never computed, waits for the first question.
   */
  landed(files: number): void {
    if (files > EAGER_FILES) return;
    this.src.background(
      this.catchUp(BACKGROUND_BUDGET_MS, EAGER_STEPS).then(() => {
        if (this.meta("search")) return this.syncSearch();
      }),
    );
  }

  /** Wait until the derived data reaches main. A history that takes long continues after the answer. */
  private async ready(): Promise<{ repo: string; sha: string; tree: string }> {
    const m = this.src.main();
    if (!m) throw new Error("The project has no main yet. Ask again when the import is done.");
    const { behind, total } = await this.catchUp(QUERY_BUDGET_MS);
    if (behind > 0) {
      this.src.background(this.catchUp());
      throw new Error(`gitring builds the history of this project now (${total - behind} of ${total} changes). Ask again in a minute.`);
    }
    return m;
  }

  /* ───────────────────────── answers: steps ───────────────────────── */

  private stepOf(r: StepRow, change?: HistoryStep["change"]): HistoryStep {
    const step: HistoryStep = { sha: r.sha, parent: r.parent, kind: r.kind, at: r.at, subject: r.subject, files: r.files, ...(change ? { change } : {}) };
    if (r.kind !== "merge" || !r.landing_id) return step;
    const l = this.src.landings().find((x) => x.id === r.landing_id);
    if (!l) return step;
    return {
      ...step,
      merge: {
        landingId: l.id,
        intentId: l.intentId,
        attemptId: l.attemptId,
        callsign: this.src.callsign(l.agentId),
        method: l.method,
        tests: { passed: l.checks?.passed ?? 0, failed: l.checks?.failed ?? 0 },
      },
    };
  }

  /** The changes of a file, or of the files under a folder, at or before change `upTo`, the newest first. */
  private pathSteps(path: string, upTo: number, limit: number): HistoryStep[] {
    type Row = { seq: number; status: "A" | "M" | "D"; additions: number; deletions: number; paths?: number; lo?: string; hi?: string };
    let rows = this.sql
      .exec<Row>("SELECT seq, status, additions, deletions FROM dd_paths WHERE path = ? AND seq <= ? ORDER BY seq DESC LIMIT ?", path, upTo, limit)
      .toArray();
    if (!rows.length) {
      // A folder: the paths between "dir/" and "dir0" ("0" follows "/").
      rows = this.sql
        .exec<Row>(
          "SELECT seq, MIN(status) AS lo, MAX(status) AS hi, SUM(additions) AS additions, SUM(deletions) AS deletions, COUNT(*) AS paths FROM dd_paths WHERE path >= ? AND path < ? AND seq <= ? GROUP BY seq ORDER BY seq DESC LIMIT ?",
          `${path}/`,
          `${path}0`,
          upTo,
          limit,
        )
        .toArray()
        .map((r) => ({ ...r, status: r.lo === r.hi ? (r.lo as Row["status"]) : "M" }));
    }
    const out: HistoryStep[] = [];
    for (const r of rows) {
      const s = this.stepBySeq(r.seq);
      if (s) out.push(this.stepOf(s, { status: r.status, additions: r.additions, deletions: r.deletions, ...(r.paths ? { paths: r.paths } : {}) }));
    }
    return out;
  }

  /** The changes of `path` up to change `upTo`, with the root when the path was there at the start. */
  private async changesOf(path: string, upTo: number, limit: number): Promise<{ steps: HistoryStep[]; more: boolean }> {
    const rows = this.pathSteps(path, upTo, limit + 1);
    const more = rows.length > limit;
    const steps = rows.slice(0, limit);
    if (!more) {
      const root = this.stepBySeq(this.rootSeq());
      if (root && (await this.entryAt(root.tree, path))) steps.push(this.stepOf(root));
    }
    return { steps, more };
  }

  /** Why a path is not on a version: it may be deleted. */
  private notThere(path: string, version: string, upTo: number): string {
    const gone = this.sql.exec<{ seq: number }>("SELECT seq FROM dd_paths WHERE path = ? AND seq <= ? AND status = 'D' ORDER BY seq DESC LIMIT 1", path, upTo).toArray()[0];
    const s = gone ? this.stepBySeq(gone.seq) : undefined;
    return s ? `${path} is not on ${version}. Commit ${short(s.sha)} ("${s.subject}") deleted it.` : `${path} is not on ${version}, or gitring keeps it without text.`;
  }

  /** The answer for one line, from the change that wrote it. */
  private lineAnswer(a: { path: string; ref: string; version: string; line: number; text: string; seq?: number; work?: WorkLine }): WhyAnswer {
    const row = a.seq !== undefined && a.seq !== UNKNOWN_STEP ? this.stepBySeq(a.seq) : undefined;
    const step = row ? this.stepOf(row) : undefined;
    const record = row?.kind === "merge" && row.landing_id ? parseWhyRecord(this.src.note(row.landing_id)) ?? undefined : undefined;
    return {
      path: a.path,
      ref: a.ref,
      line: a.line,
      text: a.text,
      ...(step ? { step } : {}),
      ...(record ? { record } : {}),
      ...(a.work ? { work: a.work } : {}),
      summary: whyLineWords({ path: a.path, line: a.line, version: a.version, step, work: a.work }),
    };
  }

  /* ───────────────────────── answers: the questions ───────────────────────── */

  /**
   * Why a line is there: the change that last wrote it, with the why-record of that merge. Without a line:
   * the changes of the file. `ref`: "main" (default), a commit id of main, or a work copy id.
   */
  async why(input: { path: string; line?: number; ref?: string }): Promise<WhyAnswer> {
    const path = normPath(input.path);
    if (!path) throw new Error("Give the path of a file.");
    const line = input.line;
    if (line !== undefined && (!Number.isInteger(line) || line < 1)) throw new Error("Give a line number of 1 or more.");
    const ref = String(input.ref ?? "main").trim() || "main";
    const m = await this.ready();
    if (ref !== "main" && ref !== m.sha && !/^[0-9a-f]{7,40}$/.test(ref)) return this.whyWork(ref, path, line);
    const step = ref === "main" || ref === m.sha ? this.tip() : this.findStep(ref);
    if (!step) throw new Error(`gitring has no history for commit ${short(ref)}. Ask about main, a commit of main or a work copy.`);
    const version = ref === "main" ? "main" : versionWords(step.sha);
    const text = await this.textAt(step.tree, path);
    if (text === null) throw new Error(this.notThere(path, version, step.seq));
    if (line === undefined) {
      const { steps, more } = await this.changesOf(path, step.seq, 20);
      return { path, ref, changes: steps, summary: whyFileWords(path, version, steps, more) };
    }
    const lines = linesOf(text);
    if (line > lines.length) throw new Error(`${path} has ${lines.length} ${lines.length === 1 ? "line" : "lines"} on ${version}. Give a line from 1 to ${lines.length}.`);
    const seq = stepAt(this.runsAt(path, step.seq, lineCount(text)), line);
    return this.lineAnswer({ path, ref, version, line, text: lines[line - 1], seq });
  }

  /** Why a line of a work copy is there: the work wrote it, or main had it at the base of the work copy. */
  private async whyWork(id: string, path: string, line: number | undefined): Promise<WhyAnswer> {
    const wc = await this.src.workCopy(id);
    if (!wc) throw new Error(`Unknown version "${id}". Use main, a commit id or a work copy id.`);
    const a = wc.attempt;
    const version = versionWords(id, wc.callsign);
    const head = wc.files.get(path) ?? null;
    if (head === null) throw new Error(`${path} is not in ${version}.`);
    const work: WorkLine = { attemptId: a.id, callsign: wc.callsign, title: wc.title, status: a.status, approach: a.course.approach, plan: a.course.plan };
    const base = await this.textAt(a.baseTree, path);
    const tip = this.tip()!;
    if (line === undefined) {
      const { steps, more } = await this.changesOf(path, tip.seq, 20);
      if (base === head) return { path, ref: id, changes: steps, summary: `${version} does not change ${path}. ${whyFileWords(path, "main", steps, more)}` };
      return { path, ref: id, work, changes: steps, summary: `${version} changes ${path} for the task "${wc.title}". It is not merged yet. Give a line to see the change that wrote it.` };
    }
    const lines = linesOf(head);
    if (line > lines.length) throw new Error(`${path} has ${lines.length} ${lines.length === 1 ? "line" : "lines"} on ${version}. Give a line from 1 to ${lines.length}.`);
    const where = base === null ? ({ added: true } as const) : oldLineOf(diffHunks(base, head), line);
    if (where.added) return this.lineAnswer({ path, ref: id, version, line, text: lines[line - 1], work });
    // The line was on the base of the work copy: the change of main that wrote it.
    let seq: number | undefined;
    const baseStep = this.stepBySha(a.baseSha) ?? this.sql.exec<StepRow>("SELECT * FROM dd_steps WHERE tree = ? ORDER BY seq DESC LIMIT 1", a.baseTree).toArray()[0];
    if (baseStep) seq = stepAt(this.runsAt(path, baseStep.seq, lineCount(base!)), where.line);
    else {
      // The base is not a known change of main: follow the line to main.
      const now = await this.textAt(tip.tree, path);
      const to = now === null ? null : newLineOf(diffHunks(base!, now), where.line);
      if (now !== null && to && !to.removed) seq = stepAt(this.runsAt(path, tip.seq, lineCount(now)), to.line);
    }
    return this.lineAnswer({ path, ref: id, version, line, text: lines[line - 1], seq });
  }

  /** The changes of a file or a folder, the newest first. Without a path: every change of main. */
  async history(input: { path?: string; limit?: number }): Promise<HistoryAnswer> {
    const limit = clamp(input.limit, 1, MAX_LIMIT, 20);
    const path = input.path ? normPath(input.path) : "";
    await this.ready();
    if (!path) {
      const rows = this.sql.exec<StepRow>("SELECT * FROM dd_steps ORDER BY seq DESC LIMIT ?", limit + 1).toArray();
      const more = rows.length > limit;
      const steps = rows.slice(0, limit).map((r) => this.stepOf(r));
      return { steps, more, summary: historyWords(undefined, steps, more) };
    }
    const { steps, more } = await this.changesOf(path, this.tip()!.seq, limit);
    return { path, steps, more, summary: historyWords(path, steps, more) };
  }

  /* ───────────────────────── search ───────────────────────── */

  private searchSerial<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.searchRun.then(fn, fn);
    this.searchRun = next.catch(() => undefined);
    return next;
  }

  private putText(path: string, body: string): void {
    const old = this.sql.exec<{ id: number; body: string }>("SELECT id, body FROM dd_text WHERE path = ?", path).toArray()[0];
    const fts = this.engine === "fts5";
    if (old) {
      if (old.body === body) return;
      if (fts) this.sql.exec("INSERT INTO dd_fts (dd_fts, rowid, path, body) VALUES ('delete', ?, ?, ?)", old.id, path, old.body);
      this.sql.exec("UPDATE dd_text SET body = ? WHERE id = ?", body, old.id);
      if (fts) this.sql.exec("INSERT INTO dd_fts (rowid, path, body) VALUES (?, ?, ?)", old.id, path, body);
      return;
    }
    const id = this.sql.exec<{ id: number }>("INSERT INTO dd_text (path, body) VALUES (?, ?) RETURNING id", path, body).one().id;
    if (fts) this.sql.exec("INSERT INTO dd_fts (rowid, path, body) VALUES (?, ?, ?)", id, path, body);
  }

  private dropText(path: string): void {
    const old = this.sql.exec<{ id: number; body: string }>("SELECT id, body FROM dd_text WHERE path = ?", path).toArray()[0];
    if (!old) return;
    if (this.engine === "fts5") this.sql.exec("INSERT INTO dd_fts (dd_fts, rowid, path, body) VALUES ('delete', ?, ?, ?)", old.id, path, old.body);
    this.sql.exec("DELETE FROM dd_text WHERE id = ?", old.id);
  }

  /** Bring the search index up to main: the touched files only (the first time, every text file of main). */
  syncSearch(): Promise<void> {
    return this.searchSerial(async () => {
      const m = this.src.main();
      if (!m) return;
      this.forRepo(m.repo);
      const state = this.meta<{ tree: string; engine: Engine }>("search");
      if (state?.tree === m.tree && state.engine === this.engine) return;
      const main = await this.src.treeText(m.tree);
      if (!state || state.engine !== this.engine) {
        this.sql.exec("DELETE FROM dd_text");
        if (this.engine === "fts5") this.sql.exec("INSERT INTO dd_fts (dd_fts) VALUES ('delete-all')");
        for (const [path, body] of main.text) this.putText(path, body);
      } else {
        const { changes } = await diffTrees(this.readTree, state.tree, m.tree, Infinity);
        for (const c of changes) {
          const body = main.text.get(c.path);
          if (body === undefined) this.dropText(c.path);
          else this.putText(c.path, body);
        }
      }
      this.setMeta("search", { tree: m.tree, engine: this.engine });
    });
  }

  /** Find a text in the files of main (a folder or a file with `path`). Case does not matter. */
  async search(input: { query: string; path?: string; limit?: number }): Promise<SearchAnswer> {
    const query = String(input.query ?? "").trim();
    if (!query) throw new Error("Give a text to find.");
    if (query.length > 200) throw new Error("Give a text of at most 200 characters.");
    if (!this.src.main()) throw new Error("The project has no main yet. Ask again when the import is done.");
    const limit = clamp(input.limit, 1, 50, SEARCH_FILES);
    const path = input.path ? normPath(input.path) : "";
    await this.syncSearch();
    const where = path ? " AND (path = ? OR substr(path, 1, ?) = ?)" : "";
    const scope = path ? [path, path.length + 1, `${path}/`] : [];
    // Trigram tokens need 3 characters. A shorter text scans the files.
    const fts = this.engine === "fts5" && [...query].length >= 3;
    const rows = fts
      ? this.sql.exec<{ path: string; body: string }>(`SELECT path, body FROM dd_fts WHERE dd_fts MATCH ?${where} ORDER BY rank, path LIMIT ?`, `"${query.replaceAll('"', '""')}"`, ...scope, limit + 1).toArray()
      : this.sql.exec<{ path: string; body: string }>(`SELECT path, body FROM dd_text WHERE instr(lower(body), lower(?)) > 0${where} ORDER BY path LIMIT ?`, query, ...scope, limit + 1).toArray();
    const needle = query.toLowerCase();
    const files: SearchAnswer["files"] = [];
    let total = 0;
    for (const r of rows.slice(0, limit)) {
      const lines = linesOf(r.body);
      const matches: { line: number; text: string }[] = [];
      let count = 0;
      lines.forEach((text, i) => {
        if (!text.toLowerCase().includes(needle)) return;
        count++;
        if (matches.length < SEARCH_LINES) matches.push({ line: i + 1, text: text.length > 240 ? `${text.slice(0, 239)}…` : text });
      });
      if (!count) continue;
      total += count;
      files.push({ path: r.path, matches, more: count - matches.length });
    }
    const more = rows.length > limit;
    return { query, ...(path ? { path } : {}), files, total, more, engine: fts ? "fts5" : "scan", summary: searchWords(query, total, files.length, more, path || undefined) };
  }

  /* ───────────────────────── compare ───────────────────────── */

  /** A commit id from its first characters: a change of main, a merge, or main. */
  private expand(ref: string): string | null {
    const m = this.src.main();
    const found = new Set<string>();
    for (const r of this.sql.exec<{ sha: string }>("SELECT sha FROM dd_steps WHERE substr(sha, 1, ?) = ?", ref.length, ref).toArray()) found.add(r.sha);
    for (const l of this.src.landings()) for (const sha of [l.mainBefore, l.mainAfter]) if (sha?.startsWith(ref)) found.add(sha);
    if (m?.sha.startsWith(ref)) found.add(m.sha);
    if (found.size > 1) throw new Error(`More than one commit starts with ${ref}. Give more characters of the commit id.`);
    return found.size ? [...found][0] : null;
  }

  /** One side of a compare: its text files, and the id of every file (for files without text). */
  private async side(raw: string): Promise<{ label: string; text: Map<string, string>; ids: Map<string, string> }> {
    const ref = String(raw ?? "").trim();
    if (!ref) throw new Error("Give two versions: main, a commit id or a work copy id.");
    const m = this.src.main();
    if (!m) throw new Error("The project has no main yet. Ask again when the import is done.");
    const ofTree = async (tree: string, label: string) => {
      const tt = await this.src.treeText(tree);
      return { label, text: tt.text, ids: new Map([...tt.snapshot].map(([p, e]) => [p, `${e.sha}:${e.mode}`])) };
    };
    if (ref === "main" || ref === m.sha) return ofTree(m.tree, "main");
    if (/^[0-9a-f]{7,40}$/.test(ref)) {
      const sha = ref.length === 40 ? ref : this.expand(ref);
      const commit = sha ? await this.src.commit(sha) : null;
      if (!commit) throw new Error(`Commit ${short(ref)} is not in this project.`);
      return ofTree(commit.treeHash, versionWords(commit.hash));
    }
    const wc = await this.src.workCopy(ref);
    if (!wc) throw new Error(`Unknown version "${ref}". Use main, a commit id or a work copy id.`);
    const base = await ofTree(wc.attempt.baseTree, "");
    const ids = base.ids;
    for (const p of wc.deleted) ids.delete(p);
    for (const [p, t] of wc.files) if (base.text.get(p) !== t) ids.set(p, `work:${p}`);
    return { label: versionWords(ref, wc.callsign), text: wc.files, ids };
  }

  /** The changes from one version to another: each side is main, a commit id or a work copy id. */
  async compare(from: string, to: string): Promise<CompareAnswer> {
    const [a, b] = await Promise.all([this.side(from), this.side(to)]);
    const paths = [...new Set([...a.ids.keys(), ...b.ids.keys(), ...a.text.keys(), ...b.text.keys()])].sort();
    const files: CompareFile[] = [];
    let additions = 0;
    let deletions = 0;
    let chars = 0;
    let more = false;
    for (const path of paths) {
      const ta = a.text.get(path) ?? null;
      const tb = b.text.get(path) ?? null;
      const ia = a.ids.get(path);
      const ib = b.ids.get(path);
      if (ta !== null && ta === tb) continue;
      if (ta === null && tb === null && ia === ib) continue;
      if (files.length >= COMPARE_FILES || chars >= COMPARE_CHARS) {
        more = true;
        break;
      }
      const inA = ta !== null || ia !== undefined;
      const inB = tb !== null || ib !== undefined;
      const status = !inA ? "A" : !inB ? "D" : "M";
      // A side that has the file without text: gitring compares only the ids.
      if ((inA && ta === null) || (inB && tb === null)) {
        files.push({ path, status, additions: 0, deletions: 0, diff: "", binary: true });
        continue;
      }
      const d = lineDiff(ta ?? "", tb ?? "");
      const diff = unifiedDiff(path, ta, tb);
      chars += diff.length;
      additions += d.additions;
      deletions += d.deletions;
      files.push({ path, status, additions: d.additions, deletions: d.deletions, diff });
    }
    return { from: a.label, to: b.label, files, additions, deletions, more, summary: compareWords(a.label, b.label, files.length, additions, deletions, more) };
  }
}
