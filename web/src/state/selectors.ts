/**
 * Derived views of ProjectState. Every selector is memoized on the identity of the
 * slices it reads, so it recomputes only when those slices change.
 */
import type {
  AgentInfo,
  Attempt,
  AttemptStatus,
  Correction,
  CourseCheck,
  Decision,
  Intent,
  IntentStatus,
  Landing,
  LogEntry,
  ProjectState,
  RadarPair,
  Range,
  Verdict,
} from "../../../src/core/types";
import { hullName, type HullName } from "../design/icons";
import { RANGE_TEXT } from "./format";

/* ───────────── memo helpers ───────────── */

export function memo<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let lastArgs: A | null = null;
  let last: R;
  return (...args: A) => {
    if (lastArgs && lastArgs.length === args.length && args.every((a, i) => Object.is(a, lastArgs![i]))) return last;
    lastArgs = args;
    last = fn(...args);
    return last;
  };
}

const idCache = new WeakMap<object, Map<string, unknown>>();
export function byId<T extends { id: string }>(arr: T[]): Map<string, T> {
  let m = idCache.get(arr) as Map<string, T> | undefined;
  if (!m) {
    m = new Map(arr.map((x) => [x.id, x]));
    idCache.set(arr, m);
  }
  return m;
}

/* ───────────── statuses ───────────── */

export const ACTIVE_STATUSES: AttemptStatus[] = [
  "declared",
  "underway",
  "submitted",
  "checking",
  "ready",
  "landing",
  "stale",
  "rederiving",
];

export function isActiveAttempt(a: Attempt): boolean {
  return ACTIVE_STATUSES.includes(a.status);
}

export const vesselColor = (index: number) => `var(--v${((index % 12) + 12) % 12})`;

/* ───────────── indexes ───────────── */

export interface Indexes {
  intentById: Map<string, Intent>;
  attemptById: Map<string, Attempt>;
  agentById: Map<string, AgentInfo>;
  attemptsByIntent: Map<string, Attempt[]>;
  correctionsByAttempt: Map<string, Correction[]>;
  checksByAttempt: Map<string, CourseCheck[]>;
  checkById: Map<string, CourseCheck>;
  landingByAttempt: Map<string, Landing>;
  decisionsByIntent: Map<string, Decision[]>;
}

const indexesMemo = memo(
  (
    intents: Intent[],
    attempts: Attempt[],
    agents: AgentInfo[],
    corrections: Correction[],
    checks: CourseCheck[],
    landings: Landing[],
    decisions: Decision[],
  ): Indexes => {
    const attemptsByIntent = new Map<string, Attempt[]>();
    for (const a of [...attempts].sort((x, y) => x.createdAt - y.createdAt)) {
      const list = attemptsByIntent.get(a.intentId) ?? [];
      list.push(a);
      attemptsByIntent.set(a.intentId, list);
    }
    const correctionsByAttempt = new Map<string, Correction[]>();
    for (const c of corrections) {
      const list = correctionsByAttempt.get(c.attemptId) ?? [];
      list.push(c);
      correctionsByAttempt.set(c.attemptId, list);
    }
    const checksByAttempt = new Map<string, CourseCheck[]>();
    for (const c of checks) {
      const list = checksByAttempt.get(c.attemptId) ?? [];
      list.push(c);
      checksByAttempt.set(c.attemptId, list);
    }
    const decisionsByIntent = new Map<string, Decision[]>();
    for (const d of decisions) {
      const list = decisionsByIntent.get(d.intentId) ?? [];
      list.push(d);
      decisionsByIntent.set(d.intentId, list);
    }
    return {
      intentById: byId(intents),
      attemptById: byId(attempts),
      agentById: byId(agents),
      attemptsByIntent,
      correctionsByAttempt,
      checksByAttempt,
      checkById: byId(checks),
      landingByAttempt: new Map(landings.map((l) => [l.attemptId, l])),
      decisionsByIntent,
    };
  },
);

export function indexes(st: ProjectState): Indexes {
  return indexesMemo(st.intents, st.attempts, st.agents, st.corrections, st.checks, st.landings, st.decisions);
}

/* ───────────── active work (map + list) ───────────── */

export interface RangeLink {
  other: string;
  range: Range;
  closing: boolean;
  verdict?: Verdict;
  corrected: boolean;
}

