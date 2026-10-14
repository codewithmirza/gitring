/**
 * The overview map: a map of the repository with every active agent, its plan, the files it
 * touched, its distance to other work and every change request (marker).
 *
 * Geometry lives in world units; strokes are non-scaling hairlines; glyphs and labels
 * keep a constant screen size. Layers are memoized so an event re-renders only what moved.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import type { FileNode, Range } from "../../../src/core/types";
import { useStore } from "../state/store";
import { selectBuoys, selectRangeLines, selectVessels, type BuoyModel, type RangeLine, type VesselModel } from "../state/selectors";
import { anchorOf, islandOf, layoutChart, type ChartLayout, type Parcel } from "./layout";
import { usePanZoom, type Transform } from "./panzoom";
import { HULL_PATHS, type HullName } from "../design/icons";
import { ATTEMPT_STATUS_TEXT, CORRECTION_KIND_SHORT, CORRECTION_KIND_TEXT, kb, RANGE_TEXT, shortSha } from "../state/format";
import { Button, EmptyState, IconButton } from "../design/components";
import { openNewIntent } from "../app/ui";
import { useCanAct } from "../state/account";
import { launchAllNow } from "../app/actions";
import { ImportPanel } from "../app/ImportPanel";
import { ChartLegend } from "./ChartLegend";
import "./chart.css";

const EMPTY: never[] = [];

/* ───────────── placement ───────────── */

export interface Placement {
  wx: number;
  wy: number;
  ox: number;
  oy: number;
  heading: number;
  offshore: boolean;
}

export function placeVessels(vessels: VesselModel[], layout: ChartLayout, compact = false): Map<string, Placement> {
  const spots = new Map<string, { wx: number; wy: number; offshore: boolean; list: VesselModel[] }>();
  for (const v of vessels) {
    let key = "";
    let wx = 0;
    let wy = 0;
    let offshore = false;
    const at = v.file ? anchorOf(layout, v.file) : null;
    const parcel = v.file ? layout.parcels.get(v.file) : undefined;
    if (at) {
      key = `f:${v.file}`;
      // Stacks sit at the parcel's left edge, so callsign tags extend over their own file.
      wx = parcel ? parcel.x0 : at.x;
      wy = at.y;
    } else {
      const first = v.courseFiles[0];
      const isl = first ? layout.islandById.get(islandOf(first)) : undefined;
      const p = first ? layout.parcels.get(first) : undefined;
      offshore = true;
      if (isl) {
        key = `o:${isl.id}`;
        wx = isl.x0 - 38;
        wy = p ? p.cy : (isl.y0 + isl.y1) / 2;
      } else {
        key = "o:sea";
        wx = layout.bounds.x0 + 70;
        wy = layout.bounds.y0 + 70;
      }
    }
    const s = spots.get(key) ?? { wx, wy, offshore, list: [] };
    s.list.push(v);
    spots.set(key, s);
  }
  const out = new Map<string, Placement>();
  for (const s of spots.values()) {
    const n = s.list.length;
    // Compact (large fleets): glyphs only, in a tight grid. Otherwise stacks with room for tags.
    const cols = compact ? Math.ceil(Math.sqrt(n)) : n > 8 ? 3 : n > 4 ? 2 : 1;
    const rows = Math.ceil(n / cols);
    const gx = compact ? 17 : 106;
    const gy = compact ? 17 : 26;
    s.list.forEach((v, i) => {
      const col = compact ? i % cols : Math.floor(i / rows);
      const row = compact ? Math.floor(i / cols) : i % rows;
      const ox = s.offshore ? (col - (cols - 1) / 2) * (compact ? gx : 104) : 17 + col * gx;
      const oy = (row - (rows - 1) / 2) * gy;
      const cur = v.file ? anchorOf(layout, v.file) ?? { x: s.wx, y: s.wy } : { x: s.wx, y: s.wy };
      const prev = v.track.length >= 2 ? anchorOf(layout, v.track[v.track.length - 2]) : null;
      const next = v.course.length ? anchorOf(layout, v.course[0]) : null;
      let heading = s.offshore ? 90 : 0;
      if (prev && (prev.x !== cur.x || prev.y !== cur.y)) heading = (Math.atan2(cur.x - prev.x, -(cur.y - prev.y)) * 180) / Math.PI;
      else if (next && (next.x !== cur.x || next.y !== cur.y)) heading = (Math.atan2(next.x - cur.x, -(next.y - cur.y)) * 180) / Math.PI;
      out.set(v.attemptId, { wx: s.wx, wy: s.wy, ox, oy, heading, offshore: s.offshore });
    });
  }
  return out;
}

