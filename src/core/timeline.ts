/**
 * The whole history of a project as one list of records, oldest first, in pages.
 *
 * The replay view reads it (`GET /api/projects/:p/events`).
 * Pure module: types and cursor helpers, shared by the Worker, the project coordinator and the web app.
 */

/*
 * The timeline of a project: its whole history as one list of records, oldest first, in pages.
 *
 * The project object keeps a short window of the activity log and the conflict checks in memory (the live
 * state). The timeline reads storage, so it has every record since the project started. The Replay view
 * reads it (GET /api/projects/:p/events) and plays the history back on the map.
 *
 * Order: by time, then by kind (TIMELINE_RANK), then by id. A cursor encodes that order as text, so
 * cursors compare as strings: a page holds the records with a cursor after `after`.
 *
 * Pure module: types and cursor helpers, shared by the Worker, the project object and the web UI.
 */

import type { AgentInfo, Attempt, Correction, CourseCheck, Decision, Intent, Landing, LogEntry } from "./types";

/** A task as the timeline shows it: the test files of the task without their source (the source can be long). */
export type TimelineIntent = Omit<Intent, "checks"> & { checks: { id: string; path: string; description: string }[] };

export type TimelineRecord =
  /** A task, at the time it was written. */
  | { kind: "intent"; at: number; cursor: string; intent: TimelineIntent }
  /** A work copy, at the time its plan came in. The document is the latest version (status, course, test runs). */
  | { kind: "attempt"; at: number; cursor: string; attempt: Attempt }
  | { kind: "log"; at: number; cursor: string; log: LogEntry }
  /** A conflict check (without the raw model answers). */
  | { kind: "check"; at: number; cursor: string; check: CourseCheck }
  /** A change request, at the time gitring sent it. The document has the delivery and the answer times. */
  | { kind: "correction"; at: number; cursor: string; correction: Correction }
  | { kind: "decision"; at: number; cursor: string; decision: Decision }
  /** A merge into main. */
  | { kind: "landing"; at: number; cursor: string; landing: Landing };

export type TimelineKind = TimelineRecord["kind"];

export interface TimelinePage {
  records: TimelineRecord[];
  /** The cursor of the last record of this page: send it as `after` for the next page. Null for an empty page. */
  next: string | null;
  /** True when no record comes after this page. */
  done: boolean;
  /** Every agent of the project (callsigns, colors, models). Agents have no time: each page has all of them. */
  agents: AgentInfo[];
}

/** The order of kinds for records with the same time. A task comes before its work, a merge after its tests. */
export const TIMELINE_RANK: Record<TimelineKind, number> = { intent: 0, attempt: 1, log: 2, check: 3, correction: 4, decision: 5, landing: 6 };

/** Records in one page: the default and the limit. */
export const TIMELINE_PAGE = 500;
export const TIMELINE_PAGE_MAX = 2000;

const AT_DIGITS = 15;
const CURSOR = /^(\d{15})\.(\d)\.([A-Za-z0-9_-]{1,80})$/;

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** An id as the cursor holds it: the id itself, or a stable hash of an id with other characters. */
function cursorId(id: string): string {
  if (SAFE_ID.test(id)) return id;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `h${(h >>> 0).toString(36)}`;
}

/** The cursor of a record: time (15 digits), kind rank and id. Cursors compare as text in timeline order. */
export function timelineCursor(at: number, kind: TimelineKind, id: string): string {
  const ms = Math.max(0, Math.min(10 ** AT_DIGITS - 1, Math.floor(Number(at) || 0)));
  return `${String(ms).padStart(AT_DIGITS, "0")}.${TIMELINE_RANK[kind]}.${cursorId(String(id))}`;
}

/** The id part of a log cursor: the storage sequence number, with leading zeros (12 digits). */
export function logCursorId(seq: number): string {
  return String(Math.max(0, Math.floor(seq))).padStart(12, "0");
}

/** True for a cursor that this module made. */
export function isTimelineCursor(raw: unknown): raw is string {
  return typeof raw === "string" && CURSOR.test(raw);
}

/** The time in a cursor (ms). */
export function cursorTime(cursor: string): number {
  const m = CURSOR.exec(cursor);
  return m ? Number(m[1]) : 0;
}

/** The page size for a request: the default when absent, else between 1 and the limit. */
export function timelineLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return TIMELINE_PAGE;
  return Math.min(TIMELINE_PAGE_MAX, n);
}
