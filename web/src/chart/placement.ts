/**
 * Finds the place of each vessel on the map: on its island, offshore, or stacked beside another vessel.
 * Pure. Read by the chart and by the replay map.
 */
import { type VesselModel } from "../state/selectors";
import { anchorOf, islandOf, type ChartLayout } from "./layout";

export interface Placement {
  wx: number;
  wy: number;
  ox: number;
  oy: number;
  heading: number;
  offshore: boolean;
}

/**
 * `compact` is for large fleets: glyphs only, in a tight grid.
 * `dense` is for a phone: most agents are dots, so the stacks are narrow and each dot has room for a 32 px tap target.
 */
export function placeVessels(vessels: VesselModel[], layout: ChartLayout, compact = false, dense = false): Map<string, Placement> {
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
    const gx = compact ? 17 : dense ? 36 : 106;
    const gy = compact ? 17 : dense ? 32 : 26;
    s.list.forEach((v, i) => {
      const col = compact ? i % cols : Math.floor(i / rows);
      const row = compact ? Math.floor(i / cols) : i % rows;
      const ox = s.offshore ? (col - (cols - 1) / 2) * (compact || dense ? gx : 104) : 17 + col * gx;
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
