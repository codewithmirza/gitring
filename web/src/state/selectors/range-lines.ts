/**
 * The distance lines between two vessels and the change-request markers (buoys) of the map.
 * Read by the chart. A line shows how close two plans are (distance 0 to 5).
 */
import type { Attempt, Correction, CourseCheck, ProjectState, Range } from "../../../../src/core/types";
import { RANGE_TEXT } from "../format";
import { byId, memo } from "./memo";
import { pairKey, selectVessels, type VesselModel } from "./vessels";

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
        label: `${RANGE_TEXT[r.range]}${r.closing ? " · closer now" : ""}`,
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
