/**
 * The agents on the map: one vessel for each active work copy, with its place, track and distance links.
 * Read by the chart, the traffic rail and the command palette.
 */
import type {
  AgentInfo,
  Attempt,
  AttemptStatus,
  Correction,
  CourseCheck,
  Intent,
  LogEntry,
  ProjectState,
  RadarPair,
  Range,
  Verdict,
} from "../../../../src/core/types";
import { hullName, type HullName } from "../../design/icons";
import { isActiveAttempt } from "./indexes";
import { byId, memo } from "./memo";

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

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

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
