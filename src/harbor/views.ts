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
import { applyFileChanges, diffSnapshots, pathProblem, type Snapshot, type SnapshotChange } from "../core/git/snapshot";
import type { ImportGraph } from "../core/analysis/graph";
import { analyzeModule, isAnalyzable } from "../core/analysis/symbols";
import { analyzeFootprint, type FileVersions } from "../core/analysis/footprint";
import type { SignatureInfo } from "../core/analysis/range";
import { buildVesselView, type VesselView } from "../core/coord/facts";
import type { NotCarried } from "../core/land/carry";
import { diffHunks, normalizeNewlines } from "../core/text/diff";

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
  /** Changed paths with base/head versions (text changes only; see `opaque`). */
  changed: FileVersions[];
  signatures: Record<SymbolKey, SignatureInfo>;
  /**
   * The whole tree that merges: the real entry (blob id, mode) of every file, text or not. In git mode it
   * is the tree of the last push (plus shadow edits); in api mode the base plus the written files. Parts of
   * the work that gitring does not merge (`notCarried`) keep their base entry here.
   */
  snapshot: Snapshot;
  /** The repository that holds the blobs of the work (the work copy's fork in git mode, else main's). */
  repo: string;
  /** Blobs that exist only as text in gitring (api-mode writes, shadow edits): blob id → text. */
  textBlobs: Map<string, string>;
  /** Changes without a text change: binary or large files, files in opaque folders, mode changes. */
  opaque: SnapshotChange[];
  /** Parts of the work that do not merge (see core/land/carry). */
  notCarried: NotCarried[];
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

/**
 * Text changes of `paths`. With `trees`, a path that exists on one side without text there (a binary or
 * large file, a file past the text limits) is not a text change: it is not a delete or an add of text.
 * `opaqueChanges` lists such paths.
 */
export function changedVersions(
  base: Map<string, string>,
  files: Map<string, string>,
  paths: Iterable<string>,
  trees?: { base: Snapshot; head: Snapshot },
): FileVersions[] {
  const out: FileVersions[] = [];
  for (const path of new Set(paths)) {
    const b = base.has(path) ? base.get(path)! : null;
    const h = files.has(path) ? files.get(path)! : null;
    if (b === h) continue;
    if (trees && ((b === null && trees.base.has(path)) || (h === null && trees.head.has(path)))) continue;
    out.push({ path, base: b, head: h });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Entry changes from `base` to `head` that are not text changes: binary, large or opaque files, and mode changes. */
export function opaqueChanges(base: Snapshot, head: Snapshot, changed: FileVersions[]): SnapshotChange[] {
  const text = new Set(changed.map((c) => c.path));
  return diffSnapshots(base, head).filter((c) => !text.has(c.path));
}

/**
 * A text tree with text written on top (`null` deletes), as real entries: each text becomes a blob id.
 * `textBlobs` maps those blob ids to their text, so a merge can read blobs that exist in no repository yet.
 */
export async function overlaySnapshot(tree: Snapshot, overlay: Map<string, string | null>): Promise<{ snapshot: Snapshot; textBlobs: Map<string, string> }> {
  // A path that git cannot hold (".git/x", "a//b") cannot merge: it stays out of the tree.
  const changes = [...overlay].filter(([path]) => !pathProblem(path)).map(([path, content]) => ({ path, content }));
  const { snapshot, blobs } = await applyFileChanges(tree, changes);
  const textBlobs = new Map<string, string>();
  for (const [path, content] of overlay) {
    const e = content === null ? undefined : snapshot.get(path);
    if (e && blobs.has(e.sha)) textBlobs.set(e.sha, content!);
  }
  return { snapshot, textBlobs };
}

/** Lines with their "\n" (the last one may lack it), as the line diff counts them. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const parts = normalizeNewlines(text).split("\n");
  const out = parts.slice(0, -1).map((l) => `${l}\n`);
  if (parts[parts.length - 1] !== "") out.push(parts[parts.length - 1]);
  return out;
}

/**
 * The agent's own contribution, without line numbers and without the text around it: per text change the
 * removed and added lines of each change block, per other change the new entry. A person says yes to this.
 * When gitring merges main into the work and the agent's blocks stay the same, the rows stay the same.
 */
export function contributionRows(changed: FileVersions[], opaque: SnapshotChange[]): string[] {
  const rows: string[] = [];
  for (const c of changed) {
    if (c.head === null) {
      rows.push(`${c.path}\0delete`);
      continue;
    }
    if (c.base === null) {
      rows.push(`${c.path}\0add\0${c.head}`);
      continue;
    }
    const hunks = diffHunks(c.base, c.head);
    if (!hunks.length) {
      // Only the line ends changed: the new text is the change.
      rows.push(`${c.path}\0text\0${c.head}`);
      continue;
    }
    const before = linesOf(c.base);
    const after = linesOf(c.head);
    for (const h of hunks) {
      const removed = h.oldLines ? before.slice(h.oldStart - 1, h.oldStart - 1 + h.oldLines).join("") : "";
      const added = h.newLines ? after.slice(h.newStart - 1, h.newStart - 1 + h.newLines).join("") : "";
      rows.push(`${c.path}\0-${removed}\0+${added}`);
    }
  }
  for (const o of [...opaque].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    rows.push(o.status === "D" ? `${o.path}\0delete` : `${o.path}\0${o.mode}\0${o.newSha}`);
  }
  return rows;
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
