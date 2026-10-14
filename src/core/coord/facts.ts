/**
 * Picks the work that is near a plan (candidates) and writes the exact facts of each pair.
 *
 * Called by the project coordinator. The facts are exact: the rules and the model both read them. Pure module.
 * Read `rules.ts` next.
 */

import type { AgentInfo, Attempt, AttemptStatus, Footprint, Intent, LineRange, PairFacts, Range, SymbolKey } from "../types";
import type { ImportGraph } from "../analysis/graph";
import {
  computeRange,
  hunksOverlap,
  intersectSymbols,
  isCodePath,
  shapeFromCourse,
  shapeFromFootprint,
  sharedChanges,
  sharedFiles as shapeSharedFiles,
  symbolName,
  symbolPath,
  unionShapes,
  type NameIndex,
  type SignatureInfo,
  type WorkShape,
} from "../analysis/range";

export interface VesselView {
  attempt: Attempt;
  intent: Intent;
  agent: AgentInfo;
  shape: WorkShape; // course ∪ footprint
  state: "active" | "waiting" | "landed";
  footprintSize: number; // changed lines + files, for R6
}

/** At most this many candidates go into one decision (3 questions each → ≤ 64 Clef questions). */
export const MAX_CANDIDATES = 20;
/** Default prefilter: range ≤ 3 (direct import). */
export const DEFAULT_MAX_RANGE: Range = 3;

/**
 * Attempt states that are not traffic any more (unless passed in explicitly as landed traffic).
 * A redo ("rederiving") is traffic: it writes code like any work copy. The stale work copy that it
 * redoes is not, and the two share one task, so they are never a pair.
 */
const OUT_OF_TRAFFIC: ReadonlySet<AttemptStatus> = new Set<AttemptStatus>([
  "landed",
  "abandoned",
  "alternate",
  "failed",
  "stale",
]);

const WAITING: ReadonlySet<AttemptStatus> = new Set<AttemptStatus>(["submitted", "checking", "ready", "landing"]);

/** The vessel state that an attempt status implies. */
export function stateOfAttempt(status: AttemptStatus): VesselView["state"] {
  if (status === "landed") return "landed";
  return WAITING.has(status) ? "waiting" : "active";
}

/** Footprint size for R6: changed lines plus files. A course-only vessel counts its declared files. */
export function footprintSize(fp: Footprint, course?: { files: string[] }): number {
  let size = 0;
  let files = 0;
  for (const touch of Object.values(fp.files ?? {})) {
    files++;
    size += (touch.additions || 0) + (touch.deletions || 0);
  }
  if (files === 0) return course?.files?.length ?? 0;
  return size + files;
}

/**
 * Helper (addition to the contract): build a VesselView from stored records.
 * shape = course ∪ footprint; state from the attempt status unless given.
 */
export function buildVesselView(args: {
  attempt: Attempt;
  intent: Intent;
  agent: AgentInfo;
  state?: VesselView["state"];
  /** Known before/after signatures of symbols the footprint changes. */
  signatures?: Record<SymbolKey, SignatureInfo>;
  /** Signatures on main, to detect declared signature changes in the course. */
  baseSignatures?: Record<SymbolKey, string>;
  /** The names that main defines, to place course symbols without a path (see qualifyBareName). */
  definedIn?: NameIndex;
}): VesselView {
  const { attempt, intent, agent } = args;
  const shape = unionShapes(shapeFromCourse(attempt.course, args.baseSignatures, args.definedIn), shapeFromFootprint(attempt.footprint, args.signatures));
  return {
    attempt,
    intent,
    agent,
    shape,
    state: args.state ?? stateOfAttempt(attempt.status),
    footprintSize: footprintSize(attempt.footprint, attempt.course),
  };
}

/* ───────────────────────────── candidates ───────────────────────────── */

function isTrafficFor(incoming: VesselView, v: VesselView): boolean {
  if (v.attempt.id === incoming.attempt.id) return false;
  // Sibling attempts of one intent compete (best-of-N); they are alternatives, not traffic.
  if (v.intent.id === incoming.intent.id) return false;
  if (v.state === "landed") return true; // landed-since-base traffic, passed in explicitly
  if (v.attempt.agentId === incoming.attempt.agentId || v.agent.id === incoming.agent.id) return false;
  return !OUT_OF_TRAFFIC.has(v.attempt.status);
}

