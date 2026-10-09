/**
 * Sector — one shard of the scale simulation (a Durable Object).
 *
 * A sector owns a region of a large synthetic codebase (a set of modules). Synthetic agents in the
 * region declare courses, log progress and land. Every course check runs the REAL Bearing
 * coordination code (selectCandidates → buildPairFacts → rules assessment → decide → corrections)
 * over synthetic vessel views. No LLM and no forks: this measures the coordination layer only.
 *
 * With `coordinate = false` the sector skips course checks; landings then count the conflicts that
 * agents would hit without Bearing (the baseline).
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../worker/env";
import type * as T from "../core/types";
import { DEFAULT_THRESHOLDS } from "../core/types";
import { graphFromEdges, type ImportGraph } from "../core/analysis/graph";
import { buildPairFacts, selectCandidates, buildVesselView, type VesselView } from "../core/coord/facts";
import { assessWithRules } from "../core/coord/rules";
import { decide } from "../core/coord/policy";

export interface SectorConfig {
  sector: number;
  sectors: number;
  modules: number; // modules owned by this sector
  filesPerModule: number;
  agents: number; // agents in this sector
  seed: number;
  coordinate: boolean;
}

export interface SectorTick {
  sector: number;
  courseChecks: number;
  corrections: number;
  /** Work in progress moved onto a new main after a landing near it (re-plot). */
  replots: number;
  landings: number;
  conflictsAtLanding: number;
  collisionsAvoided: number;
  rederives: number;
  checkMs: number[]; // sample of latencies (ms)
  active: number;
  cpuMs: number;
}

interface SimAgent {
  id: string;
  n: number;
  phase: "idle" | "work" | "land";
  ticksLeft: number;
  module: number;
  files: string[];
  hunks: Record<string, T.LineRange[]>;
  changed: string[];
  referenced: string[];
  signatureChanged: string[];
  declaredAt: number;
  baseLanding: number; // landing counter at declare
  corrected: Set<string>; // stand-on attempt ids this agent adapted to
  /** Lines to keep out of, from corrections (per file). */
  avoid: Record<string, T.LineRange[]>;
  view?: VesselView;
}

/** Probability that an agent applies a correction correctly (agents are not perfect). */
const ADAPT_P = 0.96;

const FILE_LINES = 240;

export class Sector extends DurableObject<Env> {
  private cfg?: SectorConfig;
  private agents: SimAgent[] = [];
  private graph: ImportGraph = graphFromEdges([]);
  private byFile = new Map<string, Set<SimAgent>>();
  private landed: { id: string; at: number; files: Record<string, T.LineRange[]>; changed: string[]; signatureChanged: string[] }[] = [];
  private landingCount = 0;
  private rng = mulberry32(1);
  private clock = 0;

  async configure(cfg: SectorConfig): Promise<{ files: number; edges: number }> {
    this.cfg = cfg;
    this.rng = mulberry32(cfg.seed + cfg.sector * 7919);
    const edges: [string, string][] = [];
    for (let m = 0; m < cfg.modules; m++) {
      for (let f = 0; f < cfg.filesPerModule; f++) {
        const from = filePath(cfg.sector, m, f);
        // Each file imports two files of its module and, sometimes, one file of the next module.
        for (let k = 1; k <= 2; k++) edges.push([from, filePath(cfg.sector, m, (f + k * 7) % cfg.filesPerModule)]);
        if (this.rng() < 0.15) edges.push([from, filePath(cfg.sector, (m + 1) % cfg.modules, Math.floor(this.rng() * cfg.filesPerModule))]);
      }
    }
    this.graph = graphFromEdges(edges);
    this.byFile.clear();
    this.landed = [];
    this.landingCount = 0;
    this.agents = Array.from({ length: cfg.agents }, (_, i) => ({
      id: `s${cfg.sector}a${i}`,
      n: i,
      phase: "idle" as const,
      ticksLeft: Math.floor(this.rng() * 4),
      module: 0,
      files: [],
      hunks: {},
      changed: [],
      referenced: [],
      signatureChanged: [],
      declaredAt: 0,
      baseLanding: 0,
      corrected: new Set<string>(),
      avoid: {},
    }));
    return { files: cfg.modules * cfg.filesPerModule, edges: edges.length };
  }

