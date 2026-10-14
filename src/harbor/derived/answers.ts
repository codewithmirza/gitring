/**
 * Answers the history questions: why a line is there, the changes of a path, and a text search.
 * Layer 3 of the chain in README.md. Extends DerivedUpdate (update.ts).
 * A question that comes while the history is behind waits a short time, then asks the caller to come back (ready).
 * Read next: compare.ts.
 */
import { diffHunks } from "../../core/text/diff";
import {
  historyWords,
  newLineOf,
  oldLineOf,
  parseWhyRecord,
  searchWords,
  short,
  stepAt,
  UNKNOWN_STEP,
  versionWords,
  whyFileWords,
  whyLineWords,
  type HistoryAnswer,
  type HistoryStep,
  type SearchAnswer,
  type WhyAnswer,
  type WorkLine,
} from "../../core/history";
import { MAX_LIMIT, SEARCH_FILES, SEARCH_LINES } from "./constants";
import { clamp, lineCount, linesOf, normPath } from "./helpers";
import type { StepRow } from "./types";
import { DerivedUpdate } from "./update";

export abstract class DerivedAnswers extends DerivedUpdate {
  // ───── Building answers ─────

  protected stepOf(r: StepRow, change?: HistoryStep["change"]): HistoryStep {
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
  protected pathSteps(path: string, upTo: number, limit: number): HistoryStep[] {
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
  protected async changesOf(path: string, upTo: number, limit: number): Promise<{ steps: HistoryStep[]; more: boolean }> {
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
  protected notThere(path: string, version: string, upTo: number): string {
    const gone = this.sql.exec<{ seq: number }>("SELECT seq FROM dd_paths WHERE path = ? AND seq <= ? AND status = 'D' ORDER BY seq DESC LIMIT 1", path, upTo).toArray()[0];
    const s = gone ? this.stepBySeq(gone.seq) : undefined;
    return s ? `${path} is not on ${version}. Commit ${short(s.sha)} ("${s.subject}") deleted it.` : `${path} is not on ${version}, or gitring keeps it without text.`;
  }

  /** The answer for one line, from the change that wrote it. */
  protected lineAnswer(a: { path: string; ref: string; version: string; line: number; text: string; seq?: number; work?: WorkLine }): WhyAnswer {
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

  // ───── Why and history ─────

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
  protected async whyWork(id: string, path: string, line: number | undefined): Promise<WhyAnswer> {
    const wc = await this.src.workCopy(id);
    if (!wc) throw new Error(`Unknown version "${id}". Use main, a commit id or a work copy id.`);
    const a = wc.attempt;
    // A merged work copy: its lines are in the merge commit, with the record of that merge.
    const landing = a.status === "landed" ? this.src.landings().find((l) => l.attemptId === a.id) : undefined;
    if (landing) {
      const res = await this.why({ path, line, ref: landing.mainAfter });
      return { ...res, ref: id, summary: `The work copy of ${wc.callsign} merged in commit ${short(landing.mainAfter)}. ${res.summary}` };
    }
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

  // ───── Search ─────

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
}
