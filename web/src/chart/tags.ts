/**
 * Which agents show a callsign flag on the overview map, and on which side of the glyph.
 * On a busy map the flags cover each other, the other agents and the names of the land.
 * The map keeps the flags that matter (the selected agent, an agent with a change request, an agent that waits for a yes)
 * and shows every other agent as a dot, when its flag would cover something. A phone shows only the flags that matter.
 * Pure (no React, no DOM): the chart gives the screen position of each glyph.
 */

export type TagSide = "right" | "left";

/** The ranks of an agent, from the most to the least important for the flag. */
export const TAG_RANK = { selected: 0, hovered: 1, request: 2, waiting: 3, near: 4, other: 5 } as const;

export interface TagCandidate {
  id: string;
  callsign: string;
  /** One value of TAG_RANK. */
  rank: number;
  /** Screen position of the glyph, in px. */
  x: number;
  y: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The flag is 18 px tall. It starts 12 px from the glyph. */
export function tagWidth(callsign: string): number {
  return callsign.length * 6.7 + 26;
}

const GLYPH = 11; // half the size of a glyph box
const PAD = 2; // air between two boxes
const EDGE = 6; // the frame of the map

const hit = (a: Box, b: Box) => a.x0 < b.x1 + PAD && b.x0 < a.x1 + PAD && a.y0 < b.y1 + PAD && b.y0 < a.y1 + PAD;

function boxOf(c: TagCandidate, side: TagSide): Box {
  const w = tagWidth(c.callsign);
  return side === "right" ? { x0: c.x + 12, y0: c.y - 10, x1: c.x + 12 + w, y1: c.y + 8 } : { x0: c.x - 12 - w, y0: c.y - 10, x1: c.x - 12, y1: c.y + 8 };
}

export interface TagOptions {
  candidates: TagCandidate[];
  view: { w: number; h: number };
  /** An agent with a rank above this value never gets a flag (a phone: TAG_RANK.waiting). */
  maxRank: number;
  /** Boxes that a flag of a minor agent must not cover (the names of the islands). */
  labels?: Box[];
}

/**
 * The flags to draw: the id of each agent and the side of its flag. An agent that is not in the answer is a dot.
 * The most important agents choose first. The selected agent and the agent under the pointer always get a flag.
 */
export function chooseTags({ candidates, view, maxRank, labels = [] }: TagOptions): Map<string, TagSide> {
  const shown = new Map<string, TagSide>();
  const taken: Box[] = [];
  const glyphs = candidates.map((c) => ({ id: c.id, box: { x0: c.x - GLYPH, y0: c.y - GLYPH, x1: c.x + GLYPH, y1: c.y + GLYPH } }));
  const inView = (b: Box) => b.x0 >= EDGE && b.x1 <= view.w - EDGE && b.y0 >= EDGE && b.y1 <= view.h - EDGE;
  const order = candidates.map((c, i) => ({ c, i })).sort((a, b) => a.c.rank - b.c.rank || a.i - b.i);
  for (const { c } of order) {
    if (c.rank > maxRank) continue;
    const sides: TagSide[] = ["right", "left"];
    const major = c.rank <= TAG_RANK.waiting;
    const free = (side: TagSide, strict: boolean) => {
      const b = boxOf(c, side);
      if (!inView(b) || taken.some((t) => hit(t, b))) return false;
      if (!strict) return true;
      return !glyphs.some((g) => g.id !== c.id && hit(g.box, b)) && !labels.some((l) => hit(l, b));
    };
    let pick = sides.find((s) => free(s, true));
    if (!pick && major) pick = sides.find((s) => free(s, false));
    // The selected agent and the agent under the pointer always show their flag.
    if (!pick && c.rank <= TAG_RANK.hovered) pick = inView(boxOf(c, "right")) || !inView(boxOf(c, "left")) ? "right" : "left";
    if (!pick) continue;
    shown.set(c.id, pick);
    taken.push(boxOf(c, pick));
  }
  return shown;
}
