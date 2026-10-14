/**
 * Small pure helpers of the project coordinator: names, paths, pairs, empty values and one-line error texts.
 * Imported by the layers in ../master/. Never read or write the database from here.
 */
import type * as T from "../../core/types";
import { type SnapshotChange } from "../../core/git/snapshot";
import { SOFT_PAIR_CAP, isSoftPair } from "../../core/coord";

/** An error as one line for the log. The log of the platform shows only the stack of an error object, and the message is the part that tells what happened. */
export function errorLine(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  const name = typeof e?.name === "string" && e.name ? e.name : "Error";
  return `${name}: ${(typeof e?.message === "string" ? e.message : String(err)).slice(0, 300)}`;
}
/** The lines that a "same lines" change request names, as one text. Empty for any other kind of change request. */
export function regionKey(c: { kind: T.CorrectionKind; constraints: T.Correction["constraints"] }): string {
  const regions = c.constraints.avoidRegions;
  if (c.kind !== "region" || !regions?.length) return "";
  return regions.map((r) => `${r.path}:${r.lines[0]}-${r.lines[1]}`).sort().join("|");
}

/** HH:MM in UTC, for log lines. */
export function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

export const SYSTEM: T.Actor = { kind: "system", id: "gitring", name: "gitring" };
export const HUMAN: T.Actor = { kind: "human", id: "human", name: "Human" };

export function emptyStats(): T.HarborStats {
  return {
    courseChecks: 0,
    clear: 0,
    corrections: 0,
    correctionsAcknowledged: 0,
    escalations: 0,
    landings: 0,
    landedByMethod: { "fast-forward": 0, merge: 0, rederive: 0, revert: 0 },
    rederives: 0,
    medianCheckLatencyMs: 0,
  };
}

/** The person behind an action, for `sender`. Absent for the system, a script with no person, and a name that is not an account. */
export function personOf(by: T.Actor | undefined): T.Person | undefined {
  if (!by || by.kind !== "human" || !by.id || by.id === "human" || by.id === "anonymous") return undefined;
  return { id: by.id, name: by.name };
}

/** Why a question closes, by the new state of the work copy. */
export function closedBecause(status: T.AttemptStatus): string {
  switch (status) {
    case "alternate":
      return "Another work copy of this task merged first.";
    case "landed":
      return "The work is on main.";
    case "abandoned":
      return "The work copy stopped.";
    case "stale":
    case "failed":
      return "The work cannot merge on the new main.";
    case "rederiving":
      return "The work is done again on the new main.";
    default:
      return "The agent changed the work.";
  }
}

export function emptyFootprint(): T.Footprint {
  return { files: {}, symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] }, computedAt: Date.now() };
}

export function normPath(p: string): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

/** Severity of a pair situation: closer range, overlapping lines and interface hits weigh more. */
export function severityOf(f: T.PairFacts): number {
  return (5 - f.range) * 10 + Math.min(5, f.hunkOverlaps.length) * 3 + Math.min(3, f.interfaceHits.length) * 6 + (f.closing ? 2 : 0);
}

export function normDir(p: string): string {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function sortPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Clef judges; facts anchor. Hard evidence sets a floor; no evidence sets a ceiling. */
export function anchor(model: T.CourseAssessment, rules: T.CourseAssessment, facts: T.PairFacts): T.CourseAssessment {
  const hard = facts.range === 0 || facts.interfaceHits.length > 0;
  const soft = isSoftPair(facts);
  let collision = model.collision;
  let interference = model.interference;
  if (hard) {
    collision = Math.max(collision, rules.collision * 0.95);
    interference = Math.max(interference, rules.interference * 0.95);
  }
  if (soft) {
    collision = Math.min(collision, SOFT_PAIR_CAP.collision);
    interference = Math.min(interference, SOFT_PAIR_CAP.interference);
  }
  const giveWayConfidence = model.giveWay === rules.giveWay ? Math.max(rules.giveWayConfidence, model.giveWayConfidence) : model.giveWayConfidence;
  return { ...model, collision: round(collision), interference: round(interference), giveWayConfidence: round(giveWayConfidence) };
}

export function decisiveness(as: T.CourseAssessment[]): number {
  return as.length ? Math.min(...as.map((a) => Math.abs(a.collision - 0.5) * 2)) : 1;
}

export function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** A short git-style note for a change without text: a binary file, or a new mode. */
export function opaqueDiff(c: SnapshotChange): string {
  if (c.status === "M" && c.oldSha === c.newSha) return `Mode changes to ${c.mode}.`;
  if (c.status === "D") return "Binary or large file deleted.";
  return c.mode === "120000" ? "Symbolic link." : "Binary or large file.";
}
