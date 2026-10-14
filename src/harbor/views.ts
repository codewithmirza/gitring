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
import { diffSnapshots, pathProblem, type Snapshot, type SnapshotChange } from "../core/git/snapshot";
import { hashObject, utf8 } from "../core/git/objects";
import { extendGraph, type ImportGraph } from "../core/analysis/graph";
import { analyzeModule, isAnalyzable, type PathAliases } from "../core/analysis/symbols";
import { analyzeFootprint, type FileVersions, type FootprintOptions } from "../core/analysis/footprint";
import type { NameIndex, SignatureInfo } from "../core/analysis/range";
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
  /** Signatures of top-level functions and of class and object methods on main: `path#name` → `name(params)`. */
  signatures: Record<SymbolKey, string>;
  /** The names that main defines → their files (members as `Owner.name`). Places plan symbols without a path. */
  definedIn: Record<string, string[]>;
  /** The path aliases of tsconfig.json or jsconfig.json on main. */
  aliases?: PathAliases;
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
  /** Import edges of the changed and new files (their text in the work copy). */
  imports?: [string, string][];
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
  return symbolIndex(text).signatures;
}

/**
 * One pass over a set of files: the signatures of functions and methods (`path#name` → `name(params)`),
 * and the files that define each name. A member counts as `Owner.name` and, for an owner that is
 * exported under another name, as `Alias.name` too (`default.add` for `export default class Cart`).
 */
export function symbolIndex(text: Map<string, string>): { signatures: Record<SymbolKey, string>; definedIn: Record<string, string[]> } {
  const signatures: Record<SymbolKey, string> = {};
  // No prototype: a name such as "__proto__" or "constructor" is data here.
  const definedIn = Object.create(null) as Record<string, string[]>;
  const define = (name: string, path: string): void => {
    const list = Object.hasOwn(definedIn, name) ? definedIn[name] : (definedIn[name] = []);
    if (!list.includes(path)) list.push(path);
  };
  for (const [path, src] of text) {
    if (!isAnalyzable(path)) continue;
    try {
      const mod = analyzeModule(path, src);
      for (const d of Object.values(mod.decls)) {
        if (d.signature) signatures[`${path}#${d.name}`] = d.signature;
        define(d.name, path);
      }
      for (const m of Object.values(mod.members)) {
        if (m.signature) signatures[`${path}#${m.name}`] = m.signature;
        const rest = m.name.slice(m.owner.length);
        define(m.name, path);
        for (const [exported, local] of Object.entries(mod.exports)) if (local === m.owner && exported !== m.owner) define(`${exported}${rest}`, path);
      }
    } catch {
      /* analysis is best effort */
    }
  }
  return { signatures, definedIn };
}

/** True for a member key that main has (`src/cart.js#Cart.add`), from `MainView.definedIn`. */
export function knownMemberOf(definedIn: Readonly<Record<string, readonly string[]>>): (key: SymbolKey) => boolean {
  return (key) => {
    const at = key.indexOf("#");
    const name = key.slice(at + 1);
    return at > 0 && Object.hasOwn(definedIn, name) && definedIn[name].includes(key.slice(0, at));
  };
}

/**
 * The import graph of one course check: main, plus the import edges of the changed and new files of
 * the work copies in the check. An import that a work copy adds, and a file that it creates, then
 * count for the range (3 and 4) before they reach main. The files in `skip` (the check files that
 * gitring writes into each work copy) add no edges: they are not the work of an agent.
 */
export function checkGraph(main: MainView, copies: Iterable<AttemptView>, skip: ReadonlySet<string> = new Set()): ImportGraph {
  const extra: [string, string][] = [];
  for (const v of copies) for (const e of v.imports ?? []) if (!skip.has(e[0])) extra.push(e);
  // The same edges as the last check: the same graph, so that its memo of distances stays.
  const key = extra.map(([a, b]) => `${a}\u0000${b}`).sort().join("\u0001");
  const last = lastCheckGraph.get(main.graph);
  if (last && last.key === key) return last.graph;
  const graph = extendGraph(main.graph, extra);
  lastCheckGraph.set(main.graph, { key, graph });
  return graph;
}

/** The graph of the last check, per graph of main. */
const lastCheckGraph = new WeakMap<ImportGraph, { key: string; graph: ImportGraph }>();

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
 * `blobId` gives the blob id of a text; a caller with a cache answers at once (no wait for a hash).
 * A written file keeps the mode of its path (an executable stays executable).
 */
export async function overlaySnapshot(
  tree: Snapshot,
  overlay: Map<string, string | null>,
  blobId: (text: string) => string | Promise<string> = (text) => hashObject("blob", utf8.encode(text)),
): Promise<{ snapshot: Snapshot; textBlobs: Map<string, string> }> {
  const snapshot: Snapshot = new Map(tree);
  const textBlobs = new Map<string, string>();
  for (const [path, content] of overlay) {
    // A path that git cannot hold (".git/x", "a//b") cannot merge: it stays out of the tree.
    if (pathProblem(path)) continue;
    if (content === null) {
      snapshot.delete(path);
      continue;
    }
    const id = blobId(content);
    const sha = typeof id === "string" ? id : await id;
    const mode = snapshot.get(path)?.mode;
    snapshot.set(path, { sha, mode: mode === "100755" || mode === "120000" ? mode : "100644" });
    textBlobs.set(sha, content);
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

export function footprintOf(changed: FileVersions[], allFiles: Set<string>, opts: FootprintOptions = {}) {
  return analyzeFootprint(changed, allFiles, Date.now(), opts);
}

export function vesselView(
  attempt: Attempt,
  intent: Intent,
  agent: AgentInfo,
  signatures: Record<SymbolKey, SignatureInfo> | undefined,
  baseSignatures: Record<SymbolKey, string> | undefined,
  state?: VesselView["state"],
  definedIn?: NameIndex,
): VesselView {
  return buildVesselView({ attempt, intent, agent, state, signatures, baseSignatures, definedIn });
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
  "When you wait for a merge, a person, or other agents, call gitring_wait instead of a sleep.",
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
