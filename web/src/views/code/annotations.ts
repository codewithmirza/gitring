/**
 * Marks for the code view, from the live project state only (no requests):
 *   - which active work copies change or plan each file, and the lines they change (hunks);
 *   - change requests that keep an agent out of lines (avoidRegions);
 *   - the last merge that changed each file.
 * Every selector is memoized on the slices it reads.
 */
import type { AgentInfo, Attempt, AttemptStatus, Correction, FileTouch, Intent, Landing, LineRange, ProjectState } from "../../../../src/core/types";
import { byId, isActiveAttempt, memo } from "../../state/selectors";
import { ancestors } from "./tree";

export interface WorkCopy {
  id: string;
  agentId: string;
  callsign: string;
  color: number;
  model?: string;
  client?: string;
  intentId: string;
  intentTitle: string;
  status: AttemptStatus;
  baseSha: string;
  /** Files it changed, with the base lines of each change. */
  changed: Record<string, FileTouch>;
  /** Files of its plan. */
  planned: string[];
  approach: string;
  plan: string[];
  additions: number;
  deletions: number;
  updatedAt: number;
}

const workCopiesMemo = memo((attempts: Attempt[], agents: AgentInfo[], intents: Intent[]): WorkCopy[] => {
  const agentById = byId(agents);
  const intentById = byId(intents);
  // A work copy that a redo replaced is not active work any more.
  const redone = new Set(attempts.map((a) => a.lineage?.rederivedFrom).filter(Boolean) as string[]);
  return attempts
    .filter((a) => isActiveAttempt(a) && !(a.status === "stale" && redone.has(a.id)))
    .sort((x, y) => x.createdAt - y.createdAt)
    .map((a) => {
      const agent = agentById.get(a.agentId);
      return {
        id: a.id,
        agentId: a.agentId,
        callsign: agent?.callsign ?? a.agentId.toUpperCase(),
        color: agent?.color ?? 0,
        model: agent?.model,
        client: agent?.client,
        intentId: a.intentId,
        intentTitle: intentById.get(a.intentId)?.title ?? "Unknown task",
        status: a.status,
        baseSha: a.baseSha,
        changed: a.footprint?.files ?? {},
        planned: a.course?.files ?? [],
        approach: a.course?.approach ?? "",
        plan: a.course?.plan ?? [],
        additions: a.stats?.additions ?? 0,
        deletions: a.stats?.deletions ?? 0,
        updatedAt: a.updatedAt,
      };
    });
});

/** Active work copies (not merged, stopped or replaced by a redo), oldest first. */
export function selectWorkCopies(st: ProjectState): WorkCopy[] {
  return workCopiesMemo(st.attempts, st.agents, st.intents);
}

export interface FileWork {
  wc: WorkCopy;
  /** The change, when the work copy changed the file already. */
  touch?: FileTouch;
}

export interface KeepOut {
  correction: Correction;
  /** The work copy that must keep out (it got the change request). */
  to?: WorkCopy;
  /** The work copy that changes these lines (it continues). */
  from?: WorkCopy;
  path: string;
  lines: LineRange;
}

export interface FileMarks {
  work: FileWork[];
  keepOut: KeepOut[];
}

const marksMemo = memo((wcs: WorkCopy[], corrections: Correction[]): Map<string, FileMarks> => {
  const m = new Map<string, FileMarks>();
  const at = (path: string) => {
    let x = m.get(path);
    if (!x) {
      x = { work: [], keepOut: [] };
      m.set(path, x);
    }
    return x;
  };
  for (const wc of wcs) {
    for (const [path, touch] of Object.entries(wc.changed)) at(path).work.push({ wc, touch });
    for (const path of wc.planned) if (!wc.changed[path]) at(path).work.push({ wc });
  }
  const byWc = new Map(wcs.map((w) => [w.id, w]));
  for (const c of corrections) {
    if (c.status === "superseded") continue;
    const to = byWc.get(c.attemptId);
    if (!to) continue; // the work copy ended: its change requests do not matter now
    for (const r of c.constraints?.avoidRegions ?? []) {
      at(r.path).keepOut.push({ correction: c, to, from: c.standOnAttemptId ? byWc.get(c.standOnAttemptId) : undefined, path: r.path, lines: r.lines });
    }
  }
  return m;
});

/** Marks per file path. */
export function selectMarks(st: ProjectState): Map<string, FileMarks> {
  return marksMemo(selectWorkCopies(st), st.corrections);
}

export interface FolderMarks {
  /** Work copies with changes or plans below the folder. */
  work: number;
  colors: number[];
  keepOut: number;
}

const foldersMemo = memo((marks: Map<string, FileMarks>): Map<string, FolderMarks> => {
  const ids = new Map<string, Set<string>>();
  const colors = new Map<string, number[]>();
  const out = new Map<string, FolderMarks>();
  for (const [path, fm] of marks) {
    for (const dir of ancestors(path)) {
      let set = ids.get(dir);
      if (!set) {
        set = new Set();
        ids.set(dir, set);
        colors.set(dir, []);
      }
      for (const w of fm.work) {
        if (set.has(w.wc.id)) continue;
        set.add(w.wc.id);
        colors.get(dir)!.push(w.wc.color);
      }
      const f = out.get(dir) ?? { work: 0, colors: [], keepOut: 0 };
      f.keepOut += fm.keepOut.length;
      out.set(dir, f);
    }
  }
  for (const [dir, f] of out) {
    f.work = ids.get(dir)?.size ?? 0;
    f.colors = colors.get(dir) ?? [];
  }
  return out;
});

/** Summary marks per folder (work copies below it, change requests below it). */
export function folderMarks(marks: Map<string, FileMarks>): Map<string, FolderMarks> {
  return foldersMemo(marks);
}

