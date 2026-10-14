/**
 * The layers of the agents on the map: the vessels with their wakes, and the tracks of the files they touched.
 * Read by the chart and by the replay map. Labels and glyphs keep a constant screen size.
 */
import { memo, type CSSProperties } from "react";
import type { Range } from "../../../src/core/types";
import { useStore } from "../state/store";
import { type VesselModel } from "../state/selectors";
import { HULL_PATHS, type HullName } from "../design/icons";
import { ATTEMPT_STATUS_TEXT, RANGE_TEXT } from "../state/format";
import { anchorOf, type ChartLayout } from "./layout";
import type { Placement } from "./placement";

export const Ripples = memo(function Ripples({ layout }: { layout: ChartLayout }) {
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
          near ? ` Distance ${near.range}: ${RANGE_TEXT[near.range as Range]}${near.closing ? ", closer now" : ""}.` : ""
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