export interface VesselModel {
  attemptId: string;
  agentId: string;
  callsign: string;
  model: string;
  client?: string;
  kind: AgentInfo["kind"];
  color: number;
  hull: HullName;
  intentId: string;
  intentTitle: string;
  status: AttemptStatus;
  generation: number;
  /** File the vessel works on now; null = offshore (declared, no edits yet). */
  file: string | null;
  /** Files touched, in order (the wake). */
  track: string[];
  /** Declared files not touched yet (the course ahead). */
  course: string[];
  courseFiles: string[];
  /** A course check has answered at least once. */
  checked: boolean;
  /** The last check run failed and the vessel works on a fix. */
  failing: boolean;
  lastVerdict?: Verdict;
  corrections: Correction[];
  ranges: RangeLink[];
  updatedAt: number;
}

const MOVE_KINDS = new Set<LogEntry["kind"]>(["write", "log", "push"]);

const tracksMemo = memo((logs: LogEntry[]) => {
  const m = new Map<string, string[]>();
  for (const l of logs) {
    if (!l.attemptId || !l.files?.length || !MOVE_KINDS.has(l.kind)) continue;
    const t = m.get(l.attemptId) ?? [];
    for (const f of l.files) if (t[t.length - 1] !== f) t.push(f);
    m.set(l.attemptId, t);
  }
  return m;
});

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function correctedPairs(corrections: Correction[]): Set<string> {
  const s = new Set<string>();
  for (const c of corrections) {
    if (c.status === "superseded" || !c.standOnAttemptId) continue;
    s.add(pairKey(c.attemptId, c.standOnAttemptId));
  }
  return s;
}

const vesselsMemo = memo(
  (
    attempts: Attempt[],
    agents: AgentInfo[],
    intents: Intent[],
    logs: LogEntry[],
    corrections: Correction[],
    radar: RadarPair[],
    checks: CourseCheck[],
  ): VesselModel[] => {
    const agentById = byId(agents);
    const intentById = byId(intents);
    const tracks = tracksMemo(logs);
    const rederivedFrom = new Set(attempts.map((a) => a.lineage.rederivedFrom).filter(Boolean) as string[]);
    const active = attempts.filter(
      (a) => isActiveAttempt(a) && !(a.status === "stale" && rederivedFrom.has(a.id)),
    );
    const activeIds = new Set(active.map((a) => a.id));
    const corrected = correctedPairs(corrections);

    const linksBy = new Map<string, RangeLink[]>();
    for (const p of radar) {
      if (!activeIds.has(p.a) || !activeIds.has(p.b)) continue;
      const c = corrected.has(pairKey(p.a, p.b));
      const push = (from: string, to: string) => {
        const list = linksBy.get(from) ?? [];
        list.push({ other: to, range: p.range, closing: p.closing, verdict: p.verdict, corrected: c });
        linksBy.set(from, list);
      };
      push(p.a, p.b);
      push(p.b, p.a);
    }

    const lastCheck = new Map<string, CourseCheck>();
    for (const c of checks) {
      const prev = lastCheck.get(c.attemptId);
      if (!prev || prev.at <= c.at) lastCheck.set(c.attemptId, c);
    }
    const corrBy = new Map<string, Correction[]>();
    for (const c of corrections) {
      const list = corrBy.get(c.attemptId) ?? [];
      list.push(c);
      corrBy.set(c.attemptId, list);
    }

    return active
      .sort((x, y) => x.createdAt - y.createdAt)
      .map((a) => {
        const agent = agentById.get(a.agentId);
        const intent = intentById.get(a.intentId);
        const fromLogs = tracks.get(a.id) ?? [];
        const fp = Object.keys(a.footprint?.files ?? {});
        const track = [...fp.filter((f) => !fromLogs.includes(f)), ...fromLogs];
        const color = agent?.color ?? 0;
        const check = lastCheck.get(a.id);
        return {
          attemptId: a.id,
          agentId: a.agentId,
          callsign: agent?.callsign ?? a.agentId.toUpperCase(),
          model: agent?.model ?? agent?.client ?? "unknown",
          client: agent?.client,
          kind: agent?.kind ?? "builtin",
          color,
          hull: hullName(color),
          intentId: a.intentId,
          intentTitle: intent?.title ?? "Unknown task",
          status: a.status,
          generation: a.lineage?.generation ?? 1,
          file: track.length ? track[track.length - 1] : null,
          track,
          course: a.course.files.filter((f) => !track.includes(f)),
          courseFiles: a.course.files,
          checked: Boolean(check),
          failing: Boolean(a.checks && !a.checks.ok && a.status === "underway"),
          lastVerdict: check?.verdict,
          corrections: (corrBy.get(a.id) ?? []).sort((x, y) => x.createdAt - y.createdAt),
          ranges: (linksBy.get(a.id) ?? []).sort((x, y) => x.range - y.range),
          updatedAt: a.updatedAt,
        } satisfies VesselModel;
      });
  },
);

