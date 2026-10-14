/**
 * Benchmark of the coordination logic of gitring: how many merge conflicts the plan check avoids.
 * Run: npm run bench -- [--agents N] [--sectors N] [--seed N]. It needs Node 22.7 or later and adds no package.
 * It runs the real pure code of src/core on synthetic plans. There is no network, no Artifacts store and no AI model.
 * Never add network calls here. Read next: bench/README.md (the model of the run), then src/core/coord.
 */
import { pathToFileURL } from "node:url";
import type * as T from "../src/core/types";
import { DEFAULT_THRESHOLDS } from "../src/core/types";
import { graphFromEdges, type ImportGraph } from "../src/core/analysis/graph";
import { buildPairFacts, buildVesselView, selectCandidates, type VesselView } from "../src/core/coord/facts";
import { assessWithRules } from "../src/core/coord/rules";
import { decide } from "../src/core/coord/policy";
import { draftCorrection } from "../src/core/coord/corrections";

export const HEADLINE = "Coordination logic only. No network, no Artifacts, no AI. It shows how many landing conflicts the plan check avoids and how long the pure check takes.";

/** The share of change requests that an agent applies correctly. */
export const ADAPT_P = 0.96;
const FILE_LINES = 240;
const FILES_PER_MODULE = 25;
/** Enough ticks for every agent: idle 0-3, work 2-5, wait 1-3, plus the steps between. */
const TICKS = 14;

export interface BenchOptions {
  agents: number;
  sectors: number;
  seed: number;
}

export interface SectorStats {
  landings: number;
  conflicts: number;
  checks: number;
  corrections: number;
  replots: number;
  /** Time inside the course checks, in milliseconds. */
  checkMs: number;
}

export interface BenchRow extends BenchOptions {
  landings: number;
  conflictsWithout: number;
  conflictsWith: number;
  checks: number;
  corrections: number;
  replots: number;
  checkMs: number;
  checksPerSecond: number;
  /** Wall time of the whole run, in milliseconds. */
  ms: number;
}

// ───── random numbers ─────

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ───── the synthetic code base ─────

interface SimAgent {
  id: string;
  n: number;
  phase: "idle" | "work" | "land" | "done";
  ticksLeft: number;
  module: number;
  files: string[];
  hunks: Record<string, T.LineRange[]>;
  changed: string[];
  referenced: string[];
  signatureChanged: string[];
  declaredAt: number;
  /** Number of landings in the sector when the agent declared. */
  baseLanding: number;
  /** Agents (their ids) whose change this agent has taken into account. */
  corrected: Set<string>;
  view?: VesselView;
  viewState?: VesselView["state"];
}

interface Landed {
  id: string;
  at: number;
  hunks: T.LineRange[];
}

export interface SectorConfig {
  sector: number;
  modules: number;
  filesPerModule: number;
  agents: number;
  seed: number;
  coordinate: boolean;
}

const filePath = (sector: number, module: number, file: number) => `s${sector}/m${module}/f${file}.js`;

/** Files of one sector for a number of agents: about four files for each agent. */
export function geometry(agentsInSector: number): { modules: number; filesPerModule: number } {
  const files = Math.max(200, agentsInSector * 4);
  return { modules: Math.ceil(files / FILES_PER_MODULE), filesPerModule: FILES_PER_MODULE };
}

/** The code base: each file imports two files of its module and, sometimes, one file of the next module. */
function makeGraph(cfg: SectorConfig, rng: () => number): ImportGraph {
  const edges: [string, string][] = [];
  for (let m = 0; m < cfg.modules; m++) {
    for (let f = 0; f < cfg.filesPerModule; f++) {
      const from = filePath(cfg.sector, m, f);
      for (let k = 1; k <= 2; k++) edges.push([from, filePath(cfg.sector, m, (f + k * 7) % cfg.filesPerModule)]);
      if (rng() < 0.15) edges.push([from, filePath(cfg.sector, (m + 1) % cfg.modules, Math.floor(rng() * cfg.filesPerModule))]);
    }
  }
  return graphFromEdges(edges);
}

