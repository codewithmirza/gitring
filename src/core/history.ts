/**
 * History answers: why a line is there, the changes of a file, a search of the code of main, and a
 * compare of two versions. The project object computes them from derived data (src/harbor/derived.ts).
 * The MCP tools (src/worker/mcp-history.ts), the REST routes and the web app read the same shapes.
 *
 * Pure module: the shapes, the line blame as runs, the line maps of a diff, and the plain words.
 *
 * Words: a "change" of main is a merge of gitring or a move of main without a merge (the start of the
 * project, an import, a pull of outside changes). People read "merge", "task", "work copy", never the
 * code names.
 */
import type { LandingMethod, Millis } from "./types";
import type { DiffHunk } from "./text/diff";

/* ───────────────────────── shapes ───────────────────────── */

/** "root": main when the history starts. "merge": a merge of gitring. "outside": main moved without a merge. */
export type StepKind = "root" | "merge" | "outside";

/** One change of main. */
export interface HistoryStep {
  /** The commit on main after the change. */
  sha: string;
  /** Main before the change ("" for the first change). */
  parent: string;
  kind: StepKind;
  at: Millis;
  /** Merges: the task title. Other changes: the first line of the commit message. */
  subject: string;
  /** How many files the change touched. */
  files: number;
  merge?: {
    landingId: string;
    intentId: string;
    attemptId: string;
    callsign: string;
    method: LandingMethod;
    tests: { passed: number; failed: number };
  };
  /** With a path: what the change did to the file, or to the files of the folder (`paths` of them). */
  change?: { status: "A" | "M" | "D"; additions: number; deletions: number; paths?: number };
}

/** The why-record of a merge (the git note of the merge commit), in short. */
export interface WhyRecord {
  task: { id: string; title: string; goal: string; constraints: string[] };
  plan: { steps: string[]; files: string[]; approach: string };
  /** What the agent said when it asked for the merge. */
  summary: string | null;
  agent: { callsign: string; model: string | null };
  method: LandingMethod;
  changeRequests: { id: string; kind: string; message: string; status: string; ackNote?: string }[];
  /** The conflict checks of the work, oldest first: one verdict each. */
  conflictChecks: string[];
  tests: { passed: number; failed: number; failures: string[] };
  /** The decision of a person (a yes, a pick), when there was one. */
  decision: { kind: string; by: string; rationale: string } | null;
}

/** A line of a work copy that is not merged. */
export interface WorkLine {
  attemptId: string;
  callsign: string;
  title: string;
  status: string;
  approach: string;
  plan: string[];
}

export interface WhyAnswer {
  path: string;
  /** The version as asked: "main", a commit id or a work copy id. */
  ref: string;
  line?: number;
  /** The text of the line. */
  text?: string;
  /** The change that last wrote the line. Absent when gitring does not know it. */
  step?: HistoryStep;
  /** The why-record of that merge. */
  record?: WhyRecord;
  /** The line is a change of a work copy that is not merged. */
  work?: WorkLine;
  /** Without a line: the changes of the file, the newest first. */
  changes?: HistoryStep[];
  summary: string;
}

export interface HistoryAnswer {
  /** The file or folder as asked. Absent: all changes of main. */
  path?: string;
  /** The newest first. */
  steps: HistoryStep[];
  /** More changes exist than the answer shows. */
  more: boolean;
  summary: string;
}

export interface SearchAnswer {
  query: string;
  path?: string;
  files: { path: string; matches: { line: number; text: string }[]; more: number }[];
  /** Matching lines in the files of the answer. */
  total: number;
  /** More files match than the answer shows. */
  more: boolean;
  /** "fts5": the full-text index of SQLite. "scan": a plain scan (SQLite without FTS5, or a short query). */
  engine: "fts5" | "scan";
  summary: string;
}

export interface CompareFile {
  path: string;
  status: "A" | "M" | "D";
  additions: number;
  deletions: number;
  /** Unified diff. Empty for a file that gitring keeps without text (binary or very large), or when `cut`. */
  diff: string;
  binary?: boolean;
  /** The answer has no diff for this file: the answer has a size limit. Ask again with its path. */
  cut?: boolean;
}

export interface CompareAnswer {
  from: string;
  to: string;
  /** The folder or file as asked. Absent: all files. */
  path?: string;
  files: CompareFile[];
  additions: number;
  deletions: number;
  /** More files changed than the answer shows. */
  more: boolean;
  summary: string;
}

/* ───────────────────────── line blame as runs ───────────────────────── */

/**
 * The line blame of one file, run-length coded: [step, count] = `count` lines in a row that change
 * `step` wrote. Step 0 means: gitring does not know the change.
 */
export type BlameRuns = [number, number][];

/** The step for lines that gitring cannot trace. */
export const UNKNOWN_STEP = 0;

