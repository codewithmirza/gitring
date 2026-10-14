/**
 * The overview map: the repository with every active agent, its plan, its files and its change requests.
 * The map also shows the distance of each agent to other work.
 *
 * Geometry lives in world units; strokes are non-scaling hairlines; glyphs and labels keep a constant screen size.
 * Layers are memoized so an event re-renders only what moved. This file holds the Chart component and
 * re-exports the layers, because the replay map draws the same layers. The layers are in placement.ts,
 * static-layers.tsx, vessel-layers.tsx and range-layers.tsx.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import type { FileNode } from "../../../src/core/types";
import { useStore } from "../state/store";
import { selectBuoys, selectRangeLines, selectVessels, type BuoyModel, type RangeLine, type VesselModel } from "../state/selectors";
import { kb, shortSha } from "../state/format";
import { Button, EmptyState, IconButton } from "../design/components";
import { openNewIntent } from "../app/ui";
import { useCanAct } from "../state/account";
import { launchAllNow } from "../app/actions";
import { ImportPanel } from "../app/ImportPanel";
import { islandOf, layoutChart, type Parcel } from "./layout";
import { usePanZoom } from "./panzoom";
import { ChartLegend } from "./ChartLegend";
import { placeVessels } from "./placement";
import { chooseTags, TAG_RANK, type Box } from "./tags";
import { Buoys, Contours, Pulses, RangeLines } from "./range-layers";
import { CompassRose, Graticule, Land, Parcels, Sea } from "./static-layers";
import { Ripples, TracksLayer, VesselLayer } from "./vessel-layers";
import "./chart.css";
export { placeVessels } from "./placement";
export type { Placement } from "./placement";
export { Contours, RangeLines, Buoys } from "./range-layers";
export { Sea, Land, Parcels, CompassRose, Graticule } from "./static-layers";
export { TracksLayer, VesselLayer } from "./vessel-layers";

const EMPTY: never[] = [];

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
  // A phone: most agents are dots with a tap target of 32 px; only the agents that matter have a flag.
  const narrow = size.w > 0 && size.w <= 600;
  const placements = useMemo(() => placeVessels(vessels, layout, compact, narrow), [vessels, layout, compact, narrow]);

  /** The callsign flags to draw: the ones that matter first, and none that covers another flag or an island name. */
  const tags = useMemo(() => {
    const labels: Box[] = [];
    if (22 * kq >= 12) {
      for (const i of layout.islands) {
        const x0 = t.x + (i.x0 + 8) * t.k;
        const base = t.y + (i.y0 + 11) * t.k + (4 * t.k) / kq;
        labels.push({ x0: x0 - 1, y0: base - 11, x1: x0 + i.label.length * 7.2 + 1, y1: base + 3 });
      }
    }
    const rankOf = (v: VesselModel) =>
      v.attemptId === selected
        ? TAG_RANK.selected
        : v.attemptId === hovered
          ? TAG_RANK.hovered
          : v.corrections.length
            ? TAG_RANK.request
            : v.status === "ready"
              ? TAG_RANK.waiting
              : v.ranges.some((r) => r.range <= 2)
                ? TAG_RANK.near
                : TAG_RANK.other;
    const candidates = vessels.flatMap((v) => {
      const p = placements.get(v.attemptId);
      return p ? [{ id: v.attemptId, callsign: v.callsign, rank: rankOf(v), x: p.wx * t.k + t.x + p.ox, y: p.wy * t.k + t.y + p.oy }] : [];
    });
    const maxRank = narrow ? TAG_RANK.waiting : compact ? TAG_RANK.hovered : TAG_RANK.other;
    return chooseTags({ candidates, view: size, maxRank, labels });
  }, [vessels, placements, layout, t, kq, size, selected, hovered, narrow, compact]);

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
            <VesselLayer vessels={vessels} placements={placements} k={t.k} selected={selected} hovered={hovered} compact={compact} tags={tags} hitR={narrow ? 16 : 13} onSelect={onSelectVessel} />
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

      <div className={legendOpen ? "c-overlay c-cartouche is-open" : "c-overlay c-cartouche"}>
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