export function selectVessels(st: ProjectState): VesselModel[] {
  return vesselsMemo(st.attempts, st.agents, st.intents, st.logs, st.corrections, st.radar, st.checks);
}

/* ───────────── distance lines + change-request markers (map) ───────────── */

export type RangeTone = "caution" | "correction" | "danger" | "neutral";

export interface RangeLine {
  key: string;
  a: string;
  b: string;
  range: Range;
  closing: boolean;
  tone: RangeTone;
  label: string;
}

export function rangeTone(range: Range, corrected: boolean): RangeTone {
  if (corrected) return "correction";
  if (range === 0) return "danger";
  if (range <= 3) return "caution";
  return "neutral";
}

const rangeLinesMemo = memo((vessels: VesselModel[]): RangeLine[] => {
  const out: RangeLine[] = [];
  const seen = new Set<string>();
  for (const v of vessels) {
    for (const r of v.ranges) {
      if (r.range > 2) continue;
      const key = pairKey(v.attemptId, r.other);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        a: v.attemptId,
        b: r.other,
        range: r.range,
        closing: r.closing,
        tone: rangeTone(r.range, r.corrected),
        label: `${RANGE_TEXT[r.range]}${r.closing ? " · moving closer" : ""}`,
      });
    }
  }
  return out;
});

export function selectRangeLines(st: ProjectState): RangeLine[] {
  return rangeLinesMemo(selectVessels(st));
}

export interface BuoyModel {
  id: string;
  attemptId: string;
  file: string;
  correction: Correction;
  callsign: string;
  fromCallsign?: string;
}

export function correctionFile(c: Correction, attempt?: Attempt, check?: CourseCheck): string | null {
  const region = c.constraints.avoidRegions?.[0]?.path;
  if (region) return region;
  const sig = c.constraints.useSignatures?.[0]?.symbol;
  if (sig) {
    // The buoy marks where the give-way vessel must adapt: its own use site if known.
    const usedAt = check?.facts.flatMap((f) => f.interfaceHits).find((h) => h.symbol === sig)?.usedAt?.[0];
    if (usedAt) return usedAt.split("#")[0].split(":")[0];
    const shared = attempt?.course.files.find((f) => f !== sig.split("#")[0]);
    return shared ?? sig.split("#")[0];
  }
  const facts = check?.facts.find((f) => f.otherAttemptId === c.standOnAttemptId);
  if (facts?.sharedFiles[0]) return facts.sharedFiles[0];
  return attempt?.course.files[0] ?? null;
}

const buoysMemo = memo((vessels: VesselModel[], checks: CourseCheck[], attempts: Attempt[]): BuoyModel[] => {
  const byAttempt = new Map(vessels.map((v) => [v.attemptId, v]));
  const checkById = byId(checks);
  const attemptById = byId(attempts);
  const out: BuoyModel[] = [];
  for (const v of vessels) {
    for (const c of v.corrections) {
      if (c.status === "superseded") continue;
      const file = correctionFile(c, attemptById.get(c.attemptId), checkById.get(c.checkId));
      if (!file) continue;
      const from = c.standOnAttemptId ? byAttempt.get(c.standOnAttemptId) : undefined;
      out.push({ id: c.id, attemptId: c.attemptId, file, correction: c, callsign: v.callsign, fromCallsign: from?.callsign });
    }
  }
  return out;
});

export function selectBuoys(st: ProjectState): BuoyModel[] {
  return buoysMemo(selectVessels(st), st.checks, st.attempts);
}

/* ───────────── decisions ───────────── */

export interface JudgmentItem {
  key: string;
  kind: "pick" | "escalation";
  intentId: string;
  title: string;
  detail: string;
  attemptIds: string[];
  at: number;
}

