/**
 * Keeps the derived data up to date: computes each change of main from its parent, and the search index.
 * Layer 2 of the chain in README.md. Extends DerivedStorage (storage.ts).
 * A small merge is computed when it lands (landed). A big one waits for the first question (catchUp).
 * Read next: answers.ts.
 */
import { EMPTY_TREE_SHA } from "../../core/git/objects";
import { diffHunks, lineDiff } from "../../core/text/diff";
import { textEligible } from "../../core/repo-rules";
import { applyHunks, oneRun, type BlameRuns, type StepKind } from "../../core/history";
import { BACKGROUND_BUDGET_MS, EAGER_FILES, EAGER_STEPS, MAX_WALK, TEXT_READS } from "./constants";
import { firstLine, isBlob, lineCount, mapLimit } from "./helpers";
import { diffTrees } from "./tree-diff";
import type { Engine, PlannedStep } from "./types";
import { DerivedStorage } from "./storage";

export abstract class DerivedUpdate extends DerivedStorage {
  // ───── Computing the changes of main ─────

  /** The changes of main that have no derived data yet, in order. */
  protected async plan(m: { sha: string }): Promise<PlannedStep[]> {
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
      const count = () => this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM dd_steps").one().n;
      // Most questions come when the history already has main: no walk.
      if (this.tip()?.sha === m.sha) return { behind: 0, total: count() };
      const started = Date.now();
      const plan = await this.plan(m);
      let i = 0;
      if (plan.length <= upTo) for (; i < plan.length && (i === 0 || Date.now() - started < budgetMs); i++) await this.compute(plan[i], m);
      return { behind: plan.length - i, total: count() + plan.length - i };
    });
  }

  /** Compute one change from its parent (the last change). All reads first, then all writes in one step. */
  protected async compute(s: PlannedStep, m: { sha: string; tree: string }): Promise<void> {
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
  protected async ready(): Promise<{ repo: string; sha: string; tree: string }> {
    const m = this.src.main();
    if (!m) throw new Error("The project has no main yet. Ask again when the import is done.");
    const { behind, total } = await this.catchUp(this.queryBudgetMs);
    if (behind > 0) {
      this.src.background(this.catchUp());
      throw new Error(`gitring builds the history of this project now (${total - behind} of ${total} changes). Ask again in a minute.`);
    }
    return m;
  }

  // ───── The search index ─────

  protected searchRun: Promise<unknown> = Promise.resolve();

  protected searchSerial<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.searchRun.then(fn, fn);
    this.searchRun = next.catch(() => undefined);
    return next;
  }

  protected putText(path: string, body: string): void {
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

  protected dropText(path: string): void {
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
      if (!state || state.engine !== this.engine) {
        const main = await this.src.treeText(m.tree);
        this.sql.exec("DELETE FROM dd_text");
        if (this.engine === "fts5") this.sql.exec("INSERT INTO dd_fts (dd_fts) VALUES ('delete-all')");
        for (const [path, body] of main.text) this.putText(path, body);
      } else {
        // Only the touched files: read their text, then write all rows in one step.
        const { changes } = await diffTrees(this.readTree, state.tree, m.tree, Infinity);
        const bodies = await mapLimit(changes, TEXT_READS, (c) => (isBlob(c.now) && textEligible(c.path) ? this.src.text(c.now.hash) : Promise.resolve(null)));
        changes.forEach((c, i) => {
          const body = bodies[i];
          if (body === null) this.dropText(c.path);
          else this.putText(c.path, body);
        });
      }
      this.setMeta("search", { tree: m.tree, engine: this.engine });
    });
  }
}
