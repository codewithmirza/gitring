/**
 * Pure helpers for the HarborMaster: tree text views, footprints, vessel views, traffic and clearance text.
 */
import type {
  AgentInfo,
  Attempt,
  AttemptStatus,
  Clearance,
  Correction,
  CorrectionNotice,
  CourseCheck,
  FileNode,
  Intent,
  LogEntry,
  Range,
  SymbolKey,
  TrafficVessel,
  Verdict,
} from "../core/types";
import type { Snapshot } from "../core/git/snapshot";
import type { ImportGraph } from "../core/analysis/graph";
import { analyzeModule, isAnalyzable } from "../core/analysis/symbols";
import { analyzeFootprint, type FileVersions } from "../core/analysis/footprint";
import type { SignatureInfo } from "../core/analysis/range";
import { buildVesselView, type VesselView } from "../core/coord/facts";

/** A tree with the text of its files (binary files have no entry in `text`). */
export interface TreeText {
  tree: string;
  snapshot: Snapshot;
  text: Map<string, string>;
}

export interface MainView extends TreeText {
  sha: string;
  files: FileNode[];
  graph: ImportGraph;
  imports: [string, string][];
  /** Signatures of top-level functions on main: `path#name` → `name(params)`. */
  signatures: Record<SymbolKey, string>;
}

export interface AttemptView {
  /** Content version; changes whenever the attempt's files change. */
  version: number;
  /** Full text tree of the attempt (base + work). */
  files: Map<string, string>;
  /** Changed paths with base/head versions. */
  changed: FileVersions[];
  signatures: Record<SymbolKey, SignatureInfo>;
}

export const ACTIVE: ReadonlySet<AttemptStatus> = new Set<AttemptStatus>([
  "declared",
  "underway",
  "submitted",
  "checking",
  "ready",
  "landing",
  "rederiving",
]);
export const WAITING: ReadonlySet<AttemptStatus> = new Set<AttemptStatus>(["submitted", "checking", "ready", "landing"]);

export function langOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "js";
  if (["ts", "tsx", "mts"].includes(ext)) return "ts";
  if (ext === "md") return "md";
  if (["json", "jsonc"].includes(ext)) return "json";
  if (ext === "css") return "css";
  if (ext === "html") return "html";
  return ext || "text";
}

export function fileNodes(snapshot: Snapshot, text: Map<string, string>): FileNode[] {
  return [...snapshot.keys()].sort().map((path) => ({ path, size: text.get(path)?.length ?? 0, lang: langOf(path) }));
}

/** Signatures of top-level functions in a set of files. */
export function signaturesOf(text: Map<string, string>): Record<SymbolKey, string> {
  const out: Record<SymbolKey, string> = {};
  const files = new Set(text.keys());
  for (const [path, src] of text) {
    if (!isAnalyzable(path)) continue;
    try {
      const mod = analyzeModule(path, src, files);
      for (const d of Object.values(mod.decls)) {
        if (d.signature) out[`${path}#${d.name}`] = d.signature;
      }
    } catch {
      /* analysis is best effort */
    }
  }
  return out;
}

/** Full text tree of an attempt from its base text plus an overlay of changes. */
export function overlayFiles(base: Map<string, string>, overlay: Map<string, string | null>): Map<string, string> {
  const files = new Map(base);
  for (const [path, content] of overlay) {
    if (content === null) files.delete(path);
    else files.set(path, content);
  }
  return files;
}