/** Lines that a blame covers. */
export function runsLength(runs: BlameRuns): number {
  let n = 0;
  for (const [, c] of runs) n += c;
  return n;
}

/** The step that wrote line `line` (1-based). Undefined outside the file. */
export function stepAt(runs: BlameRuns, line: number): number | undefined {
  if (!Number.isInteger(line) || line < 1) return undefined;
  let left = line;
  for (const [s, c] of runs) {
    if (left <= c) return s;
    left -= c;
  }
  return undefined;
}

function push(out: BlameRuns, step: number, count: number): void {
  if (count <= 0) return;
  const last = out[out.length - 1];
  if (last && last[0] === step) last[1] += count;
  else out.push([step, count]);
}

/**
 * The blame of a new version of a file: the blame of the old version, where each change block of the
 * diff becomes lines of `step`. `hunks` come from diffHunks(old, new) (unified numbering, context 0).
 * Cost: the number of runs plus the number of change blocks, not the size of the file.
 */
export function applyHunks(old: BlameRuns, hunks: readonly DiffHunk[], step: number): BlameRuns {
  const out: BlameRuns = [];
  let ri = 0;
  let used = 0;
  // Read `n` lines of the old blame; copy them when `keep`.
  const take = (n: number, keep: boolean) => {
    while (n > 0 && ri < old.length) {
      const [s, c] = old[ri];
      const k = Math.min(n, c - used);
      if (keep) push(out, s, k);
      used += k;
      n -= k;
      if (used === c) {
        ri++;
        used = 0;
      }
    }
  };
  let o = 0;
  for (const h of hunks) {
    const start = h.oldLines > 0 ? h.oldStart - 1 : h.oldStart;
    take(start - o, true);
    take(h.oldLines, false);
    push(out, step, h.newLines);
    o = start + h.oldLines;
  }
  take(Infinity, true);
  return out;
}

/** A blame where all `lines` lines come from one step. */
export function oneRun(step: number, lines: number): BlameRuns {
  return lines > 0 ? [[step, lines]] : [];
}

/* ───────────────────────── line maps of a diff ───────────────────────── */

/**
 * Where line `line` (1-based) of the NEW text was in the OLD text. `added`: a change block wrote it.
 * `hunks` come from diffHunks(old, new).
 */
export function oldLineOf(hunks: readonly DiffHunk[], line: number): { added: true } | { added: false; line: number } {
  let shift = 0;
  for (const h of hunks) {
    const start = h.newLines > 0 ? h.newStart : h.newStart + 1;
    if (line < start) break;
    if (h.newLines > 0 && line < start + h.newLines) return { added: true };
    shift += h.newLines - h.oldLines;
  }
  return { added: false, line: line - shift };
}

/**
 * Where line `line` (1-based) of the OLD text is in the NEW text. `removed`: a change block replaced or
 * deleted it.
 */
export function newLineOf(hunks: readonly DiffHunk[], line: number): { removed: true } | { removed: false; line: number } {
  let shift = 0;
  for (const h of hunks) {
    const start = h.oldLines > 0 ? h.oldStart : h.oldStart + 1;
    if (line < start) break;
    if (h.oldLines > 0 && line < start + h.oldLines) return { removed: true };
    shift += h.newLines - h.oldLines;
  }
  return { removed: false, line: line + shift };
}

/* ───────────────────────── the why-record ───────────────────────── */

const str = (x: unknown): string => (typeof x === "string" ? x : "");
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/** The why-record of a merge from its git note (schema gitring.logbook/v1). Null: no note, or not JSON. */
export function parseWhyRecord(note: string | null | undefined): WhyRecord | null {
  if (!note) return null;
  let raw: Record<string, unknown>;
  try {
    raw = obj(JSON.parse(note));
  } catch {
    return null;
  }
  const intent = obj(raw.intent);
  const attempt = obj(raw.attempt);
  const course = obj(attempt.course);
  const agent = obj(raw.agent);
  const checks = obj(raw.checks);
  const decision = raw.decision ? obj(raw.decision) : null;
  const by = obj(decision?.by);
  const method = str(raw.method);
  return {
    task: { id: str(intent.id), title: str(intent.title), goal: str(intent.goal), constraints: strs(intent.constraints) },
    plan: { steps: strs(course.plan), files: strs(course.files), approach: str(course.approach) },
    summary: str(attempt.summary) || null,
    agent: { callsign: str(agent.callsign), model: str(agent.model) || str(agent.client) || null },
    method: method === "fast-forward" || method === "rederive" ? method : "merge",
    changeRequests: (Array.isArray(raw.corrections) ? raw.corrections : []).map((c) => {
      const x = obj(c);
      return { id: str(x.id), kind: str(x.kind), message: str(x.message), status: str(x.status), ...(str(x.ackNote) ? { ackNote: str(x.ackNote) } : {}) };
    }),
    conflictChecks: (Array.isArray(raw.courseChecks) ? raw.courseChecks : []).map((k) => str(obj(k).verdict)).filter(Boolean),
    tests: {
      passed: num(checks.passed),
      failed: num(checks.failed),
      failures: (Array.isArray(checks.cases) ? checks.cases : [])
        .map(obj)
        .filter((c) => c.ok === false)
        .map((c) => `${str(c.file)}: ${str(c.name)}`)
        .slice(0, 10),
    },
    decision: decision ? { kind: str(decision.kind), by: str(by.name) || str(by.id) || "a person", rationale: str(decision.rationale) } : null,
  };
}