export interface LastMerge {
  landing: Landing;
  intentTitle: string;
  callsign?: string;
  color?: number;
}

const lastMergesMemo = memo((landings: Landing[], attempts: Attempt[], intents: Intent[], agents: AgentInfo[]): Map<string, LastMerge> => {
  const ab = byId(attempts);
  const ib = byId(intents);
  const gb = byId(agents);
  const out = new Map<string, LastMerge>();
  for (const l of [...landings].sort((a, b) => a.at - b.at)) {
    const a = ab.get(l.attemptId);
    if (!a) continue;
    const files = Object.keys(a.footprint?.files ?? {});
    const g = gb.get(l.agentId);
    const v: LastMerge = { landing: l, intentTitle: ib.get(l.intentId)?.title ?? "A task", callsign: g?.callsign, color: g?.color };
    for (const f of files.length ? files : a.course?.files ?? []) out.set(f, v);
  }
  return out;
});

/** The last merge that changed each file. */
export function selectLastMerges(st: ProjectState): Map<string, LastMerge> {
  return lastMergesMemo(st.landings, st.attempts, st.intents, st.agents);
}

/* ───────────── lines of one file ───────────── */

export interface Lane {
  key: string;
  kind: "change" | "keepout";
  color: number;
  ranges: LineRange[];
  wc?: WorkCopy;
  keep?: KeepOut;
  /** The lines are on the base of the work copy, and main moved since then. */
  approx: boolean;
}

/** At most this many lanes in the gutter; the context list names the rest. */
export const MAX_LANES = 4;

/** Gutter lanes for one file on main: one lane per work copy that changed lines, one per change request. */
export function lanesFor(marks: FileMarks | undefined, mainSha: string): Lane[] {
  if (!marks) return [];
  const lanes: Lane[] = [];
  for (const w of marks.work) {
    const hunks = (w.touch?.hunks ?? []).filter((h) => h[0] > 0 && h[1] >= h[0]);
    if (!hunks.length) continue;
    lanes.push({ key: `w:${w.wc.id}`, kind: "change", color: w.wc.color, ranges: hunks, wc: w.wc, approx: Boolean(mainSha) && w.wc.baseSha !== mainSha });
  }
  for (const k of marks.keepOut) {
    if (!(k.lines[0] > 0)) continue;
    const a = Math.min(k.lines[0], k.lines[1]);
    const b = Math.max(k.lines[0], k.lines[1]);
    lanes.push({ key: `k:${k.correction.id}:${a}`, kind: "keepout", color: k.to?.color ?? 0, ranges: [[a, b]], keep: k, approx: false });
  }
  return lanes.slice(0, MAX_LANES);
}

export interface LineMark {
  lane: number;
  first: boolean;
  last: boolean;
  range: LineRange;
}

/** The marks of each line (sparse: only lines with marks). Lines past the end of the file are left out. */
export function marksByLine(lanes: readonly { ranges: LineRange[] }[], lineCount: number): Map<number, LineMark[]> {
  const out = new Map<number, LineMark[]>();
  lanes.forEach((lane, li) => {
    for (const r of lane.ranges) {
      const a = Math.max(1, Math.min(r[0], r[1]));
      const b = Math.min(lineCount, Math.max(r[0], r[1]));
      for (let n = a; n <= b; n++) {
        const list = out.get(n) ?? [];
        list.push({ lane: li, first: n === a, last: n === b, range: [a, b] });
        out.set(n, list);
      }
    }
  });
  return out;
}

export interface Anno {
  key: string;
  lane: number;
  range: LineRange;
}

/** Every marked range in line order (for j/k). */
export function annoList(lanes: readonly { key: string; ranges: LineRange[] }[], lineCount = Infinity): Anno[] {
  const out: Anno[] = [];
  lanes.forEach((lane, li) => {
    for (const r of lane.ranges) {
      const a = Math.min(r[0], r[1]);
      if (a > lineCount) continue;
      out.push({ key: `${lane.key}:${a}`, lane: li, range: [a, Math.min(Math.max(r[0], r[1]), lineCount)] });
    }
  });
  return out.sort((x, y) => x.range[0] - y.range[0] || x.lane - y.lane);
}

/* ───────────── the work copy's own changes (from its diff) ───────────── */

export interface HeadChanges {
  /** Lines of the work copy's version that are new or changed. */
  added: LineRange[];
  /** Lines of the work copy's version after which old lines were removed (0: at the top). */
  removedAfter: number[];
}

/** Read a unified diff of one file: which lines of the new version changed, and where lines went away. */
export function headChanges(diff: string): HeadChanges {
  const added: LineRange[] = [];
  const removedAfter: number[] = [];
  let b = 0;
  let runStart = -1;
  let lastRemovalAt = -1;
  const close = () => {
    if (runStart !== -1) added.push([runStart, b - 1]);
    runStart = -1;
  };
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      close();
      b = Number(h[1]);
      if (b === 0) b = 1;
      continue;
    }
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename |\\)/.test(line)) continue;
    if (line.startsWith("+")) {
      if (runStart === -1) runStart = b;
      b++;
    } else if (line.startsWith("-")) {
      close();
      if (lastRemovalAt !== b - 1) removedAfter.push(b - 1);
      lastRemovalAt = b - 1;
    } else if (line.startsWith(" ")) {
      close();
      b++;
    }
  }
  close();
  // A removal right before new lines is a change of those lines: the bar shows it.
  const starts = new Set(added.map((r) => r[0]));
  return { added, removedAfter: removedAfter.filter((r) => !starts.has(r + 1)) };
}
