/**
 * The map layers that do not move with events: sea, land, parcels (files), the compass rose and the graticule.
 * Read by the chart and by the replay map. Each layer is memoized on the layout it draws.
 */
import { memo, type PointerEvent as RPointerEvent } from "react";
import { kb } from "../state/format";
import { type ChartLayout, type Parcel } from "./layout";
import { type Transform } from "./panzoom";

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
  const fs = 11.5 / kq; // 11 to 12 px on the screen (k is a little off kq): never under the 11 px floor
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
            const nameFits = w >= p.name.length * 6.9 + 8 && h >= 18; // a mono character is 0.6 em: 6.9 px at 11.5 px
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