function lookupRange(prev: ReadonlyMap<string, Range> | Readonly<Record<string, Range>> | undefined, id: string): Range | undefined {
  if (!prev) return undefined;
  if (prev instanceof Map) return prev.get(id);
  return (prev as Readonly<Record<string, Range>>)[id];
}

/** One traffic vessel, measured against the incoming vessel. */
export interface MeasuredPair {
  view: VesselView;
  range: Range;
  /** The range went down since the last check. */
  closing: boolean;
}

/**
 * The radar: the range of every traffic vessel to the incoming vessel, near or far. The caller stores
 * each range, so that the next check can see a pair come closer (closing), also from range 5.
 * Skips: itself, attempts of the same agent (unless landed), sibling attempts of the same intent, and
 * attempts that left the traffic (landed/abandoned/alternate/failed/stale) unless the view says state
 * "landed". In the order of `traffic`.
 */
export function measureTraffic(
  incoming: VesselView,
  traffic: VesselView[],
  graph: ImportGraph,
  previousRanges?: ReadonlyMap<string, Range> | Readonly<Record<string, Range>>,
): MeasuredPair[] {
  const out: MeasuredPair[] = [];
  const seen = new Set<string>();
  for (const v of traffic) {
    if (!v || seen.has(v.attempt.id) || !isTrafficFor(incoming, v)) continue;
    seen.add(v.attempt.id);
    const range = computeRange(incoming.shape, v.shape, graph);
    const prev = lookupRange(previousRanges, v.attempt.id);
    out.push({ view: v, range, closing: prev !== undefined && range < prev });
  }
  return out;
}

/**
 * Traffic near the incoming vessel: range ≤ maxRange, or closing (range went down since the
 * last check; pass `previousRanges` keyed by other attempt id — an optional extension). A closing
 * pair is a candidate at any range (5 → 4 included). See measureTraffic for the vessels it skips.
 * Sorted by range, then most recent update. Max 20.
 */
export function selectCandidates(
  incoming: VesselView,
  traffic: VesselView[],
  graph: ImportGraph,
  maxRange: Range = DEFAULT_MAX_RANGE,
  previousRanges?: ReadonlyMap<string, Range> | Readonly<Record<string, Range>>,
): { view: VesselView; range: Range }[] {
  return pickCandidates(measureTraffic(incoming, traffic, graph, previousRanges), maxRange);
}

/** The candidates among measured pairs (see selectCandidates). */
export function pickCandidates(measured: readonly MeasuredPair[], maxRange: Range = DEFAULT_MAX_RANGE): { view: VesselView; range: Range }[] {
  const out: { view: VesselView; range: Range }[] = [];
  for (const m of measured) if (m.range <= maxRange || m.closing) out.push({ view: m.view, range: m.range });
  out.sort(
    (x, y) =>
      x.range - y.range ||
      (y.view.attempt.updatedAt ?? 0) - (x.view.attempt.updatedAt ?? 0) ||
      (x.view.attempt.id < y.view.attempt.id ? -1 : x.view.attempt.id > y.view.attempt.id ? 1 : 0),
  );
  return out.slice(0, MAX_CANDIDATES);
}

/* ───────────────────────────── pair facts ───────────────────────────── */

function importsDirectly(graph: ImportGraph, from: string, to: string): boolean {
  try {
    const edges: readonly (readonly [string, string])[] = graph.edges;
    if (Array.isArray(edges) && edges.length) return edges.some(([i, m]) => i === from && m === to);
    return graph.neighbors(from).includes(to);
  } catch {
    return false;
  }
}

/**
 * Files where `consumer` uses `symbol`: its files that import the symbol's file; else its other
 * code files; else the symbol's own file (a local use); else all its files.
 */
export function usedAtFiles(symbol: SymbolKey, consumer: WorkShape, graph: ImportGraph): string[] {
  const home = symbolPath(symbol);
  const files = consumer.files;
  // Best: the files where the consumer's changed code really uses the symbol.
  const seen = consumer.referencedIn?.[symbol] ?? lookupByName(consumer.referencedIn, symbol);
  if (seen?.length) return [...seen];
  if (home) {
    const importers = files.filter((f) => f !== home && importsDirectly(graph, f, home));
    if (importers.length) return importers;
  }
  const others = files.filter((f) => f !== home && isCodePath(f));
  if (others.length) return others;
  if (home && files.includes(home)) return [home];
  return [...files];
}

