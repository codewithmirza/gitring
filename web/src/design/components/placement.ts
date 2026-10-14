/**
 * Decides where an anchored popover goes.
 * It is a pure function, so tests need no browser.
 * Rules:
 *   - The popover opens under its trigger. It flips above when the space under is too small and the space above is larger.
 *   - It stays 8 px inside the viewport. When it is too tall, it gets a max height and scrolls.
 *   - The tail points at the middle of the trigger. It keeps 14 px from the rounded corners.
 *   - Under `sheetBelow` px of viewport width, the popover becomes a full-width sheet under (or above) the trigger.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Side = "bottom" | "top";
export type Align = "start" | "center" | "end";

export interface PlaceInput {
  anchor: Box;
  /** Natural size of the popover (before any max height). */
  pop: { width: number; height: number };
  viewport: { width: number; height: number };
  side?: Side;
  align?: Align;
  /** Distance to the viewport edges. */
  margin?: number;
  /** Distance between the trigger and the popover (room for the tail). */
  gap?: number;
  /** Viewport width under which the popover is a full-width sheet. */
  sheetBelow?: number;
  /** Keep the tail this far from the popover corners. */
  tailInset?: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Set for sheets: the popover takes this width. */
  width?: number;
  maxHeight: number;
  side: Side;
  /** Tail position from the left edge of the popover, in px. */
  tailX: number;
  sheet: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function place({
  anchor,
  pop,
  viewport,
  side = "bottom",
  align = "start",
  margin = 8,
  gap = 10,
  sheetBelow = 560,
  tailInset = 14,
}: PlaceInput): Placement {
  const vw = Math.max(0, viewport.width);
  const vh = Math.max(0, viewport.height);
  const below = vh - (anchor.top + anchor.height) - gap - margin;
  const above = anchor.top - gap - margin;

  // Prefer the asked side. Flip when the popover does not fit there but fits on the other side;
  // when it fits on neither side, take the side with more room.
  const other: Side = side === "bottom" ? "top" : "bottom";
  const spaceOf = (s: Side) => (s === "bottom" ? below : above);
  let chosen: Side = side;
  if (spaceOf(side) < pop.height) {
    if (spaceOf(other) >= pop.height) chosen = other;
    else if (spaceOf(other) > spaceOf(side)) chosen = other;
  }

  const room = Math.max(80, chosen === "bottom" ? below : above);
  const height = Math.min(pop.height, room);
  const top = chosen === "bottom" ? anchor.top + anchor.height + gap : anchor.top - gap - height;
  const anchorMid = anchor.left + anchor.width / 2;

  const sheet = vw < sheetBelow;
  if (sheet) {
    const width = Math.max(0, vw - margin * 2);
    return {
      left: margin,
      top: Math.max(margin, top),
      width,
      maxHeight: room,
      side: chosen,
      tailX: clamp(anchorMid - margin, tailInset, Math.max(tailInset, width - tailInset)),
      sheet: true,
    };
  }

  const w = Math.min(pop.width, vw - margin * 2);
  let left = align === "end" ? anchor.left + anchor.width - w : align === "center" ? anchorMid - w / 2 : anchor.left;
  left = clamp(left, margin, Math.max(margin, vw - w - margin));
  return {
    left,
    top: Math.max(margin, top),
    maxHeight: room,
    side: chosen,
    tailX: clamp(anchorMid - left, tailInset, Math.max(tailInset, w - tailInset)),
    sheet: false,
  };
}
