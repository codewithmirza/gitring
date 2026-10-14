/**
 * The layers of conflicts on the map: contour lines, distance lines between vessels, pulses and change-request buoys.
 * Read by the chart and by the replay map.
 */
import { memo } from "react";
import { useStore } from "../state/store";
import { type BuoyModel, type RangeLine, type VesselModel } from "../state/selectors";
import { CORRECTION_KIND_SHORT, CORRECTION_KIND_TEXT } from "../state/format";
import { anchorOf, type ChartLayout } from "./layout";

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

export const Pulses = memo(function Pulses({ pos, k }: { pos: Map<string, { x: number; y: number }>; k: number }) {
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
        const done = b.correction.status === "acknowledged" || b.correction.status === "closed";
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