  /** Advance every agent one step. */
  async tick(): Promise<SectorTick> {
    const cfg = this.cfg;
    const out: SectorTick = {
      sector: cfg?.sector ?? 0,
      courseChecks: 0,
      corrections: 0,
      replots: 0,
      landings: 0,
      conflictsAtLanding: 0,
      collisionsAvoided: 0,
      rederives: 0,
      checkMs: [],
      active: 0,
      cpuMs: 0,
    };
    if (!cfg) return out;
    const t0 = Date.now();
    this.clock += 1;
    for (const a of this.agents) {
      if (a.ticksLeft > 0) {
        a.ticksLeft -= 1;
        if (a.phase !== "idle") out.active += 1;
        continue;
      }
      if (a.phase === "idle") {
        this.declare(a);
        a.phase = "work";
        a.ticksLeft = 2 + Math.floor(this.rng() * 4);
        if (cfg.coordinate) this.check(a, out);
      } else if (a.phase === "work") {
        this.grow(a);
        if (cfg.coordinate) this.check(a, out);
        a.phase = "land";
        a.ticksLeft = 1 + Math.floor(this.rng() * 3);
      } else {
        this.land(a, out);
        a.phase = "idle";
        a.ticksLeft = Math.floor(this.rng() * 3);
      }
      if (a.phase !== "idle") out.active += 1;
    }
    // Keep the landed window short (old landings are below every live base).
    const minBase = Math.min(...this.agents.filter((a) => a.phase !== "idle").map((a) => a.baseLanding), this.landingCount);
    this.landed = this.landed.filter((l) => l.at > minBase);
    out.cpuMs = Date.now() - t0;
    return out;
  }

  private declare(a: SimAgent): void {
    const cfg = this.cfg!;
    this.unindex(a);
    // Hot spots: a few modules get most of the work (Zipf-like).
    a.module = Math.min(cfg.modules - 1, Math.floor(Math.pow(this.rng(), 2.2) * cfg.modules));
    const nFiles = 1 + Math.floor(this.rng() * 3);
    const hot = Math.floor(Math.pow(this.rng(), 1.8) * cfg.filesPerModule);
    a.files = [...new Set(Array.from({ length: nFiles }, (_, k) => filePath(cfg.sector, a.module, (hot + k * 3) % cfg.filesPerModule)))];
    a.hunks = {};
    a.changed = [];
    a.referenced = [];
    a.signatureChanged = [];
    for (const f of a.files) {
      const start = 1 + Math.floor(Math.pow(this.rng(), 1.5) * (FILE_LINES - 30));
      a.hunks[f] = [[start, start + 4 + Math.floor(this.rng() * 18)]];
      a.changed.push(`${f}#fn${Math.floor(start / 30)}`);
    }
    // Some work changes an interface; some uses one.
    if (this.rng() < 0.12) a.signatureChanged.push(a.changed[0]);
    if (this.rng() < 0.5) {
      const target = filePath(cfg.sector, a.module, Math.floor(Math.pow(this.rng(), 1.8) * cfg.filesPerModule));
      a.referenced.push(`${target}#fn${Math.floor(this.rng() * 8)}`);
    }
    a.declaredAt = this.clock * 1000 + a.n;
    a.baseLanding = this.landingCount;
    a.corrected = new Set();
    a.avoid = {};
    this.index(a);
    a.view = undefined;
  }

  private grow(a: SimAgent): void {
    const f = a.files[Math.floor(this.rng() * a.files.length)];
    let start = 1 + Math.floor(this.rng() * (FILE_LINES - 20));
    const len = 3 + Math.floor(this.rng() * 10);
    // An agent that received corrections keeps its new edits out of those lines.
    for (const [s0, e0] of a.avoid[f] ?? []) {
      if (start <= e0 + 2 && start + len >= s0 - 2) start = Math.min(FILE_LINES - len, e0 + 4);
    }
    (a.hunks[f] ??= []).push([start, start + len]);
    a.view = undefined;
  }