const overlap = (a: T.LineRange[], b: T.LineRange[], slack: number) => a.some(([s, e]) => b.some(([os, oe]) => s <= oe + slack && e >= os - slack));

/**
 * One sector. `work` draws everything that belongs to the work (which files, which lines, how long);
 * `adapt` draws what belongs to the agents (a mistake or not). The work is the same with and without
 * the plan check, because the two streams are separate.
 */
export class Sector {
  private readonly work: () => number;
  private readonly adapt: () => number;
  private readonly graph: ImportGraph;
  private readonly agents: SimAgent[];
  private readonly byId = new Map<string, SimAgent>();
  private readonly byFile = new Map<string, Set<SimAgent>>();
  private readonly landedByFile = new Map<string, Landed[]>();
  private readonly landedBySymbol = new Map<string, Landed[]>();
  private landingCount = 0;
  private clock = 0;
  private stats: SectorStats = { landings: 0, conflicts: 0, checks: 0, corrections: 0, replots: 0, checkMs: 0 };

  constructor(readonly cfg: SectorConfig) {
    const base = (cfg.seed + cfg.sector * 7919) >>> 0;
    this.work = mulberry32(base);
    this.adapt = mulberry32(base ^ 0x9e3779b9);
    this.graph = makeGraph(cfg, this.work);
    this.agents = Array.from({ length: cfg.agents }, (_, n) => ({
      id: `s${cfg.sector}a${n}`,
      n,
      phase: "idle" as const,
      ticksLeft: Math.floor(this.work() * 4),
      module: 0,
      files: [],
      hunks: {},
      changed: [],
      referenced: [],
      signatureChanged: [],
      declaredAt: 0,
      baseLanding: 0,
      corrected: new Set<string>(),
    }));
    for (const a of this.agents) this.byId.set(a.id, a);
  }

  /** Run every agent through its task. */
  run(): SectorStats {
    for (let tick = 0; tick < TICKS; tick++) {
      this.clock = tick + 1;
      for (const a of this.agents) this.step(a);
    }
    return this.stats;
  }

  /**
   * For the cost test: `others` plans are active at the same time (the traffic), and `probes` more
   * plans exist only to be checked. The sector needs at least `others + probes` agents.
   */
  populate(others: number, probes: number): { views: VesselView[]; probes: { agent: SimAgent; view: VesselView }[]; graph: ImportGraph; nearViews: (a: SimAgent) => VesselView[] } {
    const start = (a: SimAgent) => {
      this.declare(a);
      a.phase = "work";
      this.grow(a);
    };
    const active = this.agents.slice(0, others);
    for (const a of active) start(a);
    const checked = this.agents.slice(others, others + probes);
    for (const a of checked) {
      start(a);
      for (const f of a.files) this.byFile.get(f)?.delete(a); // not traffic for the others
    }
    return {
      views: active.map((a) => this.viewOf(a)),
      probes: checked.map((a) => ({ agent: a, view: this.viewOf(a) })),
      graph: this.graph,
      nearViews: (a) => [...this.near(a)].filter((o) => o.phase === "work" || o.phase === "land").map((o) => this.viewOf(o)),
    };
  }

  private step(a: SimAgent): void {
    if (a.phase === "done") return;
    if (a.ticksLeft > 0) {
      a.ticksLeft -= 1;
      return;
    }
    if (a.phase === "idle") {
      this.declare(a);
      a.phase = "work";
      a.ticksLeft = 2 + Math.floor(this.work() * 4);
      if (this.cfg.coordinate) this.check(a);
    } else if (a.phase === "work") {
      this.grow(a);
      if (this.cfg.coordinate) this.check(a);
      a.phase = "land";
      a.ticksLeft = 1 + Math.floor(this.work() * 3);
    } else {
      this.land(a);
      a.phase = "done";
    }
  }

