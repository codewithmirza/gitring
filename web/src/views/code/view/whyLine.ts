/**
 * Which line "Why?" asks about when nobody picked one, and how to keep a line in sight above the phone sheet.
 * These functions read the page (the selection and the rows on screen). They change no state.
 * Used by useCodeCursor.ts (the choice) and BottomSheet.tsx (the scroll). Read LineHistory.tsx next.
 */
import type { LineRange } from "../../../../../src/core/types";
import { LINE_H } from "../CodeLines";

/* ───────────── the line to ask about ───────────── */

/** The line that holds the start of the text selection (the caret), or null when it is not in the code. */
export function lineAtCaret(scroller: HTMLElement | null, selection: Selection | null): number | null {
  const node = selection?.anchorNode;
  if (!scroller || !node || !scroller.contains(node)) return null;
  const row = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".cv-line");
  const n = Number(row?.dataset.line);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The first and the last line that show in the scroll area, or null when no row shows. */
export function linesInView(scroller: HTMLElement | null): LineRange | null {
  if (!scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  const bottom = top + scroller.clientHeight;
  let first = 0;
  let last = 0;
  for (const row of scroller.querySelectorAll<HTMLElement>(".cv-line")) {
    const box = row.getBoundingClientRect();
    if (box.bottom <= top + 1 || box.top >= bottom) continue;
    const n = Number(row.dataset.line);
    if (!first) first = n;
    last = n;
  }
  return first ? [first, last] : null;
}

/**
 * The line for "Why?" when no line is selected: the line under the caret; else the first line on screen that an agent
 * changes; else the first line on screen. A line that is far out of sight is never chosen, so the page does not jump.
 */
export function lineForWhy(scroller: HTMLElement | null, selection: Selection | null, changed: LineRange[]): number {
  const caret = lineAtCaret(scroller, selection);
  if (caret) return caret;
  const view = linesInView(scroller);
  if (!view) return changed[0]?.[0] ?? 1;
  const mark = changed.find((r) => r[1] >= view[0] && r[0] <= view[1]);
  return mark ? Math.max(mark[0], view[0]) : view[0];
}

/* ───────────── the strip above the sheet ───────────── */

/**
 * Scrolls the code so that line `n` shows in the strip between the top of the code and `stripBottom` (the top of the sheet).
 * It does nothing when the line is in the strip already. Without wrap, a line that is far away has no row yet: its place is known.
 */
export function revealLine(n: number, stripBottom: number): void {
  const scroller = document.querySelector<HTMLElement>(".cv-lines");
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const strip = Math.min(stripBottom, box.bottom) - box.top;
  if (strip < LINE_H * 2) return;
  const row = scroller.querySelector<HTMLElement>(`.cv-line[data-line="${n}"]`);
  if (!row) {
    scroller.scrollTop = Math.max(0, (n - 1) * LINE_H - (strip - LINE_H) / 2);
    return;
  }
  const at = row.getBoundingClientRect();
  const edge = 8;
  if (at.top >= box.top + edge && at.bottom <= box.top + strip - edge) return;
  scroller.scrollTop += at.top - (box.top + (strip - at.height) / 2);
}