/* ───────────── static layers ───────────── */

export const Sea = memo(function Sea({ layout }: { layout: ChartLayout }) {
  return (
    <g className="c-sea" aria-hidden="true">
      {layout.islands.map((i) => (
        <g key={i.id}>
          <rect className="c-depth" x={i.x0 - 30} y={i.y0 - 30} width={i.x1 - i.x0 + 60} height={i.y1 - i.y0 + 60} rx={26} />
          <rect className="c-shoal" x={i.x0 - 13} y={i.y0 - 13} width={i.x1 - i.x0 + 26} height={i.y1 - i.y0 + 26} rx={14} />
        </g>
      ))}
    </g>
  );
});

export const Land = memo(function Land({ layout }: { layout: ChartLayout }) {
  return (
    <g className="c-land" aria-hidden="true">
      {layout.islands.map((i) => (
        <rect key={i.id} className="c-island" x={i.x0} y={i.y0} width={i.x1 - i.x0} height={i.y1 - i.y0} rx={5} />
      ))}
    </g>
  );
});

export const Parcels = memo(function Parcels({
  layout,
  kq,
  onHover,
  onParcel,
}: {
  layout: ChartLayout;
  kq: number;
  onHover: (p: Parcel | null, e?: RPointerEvent) => void;
  onParcel?: (path: string) => void;
}) {
  const fs = 10 / kq;
  return (
    <g className="c-parcels">
      {layout.islands.map((i) => (
        <g key={i.id}>
          {22 * kq >= 12 && (
            <text className="c-island-label" x={i.x0 + 8} y={i.y0 + 11 + 4 / kq} fontSize={fs}>
              {i.label}
            </text>
          )}
          {i.parcels.map((p) => {
            const w = (p.x1 - p.x0) * kq;
            const h = (p.y1 - p.y0) * kq;
            const nameFits = w >= p.name.length * 6 + 8 && h >= 17;
            const soundFits = nameFits && h >= 32;
            return (
              <g
                key={p.path}
                className="c-parcel"
                onPointerEnter={(e) => onHover(p, e)}
                onPointerMove={(e) => onHover(p, e)}
                onPointerLeave={() => onHover(null)}
                onClick={() => onParcel?.(p.path)}
              >
                <rect x={p.x0} y={p.y0} width={p.x1 - p.x0} height={p.y1 - p.y0} rx={1.5} />
                {nameFits && (
                  <text className="c-parcel-label" x={p.x0 + 5 / kq} y={p.y0 + 13 / kq} fontSize={fs}>
                    {p.name}
                  </text>
                )}
                {soundFits && (
                  <text className="c-sounding" x={p.x0 + 5 / kq} y={p.y0 + 26 / kq} fontSize={fs}>
                    {kb(p.size)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      ))}
    </g>
  );
});

export function CompassRose({ x, y, r }: { x: number; y: number; r: number }) {
  const ticks = [];
  for (let d = 0; d < 360; d += 10) {
    const long = d % 30 === 0;
    const a = (d * Math.PI) / 180;
    const r0 = r - (long ? 7 : 4);
    ticks.push(
      <line key={d} x1={x + Math.sin(a) * r0} y1={y - Math.cos(a) * r0} x2={x + Math.sin(a) * r} y2={y - Math.cos(a) * r} />,
    );
  }
  const w = r * 0.13;
  const tip = r * 0.78;
  const tri = (ax: number, ay: number, bx: number, by: number) => `M${x} ${y} L${x + ax} ${y + ay} L${x + bx} ${y + by}Z`;
  return (
    <g className="c-rose" aria-hidden="true">
      <circle cx={x} cy={y} r={r} />
      <circle cx={x} cy={y} r={r * 0.6} className="c-rose__inner" />
      {ticks}
      <path className="c-rose__dark" d={tri(0, -tip, -w, -w)} />
      <path className="c-rose__light" d={tri(0, -tip, w, -w)} />
      <path className="c-rose__dark" d={tri(tip, 0, w, -w)} />
      <path className="c-rose__light" d={tri(tip, 0, w, w)} />
      <path className="c-rose__dark" d={tri(0, tip, w, w)} />
      <path className="c-rose__light" d={tri(0, tip, -w, w)} />
      <path className="c-rose__dark" d={tri(-tip, 0, -w, w)} />
      <path className="c-rose__light" d={tri(-tip, 0, -w, -w)} />
      <text x={x} y={y - r - 6} textAnchor="middle" className="c-rose__n">
        N
      </text>
    </g>
  );
}

/* ───────────── screen-space frame + graticule ───────────── */

function colName(i: number): string {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export const Graticule = memo(function Graticule({ t, w, h, origin, part }: { t: Transform; w: number; h: number; origin: { x: number; y: number }; part: "grid" | "frame" }) {
  let step = 64;
  while (step * t.k < 44) step *= 2;
  while (step * t.k > 150 && step > 16) step /= 2;
  const xs: number[] = [];
  const ys: number[] = [];
  const wx0 = -t.x / t.k;
  const wy0 = -t.y / t.k;
  for (let wx = Math.floor(wx0 / step) * step; wx * t.k + t.x < w; wx += step) xs.push(wx);
  for (let wy = Math.floor(wy0 / step) * step; wy * t.k + t.y < h; wy += step) ys.push(wy);
  const sx = (wx: number) => Math.round(wx * t.k + t.x) + 0.5;
  const sy = (wy: number) => Math.round(wy * t.k + t.y) + 0.5;
  const label = (wx: number, axis: "x" | "y") => {
    const i = Math.round(((axis === "x" ? wx - origin.x : wx - origin.y) as number) / 64);
    if (i < 0) return null;
    return axis === "x" ? colName(i) : String(i + 1);
  };
  const B = 6; // frame band: 1px + 3px gap + 1px, inset by 1
  if (part === "grid") {
    // Extend one viewport on each side: a drag preview moves this layer before React re-renders.
    const gx: number[] = [];
    const gy: number[] = [];
    for (let wx = Math.floor((wx0 - w / t.k) / step) * step; wx * t.k + t.x < 2 * w; wx += step) gx.push(wx);
    for (let wy = Math.floor((wy0 - h / t.k) / step) * step; wy * t.k + t.y < 2 * h; wy += step) gy.push(wy);
    return (
      <g className="c-grat" aria-hidden="true">
        {gx.map((x) => (
          <line key={`x${x}`} x1={sx(x)} y1={-h} x2={sx(x)} y2={2 * h} />
        ))}
        {gy.map((y) => (
          <line key={`y${y}`} x1={-w} y1={sy(y)} x2={2 * w} y2={sy(y)} />
        ))}
      </g>
    );
  }
  return (
    <g aria-hidden="true">
      <g className="c-frame">
        {/* alternating scale bars inside the double rule, aligned to the graticule */}
        {xs.map((x, i) => {
          const a = Math.max(B, sx(x));
          const b = Math.min(w - B, sx(x + step));
          if (b <= a || Math.round(x / step) % 2 !== 0) return null;
          return (
            <g key={`bx${x}${i}`}>
              <rect className="c-frame__bar" x={a} y={2} width={b - a} height={3} />
              <rect className="c-frame__bar" x={a} y={h - 5} width={b - a} height={3} />
            </g>
          );
        })}
        {ys.map((y, i) => {
          const a = Math.max(B, sy(y));
          const b = Math.min(h - B, sy(y + step));
          if (b <= a || Math.round(y / step) % 2 !== 0) return null;
          return (
            <g key={`by${y}${i}`}>
              <rect className="c-frame__bar" x={2} y={a} width={3} height={b - a} />
              <rect className="c-frame__bar" x={w - 5} y={a} width={3} height={b - a} />
            </g>
          );
        })}
        <rect className="c-frame__rule" x={0.5} y={0.5} width={w - 1} height={h - 1} />
        <rect className="c-frame__rule" x={5.5} y={5.5} width={w - 11} height={h - 11} />
        {xs.map((x) => {
          const l = label(x, "x");
          const px = sx(x);
          if (!l || px < 24 || px > w - 24) return null;
          return (
            <text key={`tx${x}`} className="c-tick" x={px + 4} y={18}>
              {l}
            </text>
          );
        })}
        {ys.map((y) => {
          const l = label(y, "y");
          const py = sy(y);
          if (!l || py < 28 || py > h - 16) return null;
          return (
            <text key={`ty${y}`} className="c-tick" x={10} y={py - 4}>
              {l}
            </text>
          );
        })}
      </g>
    </g>
  );
});

/* ───────────── dynamic layers ───────────── */

export const Contours = memo(function Contours({ layout, vessels }: { layout: ChartLayout; vessels: VesselModel[] }) {
  const counts = new Map<string, number>();
  for (const v of vessels) {
    for (const f of new Set([...v.track, ...(v.file ? [v.file] : [])])) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return (
    <g className="c-contours" aria-hidden="true">
      {[...counts.entries()].map(([path, n]) => {
        const p = layout.parcels.get(path);
        if (!p) return null;
        return Array.from({ length: Math.min(3, n) }, (_, i) => {
          const o = 4 + i * 4;
          return (
            <rect key={`${path}-${i}`} className="c-contour" x={p.x0 - o} y={p.y0 - o} width={p.x1 - p.x0 + o * 2} height={p.y1 - p.y0 + o * 2} rx={2 + o} />
          );
        });
      })}
    </g>
  );
});

const Ripples = memo(function Ripples({ layout }: { layout: ChartLayout }) {
  const ripples = useStore((s) => s.ripples);
  const now = Date.now();
  return (
    <g className="c-ripples" aria-hidden="true">
      {ripples
        .filter((r) => now - r.at < 1500)
        .flatMap((r) =>
          r.files.map((f) => {
            const p = layout.parcels.get(f);
            if (!p) return null;
            return <rect key={`${r.id}-${f}`} className="c-ripple" x={p.x0} y={p.y0} width={p.x1 - p.x0} height={p.y1 - p.y0} rx={1.5} />;
          }),
        )}
    </g>
  );
});

const Track = memo(function Track({ d, color, kind, dim, quiet }: { d: string; color: number; kind: "wake" | "course" | "course-pending"; dim: boolean; quiet?: boolean }) {
  return <path className={`c-${kind}${dim ? " is-dim" : quiet ? " is-quiet" : ""}`} d={d} style={{ "--vc": `var(--v${color % 12})` } as CSSProperties} />;
});

const Waypoint = memo(function Waypoint({ x, y, k, color, dim }: { x: number; y: number; k: number; color: number; dim: boolean }) {
  return <circle className={`c-waypoint${dim ? " is-dim" : ""}`} cx={x} cy={y} r={3 / k} style={{ "--vc": `var(--v${color % 12})` } as CSSProperties} />;
});

interface VesselProps {
  id: string;
  callsign: string;
  color: number;
  hull: HullName;
  wx: number;
  wy: number;
  ox: number;
  oy: number;
  heading: number;
  k: number;
  selected: boolean;
  hovered: boolean;
  dim: boolean;
  label: string;
  waiting: boolean;
  showTag: boolean;
  onSelect: (id: string) => void;
}

const Vessel = memo(function Vessel(p: VesselProps) {
  const tagW = p.callsign.length * 6.7 + 26;
  const style = { "--vc": `var(--v${p.color % 12})`, transform: `translate(${p.wx}px, ${p.wy}px)` } as CSSProperties;
  return (
    <g
      className={["c-vessel", p.selected && "is-selected", p.hovered && "is-hovered", p.dim && "is-dim", p.waiting && "is-waiting"].filter(Boolean).join(" ")}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={p.label}
      aria-pressed={p.selected}
      data-attempt={p.id}
      onClick={(e) => {
        e.stopPropagation();
        p.onSelect(p.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          p.onSelect(p.id);
        }
      }}
    >
      <g transform={`scale(${1 / p.k})`}>
        <g transform={`translate(${p.ox} ${p.oy})`}>
          <circle className="c-vessel__hit" r={13} />
          <circle className="c-vessel__ring" r={13} />
          <line className="c-vessel__heading" x1={0} y1={-9} x2={0} y2={-20} transform={`rotate(${p.heading})`} />
          <path className="c-vessel__hull" d={HULL_PATHS[p.hull]} transform={`rotate(${p.heading}) translate(-8 -8)`} />
          {p.showTag && <g className="c-tag" transform="translate(12 -10)">
            <path
              className="c-tag__bg"
              d={`M9 0 H${tagW} L${tagW - 5} 9 L${tagW} 18 H9 A9 9 0 0 1 9 0 Z`}
            />
            <path className="c-tag__hull" d={HULL_PATHS[p.hull]} transform="translate(5 4.5) scale(0.56)" />
            <text className="c-tag__text" x={17} y={12.5}>
              {p.callsign}
            </text>
          </g>}
        </g>
      </g>
    </g>
  );
});

export const RangeLines = memo(function RangeLines({
  lines,
  pos,
  k,
  selected,
}: {
  lines: RangeLine[];
  pos: Map<string, { x: number; y: number }>;
  k: number;
  selected: string | null;
}) {
  // Labels avoid each other: try the midpoint, then nudge along the line; drop the label if all collide.
  const placed: { x: number; y: number; w: number }[] = [];
  const free = (x: number, y: number, w: number) => !placed.some((p) => Math.abs(p.x - x) * k < (p.w + w) / 2 + 4 && Math.abs(p.y - y) * k < 20);
  return (
    <g className="c-ranges">
      {lines.map((l) => {
        const a = pos.get(l.a);
        const b = pos.get(l.b);
        if (!a || !b) return null;
        const dim = Boolean(selected && l.a !== selected && l.b !== selected);
        const tw = l.label.length * 6.1 + 12;
        const screenLen = Math.hypot(a.x - b.x, a.y - b.y) * k;
        let spot: { x: number; y: number } | null = null;
        if (screenLen >= tw + 44) {
          for (const f of [0.5, 0.38, 0.62, 0.28, 0.72]) {
            const x = a.x + (b.x - a.x) * f;
            const y = a.y + (b.y - a.y) * f;
            if (free(x, y, tw)) {
              spot = { x, y };
              placed.push({ x, y, w: tw });
              break;
            }
          }
        }
        const mx = spot?.x ?? 0;
        const my = spot?.y ?? 0;
        return (
          <g key={l.key} className={`c-range c-range--${l.tone}${dim ? " is-dim" : ""}`}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            {spot && (
              <g transform={`translate(${mx} ${my}) scale(${1 / k})`}>
                <rect className="c-range__bg" x={-tw / 2} y={-9} width={tw} height={18} rx={2} />
                <text className="c-range__text" x={0} y={3.5} textAnchor="middle">
                  {l.label}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
});

const Pulses = memo(function Pulses({ pos, k }: { pos: Map<string, { x: number; y: number }>; k: number }) {
  const pulses = useStore((s) => s.pulses);
  const now = Date.now();
  return (
    <g className="c-pulses" aria-hidden="true">
      {pulses
        .filter((p) => now - p.at < 1600)
        .map((p) => {
          const a = pos.get(p.a);
          const b = pos.get(p.b);
          if (!a || !b) return null;
          return (
            <g key={p.id} transform={`translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2}) scale(${1 / k})`}>
              <circle className="c-pulse" r={22} />
            </g>
          );
        })}
    </g>
  );
});

export const Buoys = memo(function Buoys({
  buoys,
  layout,
  k,
  selected,
  onBuoy,
}: {
  buoys: BuoyModel[];
  layout: ChartLayout;
  k: number;
  selected: string | null;
  onBuoy: (correctionId: string, attemptId: string) => void;
}) {
  const perFile = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const b of buoys) totals.set(b.file, (totals.get(b.file) ?? 0) + 1);
  return (
    <g className="c-buoys">
      {buoys.map((b) => {
        const p = layout.parcels.get(b.file);
        const a = anchorOf(layout, b.file);
        if (!a) return null;
        const n = perFile.get(b.file) ?? 0;
        perFile.set(b.file, n + 1);
        const bx = p ? p.x1 - 9 / k - n * (16 / k) : a.x;
        const by = p ? p.y0 + 10 / k : a.y;
        const kind = CORRECTION_KIND_SHORT[b.correction.kind];
        const dim = Boolean(selected && b.attemptId !== selected);
        const done = b.correction.status === "acknowledged";
        return (
          <g
            key={b.id}
            className={["c-buoy", dim && "is-dim", done && "is-done"].filter(Boolean).join(" ")}
            transform={`translate(${bx} ${by}) scale(${1 / k})`}
            role="button"
            tabIndex={0}
            aria-label={`Change request ${b.id} for ${b.callsign} in ${b.file}: ${CORRECTION_KIND_TEXT[b.correction.kind]}${b.fromCallsign ? `, ${b.fromCallsign} continues` : ""}. Open the change request.`}
            onClick={(e) => {
              e.stopPropagation();
              onBuoy(b.id, b.attemptId);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onBuoy(b.id, b.attemptId);
              }
            }}
          >
            <circle className="c-buoy__hit" r={11} />
            <path className="c-buoy__mark" d="M0 -7 L7 0 L0 7 L-7 0 Z" />
            {/* A word label fits next to a single marker; two or more markers on one file show no labels. */}
            {(totals.get(b.file) ?? 0) === 1 && (
              <text className="c-buoy__label" x={10} y={-6}>
                {kind}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

export const TracksLayer = memo(function TracksLayer({
  vessels,
  layout,
  pos,
  k,
  selected,
  hovered,
}: {
  vessels: VesselModel[];
  layout: ChartLayout;
  pos: Map<string, { x: number; y: number }>;
  k: number;
  selected: string | null;
  hovered: string | null;
}) {
  return (
    <g className="c-tracks">
      {vessels.map((v) => {
        const me = pos.get(v.attemptId);
        if (!me) return null;
        const dim = Boolean(selected && selected !== v.attemptId);
        const focusOn = selected === v.attemptId || hovered === v.attemptId;
        const wake = v.track
          .slice(0, -1)
          .map((f) => anchorOf(layout, f))
          .filter(Boolean) as { x: number; y: number }[];
        const ahead = v.course.map((f) => anchorOf(layout, f)).filter(Boolean) as { x: number; y: number }[];
        const wakeD = wake.length ? `M${wake.map((q) => `${q.x} ${q.y}`).join(" L")} L${me.x} ${me.y}` : "";
        const courseD = ahead.length ? `M${me.x} ${me.y} L${ahead.map((q) => `${q.x} ${q.y}`).join(" L")}` : "";
        return (
          <g key={v.attemptId}>
            {wakeD && <Track d={wakeD} color={v.color} kind="wake" dim={dim} />}
            {courseD && <Track d={courseD} color={v.color} kind={v.checked ? "course" : "course-pending"} dim={dim} quiet={!focusOn && v.checked} />}
            {focusOn && ahead.map((q, i) => <Waypoint key={i} x={q.x} y={q.y} k={k} color={v.color} dim={false} />)}
          </g>
        );
      })}
    </g>
  );
});

export const VesselLayer = memo(function VesselLayer({
  vessels,
  placements,
  k,
  selected,
  hovered,
  compact,
  onSelect,
}: {
  vessels: VesselModel[];
  placements: Map<string, Placement>;
  k: number;
  selected: string | null;
  hovered: string | null;
  compact: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <g className="c-vessels">
      {vessels.map((v) => {
        const p = placements.get(v.attemptId);
        if (!p) return null;
        const near = v.ranges.find((r) => r.range <= 2);
        const label = `${v.callsign}, ${v.model}. ${ATTEMPT_STATUS_TEXT[v.status]}${v.file ? ` in ${v.file}` : ", no file changed yet"}. Task: ${v.intentTitle}.${
          near ? ` Distance ${near.range}: ${RANGE_TEXT[near.range as Range]}${near.closing ? ", moving closer" : ""}.` : ""
        }${v.corrections.length ? ` ${v.corrections.length} ${v.corrections.length === 1 ? "change request" : "change requests"}.` : ""}`;
        return (
          <Vessel
            key={v.attemptId}
            id={v.attemptId}
            callsign={v.callsign}
            color={v.color}
            hull={v.hull}
            wx={p.wx}
            wy={p.wy}
            ox={p.ox}
            oy={p.oy}
            heading={Math.round(p.heading)}
            k={k}
            selected={selected === v.attemptId}
            hovered={hovered === v.attemptId}
            dim={Boolean(selected && selected !== v.attemptId)}
            label={label}
            waiting={v.status === "ready"}
            showTag={!compact || selected === v.attemptId || hovered === v.attemptId}
            onSelect={onSelect}
          />
        );
      })}
    </g>
  );
});

/* ───────────── chart ───────────── */

export interface ChartProps {
  selected: string | null;
  hovered?: string | null;
  onSelect: (attemptId: string | null) => void;
  onBuoy: (correctionId: string, attemptId: string) => void;
  onParcel?: (path: string) => void;
  /** Bring this work copy into view (changes when the Active work list selects an agent). */
  focusRequest?: { id: string; n: number } | null;
  projectName: string;
}

export function Chart({ selected, hovered = null, onSelect, onBuoy, onParcel, focusRequest, projectName }: ChartProps) {
  const files = useStore((s) => s.state?.files ?? (EMPTY as FileNode[]));
  const canAct = useCanAct();
  const mainSha = useStore((s) => s.state?.project.mainSha ?? "");
  const vessels = useStore((s) => (s.state ? selectVessels(s.state) : (EMPTY as VesselModel[])));
  const rangeLines = useStore((s) => (s.state ? selectRangeLines(s.state) : (EMPTY as RangeLine[])));
  const buoys = useStore((s) => (s.state ? selectBuoys(s.state) : (EMPTY as BuoyModel[])));

  const layout = useMemo(() => layoutChart(files), [files]);
  const activeIslands = useMemo(() => {
    const ids = new Set<string>();
    for (const v of vessels) for (const f of [v.file, ...v.courseFiles]) if (f) ids.add(islandOf(f));
    return [...ids].sort().join("|");
  }, [vessels]);
  const focus = useMemo(() => {
    const list = layout.islands.filter((i) => activeIslands.split("|").includes(i.id));
    if (!list.length) return null;
    return {
      x0: Math.min(...list.map((i) => i.x0)) - 60,
      y0: Math.min(...list.map((i) => i.y0)),
      x1: Math.max(...list.map((i) => i.x1)) + 30,
      y1: Math.max(...list.map((i) => i.y1)),
    };
  }, [layout, activeIslands]);
  const wrap = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<SVGSVGElement | null>(null);
  const { t, size, fit, zoomAt, panBy, centerOn, wasDrag, handlers } = usePanZoom(wrap, files.length ? layout.bounds : null, focus, worldRef);
  // A committed transform replaces the gesture preview in the same frame.
  useLayoutEffect(() => {
    if (worldRef.current) worldRef.current.style.transform = "";
  }, [t]);
  const [hover, setHover] = useState<{ p: Parcel; x: number; y: number } | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);

  const kq = Math.round(t.k * 20) / 20 || 0.05;
  const compact = vessels.length > 24;
  const placements = useMemo(() => placeVessels(vessels, layout, compact), [vessels, layout, compact]);

  /** Screen-offset-aware positions (world units) for lines that end at a vessel. */
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const [id, p] of placements) m.set(id, { x: p.wx + p.ox / t.k, y: p.wy + p.oy / t.k });
    return m;
  }, [placements, t.k]);

  const origin = useMemo(() => ({ x: Math.floor(layout.bounds.x0 / 64) * 64, y: Math.floor(layout.bounds.y0 / 64) * 64 }), [layout]);

  useEffect(() => {
    if (!focusRequest) return;
    const p = placements.get(focusRequest.id);
    if (!p || !size.w) return;
    const sx = p.wx * t.k + t.x;
    const sy = p.wy * t.k + t.y;
    if (sx < 60 || sy < 60 || sx > size.w - 60 || sy > size.h - 60) centerOn(p.wx, p.wy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  const onHover = useCallback((p: Parcel | null, e?: RPointerEvent) => {
    if (!p || !e || !wrap.current) {
      setHover(null);
      return;
    }
    const r = wrap.current.getBoundingClientRect();
    setHover({ p, x: e.clientX - r.left, y: e.clientY - r.top });
  }, []);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 192 : 64;
    switch (e.key) {
      case "ArrowLeft":
        panBy(step, 0);
        break;
      case "ArrowRight":
        panBy(-step, 0);
        break;
      case "ArrowUp":
        panBy(0, step);
        break;
      case "ArrowDown":
        panBy(0, -step);
        break;
      case "+":
      case "=":
        zoomAt(1.25);
        break;
      case "-":
      case "_":
        zoomAt(0.8);
        break;
      case "0":
        fit();
        break;
      case "Escape":
        if (selected) onSelect(null);
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const onSelectVessel = useCallback(
    (id: string) => {
      if (wasDrag()) return;
      onSelect(id === selected ? null : id);
    },
    [onSelect, selected, wasDrag],
  );

  const vesselByFile = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const v of vessels) if (v.file) m.set(v.file, [...(m.get(v.file) ?? []), v.callsign]);
    return m;
  }, [vessels]);

  const corrections = buoys.length;
  const summary = `Map of ${projectName}. ${vessels.length} ${vessels.length === 1 ? "agent works" : "agents work"}, ${rangeLines.length} close ${
    rangeLines.length === 1 ? "pair" : "pairs"
  }, ${corrections} ${corrections === 1 ? "change request" : "change requests"}. Arrow keys move the map, plus and minus zoom, 0 fits the map. The Active work list has the same information as text.`;

  return (
    <div
      ref={wrap}
      className={vessels.length > 40 ? "c-chart c-chart--fleet" : "c-chart"}
      tabIndex={0}
      role="region"
      aria-label={summary}
      aria-roledescription="map"
      onKeyDown={onKey}
      {...handlers}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest(".c-vessel, .c-buoy, button")) return;
        const r = wrap.current!.getBoundingClientRect();
        zoomAt(1.6, e.clientX - r.left, e.clientY - r.top);
      }}
      onClick={(e) => {
        if (wasDrag()) return;
        if (!(e.target as Element).closest(".c-vessel, .c-buoy, .c-overlay")) onSelect(null);
      }}
    >
      {size.w > 0 && (
        <svg ref={worldRef} className="c-svg c-svg--world" width={size.w} height={size.h} role="presentation">
          <Graticule t={t} w={size.w} h={size.h} origin={origin} part="grid" />
          <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
            <Sea layout={layout} />
            <Land layout={layout} />
            {hover && (
              <rect
                className="c-parcel-hover"
                x={hover.p.x0}
                y={hover.p.y0}
                width={hover.p.x1 - hover.p.x0}
                height={hover.p.y1 - hover.p.y0}
                rx={1.5}
              />
            )}
            <Contours layout={layout} vessels={vessels} />
            <Parcels layout={layout} kq={kq} onHover={onHover} onParcel={onParcel} />
            <Ripples layout={layout} />
            <CompassRose x={layout.rose.x} y={layout.rose.y} r={layout.rose.r} />
            <TracksLayer vessels={vessels} layout={layout} pos={pos} k={t.k} selected={selected} hovered={hovered} />
            <RangeLines lines={rangeLines} pos={pos} k={t.k} selected={selected} />
            <Pulses pos={pos} k={t.k} />
            <Buoys buoys={buoys} layout={layout} k={t.k} selected={selected} onBuoy={onBuoy} />
            <VesselLayer vessels={vessels} placements={placements} k={t.k} selected={selected} hovered={hovered} compact={compact} onSelect={onSelectVessel} />
          </g>
        </svg>
      )}
      {size.w > 0 && (
        <svg className="c-svg c-svg--frame" width={size.w} height={size.h} aria-hidden="true">
          <Graticule t={t} w={size.w} h={size.h} origin={origin} part="frame" />
        </svg>
      )}

      {hover && (
        <div className="c-tip c-overlay" style={{ left: Math.min(hover.x + 14, size.w - 230), top: Math.min(hover.y + 14, size.h - 90) }} aria-hidden="true">
          <div className="voice-agent">{hover.p.path}</div>
          <div className="ink-3">
            {kb(hover.p.size)} · {hover.p.lang}
            {vesselByFile.get(hover.p.path)?.length ? ` · ${vesselByFile.get(hover.p.path)!.join(", ")}` : ""}
          </div>
          {onParcel && <div className="ink-3">Click to read the file on main.</div>}
        </div>
      )}

      <div className="c-overlay c-cartouche">
        <div className="c-cartouche__title">{projectName}</div>
        <div className="c-cartouche__meta voice-agent">
          main {shortSha(mainSha)} · {files.length} files
        </div>
        <button type="button" className="c-cartouche__toggle" aria-expanded={legendOpen} onClick={() => setLegendOpen(!legendOpen)}>
          {legendOpen ? "Hide legend" : "Show legend"}
        </button>
        {legendOpen && <ChartLegend />}
      </div>

      {files.length === 0 && (
        <div className="c-empty" role="status">
          <ImportPanel />
        </div>
      )}

      {vessels.length === 0 && files.length > 0 && (
        <div className="c-empty">
          <EmptyState
            art={false}
            text={canAct ? "No agents work now. Write a task and start agents, or start agents on all open tasks." : "No agents work now. Members start agents on this project."}
            action={
              canAct ? (
                <div className="c-empty__actions">
                  <Button variant="primary" icon="plus" onClick={openNewIntent}>
                    New task
                  </Button>
                  <Button icon="play" onClick={() => void launchAllNow()}>
                    Start agents
                  </Button>
                </div>
              ) : undefined
            }
          />
        </div>
      )}

      <div className="c-overlay c-zoom" role="group" aria-label="Zoom">
        <IconButton icon="plus" label="Zoom in" shortcut="+" variant="secondary" onClick={() => zoomAt(1.25)} />
        <IconButton icon="minus" label="Zoom out" shortcut="−" variant="secondary" onClick={() => zoomAt(0.8)} />
        <IconButton icon="fit" label="Fit the map" shortcut="0" variant="secondary" onClick={fit} />
      </div>
    </div>
  );
}