  private declare(a: SimAgent): void {
    const cfg = this.cfg;
    // A few modules get most of the work.
    a.module = Math.min(cfg.modules - 1, Math.floor(Math.pow(this.work(), 2.2) * cfg.modules));
    const nFiles = 1 + Math.floor(this.work() * 3);
    const hot = Math.floor(Math.pow(this.work(), 1.8) * cfg.filesPerModule);
    a.files = [...new Set(Array.from({ length: nFiles }, (_, k) => filePath(cfg.sector, a.module, (hot + k * 3) % cfg.filesPerModule)))];
    a.hunks = {};
    a.changed = [];
    a.referenced = [];
    a.signatureChanged = [];
    for (const f of a.files) {
      const start = 1 + Math.floor(Math.pow(this.work(), 1.5) * (FILE_LINES - 30));
      a.hunks[f] = [[start, start + 4 + Math.floor(this.work() * 18)]];
      a.changed.push(`${f}#fn${Math.floor(start / 30)}`);
    }
    // Some work changes an interface; some work uses one.
    if (this.work() < 0.12) a.signatureChanged.push(a.changed[0]);
    if (this.work() < 0.5) {
      const target = filePath(cfg.sector, a.module, Math.floor(Math.pow(this.work(), 1.8) * cfg.filesPerModule));
      a.referenced.push(`${target}#fn${Math.floor(this.work() * 8)}`);
    }
    a.declaredAt = this.clock * 1000 + a.n; // never the same time for two plans
    a.baseLanding = this.landingCount;
    a.corrected = new Set();
    a.view = undefined;
    for (const f of a.files) this.fileSet(f).add(a);
  }

  private fileSet(f: string): Set<SimAgent> {
    let s = this.byFile.get(f);
    if (!s) this.byFile.set(f, (s = new Set()));
    return s;
  }

  /** The agent writes more lines in one of its files. A change request keeps the agent out of the lines of another agent. */
  private grow(a: SimAgent): void {
    const f = a.files[Math.floor(this.work() * a.files.length)];
    const start = 1 + Math.floor(this.work() * (FILE_LINES - 20));
    const len = 3 + Math.floor(this.work() * 10);
    (a.hunks[f] ??= []).push([start, start + len]);
    a.view = undefined;
  }

  private viewOf(a: SimAgent): VesselView {
    const state: VesselView["state"] = a.phase === "land" ? "waiting" : "active";
    if (a.view && a.viewState === state) return a.view;
    a.view = makeView(a, state);
    a.viewState = state;
    return a.view;
  }

  /** Agents on the same files or one import away (the index of files). */
  private near(a: SimAgent): Set<SimAgent> {
    const out = new Set<SimAgent>();
    for (const f of a.files) {
      for (const o of this.byFile.get(f) ?? []) if (o !== a) out.add(o);
      for (const nb of this.graph.neighbors(f)) for (const o of this.byFile.get(nb) ?? []) if (o !== a) out.add(o);
    }
    return out;
  }

  /** One course check of the real code: candidates, facts, rules, policy, text of the change request. */
  private check(a: SimAgent): void {
    const t0 = performance.now();
    const incoming = this.viewOf(a);
    const traffic = [...this.near(a)].filter((o) => o.phase === "work" || o.phase === "land").map((o) => this.viewOf(o));
    const outcome = courseCheck(incoming, traffic, this.graph);
    this.stats.checks += 1;
    for (const c of outcome) {
      const other = this.byId.get(c.otherAttemptId);
      const giveWay = c.giveWay === "incoming" ? a : other;
      const standOn = c.giveWay === "incoming" ? other : a;
      if (!giveWay || !standOn || giveWay.corrected.has(standOn.id)) continue;
      this.stats.corrections += 1;
      if (this.adapt() > ADAPT_P) continue; // the agent made a mistake: it does not apply the change request
      giveWay.corrected.add(standOn.id);
      for (const r of c.avoid) this.moveOut(giveWay, r.path, r.lines);
    }
    this.stats.checkMs += performance.now() - t0;
  }