export function changedVersions(base: Map<string, string>, files: Map<string, string>, paths: Iterable<string>): FileVersions[] {
  const out: FileVersions[] = [];
  for (const path of new Set(paths)) {
    const b = base.has(path) ? base.get(path)! : null;
    const h = files.has(path) ? files.get(path)! : null;
    if (b === h) continue;
    out.push({ path, base: b, head: h });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function footprintOf(changed: FileVersions[], allFiles: Set<string>) {
  return analyzeFootprint(changed, allFiles, Date.now());
}

export function vesselView(
  attempt: Attempt,
  intent: Intent,
  agent: AgentInfo,
  signatures: Record<SymbolKey, SignatureInfo> | undefined,
  baseSignatures: Record<SymbolKey, string> | undefined,
  state?: VesselView["state"],
): VesselView {
  return buildVesselView({ attempt, intent, agent, state, signatures, baseSignatures });
}

/** Notices for an agent, from pending corrections. */
export function notices(corrections: Correction[], callsignOf: (attemptId?: string) => string | undefined): CorrectionNotice[] {
  return corrections.map((c) => ({
    id: c.id,
    kind: c.kind,
    message: c.message,
    constraints: c.constraints,
    from: callsignOf(c.standOnAttemptId),
    ...(c.alsoStandOn?.length ? { more: c.alsoStandOn.length } : {}),
  }));
}

export function trafficVessel(
  a: Attempt,
  intent: Intent | undefined,
  agent: AgentInfo | undefined,
  logs: LogEntry[],
  range: Range,
  closing: boolean,
): TrafficVessel {
  const files = [...new Set([...a.course.files, ...Object.keys(a.footprint.files)])].sort();
  const symbols = [
    ...new Set([...a.course.symbols, ...a.footprint.symbols.modified, ...a.footprint.symbols.defined, ...a.footprint.symbols.signatureChanged]),
  ].sort();
  return {
    attemptId: a.id,
    agentId: a.agentId,
    callsign: agent?.callsign ?? a.agentId,
    intentId: a.intentId,
    intentTitle: intent?.title ?? a.intentId,
    status: a.status,
    approach: a.course.approach,
    files,
    symbols: symbols.slice(0, 24),
    recentLogs: logs.slice(-4).map((l) => l.message),
    range,
    closing,
  };
}

export function adviceFor(verdict: Verdict | undefined, newCorrections: number, traffic: TrafficVessel[]): string {
  if (newCorrections > 0) {
    return `You have ${newCorrections} new change request${newCorrections > 1 ? "s" : ""}. Apply ${newCorrections > 1 ? "them" : "it"}, then call gitring_ack. Continue your work.`;
  }
  const close = traffic.filter((t) => t.range <= 2);
  if (verdict === "escalate") return "A person looks at a risk in your plan. Continue your work. gitring tells you if the plan must change.";
  if (close.length) return `Plan clear. ${close.length} other ${close.length > 1 ? "agents work" : "agent works"} near you. Read their context with gitring_traffic before you edit shared files.`;
  return "Plan clear. Continue your work.";
}

export function clearance(
  verdict: Verdict | undefined,
  fresh: CorrectionNotice[],
  traffic: TrafficVessel[],
): Clearance {
  return { verdict: verdict ?? "clear", corrections: fresh, traffic, advice: adviceFor(verdict, fresh.length, traffic) };
}

export function latestCheck(checks: CourseCheck[], attemptId: string): CourseCheck | undefined {
  for (let i = checks.length - 1; i >= 0; i--) if (checks[i].attemptId === attemptId) return checks[i];
  return undefined;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export const PROTOCOL = [
  "Call gitring_log after each important step. Name the files you touch.",
  "Read each change request in an answer. Apply it, then call gitring_ack. Continue your work.",
  "Write files with gitring_write (api mode), or push to your work copy remote (git mode). gitring reads your latest push at gitring_check and gitring_submit.",
  "Call gitring_check before gitring_submit. Do not edit the test files of other tasks.",
  "When gitring_submit says that a person must say yes, tell the person and wait. Do not change the work copy. Call gitring_status to see the answer.",
  "Read gitring_traffic before you edit a shared file. Call gitring_update when main moves.",
];

/** ASD-STE100 friendly short reason for check failures. */
export function failureSummary(cases: { file: string; name: string; ok: boolean; error?: string }[], max = 4): string {
  const failed = cases.filter((c) => !c.ok);
  if (!failed.length) return "All tests pass.";
  const lines = failed.slice(0, max).map((c) => `${c.file}: "${c.name}" fails${c.error ? `: ${c.error.split("\n")[0].slice(0, 160)}` : "."}`);
  const left = failed.length - max;
  const more = left > 0 ? ` ${left} more ${left > 1 ? "tests fail" : "test fails"}.` : "";
  return `${failed.length} ${failed.length > 1 ? "tests fail" : "test fails"}. ${lines.join(" ")}${more}`;
}