/* ───────────────────────── words ───────────────────────── */

/** "2026-10-13" (UTC). */
export function dayOf(at: Millis): string {
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString().slice(0, 10) : "an unknown day";
}

export const short = (sha: string): string => sha.slice(0, 7);

/** What the version is, for a sentence: "main", "commit abc1234", "the work copy of Robin-7". */
export function versionWords(ref: string, callsign?: string): string {
  if (ref === "main") return "main";
  if (/^[0-9a-f]{7,40}$/.test(ref)) return `commit ${short(ref)}`;
  return callsign ? `the work copy of ${callsign}` : `the work copy ${ref}`;
}

/** Who made a change of main, in one sentence. */
export function stepWords(s: HistoryStep): string {
  if (s.kind === "merge" && s.merge) return `It came from the task "${s.subject}". ${s.merge.callsign} merged it on ${dayOf(s.at)} (commit ${short(s.sha)}).`;
  if (s.kind === "root") return `It was on main before gitring recorded history (commit ${short(s.sha)}: "${s.subject}").`;
  return `It came with commit ${short(s.sha)} ("${s.subject}") on ${dayOf(s.at)}. Main moved to that commit without a merge of gitring.`;
}

/** The summary of a why answer for one line. */
export function whyLineWords(a: { path: string; line: number; version: string; step?: HistoryStep; work?: WorkLine }): string {
  const head = `Line ${a.line} of ${a.path} on ${a.version}.`;
  if (a.work) return `${head} The work copy of ${a.work.callsign} wrote it for the task "${a.work.title}". It is not merged yet.`;
  if (!a.step) return `${head} gitring does not know which change wrote it.`;
  return `${head} ${stepWords(a.step)}`;
}

/** The summary of a why answer for a whole file. */
export function whyFileWords(path: string, version: string, changes: HistoryStep[], more: boolean): string {
  const merges = changes.filter((s) => s.kind !== "root");
  const where = version === "main" ? "main" : `main up to ${version}`;
  if (!merges.length) return `No change of ${where} touched ${path} after the start of the history. Give a line to see where it came from.`;
  const last = merges[0];
  const n = `${merges.length}${more ? " or more" : ""}`;
  const lastWords = last.kind === "merge" ? `the task "${last.subject}"` : `commit ${short(last.sha)} ("${last.subject}")`;
  return `${n} ${merges.length === 1 && !more ? "change" : "changes"} of ${where} touched ${path}. The last is ${lastWords}. Give a line to see the change that wrote it.`;
}

export function historyWords(path: string | undefined, steps: HistoryStep[], more: boolean): string {
  const what = path ? path : "main";
  if (!steps.length) return path ? `gitring has no change of ${path} in the history of main.` : "Main has no history yet.";
  const n = steps.length;
  return `${n}${more ? " recent" : ""} ${n === 1 ? "change" : "changes"} of ${what}. The newest is first.${more ? " Give a higher limit to see more." : ""}`;
}

export function searchWords(query: string, total: number, files: number, more: boolean, path?: string): string {
  const where = path ? `the files of main under ${path}` : "the files of main";
  if (!total) return `No line of ${where} has "${query}".`;
  return `${total} ${total === 1 ? "line" : "lines"} in ${files}${more ? " or more" : ""} ${files === 1 && !more ? "file" : "files"} of ${where} ${total === 1 ? "has" : "have"} "${query}".`;
}

/** The summary of a compare. `cut`: files without a diff in the answer. `path`: the folder or file as asked. */
export function compareWords(from: string, to: string, files: number, additions: number, deletions: number, more: boolean, cut = 0, path?: string): string {
  const where = path ? ` under ${path}` : "";
  if (!files) return `${from} and ${to} have the same files${where}.`;
  const head = `${from} and ${to} differ in ${files}${more ? " or more" : ""} ${files === 1 && !more ? "file" : "files"}${where} (+${additions} -${deletions}).`;
  const tail: string[] = [];
  if (cut) tail.push(`The answer has no diff for ${cut} of them because of its size.`);
  if (more) tail.push("The answer shows the first files only.");
  if (tail.length) tail.push("Give a path to see one folder or file.");
  return [head, ...tail].join(" ");
}