  /** The agent moves its edits out of the lines that the change request names. */
  private moveOut(a: SimAgent, path: string, lines: T.LineRange): void {
    const hs = a.hunks[path];
    if (!hs) return;
    const [as, ae] = lines;
    a.hunks[path] = hs.map(([s, e]) => {
      if (s <= ae + 2 && e >= as - 2) {
        const len = e - s;
        const ns = ae + 4 <= FILE_LINES - len ? ae + 4 : Math.max(1, as - 4 - len);
        return [ns, ns + len] as T.LineRange;
      }
      return [s, e] as T.LineRange;
    });
    a.view = undefined;
  }

  private land(a: SimAgent): void {
    // A conflict: a change landed after the base of the agent, the agent did not take it into account,
    // and it overlaps the lines of the agent, or it changes a signature that the agent uses.
    let conflict = false;
    for (const f of a.files) {
      for (const l of this.landedByFile.get(f) ?? []) {
        if (l.at <= a.baseLanding || a.corrected.has(l.id)) continue;
        if (overlap(a.hunks[f] ?? [], l.hunks, 1)) conflict = true;
      }
    }
    if (!conflict) {
      for (const s of a.referenced) {
        for (const l of this.landedBySymbol.get(s) ?? []) if (l.at > a.baseLanding && !a.corrected.has(l.id)) conflict = true;
      }
    }
    if (conflict) this.stats.conflicts += 1;
    this.landingCount += 1;
    this.stats.landings += 1;
    for (const f of a.files) {
      const list = this.landedByFile.get(f) ?? [];
      list.push({ id: a.id, at: this.landingCount, hunks: a.hunks[f] ?? [] });
      this.landedByFile.set(f, list);
    }
    for (const s of a.signatureChanged) {
      const list = this.landedBySymbol.get(s) ?? [];
      list.push({ id: a.id, at: this.landingCount, hunks: [] });
      this.landedBySymbol.set(s, list);
    }
    // Re-plot: gitring moves the agents near the landed files onto the new main.
    if (this.cfg.coordinate) {
      for (const o of this.near(a)) {
        if (o.phase !== "work" && o.phase !== "land") continue;
        this.stats.replots += 1;
        if (!o.corrected.has(a.id) && this.adapt() <= ADAPT_P) o.corrected.add(a.id);
      }
    }
    for (const f of a.files) this.byFile.get(f)?.delete(a);
  }
}

/** A plan as the course check sees it. Only the fields that the code of the check reads are set. */
function makeView(a: SimAgent, state: VesselView["state"]): VesselView {
  const files: Record<string, T.FileTouch> = {};
  for (const [f, hs] of Object.entries(a.hunks)) files[f] = { status: "M", hunks: hs, additions: 6, deletions: 2 };
  const attempt = {
    id: a.id,
    intentId: `i_${a.id}`,
    agentId: a.id,
    fork: { repo: a.id },
    mode: "api",
    baseSha: "",
    baseTree: "",
    status: "underway",
    course: { plan: [], files: a.files, symbols: a.changed, approach: "", declaredAt: a.declaredAt },
    footprint: { files, symbols: { defined: [], modified: a.changed, removed: [], signatureChanged: a.signatureChanged, referenced: a.referenced }, computedAt: 0 },
    corrections: [],
    lineage: { generation: 1 },
    stats: { filesChanged: a.files.length, additions: 6, deletions: 2, steps: 1 },
    createdAt: 0,
    updatedAt: 0,
  } as unknown as T.Attempt;
  const intent = { id: attempt.intentId, title: `Task ${a.n} in module ${a.module}`, goal: `Change ${a.files.join(", ")}`, priority: "normal" } as unknown as T.Intent;
  const agent = { id: a.id, callsign: a.id, kind: "sim", color: 0, status: "underway", lastSeen: 0 } as unknown as T.AgentInfo;
  return buildVesselView({ attempt, intent, agent, state });
}

