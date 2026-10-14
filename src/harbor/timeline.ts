/**
 * Reads the timeline of a project from the project object, a page at a time (see src/core/timeline.ts).
 * Called by HarborReads.events (master/reads.ts) for the Replay view and the demo video.
 * Never put the source of test files, container output, raw model answers or old diffs into a record: they can be large.
 * Read next: ../core/timeline.ts.
 */
import type * as T from "../core/types";
import {
  cursorTime,
  logCursorId,
  timelineCursor,
  timelineLimit,
  type TimelineIntent,
  type TimelinePage,
  type TimelineRecord,
} from "../core/timeline";

/**
 * Two kinds of source:
 *   - documents that the object keeps in memory in full (tasks, work copies, change requests, decisions,
 *     merges, agents): load() reads all of them, and every write goes through to storage;
 *   - the activity log and the conflict checks, which the object keeps in memory only as a recent window:
 *     they come from SQLite, a page at a time, in time order (an index on `at` keeps the reads short).
 */
export interface TimelineSources {
  intents: Iterable<T.Intent>;
  attempts: Iterable<T.Attempt>;
  corrections: Iterable<T.Correction>;
  decisions: Iterable<T.Decision>;
  landings: Iterable<T.Landing>;
  agents: Iterable<T.AgentInfo>;
}

/** Longest error text of one test case in a record. */
const CASE_ERROR_MAX = 400;

const indexed = new WeakSet<object>();

/** Indexes for reads in time order. They are made once per storage, on the first read. */
function ensureIndexes(sql: SqlStorage): void {
  if (indexed.has(sql)) return;
  sql.exec("CREATE INDEX IF NOT EXISTS logs_at ON logs (at, seq)");
  sql.exec("CREATE INDEX IF NOT EXISTS checks_at ON checks (at, id)");
  indexed.add(sql);
}

const byCursor = (a: TimelineRecord, b: TimelineRecord) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0);

/**
 * One page of the timeline: at most `limit` records with a cursor after `after` (null: from the start).
 * A source that has more records than the page holds marks the page as not done.
 */
export function readTimeline(sql: SqlStorage, src: TimelineSources, after: string | null, rawLimit?: number): TimelinePage {
  ensureIndexes(sql);
  const limit = timelineLimit(rawLimit);
  const from = after ?? "";
  const fromAt = after ? cursorTime(after) : -1;
  let full = false;
  const out: TimelineRecord[] = [];
  const take = (list: TimelineRecord[], truncated = false) => {
    const fresh = list.filter((r) => r.cursor > from).sort(byCursor);
    if (truncated || fresh.length > limit) full = true;
    out.push(...fresh.slice(0, limit));
  };

  take([...src.intents].map((i) => ({ kind: "intent", at: i.createdAt, cursor: timelineCursor(i.createdAt, "intent", i.id), intent: intentRecord(i) })));
  take([...src.attempts].map((a) => ({ kind: "attempt", at: a.createdAt, cursor: timelineCursor(a.createdAt, "attempt", a.id), attempt: attemptRecord(a) })));
  take([...src.corrections].map((c) => ({ kind: "correction", at: c.createdAt, cursor: timelineCursor(c.createdAt, "correction", c.id), correction: correctionRecord(c) })));
  take([...src.decisions].map((d) => ({ kind: "decision", at: d.at, cursor: timelineCursor(d.at, "decision", d.id), decision: d })));
  take([...src.landings].map((l) => ({ kind: "landing", at: l.at, cursor: timelineCursor(l.at, "landing", l.id), landing: landingRecord(l) })));

  // The activity log: rows at the time of the cursor (the cursor decides), then the rows after it.
  const logs = (rows: { seq: number; json: string }[]): TimelineRecord[] =>
    rows.map((r) => {
      const log = JSON.parse(r.json) as T.LogEntry;
      return { kind: "log", at: log.at, cursor: timelineCursor(log.at, "log", logCursorId(r.seq)), log };
    });
  if (fromAt >= 0) take(logs(sql.exec<{ seq: number; json: string }>("SELECT seq, json FROM logs WHERE at = ? ORDER BY seq", fromAt).toArray()));
  const laterLogs = sql.exec<{ seq: number; json: string }>("SELECT seq, json FROM logs WHERE at > ? ORDER BY at, seq LIMIT ?", fromAt, limit).toArray();
  take(logs(laterLogs), laterLogs.length >= limit);

  // The conflict checks, the same way.
  const checks = (rows: { json: string }[]): TimelineRecord[] =>
    rows.map((r) => {
      const check = checkRecord(JSON.parse(r.json) as T.CourseCheck);
      return { kind: "check", at: check.at, cursor: timelineCursor(check.at, "check", check.id), check };
    });
  if (fromAt >= 0) take(checks(sql.exec<{ json: string }>("SELECT json FROM checks WHERE at = ? ORDER BY id", fromAt).toArray()));
  const laterChecks = sql.exec<{ json: string }>("SELECT json FROM checks WHERE at > ? ORDER BY at, id LIMIT ?", fromAt, limit).toArray();
  take(checks(laterChecks), laterChecks.length >= limit);

  out.sort(byCursor);
  if (out.length > limit) {
    full = true;
    out.length = limit;
  }
  return { records: out, next: out.length ? out[out.length - 1].cursor : null, done: !full, agents: [...src.agents] };
}

// ───── What a record holds ─────

function intentRecord(i: T.Intent): TimelineIntent {
  return { ...i, checks: i.checks.map((c) => ({ id: c.id, path: c.path, description: c.description })) };
}

function runRecord(run: T.CheckRun): T.CheckRun;
function runRecord(run: T.CheckRun | undefined): T.CheckRun | undefined;
function runRecord(run: T.CheckRun | undefined): T.CheckRun | undefined {
  if (!run) return run;
  const { log: _log, ...rest } = run;
  return { ...rest, cases: run.cases.map((c) => (c.error && c.error.length > CASE_ERROR_MAX ? { ...c, error: `${c.error.slice(0, CASE_ERROR_MAX)}…` } : c)) };
}

function attemptRecord(a: T.Attempt): T.Attempt {
  return { ...a, checks: runRecord(a.checks), composedChecks: runRecord(a.composedChecks) };
}

function checkRecord(c: T.CourseCheck): T.CourseCheck {
  const { raw: _raw, ...rest } = c;
  return rest;
}

/** A change request without the diffs of earlier changes (`reapply` keeps the paths, the diff text is empty). */
function correctionRecord(c: T.Correction): T.Correction {
  if (!c.constraints.reapply?.length) return c;
  return { ...c, constraints: { ...c.constraints, reapply: c.constraints.reapply.map((r) => ({ path: r.path, diff: "" })) } };
}

function landingRecord(l: T.Landing): T.Landing {
  return { ...l, checks: runRecord(l.checks) };
}
