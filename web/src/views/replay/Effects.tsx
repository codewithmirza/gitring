/**
 * Map effects of the replay, in screen space above the map: a plan draws its course, a conflict check
 * sweeps and reaches its candidates, a change request flies to its agent as a magenta diamond, tests ring
 * the work copy, a commit ripples over the files it changed.
 *
 * React renders an effect once when it starts and once when it ends. In between, the frame callback of the
 * replay clock paints it: it writes a few geometry and paint attributes on the effect's own elements.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ReplayClock } from "./clock";
import { easeInOut, easeOut, effectsAt, type Effect, type ReplayScript } from "./model";

export interface Point {
  x: number;
  y: number;
}

/** Screen geometry of the map now. */
export interface Geo {
  /** Where a work copy is (its vessel, or where it was last). */
  pos: (attemptId: string | undefined) => Point | null;
  /** The screen rectangle of a file on main. */
  parcel: (path: string) => { x: number; y: number; w: number; h: number } | null;
  /** Where a file is (its parcel or its island). */
  anchor: (path: string) => Point | null;
  /** The color index of the agent of a work copy. */
  color: (attemptId: string | undefined) => number;
  width: number;
  height: number;
  /** Glyph scale: 1 at 1280×720, more on large screens. */
  g: number;
}

type Paint = (p: number) => void;
type Register = (id: string, paint: Paint | null) => void;

const TONE: Record<Effect["tone"], string> = { accent: "var(--accent)", magenta: "var(--magenta)", clear: "var(--clear)", danger: "var(--danger)", caution: "var(--caution)" };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Fade with the paint opacities. A change of the `opacity` or the `transform` attribute in each frame makes
 * the browser sort the layers of the whole map again (a dropped frame now and then): the effects change
 * only geometry and paint, so a frame costs a repaint of the effects.
 */
function fade(el: Element | null | undefined, a: number): void {
  if (!el) return;
  const v = clamp01(a).toFixed(3);
  el.setAttribute("fill-opacity", v);
  el.setAttribute("stroke-opacity", v);
}

function moveTo(el: Element | null | undefined, x: number, y: number, ax = "x", ay = "y"): void {
  if (!el) return;
  el.setAttribute(ax, x.toFixed(1));
  el.setAttribute(ay, y.toFixed(1));
}

/** A diamond around a point (the mark of a change request). */
const diamond = (x: number, y: number, s: number) => `M${x} ${y - s}L${x + s} ${y}L${x} ${y + s}L${x - s} ${y}Z`;

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** The effects layer. */
export function Effects({ script, clock, geo }: { script: ReplayScript; clock: ReplayClock; geo: Geo }) {
  const [active, setActive] = useState<Effect[]>([]);
  const paints = useRef(new Map<string, Paint>());
  const key = useRef("");
  const schedule = clock.schedule;
  const still = useMemo(reducedMotion, []);

  const register = useCallback<Register>((id, paint) => {
    if (paint) paints.current.set(id, paint);
    else paints.current.delete(id);
  }, []);

  const frame = useCallback(
    (wall: number) => {
      const list = still ? [] : effectsAt(script, schedule, wall);
      const k = list.map((e) => (e.labelled ? e.id : `${e.id}~`)).join("|");
      if (k !== key.current) {
        key.current = k;
        setActive(list);
      }
      for (const e of list) paints.current.get(e.id)?.(e.p);
    },
    [script, schedule, still],
  );

  useEffect(() => clock.onFrame(frame), [clock.onFrame, frame]);
  // New effects mount after the frame that found them: paint them at once, before the browser paints.
  useLayoutEffect(() => {
    for (const e of effectsAt(script, schedule, clock.wall())) paints.current.get(e.id)?.(e.p);
  });

  return (
    <svg className="rp-fx" width={geo.width} height={geo.height} aria-hidden="true">
      {active.map((e) => (
        <EffectShape key={e.id} e={e} geo={geo} register={register} />
      ))}
    </svg>
  );
}

const EffectShape = memo(function EffectShape({ e, geo, register }: { e: Effect; geo: Geo; register: Register }) {
  switch (e.kind) {
    case "course":
      return <Course e={e} geo={geo} register={register} />;
    case "sweep":
      return <Sweep e={e} geo={geo} register={register} />;
    case "flight":
      return <Flight e={e} geo={geo} register={register} />;
    case "pop":
    case "ack":
    case "ring":
    case "lease":
      return <Ring e={e} geo={geo} register={register} />;
    case "wake":
    case "commit":
      return <Ripple e={e} geo={geo} register={register} />;
    case "replot":
      return <Replot e={e} geo={geo} register={register} />;
    default:
      return null;
  }
});

