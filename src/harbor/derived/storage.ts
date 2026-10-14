/**
 * Storage of the derived data: the tables, the lookups of changes, and the reading of trees and text.
 * Layer 1 of the chain in README.md. It has no parent class.
 * The derived data belongs to one repository: a new repository of the project starts it again (forRepo).
 * Read next: update.ts.
 */
import type { TreeEntry } from "../../platform/repo/backend";
import { EMPTY_TREE_SHA } from "../../core/git/objects";
import { oneRun, runsLength, short, UNKNOWN_STEP, type BlameRuns } from "../../core/history";
import { FTS, QUERY_BUDGET_MS, SCHEMA } from "./constants";
import { isBlob } from "./helpers";
import type { DerivedSource, Engine, StepRow } from "./types";

export abstract class DerivedStorage {
  // ───── State and start-up ─────

  protected readonly engine: Engine;

  protected run: Promise<unknown> = Promise.resolve();

  /** `queryBudgetMs`: how long a question waits for the history (tests make it short). */
  constructor(
    protected readonly src: DerivedSource,
    protected readonly queryBudgetMs = QUERY_BUDGET_MS,
  ) {
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

  // ───── Tables ─────

  protected get sql(): SqlStorage {
    return this.src.sql;
  }

  protected meta<V>(key: string): V | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM dd_meta WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as V) : undefined;
  }

  protected setMeta(key: string, value: unknown): void {
    this.sql.exec("INSERT OR REPLACE INTO dd_meta (key, value) VALUES (?, ?)", key, JSON.stringify(value));
  }

  /** The derived data belongs to one repository. A new repository of the project (a new start) starts it again. */
  protected forRepo(repo: string): void {
    if (this.meta<string>("repo") === repo) return;
    for (const t of ["dd_steps", "dd_paths", "dd_blame", "dd_text", "dd_meta"]) this.sql.exec(`DELETE FROM ${t}`);
    if (this.engine === "fts5") this.sql.exec("INSERT INTO dd_fts (dd_fts) VALUES ('delete-all')");
    this.setMeta("repo", repo);
  }

  protected tip(): StepRow | undefined {
    return this.sql.exec<StepRow>("SELECT * FROM dd_steps ORDER BY seq DESC LIMIT 1").toArray()[0];
  }

  protected rootSeq(): number {
    return this.sql.exec<{ seq: number }>("SELECT seq FROM dd_steps ORDER BY seq ASC LIMIT 1").toArray()[0]?.seq ?? UNKNOWN_STEP;
  }

  protected stepBySeq(seq: number): StepRow | undefined {
    return this.sql.exec<StepRow>("SELECT * FROM dd_steps WHERE seq = ?", seq).toArray()[0];
  }

  protected stepBySha(sha: string): StepRow | undefined {
    return this.sql.exec<StepRow>("SELECT * FROM dd_steps WHERE sha = ?", sha).toArray()[0];
  }

  /** A change by a commit id or its first characters (at least 7). */
  protected findStep(ref: string): StepRow | undefined {
    if (ref.length === 40) return this.stepBySha(ref);
    const rows = this.sql.exec<StepRow>("SELECT * FROM dd_steps WHERE substr(sha, 1, ?) = ? LIMIT 2", ref.length, ref).toArray();
    return rows.length === 1 ? rows[0] : undefined;
  }

  /** The blame of `path` at change `seq`, for a text of `lines` lines. */
  protected runsAt(path: string, seq: number, lines: number, before = false): BlameRuns {
    const row = this.sql
      .exec<{ runs: string | null }>(`SELECT runs FROM dd_blame WHERE path = ? AND seq ${before ? "<" : "<="} ? ORDER BY seq DESC LIMIT 1`, path, seq)
      .toArray()[0];
    if (!row) return oneRun(this.rootSeq(), lines);
    const runs = row.runs ? (JSON.parse(row.runs) as BlameRuns) : null;
    // A blame that does not fit the text: gitring cannot trace these lines.
    return runs && runsLength(runs) === lines ? runs : oneRun(UNKNOWN_STEP, lines);
  }

  // ───── Reading trees and text ─────

  protected readTree = async (tree: string): Promise<TreeEntry[]> => {
    if (!tree || tree === EMPTY_TREE_SHA) return [];
    const entries = await this.src.readTree(tree);
    if (!entries) throw new Error(`gitring cannot read tree ${short(tree)} of this project.`);
    return entries;
  };

  /** The entry at `path` in a tree, or null. */
  protected async entryAt(tree: string, path: string): Promise<TreeEntry | null> {
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
  protected async textAt(tree: string, path: string): Promise<string | null> {
    const e = await this.entryAt(tree, path);
    return isBlob(e ?? undefined) ? this.src.text(e!.hash) : null;
  }

  /** One run at a time: each change needs the result of its parent. */
  protected serial<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.run.then(fn, fn);
    this.run = next.catch(() => undefined);
    return next;
  }
}
