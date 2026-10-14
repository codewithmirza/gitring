/**
 * The replay map: the chart of the project, with the world of the current step on it.
 * It uses the same layers as the overview map, with the effects layer above them.
 * The camera is fixed: it frames every island that the history touches, so the picture does not move while it plays
 * (good for a recording).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { FileNode } from "../../../../src/core/types";
import { Buoys, CompassRose, Contours, Graticule, Land, Parcels, placeVessels, RangeLines, Sea, TracksLayer, VesselLayer } from "../../chart/Chart";
import { anchorOf, islandOf, layoutChart, type ChartLayout, type Rect } from "../../chart/layout";
import { fitTransform, type Transform } from "../../chart/panzoom";
import { shortSha } from "../../state/format";
import type { ReplayClock } from "./clock";
import { Effects, type Geo, type Point } from "./Effects";
import type { ReplayScript, World } from "./model";

const noop = () => undefined;
/** Most zoom past the fit: a small history on a large repository still shows its neighborhood. */
const MAX_K = 2.4;

/** The islands that the history touches, with room for the agents that wait offshore and for their tags. */
export function focusBounds(layout: ChartLayout, script: ReplayScript): Rect {
  const ids = new Set<string>();
  for (const s of script.steps) for (const f of s.files ?? []) ids.add(islandOf(f));
  for (const a of script.attempts.values()) for (const f of a.course?.files ?? []) ids.add(islandOf(f));
  const list = layout.islands.filter((i) => ids.has(i.id));
  if (!list.length) return layout.bounds;
  return {
    x0: Math.min(...list.map((i) => i.x0)) - 150,
    y0: Math.min(...list.map((i) => i.y0)) - 40,
    x1: Math.max(...list.map((i) => i.x1)) + 150,
    y1: Math.max(...list.map((i) => i.y1)) + 40,
  };
}

function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export interface ReplayMapProps {
  files: FileNode[];
  script: ReplayScript;
  world: World;
  clock: ReplayClock;
  /** The work copy of the step now: the others dim a little. */
  focus: string | null;
  projectName: string;
  /** Room at the top for the overlays (px). */
  top?: number;
}

export function ReplayMap({ files, script, world, clock, focus, projectName, top = 0 }: ReplayMapProps) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const size = useSize(wrap);
  const layout = useMemo(() => layoutChart(files), [files]);
  const bounds = useMemo(() => focusBounds(layout, script), [layout, script]);
  // Glyphs and labels grow on large screens, so they stay readable in a video.
  const g = size.w ? Math.max(1, Math.min(1.6, Math.min(size.w / 1000, size.h / 600))) : 1;
  const bottom = 44 * g;

  const t: Transform = useMemo(() => {
    if (!size.w) return { x: 0, y: 0, k: 1 };
    const h = Math.max(100, size.h - top - bottom);
    const f = fitTransform(bounds, size.w, h, 0.94);
    const k = Math.min(f.k, MAX_K);
    const cx = (bounds.x0 + bounds.x1) / 2;
    const cy = (bounds.y0 + bounds.y1) / 2;
    return { k, x: size.w / 2 - cx * k, y: top + h / 2 - cy * k };
  }, [bounds, size.w, size.h, top, bottom]);

  const kk = t.k / g;
  const kq = Math.round(kk * 20) / 20 || 0.05;
  const compact = world.vessels.length > 24;
  const placements = useMemo(() => placeVessels(world.vessels, layout, compact), [world.vessels, layout, compact]);
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const [id, p] of placements) m.set(id, { x: p.wx + p.ox / kk, y: p.wy + p.oy / kk });
    return m;
  }, [placements, kk]);

  // Where each work copy was last: a merged work copy leaves the map, but its commit and its change
  // requests still start from there.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lastPos = useMemo(() => new Map<string, { x: number; y: number }>(), [layout]);
  for (const [id, p] of pos) lastPos.set(id, p);

  const geo: Geo = useMemo(() => {
    const screen = (p: { x: number; y: number }): Point => ({ x: p.x * t.k + t.x, y: p.y * t.k + t.y });
    const anchor = (path: string) => {
      const a = anchorOf(layout, path);
      return a ? screen(a) : null;
    };
    return {
      pos: (id) => {
        if (!id) return null;
        const p = pos.get(id) ?? lastPos.get(id);
        if (p) return screen(p);
        const a = script.attempts.get(id);
        const f = a && (Object.keys(a.footprint?.files ?? {})[0] ?? a.course?.files[0]);
        return f ? anchor(f) : null;
      },
      parcel: (path) => {
        const p = layout.parcels.get(path);
        if (!p) return null;
        const a = screen({ x: p.x0, y: p.y0 });
        return { x: a.x, y: a.y, w: (p.x1 - p.x0) * t.k, h: (p.y1 - p.y0) * t.k };
      },
      anchor,
      color: (id) => {
        const a = id ? script.attempts.get(id) : undefined;
        return (a && script.agents.get(a.agentId)?.color) ?? 0;
      },
      width: size.w,
      height: size.h,
      g,
    };
  }, [layout, t, pos, lastPos, script, size.w, size.h, g]);

  const origin = useMemo(() => ({ x: Math.floor(layout.bounds.x0 / 64) * 64, y: Math.floor(layout.bounds.y0 / 64) * 64 }), [layout]);
  const shownFocus = focus && pos.has(focus) ? focus : null;
  const commits = world.commits.slice(-6);

  return (
    <div ref={wrap} className="c-chart rp-map" style={{ "--rp-g": g } as CSSProperties} aria-hidden="true">
      {size.w > 0 && (
        <svg className="c-svg c-svg--world" width={size.w} height={size.h} role="presentation">
          <Graticule t={t} w={size.w} h={size.h} origin={origin} part="grid" />
          <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
            <Sea layout={layout} />
            <Land layout={layout} />
            <Contours layout={layout} vessels={world.vessels} />
            <Parcels layout={layout} kq={kq} onHover={noop} />
            <CompassRose x={layout.rose.x} y={layout.rose.y} r={layout.rose.r} />
            <TracksLayer vessels={world.vessels} layout={layout} pos={pos} k={kk} selected={shownFocus} hovered={shownFocus} />
            <RangeLines lines={world.ranges} pos={pos} k={kk} selected={shownFocus} />
            <Buoys buoys={world.buoys} layout={layout} k={kk} selected={shownFocus} onBuoy={noop} />
            <VesselLayer vessels={world.vessels} placements={placements} k={kk} selected={shownFocus} hovered={null} compact={compact} onSelect={noop} />
          </g>
        </svg>
      )}
      {size.w > 0 && (
        <svg className="c-svg c-svg--frame" width={size.w} height={size.h} aria-hidden="true">
          <Graticule t={t} w={size.w} h={size.h} origin={origin} part="frame" />
        </svg>
      )}
      {size.w > 0 && <Effects script={script} clock={clock} geo={geo} />}

      <div className="rp-mainlane" aria-hidden="true">
        <span className="rp-mainlane__name">main</span>
        <span className="rp-mainlane__line" />
        {commits.map((c) => (
          <span key={c.sha} className="rp-mainlane__commit" title={c.title}>
            <span className="rp-mainlane__dot" />
            <span className="rp-mainlane__sha">{shortSha(c.sha)}</span>
          </span>
        ))}
        <span className="rp-mainlane__head">{world.mainSha ? shortSha(world.mainSha) : "—"}</span>
      </div>
      <span className="vh">Map of {projectName}</span>
    </div>
  );
}
