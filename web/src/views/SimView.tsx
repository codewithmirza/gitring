import { useEffect, useMemo, useRef, useState } from "react";
import type { SimStats } from "../../../src/core/types";
import { Button, Stat, StatRow, toast } from "../design/components";
import { Icon } from "../design/icons";
import { useTheme } from "../design/theme";
import { harbor } from "../state/api";
import { compact, duration, int } from "../state/format";
import { useStore } from "../state/store";
import { useIsOwner } from "../state/account";
import "./sim.css";

const SECTOR_CAPACITY = 2400; // course checks per second per sector (Clef-flash, batched)
const CHECKS_PER_AGENT = 0.5; // declare + log + write, per agent per second

const toAgents = (x: number) => Math.round(10 ** (2 + 3 * x));
const fromAgents = (n: number) => (Math.log10(Math.max(100, n)) - 2) / 3;

function hash(i: number) {
  let h = 2166136261 ^ (i * 374761393);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Share of agents per sector: a few hot regions (render.js-like) and a long tail. */
function shares(sectors: number): number[] {
  const raw = Array.from({ length: sectors }, (_, i) => 1 / (1 + i * 0.35) ** 0.9 * (0.75 + hash(i) * 0.5));
  // shuffle deterministically so hot sectors are spread over the grid
  const order = raw.map((v, i) => ({ v, k: hash(i + 99) })).sort((a, b) => a.k - b.k).map((x) => x.v);
  const sum = order.reduce((s, v) => s + v, 0);
  return order.map((v) => v / sum);
}

function readVar(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || "#888";
}

function SectorCanvas({ agents, sectors, running, loads }: { agents: number; sectors: number; running: boolean; loads?: number[] }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const theme = useTheme();
  const loadKey = loads && loads.length === sectors ? loads.join(",") : "";
  const share = useMemo(() => {
    // Real per-sector load from the running simulation, when the backend sends it.
    if (loadKey) {
      const xs = loadKey.split(",").map(Number);
      const sum = xs.reduce((s, v) => s + v, 0);
      if (sum > 0) return xs.map((v) => v / sum);
    }
    return shares(sectors);
  }, [sectors, loadKey]);
  const [size, setSize] = useState({ w: 800, h: 360 });

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: Math.max(240, Math.min(420, e.contentRect.width * 0.42)) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const colors = {
      bg: readVar(canvas, "--bg"),
      shoal: readVar(canvas, "--shoal"),
      accent: readVar(canvas, "--accent"),
      line: readVar(canvas, "--line"),
      strong: readVar(canvas, "--line-strong"),
      ink: readVar(canvas, "--ink-2"),
      ink3: readVar(canvas, "--ink-3"),
      caution: readVar(canvas, "--caution"),
      vessels: Array.from({ length: 12 }, (_, i) => readVar(canvas, `--v${i}`)),
    };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cols = Math.ceil(Math.sqrt(sectors * (size.w / size.h)));
    const rows = Math.ceil(sectors / cols);
    const cw = size.w / cols;
    const ch = size.h / rows;
    const offered = agents * CHECKS_PER_AGENT;
    const dotTotal = Math.min(2600, Math.max(60, agents / 20));
    const dots = share.flatMap((s, i) => {
      const n = Math.round(s * dotTotal);
      return Array.from({ length: n }, (_, j) => ({ sector: i, x: hash(i * 7919 + j), y: hash(i * 104729 + j * 3), c: (i + j) % 12, p: hash(j + i) * Math.PI * 2 }));
    });
    let raf = 0;
    const draw = (time: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, size.w, size.h);
      ctx.font = `500 10px "Atkinson Hyperlegible Mono", ui-monospace, monospace`;
      share.forEach((s, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const x = c * cw;
        const y = r * ch;
        const load = running ? (offered * s) / SECTOR_CAPACITY : 0;
        ctx.fillStyle = colors.shoal;
        ctx.fillRect(x + 2, y + 2, cw - 4, ch - 4);
        if (load > 0) {
          ctx.globalAlpha = Math.min(1, load) * 0.75;
          ctx.fillStyle = colors.accent;
          ctx.fillRect(x + 2, y + 2, cw - 4, ch - 4);
          ctx.globalAlpha = 1;
        }
        ctx.lineWidth = load > 1 ? 2 : 1;
        ctx.strokeStyle = load > 1 ? colors.caution : colors.strong;
        ctx.strokeRect(x + 2.5, y + 2.5, cw - 5, ch - 5);
        if (load > 1) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 2, y + 2, cw - 4, ch - 4);
          ctx.clip();
          ctx.strokeStyle = colors.caution;
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = 1;
          for (let k = -ch; k < cw; k += 8) {
            ctx.beginPath();
            ctx.moveTo(x + k, y + ch);
            ctx.lineTo(x + k + ch, y);
            ctx.stroke();
          }
          ctx.restore();
        }
        if (cw > 70 && ch > 34) {
          ctx.fillStyle = colors.ink;
          ctx.fillText(`S${String(i + 1).padStart(2, "0")}`, x + 8, y + 16);
          if (running) {
            ctx.fillStyle = load > 1 ? colors.caution : colors.ink3;
            ctx.fillText(`${compact(agents * s)} · ${Math.round(load * 100)}%`, x + 8, y + 29);
          }
        }
      });
      if (running) {
        const t = reduce ? 0 : time / 1000;
        for (const d of dots) {
          const c = d.sector % cols;
          const r = Math.floor(d.sector / cols);
          const px = c * cw + 8 + (d.x * (cw - 16) + Math.sin(t * 0.6 + d.p) * 3);
          const py = r * ch + 36 + (d.y * Math.max(4, ch - 44) + Math.cos(t * 0.5 + d.p) * 2);
          ctx.fillStyle = colors.vessels[d.c];
          ctx.globalAlpha = 0.85;
          ctx.fillRect(px, py, 2, 2);
        }
        ctx.globalAlpha = 1;
      }
      if (running && !reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [agents, sectors, running, size, share, theme]);

  return (
    <canvas
      ref={ref}
      className="sim__canvas"
      style={{ width: size.w, height: size.h }}
      role="img"
      aria-label={`Sector density: ${int(agents)} agents over ${sectors} sectors. Each cell is a sector. Darker cells carry more course checks. Hatched cells are over capacity.`}
    />
  );
}

