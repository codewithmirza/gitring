/**
 * Computes the world after a step: the tasks, vessels, distance lines, buoys, merge queue and commits.
 * Pure. Replays the steps from the start to the index, so it never keeps state between calls.
 */
import type { AttemptStatus, Correction, CorrectionKind, LandingMethod, Range, Verdict } from "../../../../../src/core/types";
import { correctionFile, rangeTone, type RangeLine, type RangeLink, type VesselModel } from "../../../state/selectors";
import { hullName } from "../../../design/icons";
import { RANGE_TEXT } from "../../../state/format";
import type { ReplayScript } from "./steps";

/* ───────────── types ───────────── */

export type TaskState = "open" | "working" | "merged" | "paused";

export interface WorldTask {
  id: string;
  title: string;
  state: TaskState;
  at: number;
}

export interface WorldBuoy {
  id: string;
  attemptId: string;
  file: string;
  kind: CorrectionKind;
  done: boolean;
  correction: Correction;
  callsign: string;
  fromCallsign?: string;
}

export interface WorldCommit {
  sha: string;
  title: string;
  method: LandingMethod;
  attemptId: string;
  at: number;
}

export interface World {
  /** The index of the step, -1 before the first step. */
  index: number;
  at: number;
  tasks: WorldTask[];
  vessels: VesselModel[];
  ranges: RangeLine[];
  buoys: WorldBuoy[];
  /** Work copies that wait in the merge queue, in order. */
  queue: string[];
  /** The work copy that holds the merge lease. */
  lease: string | null;
  mainSha: string | null;
  commits: WorldCommit[];
  counts: { tasks: number; plans: number; checks: number; requests: number; acks: number; tests: number; merges: number };
}

/* ───────────── constants ───────────── */

const SHOWN: ReadonlySet<AttemptStatus> = new Set<AttemptStatus>(["declared", "underway", "submitted", "checking", "ready", "landing", "stale", "rederiving"]);