interface ShapeProps {
  e: Effect;
  geo: Geo;
  register: Register;
}

function useRegister(id: string, register: Register, paint: Paint) {
  useLayoutEffect(() => {
    register(id, paint);
    return () => register(id, null);
  }, [id, register, paint]);
}

/** A point on a polyline at a share of its length. */
function along(points: Point[], lengths: number[], total: number, t: number): Point {
  let d = t * total;
  for (let i = 1; i < points.length; i++) {
    const seg = lengths[i - 1];
    if (d <= seg || i === points.length - 1) {
      const f = seg ? clamp01(d / seg) : 1;
      return { x: lerp(points[i - 1].x, points[i].x, f), y: lerp(points[i - 1].y, points[i].y, f) };
    }
    d -= seg;
  }
  return points[points.length - 1];
}

/** A plan draws its course: from the agent through the files of the plan. */
function Course({ e, geo, register }: ShapeProps) {
  const path = useRef<SVGPathElement>(null);
  const head = useRef<SVGCircleElement>(null);
  const group = useRef<SVGGElement>(null);
  const start = geo.pos(e.step.attemptId);
  const points = useMemo(() => {
    const ahead = (e.step.files ?? []).map((f) => geo.anchor(f)).filter((p): p is Point => Boolean(p));
    return start ? [start, ...ahead] : ahead;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.id, start?.x, start?.y, geo]);
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  const total = lengths.reduce((s, l) => s + l, 0);
  const paint = useCallback<Paint>(
    (p) => {
      const t = easeOut(clamp01(p / 0.7));
      path.current?.setAttribute("stroke-dashoffset", String(total * (1 - t)));
      const at = points.length > 1 ? along(points, lengths, total, t) : points[0];
      if (at) moveTo(head.current, at.x, at.y, "cx", "cy");
      fade(group.current, p > 0.78 ? 1 - (p - 0.78) / 0.22 : 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, total],
  );
  useRegister(e.id, register, paint);
  if (points.length < 2) return null;
  const d = `M${points.map((p) => `${p.x} ${p.y}`).join(" L")}`;
  const style = { "--vc": `var(--v${geo.color(e.step.attemptId) % 12})` } as CSSProperties;
  return (
    <g ref={group} className="rp-fx-course" style={style}>
      <path ref={path} d={d} strokeDasharray={`${total} ${total}`} strokeDashoffset={total} strokeWidth={2.5 * geo.g} />
      <circle ref={head} cx={points[0].x} cy={points[0].y} r={4.5 * geo.g} />
    </g>
  );
}

/** A conflict check: a sweep around the agent, and a line to each candidate with its distance. */
function Sweep({ e, geo, register }: ShapeProps) {
  const ring = useRef<SVGCircleElement>(null);
  const lines = useRef<(SVGLineElement | null)[]>([]);
  const badges = useRef<(SVGGElement | null)[]>([]);
  const c = geo.pos(e.step.attemptId);
  const facts = useMemo(() => [...(e.step.check?.facts ?? [])].sort((a, b) => a.range - b.range).slice(0, 4), [e.step.check]);
  const others = facts.map((f) => ({ f, at: geo.pos(f.otherAttemptId) }));
  const g = geo.g;
  const paint = useCallback<Paint>(
    (p) => {
      if (!c) return;
      const r = lerp(8 * g, 88 * g, easeOut(p));
      ring.current?.setAttribute("r", String(r));
      fade(ring.current, 0.9 * (1 - p));
      const reach = easeOut(clamp01(p / 0.45));
      others.forEach((o, i) => {
        if (!o.at) return;
        const l = lines.current[i];
        moveTo(l, lerp(c.x, o.at.x, reach), lerp(c.y, o.at.y, reach), "x2", "y2");
        fade(l, p > 0.8 ? (1 - p) / 0.2 : 1);
        fade(badges.current[i], p < 0.4 ? 0 : p > 0.85 ? (1 - p) / 0.15 : 1);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c?.x, c?.y, others.map((o) => `${o.at?.x},${o.at?.y}`).join(";"), g],
  );
  useRegister(e.id, register, paint);
  if (!c) return null;
  return (
    <g className="rp-fx-sweep" style={{ "--tone": TONE[e.tone] } as CSSProperties}>
      <circle ref={ring} cx={c.x} cy={c.y} r={8 * g} strokeWidth={2 * g} />
      {others.map((o, i) =>
        o.at ? (
          <g key={o.f.otherAttemptId}>
            <line
              ref={(el) => {
                lines.current[i] = el;
              }}
              x1={c.x}
              y1={c.y}
              x2={c.x}
              y2={c.y}
              strokeWidth={1.5 * g}
              className={o.f.range <= 1 ? "is-close" : undefined}
            />
            <g
              ref={(el) => {
                badges.current[i] = el;
              }}
              fillOpacity={0}
              strokeOpacity={0}
              transform={`translate(${o.at.x} ${o.at.y - 22 * g})`}
            >
              <rect x={-11 * g} y={-10 * g} width={22 * g} height={20 * g} rx={3 * g} />
              <text y={5 * g} fontSize={13 * g}>
                {o.f.range}
              </text>
            </g>
          </g>
        ) : null,
      )}
    </g>
  );
}

/** A change request flies from the agent that continues to the agent that adapts. */
function Flight({ e, geo, register }: ShapeProps) {
  const mark = useRef<SVGPathElement>(null);
  const trail = useRef<SVGPathElement>(null);
  const label = useRef<SVGTextElement>(null);
  const g = geo.g;
  const to = geo.pos(e.step.attemptId) ?? (e.step.files?.[0] ? geo.anchor(e.step.files[0]) : null);
  const from = geo.pos(e.step.correction?.standOnAttemptId) ?? { x: geo.width / 2, y: -20 };
  const ctrl = useMemo(() => {
    if (!to) return null;
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    // Bend the path up (screen), so it reads as a flight and not as a distance line.
    const side = dx >= 0 ? -1 : 1;
    return { x: mx + (-dy / len) * len * 0.28 * side, y: my + (dx / len) * len * 0.28 * side - 18 * g };
  }, [from.x, from.y, to?.x, to?.y, g]);
  const total = to && ctrl ? Math.hypot(ctrl.x - from.x, ctrl.y - from.y) + Math.hypot(to.x - ctrl.x, to.y - ctrl.y) : 0;
  const paint = useCallback<Paint>(
    (p) => {
      if (!to || !ctrl) return;
      const t = easeInOut(clamp01(p / 0.78));
      const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * ctrl.x + t * t * to.x;
      const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * ctrl.y + t * t * to.y;
      const land = p > 0.78 ? (p - 0.78) / 0.22 : 0;
      const scale = 1 + Math.sin(land * Math.PI) * 0.7;
      mark.current?.setAttribute("d", diamond(x, y, 8 * g * scale));
      trail.current?.setAttribute("stroke-dashoffset", String(total * (1 - t)));
      fade(trail.current, p > 0.7 ? ((1 - p) / 0.3) * 0.7 : 0.7);
      moveTo(label.current, x + 12 * g, y - 10 * g);
      fade(label.current, p < 0.08 ? p / 0.08 : p > 0.7 ? (0.9 - p) / 0.2 : 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [from.x, from.y, to?.x, to?.y, ctrl, total, g],
  );
  useRegister(e.id, register, paint);
  if (!to || !ctrl) return null;
  return (
    <g className="rp-fx-flight">
      <path ref={trail} className="rp-fx-flight__trail" d={`M${from.x} ${from.y} Q${ctrl.x} ${ctrl.y} ${to.x} ${to.y}`} strokeDasharray={`${total} ${total}`} strokeDashoffset={total} strokeWidth={2 * g} />
      <path ref={mark} className="rp-fx-flight__mark" d={diamond(from.x, from.y, 8 * g)} strokeWidth={2 * g} />
      <text ref={label} className="rp-fx-label" x={from.x + 12 * g} y={from.y - 10 * g} fontSize={13 * g} fillOpacity={0} strokeOpacity={0}>
        change request
      </text>
    </g>
  );
}

/** A ring at a work copy: tests (pass or fail), a change request that arrives or is applied, the merge lease. */
function Ring({ e, geo, register }: ShapeProps) {
  const ring = useRef<SVGCircleElement>(null);
  const tag = useRef<SVGTextElement>(null);
  const g = geo.g;
  const at = geo.pos(e.step.attemptId);
  const text = e.labelled ? labelOf(e) : null;
  const paint = useCallback<Paint>(
    (p) => {
      if (!at) return;
      const t = easeOut(p);
      const r0 = e.kind === "pop" ? 6 : 12;
      const r1 = e.kind === "lease" ? 22 : e.kind === "pop" ? 26 : 34;
      ring.current?.setAttribute("r", String(lerp(r0, r1, t) * g));
      fade(ring.current, e.kind === "lease" ? 0.9 * (1 - p * 0.6) : 0.95 * (1 - p));
      fade(tag.current, p < 0.12 ? p / 0.12 : p > 0.8 ? (1 - p) / 0.2 : 1);
      moveTo(tag.current, at.x + 18 * g, at.y + 26 * g - t * 6 * g);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [at?.x, at?.y, g, e.kind],
  );
  useRegister(e.id, register, paint);
  if (!at) return null;
  return (
    <g className={`rp-fx-ring rp-fx-ring--${e.kind}`} style={{ "--tone": TONE[e.tone] } as CSSProperties}>
      <circle ref={ring} cx={at.x} cy={at.y} r={12 * g} strokeWidth={(e.kind === "lease" ? 3 : 2.5) * g} />
      {text && (
        <text ref={tag} className="rp-fx-label" x={at.x + 18 * g} y={at.y + 26 * g} fontSize={13 * g} fillOpacity={0} strokeOpacity={0}>
          {text}
        </text>
      )}
    </g>
  );
}

function labelOf(e: Effect): string | null {
  const t = e.step.tests;
  if (e.kind === "ring" && t) return `${t.scope === "composed" ? "main + work " : ""}${t.passed}/${t.total} ${t.ok ? "pass" : "fail"}`;
  if (e.kind === "ring" && e.step.kind === "stale") return "cannot merge";
  if (e.kind === "ack") return "applied";
  if (e.kind === "lease") return "merge lease";
  if (e.kind === "pop") return "reached";
  return null;
}

/** Files flash: the files that an agent writes (blue), or the files of a commit on main (green, with a ring). */
function Ripple({ e, geo, register }: ShapeProps) {
  const rects = useRef<SVGGElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const tag = useRef<SVGTextElement>(null);
  const g = geo.g;
  const boxes = useMemo(
    () => (e.step.files ?? []).map((f) => geo.parcel(f)).filter((b): b is NonNullable<typeof b> => Boolean(b)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [e.id, geo],
  );
  const commit = e.kind === "commit";
  const at = commit ? geo.pos(e.step.attemptId) ?? (boxes[0] ? { x: boxes[0].x + boxes[0].w / 2, y: boxes[0].y + boxes[0].h / 2 } : null) : null;
  const paint = useCallback<Paint>(
    (p) => {
      fade(rects.current, (commit ? 0.55 : 0.4) * (1 - easeOut(p)));
      if (at) {
        ring.current?.setAttribute("r", String(lerp(10, 96, easeOut(p)) * g));
        fade(ring.current, 0.9 * (1 - p));
        fade(tag.current, p < 0.1 ? p / 0.1 : p > 0.75 ? (1 - p) / 0.25 : 1);
        moveTo(tag.current, at.x, at.y - (22 + easeOut(p) * 26) * g);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [at?.x, at?.y, g, commit],
  );
  useRegister(e.id, register, paint);
  return (
    <g className={`rp-fx-ripple rp-fx-ripple--${e.kind}`} style={{ "--tone": TONE[e.tone] } as CSSProperties}>
      <g ref={rects} fillOpacity={0}>
        {boxes.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={2} />
        ))}
      </g>
      {at && <circle ref={ring} cx={at.x} cy={at.y} r={10 * g} strokeWidth={3 * g} />}
      {at && e.step.landing && (
        <text ref={tag} className="rp-fx-label rp-fx-label--center" x={at.x} y={at.y - 22 * g} fontSize={14 * g} fillOpacity={0} strokeOpacity={0}>
          main {e.step.landing.mainAfter.slice(0, 7)}
        </text>
      )}
    </g>
  );
}

/** Main moved: each work copy that gitring moves onto the new main gets a ring. */
function Replot({ e, geo, register }: ShapeProps) {
  const rings = useRef<(SVGCircleElement | null)[]>([]);
  const g = geo.g;
  const points = (e.step.others ?? []).map((id) => geo.pos(id));
  const paint = useCallback<Paint>(
    (p) => {
      rings.current.forEach((r, i) => {
        const delay = Math.min(0.3, i * 0.08);
        const t = clamp01((p - delay) / (1 - delay));
        r?.setAttribute("r", String(lerp(8, 46, easeOut(t)) * g));
        fade(r, t <= 0 ? 0 : 0.9 * (1 - t));
      });
    },
    [g],
  );
  useRegister(e.id, register, paint);
  return (
    <g className="rp-fx-replot" style={{ "--tone": TONE[e.tone] } as CSSProperties}>
      {points.map((at, i) =>
        at ? (
          <circle
            key={i}
            ref={(el) => {
              rings.current[i] = el;
            }}
            cx={at.x}
            cy={at.y}
            r={8 * g}
            strokeOpacity={0}
            strokeWidth={2.5 * g}
          />
        ) : null,
      )}
    </g>
  );
}