/** Milliseconds: two decimals under 10 ms. */
function ms(v: number): string {
  return v < 10 ? v.toFixed(2) : String(Math.round(v));
}

export function SimView() {
  const sim = useStore((s) => s.state?.sim);
  const [x, setX] = useState(fromAgents(sim?.agents ?? 10_000));
  const [sectors, setSectors] = useState(sim?.sectors ?? 16);
  const [busy, setBusy] = useState(false);
  const owner = useIsOwner();
  const agents = toAgents(x);
  const running = Boolean(sim?.running);
  const shown: SimStats | undefined = sim;
  const capacity = sectors * SECTOR_CAPACITY;
  const offered = agents * CHECKS_PER_AGENT;
  const rho = offered / capacity;

  const start = async () => {
    setBusy(true);
    try {
      await harbor().simStart(agents, sectors);
    } catch (e) {
      toast({ tone: "danger", title: "The simulation did not start", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await harbor().simStop();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page sim">
      <p className="page__eyebrow">
        <Icon name="waves" size={14} /> Simulation
      </p>
      <h1 className="page__title" tabIndex={-1}>
        Simulate scale
      </h1>
      <p className="page__lede">
        Run synthetic agents over sector shards. Each sector checks the courses in its code region. There are no models and no forks in the simulation: it
        measures the coordination.
      </p>

      <section className="sim__controls" aria-label="Simulation controls">
        <div className="sim__slider">
          <label htmlFor="sim-agents" className="b-field__label">
            Agents
          </label>
          <input
            id="sim-agents"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={x}
            onChange={(e) => setX(Number(e.target.value))}
            aria-valuetext={`${int(agents)} agents`}
          />
          <output htmlFor="sim-agents" className="sim__value voice-agent">
            {int(agents)}
          </output>
          <span className="sim__scale voice-agent" aria-hidden="true">
            <span>100</span>
            <span>1k</span>
            <span>10k</span>
            <span>100k</span>
          </span>
        </div>
        <div className="sim__slider">
          <label htmlFor="sim-sectors" className="b-field__label">
            Sectors
          </label>
          <input
            id="sim-sectors"
            type="range"
            min={1}
            max={64}
            step={1}
            value={sectors}
            onChange={(e) => setSectors(Number(e.target.value))}
            aria-valuetext={`${sectors} sectors`}
          />
          <output htmlFor="sim-sectors" className="sim__value voice-agent">
            {sectors}
          </output>
          <span className="sim__scale voice-agent" aria-hidden="true">
            <span>1</span>
            <span>16</span>
            <span>32</span>
            <span>64</span>
          </span>
        </div>
        <div className="sim__actions">
          <p className={["sim__load", rho > 1 && "is-over"].filter(Boolean).join(" ")}>
            Offered load <span className="voice-agent">{compact(offered)}</span> checks/s · capacity <span className="voice-agent">{compact(capacity)}</span> ·{" "}
            <span className="voice-agent">{Math.round(rho * 100)}%</span>
            {rho > 1 ? ". Add sectors: checks queue up." : "."}
          </p>
          {!owner ? (
            <p className="sim__note">{running ? "A simulation runs now. Its owner stops it." : "Owners of this project start the simulation."}</p>
          ) : running ? (
            <Button variant="danger" icon="stop" busy={busy} onClick={stop}>
              Stop simulation
            </Button>
          ) : (
            <Button variant="primary" icon="play" busy={busy} onClick={start}>
              Start simulation
            </Button>
          )}
        </div>
      </section>

      <section className="sim__metrics" aria-label="Live metrics" aria-live="off">
        <StatRow label="Throughput">
          <Stat variant="hero" value={shown ? compact(shown.courseChecksPerSec) : "—"} label="course checks / s" source="Course checks served per second, all sectors." />
          <Stat value={shown ? compact(shown.correctionsPerSec) : "—"} label="corrections / s" source="Corrections from course checks, all sectors." />
          <Stat value={shown ? compact(shown.replotsPerSec ?? 0) : "—"} label="re-plots / s" source="Work in progress that Gitring moved onto a new main after a landing near it." />
          <Stat value={shown ? (shown.landingsPerSec >= 100 ? compact(shown.landingsPerSec) : shown.landingsPerSec.toFixed(1)) : "—"} label="landings / s" />
        </StatRow>
        <StatRow label="Safety and latency">
          <Stat value={shown ? int(shown.collisionsAvoided) : "—"} label="collisions avoided" source="Range-0 pairs that a correction cleared before landing." />
          <Stat value={shown ? int(shown.conflictsAtLanding) : "—"} label="conflicts at landing" good={Boolean(shown && shown.conflictsAtLanding === 0)} />
          <Stat
            value={shown?.conflictRate !== undefined ? `${(shown.conflictRate * 100).toFixed(1)}%` : "—"}
            label="conflict rate with Gitring"
            good={Boolean(shown && (shown.conflictRate ?? 1) < (shown.baselineConflictRate ?? 0))}
            source="Landings that hit lines or interfaces changed by an earlier landing, with course checks on."
          />
          <Stat
            value={shown?.baselineConflictRate !== undefined ? `${(shown.baselineConflictRate * 100).toFixed(1)}%` : "—"}
            label="without Gitring (baseline shard)"
            source="The same agents and density in one extra sector with course checks off."
          />
          <Stat
            value={shown ? ms(shown.p50CheckMs) : "—"}
            unit="ms"
            label="p50 check"
            source="Wall time of each sector tick divided by its course checks. The simulation decides with the rules of the road, not with Clef."
          />
          <Stat value={shown ? ms(shown.p99CheckMs) : "—"} unit="ms" label="p99 check" />
          <Stat value={shown ? duration(shown.elapsedMs) : "—"} label={running ? "running" : "last run"} />
        </StatRow>
      </section>

      <section className="sim__density" aria-labelledby="density-title">
        <div className="sim__densityhead">
          <h2 className="page__h2" id="density-title">
            Sector density
          </h2>
          <p>One cell per sector. Darker cells carry more course checks. Hatched cells are over capacity. Dots are agents, in their identity colors.</p>
        </div>
        <div className="sim__canvaswrap">
          <SectorCanvas
            agents={running ? shown?.agents ?? agents : agents}
            sectors={running ? shown?.sectors ?? sectors : sectors}
            running={running}
            loads={shown?.sectorLoad}
          />
        </div>
      </section>

      <section className="sim__how" aria-labelledby="how-title">
        <h2 className="page__h2" id="how-title">
          How Gitring scales
        </h2>
        <ul>
          <li>
            <strong>Most courses clear without a model call.</strong> Gitring asks the model only when another vessel is within range R3.
          </li>
          <li>
            <strong>One sector per code region.</strong> A sector Durable Object checks the courses in its region. In this simulation each agent works inside
            one region; a course that crosses regions goes to each sector it touches.
          </li>
          <li>
            <strong>One writer of main.</strong> The HarborMaster keeps the landing queue. Sectors never write main.
          </li>
          <li>
            <strong>Batched decisions.</strong> One Clef-flash call answers up to 20 candidates (60 questions).
          </li>
        </ul>
      </section>
    </div>
  );
}