interface Live {
  status: AttemptStatus;
  track: string[];
  failing: boolean;
  lastVerdict?: Verdict;
  checked: boolean;
  updatedAt: number;
  hidden: boolean;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/* ───────────── the world after a step ───────────── */

/** What the map and the panels show after step `index` (-1: before the first step). */
export function worldAt(script: ReplayScript, index: number): World {
  const last = Math.min(index, script.steps.length - 1);
  const live = new Map<string, Live>();
  const taskState = new Map<string, TaskState>();
  const taskAt = new Map<string, number>();
  const pairs = new Map<string, { a: string; b: string; range: Range; closing: boolean; verdict: Verdict }>();
  const issued: Correction[] = [];
  const acked = new Set<string>();
  const queue: string[] = [];
  let lease: string | null = null;
  const commits: WorldCommit[] = [];
  let mainSha: string | null = script.landings[0]?.mainBefore ?? null;
  const counts = { tasks: 0, plans: 0, checks: 0, requests: 0, acks: 0, tests: 0, merges: 0 };
  const dequeue = (id?: string) => {
    if (!id) return;
    const n = queue.indexOf(id);
    if (n >= 0) queue.splice(n, 1);
  };
  const setTask = (id: string | undefined, s: TaskState) => {
    if (!id || !taskState.has(id)) return;
    if (taskState.get(id) === "merged" && s !== "merged") return;
    taskState.set(id, s);
  };

  for (let i = 0; i <= last; i++) {
    const s = script.steps[i];
    const v = s.attemptId ? live.get(s.attemptId) : undefined;
    const touch = (patch: Partial<Live>) => v && Object.assign(v, patch, { updatedAt: s.at });
    switch (s.kind) {
      case "task":
        if (s.intentId) {
          taskState.set(s.intentId, "open");
          taskAt.set(s.intentId, s.at);
        }
        counts.tasks++;
        break;
      case "plan":
        if (s.attemptId) {
          live.set(s.attemptId, { status: "declared", track: [], failing: false, checked: false, updatedAt: s.at, hidden: false });
          // The work copy that this one redoes leaves the map.
          for (const [old, redo] of script.redoOf) if (redo === s.attemptId && live.has(old)) live.get(old)!.hidden = true;
        }
        setTask(s.intentId, "working");
        counts.plans++;
        break;
      case "check":
        if (s.check) {
          touch({ checked: true, lastVerdict: s.check.verdict });
          for (const f of s.check.facts ?? []) pairs.set(pairKey(s.check.attemptId, f.otherAttemptId), { a: s.check.attemptId, b: f.otherAttemptId, range: f.range, closing: f.closing, verdict: s.check.verdict });
        }
        counts.checks++;
        break;
      case "request":
        if (s.correction) issued.push(s.correction);
        counts.requests++;
        break;
      case "ack": {
        const id = s.detail ?? issued.filter((c) => c.attemptId === s.attemptId && !acked.has(c.id)).pop()?.id;
        if (id) acked.add(id);
        counts.acks++;
        break;
      }
      case "work":
        if (v) {
          for (const f of s.files ?? []) if (v.track[v.track.length - 1] !== f) v.track.push(f);
          if (v.status === "declared") v.status = "underway";
          touch({});
        }
        break;
      case "tests":
        if (s.tests && !s.tests.waits) {
          touch({ failing: !s.tests.ok });
          counts.tests++;
        }
        break;
      case "submit":
        if (s.submit === "fix") touch({ status: "underway", failing: true });
        else {
          touch({ status: "ready", failing: false });
          if (s.submit === "queue" && s.attemptId && !queue.includes(s.attemptId)) queue.push(s.attemptId);
        }
        break;
      case "decision":
        if (s.attemptId && v?.status === "ready" && /chooses|says yes/.test(s.caption) && !queue.includes(s.attemptId)) queue.push(s.attemptId);
        break;
      case "lease":
        dequeue(s.attemptId);
        lease = s.attemptId ?? null;
        touch({ status: "landing" });
        break;
      case "composed":
        if (s.tests && !s.tests.ok) {
          lease = null;
          touch({ status: "stale" });
        }
        counts.tests++;
        break;
      case "commit":
        if (s.landing) {
          mainSha = s.landing.mainAfter;
          commits.push({ sha: s.landing.mainAfter, title: script.intents.get(s.landing.intentId)?.title ?? "a task", method: s.landing.method, attemptId: s.landing.attemptId, at: s.at });
        }
        dequeue(s.attemptId);
        if (lease === s.attemptId) lease = null;
        touch({ status: "landed" });
        setTask(s.intentId, "merged");
        // Corrections that this work applied count as answered at the merge.
        for (const c of issued) if (c.attemptId === s.attemptId) acked.add(c.id);
        counts.merges++;
        break;
      case "stale":
        dequeue(s.attemptId);
        if (lease === s.attemptId) lease = null;
        touch({ status: "stale" });
        break;
      case "end":
        dequeue(s.attemptId);
        touch({ status: s.attemptId ? (script.attempts.get(s.attemptId)?.status ?? "abandoned") : "abandoned" });
        break;
      case "note":
        if (/ pauses /.test(s.caption)) setTask(s.intentId, "paused");
        break;
      default:
        break;
    }
  }

  const at = last >= 0 ? script.steps[last].at : script.start;
  const shown = [...live.entries()].filter(([, l]) => SHOWN.has(l.status) && !l.hidden);
  const shownIds = new Set(shown.map(([id]) => id));

  // Pairs with a change request between them show as corrected (magenta) on the map.
  const corrected = new Set(issued.filter((c) => c.standOnAttemptId).map((c) => pairKey(c.attemptId, c.standOnAttemptId!)));
  const linksBy = new Map<string, RangeLink[]>();
  const ranges: RangeLine[] = [];
  for (const [key, p] of pairs) {
    if (!shownIds.has(p.a) || !shownIds.has(p.b)) continue;
    const isCorrected = corrected.has(key);
    const add = (from: string, to: string) => linksBy.set(from, [...(linksBy.get(from) ?? []), { other: to, range: p.range, closing: p.closing, verdict: p.verdict, corrected: isCorrected }]);
    add(p.a, p.b);
    add(p.b, p.a);
    if (p.range <= 2) ranges.push({ key, a: p.a, b: p.b, range: p.range, closing: p.closing, tone: rangeTone(p.range, isCorrected), label: `${RANGE_TEXT[p.range]}${p.closing ? " · closer now" : ""}` });
  }

  // The newest change request of a work copy replaces the older ones that it supersedes.
  const latestFor = new Map<string, Correction>();
  for (const c of issued) latestFor.set(c.attemptId, c);
  const correctionsBy = new Map<string, Correction[]>();
  for (const c of issued) {
    if (c.status === "superseded" && latestFor.get(c.attemptId) !== c) continue;
    correctionsBy.set(c.attemptId, [...(correctionsBy.get(c.attemptId) ?? []), { ...c, status: acked.has(c.id) ? "acknowledged" : "delivered" }]);
  }

  const vessels: VesselModel[] = shown
    .map(([id, l]) => {
      const a = script.attempts.get(id)!;
      const agent = script.agents.get(a.agentId);
      const color = agent?.color ?? 0;
      return {
        attemptId: id,
        agentId: a.agentId,
        callsign: agent?.callsign ?? "AGENT",
        model: agent?.model ?? agent?.client ?? "unknown",
        client: agent?.client,
        kind: agent?.kind ?? "builtin",
        color,
        hull: hullName(color),
        intentId: a.intentId,
        intentTitle: script.intents.get(a.intentId)?.title ?? "a task",
        status: l.status,
        generation: a.lineage?.generation ?? 1,
        file: l.track.length ? l.track[l.track.length - 1] : null,
        track: [...l.track],
        course: (a.course?.files ?? []).filter((f) => !l.track.includes(f)),
        courseFiles: a.course?.files ?? [],
        checked: l.checked,
        failing: l.failing,
        lastVerdict: l.lastVerdict,
        corrections: correctionsBy.get(id) ?? [],
        ranges: (linksBy.get(id) ?? []).sort((x, y) => x.range - y.range),
        updatedAt: l.updatedAt,
      } satisfies VesselModel;
    })
    .sort((x, y) => (script.attempts.get(x.attemptId)!.createdAt - script.attempts.get(y.attemptId)!.createdAt));

  const byId = new Map(vessels.map((v) => [v.attemptId, v]));
  const buoys: WorldBuoy[] = [];
  for (const v of vessels) {
    for (const c of v.corrections) {
      const file = correctionFile(c, script.attempts.get(c.attemptId), script.checks.get(c.checkId));
      if (!file) continue;
      buoys.push({ id: c.id, attemptId: c.attemptId, file, kind: c.kind, done: c.status === "acknowledged", correction: c, callsign: v.callsign, fromCallsign: c.standOnAttemptId ? byId.get(c.standOnAttemptId)?.callsign : undefined });
    }
  }

  const tasks: WorldTask[] = [...taskState.entries()]
    .map(([id, state]) => ({ id, title: script.intents.get(id)?.title ?? "a task", state, at: taskAt.get(id) ?? 0 }))
    .sort((x, y) => x.at - y.at);

  return { index: last, at, tasks, vessels, ranges, buoys, queue, lease, mainSha, commits, counts };
}