interface Request {
  otherAttemptId: string;
  giveWay: "incoming" | "other";
  avoid: { path: string; lines: T.LineRange }[];
}

/**
 * The course check of one plan against the traffic that it gets: the real pure code, in the order
 * that the harbor uses. It returns the change requests (who gives way, and the lines to avoid).
 */
export function courseCheck(incoming: VesselView, traffic: VesselView[], graph: ImportGraph): Request[] {
  const cands = selectCandidates(incoming, traffic, graph, 3).map((c) => ({ view: c.view, facts: buildPairFacts(incoming, c.view, graph) }));
  if (!cands.length) return [];
  const r = assessWithRules(incoming, cands);
  const outcome = decide(
    r.assessments,
    cands.map((c) => c.facts),
    DEFAULT_THRESHOLDS,
    r.duplicate,
    r.confidence,
  );
  return outcome.corrections.map((c) => {
    const other = cands.find((x) => x.view.attempt.id === c.otherAttemptId)!.view;
    const drafted = c.giveWay === "incoming" ? draftCorrection(incoming, other, c.facts, c.rule, "incoming") : draftCorrection(other, incoming, c.facts, c.rule, "other");
    return { otherAttemptId: c.otherAttemptId, giveWay: c.giveWay, avoid: drafted.constraints.avoidRegions ?? [] };
  });
}

// ───── the run ─────

/** All sectors, with and without the plan check. The counts are the same for the same options. */
export function runBench(opts: BenchOptions): BenchRow {
  const t0 = performance.now();
  const row: BenchRow = { ...opts, landings: 0, conflictsWithout: 0, conflictsWith: 0, checks: 0, corrections: 0, replots: 0, checkMs: 0, checksPerSecond: 0, ms: 0 };
  for (let s = 0; s < opts.sectors; s++) {
    // The agents go to the sectors one by one: the sectors differ by at most one agent.
    const n = Math.floor(opts.agents / opts.sectors) + (s < opts.agents % opts.sectors ? 1 : 0);
    if (!n) continue;
    const cfg = { sector: s, ...geometry(n), agents: n, seed: opts.seed };
    const without = new Sector({ ...cfg, coordinate: false }).run();
    const withCheck = new Sector({ ...cfg, coordinate: true }).run();
    row.landings += withCheck.landings;
    row.conflictsWithout += without.conflicts;
    row.conflictsWith += withCheck.conflicts;
    row.checks += withCheck.checks;
    row.corrections += withCheck.corrections;
    row.replots += withCheck.replots;
    row.checkMs += withCheck.checkMs;
  }
  row.checksPerSecond = row.checkMs > 0 ? Math.round((row.checks / row.checkMs) * 1000) : 0;
  row.ms = Math.round(performance.now() - t0);
  return row;
}

// ───── cost of one check ─────

export interface GrowthRow {
  others: number;
  /** Microseconds for one check that compares the plan with every other active plan (the harbor does this). */
  allPlansUs: number;
  /** Microseconds for one check that compares the plan only with plans on the same files or one import away. */
  indexedUs: number;
  /** Plans near the checked plan, on average. */
  near: number;
  probes: number;
}

/**
 * How the cost of one course check grows with the number of other active plans in one project.
 * The plans are the same synthetic work as above, all in one sector. The views of the plans are built
 * before the timer starts; the harbor builds them again at each check, so its real cost is higher.
 */