const queueMemo = memo((intents: Intent[], attempts: Attempt[], checks: CourseCheck[], agents: AgentInfo[]): JudgmentItem[] => {
  const out: JudgmentItem[] = [];
  const agentById = byId(agents);
  for (const i of intents) {
    if (i.status !== "judging") continue;
    const ready = attempts.filter((a) => a.intentId === i.id && a.status === "ready");
    if (!ready.length) {
      // No work copy is ready: the work could not merge, or its agent did not answer.
      const open = attempts.filter((a) => a.intentId === i.id && isActiveAttempt(a));
      out.push({
        key: `stuck:${i.id}`,
        kind: "escalation",
        intentId: i.id,
        title: i.title,
        detail: "The work could not merge. Redo it on the new main, or pause the task",
        attemptIds: open.map((a) => a.id),
        at: i.updatedAt,
      });
      continue;
    }
    out.push({
      key: `pick:${i.id}`,
      kind: "pick",
      intentId: i.id,
      title: i.title,
      detail: `Choose 1 of ${ready.length} ready work copies`,
      attemptIds: ready.map((a) => a.id),
      at: i.updatedAt,
    });
  }
  const latest = new Map<string, CourseCheck>();
  for (const c of checks) {
    const p = latest.get(c.attemptId);
    if (!p || p.at <= c.at) latest.set(c.attemptId, c);
  }
  const attemptById = byId(attempts);
  for (const c of latest.values()) {
    if (c.verdict !== "escalate") continue;
    const a = attemptById.get(c.attemptId);
    if (!a || !isActiveAttempt(a)) continue;
    const intent = intents.find((i) => i.id === a.intentId);
    out.push({
      key: `esc:${c.id}`,
      kind: "escalation",
      intentId: a.intentId,
      title: intent?.title ?? "A decision needs a person",
      detail: `Decide on the work of ${agentById.get(a.agentId)?.callsign ?? a.agentId}`,
      attemptIds: [a.id],
      at: c.at,
    });
  }
  return out.sort((x, y) => x.at - y.at);
});

export function selectJudgmentQueue(st: ProjectState): JudgmentItem[] {
  return queueMemo(st.intents, st.attempts, st.checks, st.agents);
}

/* ───────────── intents ───────────── */

export const INTENT_GROUPS: { id: string; label: string; statuses: IntentStatus[] }[] = [
  { id: "judging", label: "Needs a choice", statuses: ["judging"] },
  { id: "underway", label: "Working", statuses: ["underway", "landing"] },
  { id: "open", label: "Open", statuses: ["open", "draft"] },
  { id: "landed", label: "Merged", statuses: ["landed"] },
  { id: "parked", label: "Paused", statuses: ["parked", "merged-into"] },
];

export interface IntentGroup {
  id: string;
  label: string;
  intents: Intent[];
}

const groupsMemo = memo((intents: Intent[]): IntentGroup[] =>
  INTENT_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    intents: intents
      .filter((i) => g.statuses.includes(i.status))
      .sort((a, b) => (g.id === "landed" ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt)),
  })).filter((g) => g.intents.length > 0),
);

export function selectIntentGroups(st: ProjectState): IntentGroup[] {
  return groupsMemo(st.intents);
}

/* ───────────── history ───────────── */

export interface LogbookRow {
  landing: Landing;
  intent?: Intent;
  attempt?: Attempt;
  agent?: AgentInfo;
  corrections: number;
}

const logbookMemo = memo((landings: Landing[], intents: Intent[], attempts: Attempt[], agents: AgentInfo[]): LogbookRow[] => {
  const ib = byId(intents);
  const ab = byId(attempts);
  const gb = byId(agents);
  return [...landings]
    .sort((a, b) => b.at - a.at)
    .map((l) => {
      const attempt = ab.get(l.attemptId);
      return {
        landing: l,
        intent: ib.get(l.intentId),
        attempt,
        agent: gb.get(l.agentId),
        corrections: l.correctionsApplied ?? attempt?.corrections.length ?? 0,
      };
    });
});

export function selectLogbook(st: ProjectState): LogbookRow[] {
  return logbookMemo(st.landings, st.intents, st.attempts, st.agents);
}

/* ───────────── misc ───────────── */

export function latestCheckFor(st: ProjectState, attemptId: string): CourseCheck | undefined {
  const list = indexes(st).checksByAttempt.get(attemptId) ?? [];
  return list.reduce<CourseCheck | undefined>((m, c) => (!m || c.at >= m.at ? c : m), undefined);
}

export function checkForCorrection(st: ProjectState, c: Correction): CourseCheck | undefined {
  return indexes(st).checkById.get(c.checkId);
}

export function assessmentFor(check: CourseCheck | undefined, otherAttemptId: string | undefined) {
  if (!check) return undefined;
  return check.assessments.find((a) => a.otherAttemptId === otherAttemptId) ?? check.assessments[0];
}

export function factsFor(check: CourseCheck | undefined, otherAttemptId: string | undefined) {
  if (!check) return undefined;
  return check.facts.find((f) => f.otherAttemptId === otherAttemptId) ?? check.facts[0];
}