function lookupByName(at: Record<SymbolKey, string[]> | undefined, symbol: SymbolKey): string[] | undefined {
  if (!at) return undefined;
  const name = symbolName(symbol);
  const path = symbolPath(symbol);
  for (const [k, v] of Object.entries(at)) {
    if (symbolName(k) === name && (!path || !symbolPath(k) || symbolPath(k) === path)) return v;
  }
  return undefined;
}

export function buildPairFacts(incoming: VesselView, other: VesselView, graph: ImportGraph, previousRange?: Range): PairFacts {
  const a = incoming.shape;
  const b = other.shape;
  const shared = shapeSharedFiles(a, b);
  const interfaceHits: PairFacts["interfaceHits"] = [
    ...intersectSymbols(a.signatureChanged, b.referenced).map((symbol) => ({
      changedBy: "incoming" as const,
      symbol,
      usedAt: usedAtFiles(symbol, b, graph),
    })),
    ...intersectSymbols(b.signatureChanged, a.referenced).map((symbol) => ({
      changedBy: "other" as const,
      symbol,
      usedAt: usedAtFiles(symbol, a, graph),
    })),
  ];
  const hunkOverlaps: PairFacts["hunkOverlaps"] = [];
  for (const path of shared) {
    for (const hi of a.hunks[path] ?? []) {
      for (const ho of b.hunks[path] ?? []) {
        if (hunksOverlap(hi, ho)) hunkOverlaps.push({ path, incoming: [hi[0], hi[1]] as LineRange, other: [ho[0], ho[1]] as LineRange });
      }
    }
  }
  const range = computeRange(a, b, graph);
  const facts: PairFacts = {
    otherAttemptId: other.attempt.id,
    otherAgentId: other.agent.id,
    otherIntentId: other.intent.id,
    otherState: other.state,
    sharedFiles: shared,
    sharedSymbols: sharedChanges(a, b),
    interfaceHits,
    hunkOverlaps,
    range,
    closing: previousRange !== undefined && range < previousRange,
    intentSimilarity: intentSimilarity(incoming.intent, other.intent),
  };
  if (previousRange !== undefined) facts.previousRange = previousRange;
  return facts;
}

/* ───────────────────────────── intent similarity ───────────────────────────── */

/** Small English stop-word list plus generic work verbs that say nothing about the goal. */
const STOP_WORDS = new Set(
  (
    "a an and are as at be but by can do does for from has have if in into is it its of on or so that the their them " +
    "then there these this those to was we were when where which while will with you your our us i me my he she they " +
    "not no all any each every more most other some such only own same than too very just also should must may might " +
    "would could shall about after before over under again further once here how what who whom why both few nor up down " +
    "out off above below between through during until against because per via e g eg ie etc please " +
    // generic work verbs and nouns
    "add adds added make makes made use uses used using update updates updated change changes changed fix fixes fixed " +
    "implement implements implemented create creates created new support supports supported allow allows allowed let lets " +
    "need needs want wants get gets set sets ensure ensures feature"
  ).split(/\s+/),
);

/** Canonical forms for a few common software synonyms. */
const SYNONYMS: Record<string, string> = {
  theme: "mode",
  toggle: "switch",
  delete: "remove",
  drop: "remove",
  display: "show",
  colour: "color",
  btn: "button",
  cost: "price",
  pricing: "price",
  spec: "test",
  bug: "defect",
  issue: "defect",
};

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}

/** Lowercase content tokens: stop words removed, light stemming, synonyms folded. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text ?? "").toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z0-9]+/)) {
    if (!raw || STOP_WORDS.has(raw)) continue;
    let w = stem(raw);
    w = SYNONYMS[w] ?? SYNONYMS[raw] ?? w;
    if (!w || STOP_WORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Token Jaccard over title + goal, stop words removed (0..1).
 * The title carries the most signal, so the result blends two Jaccard values:
 *   0.5 · J(title tokens) + 0.5 · J(title ∪ goal tokens)
 * (only the second term when a title has no content tokens).
 */
export function intentSimilarity(a: Intent, b: Intent): number {
  if (a.id && a.id === b.id) return 1;
  const ta = new Set(tokenize(a.title));
  const tb = new Set(tokenize(b.title));
  const all = (i: Intent, t: Set<string>) => new Set([...t, ...tokenize(i.goal)]);
  const whole = jaccard(all(a, ta), all(b, tb));
  const sim = ta.size && tb.size ? 0.5 * jaccard(ta, tb) + 0.5 * whole : whole;
  return Math.round(Math.min(1, Math.max(0, sim)) * 1000) / 1000;
}