export function growth(sizes: number[], seed: number, probeCount?: number): GrowthRow[] {
  const rows: GrowthRow[] = [];
  for (const others of sizes) {
    const count = probeCount ?? Math.max(10, Math.round(100_000 / others));
    const sector = new Sector({ sector: 0, ...geometry(others), agents: others + count, seed, coordinate: false });
    const { views, probes, graph, nearViews } = sector.populate(others, count);
    let t = performance.now();
    for (const p of probes) courseCheck(p.view, views, graph);
    const allPlansUs = ((performance.now() - t) / probes.length) * 1000;
    t = performance.now();
    let found = 0;
    for (const p of probes) {
      const traffic = nearViews(p.agent);
      found += traffic.length;
      courseCheck(p.view, traffic, graph);
    }
    const indexedUs = ((performance.now() - t) / probes.length) * 1000;
    rows.push({ others, allPlansUs, indexedUs, near: found / probes.length, probes: probes.length });
  }
  return rows;
}

// ───── output ─────

const num = (n: number) => n.toLocaleString("en-US");
const pad = (s: string | number, w: number) => String(s).padStart(w);

export function formatRow(row: BenchRow): string[] {
  const avoided = row.conflictsWithout ? Math.round(((row.conflictsWithout - row.conflictsWith) / row.conflictsWithout) * 100) : 0;
  return [
    `${pad("agents", 9)} ${pad("sectors", 8)} ${pad("conflicts without", 18)} ${pad("conflicts with", 15)} ${pad("avoided", 8)} ${pad("checks/s", 10)}`,
    `${pad(num(row.agents), 9)} ${pad(row.sectors, 8)} ${pad(num(row.conflictsWithout), 18)} ${pad(num(row.conflictsWith), 15)} ${pad(`${avoided}%`, 8)} ${pad(num(row.checksPerSecond), 10)}`,
  ];
}

export function formatGrowth(rows: GrowthRow[]): string[] {
  return [
    `${pad("other plans", 12)} ${pad("all plans (us)", 15)} ${pad("indexed (us)", 13)} ${pad("plans near", 11)}`,
    ...rows.map((r) => `${pad(num(r.others), 12)} ${pad(r.allPlansUs.toFixed(0), 15)} ${pad(r.indexedUs.toFixed(0), 13)} ${pad(r.near.toFixed(1), 11)}`),
  ];
}

export function parseArgs(argv: string[]): BenchOptions {
  const opts: BenchOptions = { agents: 100_000, sectors: 100, seed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(agents|sectors|seed)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`Unknown option ${argv[i]}. Use --agents N, --sectors N or --seed N.`);
    const raw = m[2] ?? argv[++i];
    const value = Number(raw);
    if (raw === undefined || !Number.isInteger(value) || value < 0) throw new Error(`Option --${m[1]} needs a whole number. You gave ${raw}.`);
    opts[m[1] as keyof BenchOptions] = value;
  }
  if (opts.agents < 1) throw new Error("Option --agents must be 1 or more.");
  if (opts.sectors < 1) throw new Error("Option --sectors must be 1 or more.");
  opts.sectors = Math.min(opts.sectors, opts.agents);
  return opts;
}

export function main(argv: string[]): void {
  console.log(HEADLINE);
  const opts = parseArgs(argv);
  console.log("");
  console.log(`Seed ${opts.seed}. Each agent makes one change: it sends a plan, writes, and lands. All agents work at the same time.`);
  console.log(`A few files get most of the work. An agent applies a change request correctly in ${Math.round(ADAPT_P * 100)} of 100 cases.`);
  console.log("");
  const row = runBench(opts);
  for (const line of formatRow(row)) console.log(line);
  console.log("");
  console.log(`${num(row.landings)} landings, ${num(row.checks)} course checks, ${num(row.corrections)} change requests, ${num(row.replots)} re-plots. The run took ${(row.ms / 1000).toFixed(1)} s.`);
  console.log("The counts are the same for the same options. The times change from run to run.");
  console.log("");
  console.log("Cost of one course check when other plans are active (mean, in microseconds).");
  console.log("The harbor compares the plan with all other active plans. An index of files compares fewer plans.");
  for (const line of formatGrowth(growth([1000, 5000, 20000], opts.seed))) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 1;
  }
}