  private viewOf(a: SimAgent, state: VesselView["state"] = "active"): VesselView {
    if (a.view && a.view.state === state) return a.view;
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
      footprint: {
        files,
        symbols: { defined: [], modified: a.changed, removed: [], signatureChanged: a.signatureChanged, referenced: a.referenced },
        computedAt: 0,
      },
      corrections: [],
      lineage: { generation: 1 },
      stats: { filesChanged: a.files.length, additions: 6, deletions: 2, steps: 1 },
      createdAt: 0,
      updatedAt: 0,
    } as T.Attempt;
    const intent = { id: attempt.intentId, title: `Task ${a.n} in module ${a.module}`, goal: `Change ${a.files.join(", ")}`, priority: "normal" } as T.Intent;
    const agent = { id: a.id, callsign: a.id, kind: "sim", color: 0, status: "underway", lastSeen: 0 } as T.AgentInfo;
    a.view = buildVesselView({ attempt, intent, agent, state });
    return a.view;
  }

  private check(a: SimAgent, out: SectorTick): void {
    const t0 = performance.now();
    const incoming = this.viewOf(a);
    // Inverted index: only vessels on the same files or one import away.
    const near = new Set<SimAgent>();
    for (const f of a.files) {
      for (const o of this.byFile.get(f) ?? []) if (o !== a) near.add(o);
      for (const nb of this.graph.neighbors(f)) for (const o of this.byFile.get(nb) ?? []) if (o !== a) near.add(o);
    }
    const traffic = [...near].filter((o) => o.phase !== "idle").map((o) => this.viewOf(o, o.phase === "land" ? "waiting" : "active"));
    const cands = selectCandidates(incoming, traffic, this.graph, 3).map((c) => ({ view: c.view, facts: buildPairFacts(incoming, c.view, this.graph) }));
    out.courseChecks += 1;
    if (cands.length) {
      const r = assessWithRules(incoming, cands);
      const outcome = decide(r.assessments, cands.map((c) => c.facts), { ...DEFAULT_THRESHOLDS, interference: 1.7 }, r.duplicate, r.confidence);
      for (const c of outcome.corrections) {
        const giveWay = c.giveWay === "incoming" ? a : this.agents.find((x) => x.id === c.otherAttemptId);
        const standOn = c.giveWay === "incoming" ? c.otherAttemptId : a.id;
        if (!giveWay || giveWay.corrected.has(standOn)) continue;
        giveWay.corrected.add(standOn);
        out.corrections += 1;
        if (c.facts.range <= 1) out.collisionsAvoided += 1;
        // The give-way agent moves its hunks out of the stand-on agent's lines (a region correction).
        const so = this.agents.find((x) => x.id === standOn);
        if (so) this.steerClear(giveWay, so);
      }
    }
    const ms = performance.now() - t0;
    if (out.checkMs.length < 400 || this.rng() < 0.05) out.checkMs.push(Math.round(ms * 1000) / 1000);
  }

  /** Apply a correction: keep out of the stand-on vessel's lines and adapt to its interface. */
  private steerClear(giveWay: SimAgent, standOn: SimAgent): void {
    if (this.rng() > ADAPT_P) return; // the agent misread the correction
    for (const [f, hs] of Object.entries(standOn.hunks)) (giveWay.avoid[f] ??= []).push(...hs);
    for (const [f, hs] of Object.entries(giveWay.hunks)) {
      const avoid = standOn.hunks[f];
      if (!avoid) continue;
      giveWay.hunks[f] = hs.map(([s, e]) => {
        for (const [as, ae] of avoid) {
          if (s <= ae + 2 && e >= as - 2) {
            const len = e - s;
            const ns = ae + 4 <= FILE_LINES - len ? ae + 4 : Math.max(1, as - 4 - len);
            return [ns, ns + len] as T.LineRange;
          }
        }
        return [s, e] as T.LineRange;
      });
    }
    giveWay.view = undefined;
  }

  private land(a: SimAgent, out: SectorTick): void {
    // Conflict at landing: our lines overlap lines that landed after our base, and we did not adapt.
    let conflict = false;
    for (const l of this.landed) {
      if (l.at <= a.baseLanding || a.corrected.has(l.id)) continue;
      for (const [f, hs] of Object.entries(a.hunks)) {
        const other = l.files[f];
        if (!other) continue;
        if (hs.some(([s, e]) => other.some(([os, oe]) => s <= oe + 1 && e >= os - 1))) conflict = true;
      }
      if (l.signatureChanged.some((s) => a.referenced.includes(s))) conflict = true;
      if (conflict) break;
    }
    if (conflict) {
      out.conflictsAtLanding += 1;
      out.rederives += this.cfg?.coordinate ? 1 : 0;
    }
    this.landingCount += 1;
    this.landed.push({ id: a.id, at: this.landingCount, files: a.hunks, changed: a.changed, signatureChanged: a.signatureChanged });
    out.landings += 1;
    // Re-plot: main moved, so Bearing moves every vessel near the landed files onto the new main.
    // Overlapping lines go back to main and the agent makes its change again (it adapts with ADAPT_P).
    if (this.cfg?.coordinate) {
      const near = new Set<SimAgent>();
      for (const f of a.files) {
        for (const o of this.byFile.get(f) ?? []) if (o !== a) near.add(o);
        for (const nb of this.graph.neighbors(f)) for (const o of this.byFile.get(nb) ?? []) if (o !== a) near.add(o);
      }
      for (const o of near) {
        if (o.phase === "idle" || o.corrected.has(a.id)) continue;
        if (this.rng() <= ADAPT_P) o.corrected.add(a.id);
        out.replots += 1;
      }
    }
    // Every live agent that saw this vessel as traffic remembers it (it already adapted if corrected).
    this.unindex(a);
  }

  private index(a: SimAgent): void {
    for (const f of a.files) {
      let s = this.byFile.get(f);
      if (!s) this.byFile.set(f, (s = new Set()));
      s.add(a);
    }
  }

  private unindex(a: SimAgent): void {
    for (const f of a.files) this.byFile.get(f)?.delete(a);
  }
}

function filePath(sector: number, module: number, file: number): string {
  return `s${sector}/m${module}/f${file}.js`;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
