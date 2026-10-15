/**
 * The React hook that starts the story engine when the story mounts and stops it when the story goes away.
 * Used by Story.tsx. The engine finds its parts by class name, so React renders them once and never again while you scroll.
 * It also keeps a reader at the end of the page in place when the story replaces the shorter plain text.
 */
import { useLayoutEffect, useState, type RefObject } from "react";
import { GEOMETRY } from "../geometry";
import { createFrame } from "./frame";
import { bindInput } from "./input";
import { watchMode } from "./mode";
import { readParts } from "./paint";
import { readScrollRoot, type ScrollRoot } from "./scroll-root";

/** Where the end of the section stands in its scroll box (px from the top of the box). */
function endOfSection(element: HTMLElement, root: ScrollRoot): number {
  return element.getBoundingClientRect().bottom - root.top();
}

/**
 * The story is much taller than the plain text that it replaces. A reader who sees the end of the section, or the page
 * below it (a link to the end of the page, or "Skip the story" before the code arrived), stays at the same place:
 * the page moves so that the end of the section is where it was. A reader above or inside the section does not move.
 */
function keepEnd(element: HTMLElement, root: ScrollRoot, endBefore: number): void {
  if (endBefore > root.height()) return;
  const moved = endOfSection(element, root) - endBefore;
  if (moved) root.scrollTo(root.scrollTop() + moved, "auto");
}

export function useStoryEngine(section: RefObject<HTMLElement | null>): void {
  // Read in the first render, before React puts the story in place of the plain text.
  const [endBefore] = useState(() => (section.current ? endOfSection(section.current, readScrollRoot(section.current)) : null));
  // A layout effect, so the engine chooses the layout before the first paint of the story: no flash of the stacked layout.
  useLayoutEffect(() => {
    const element = section.current;
    const parts = element && readParts(element);
    if (!parts) return;
    const root = readScrollRoot(parts.section);
    const frame = createFrame(parts, GEOMETRY, root);
    const stopInput = bindInput(parts, frame, root, GEOMETRY);
    frame.refresh();
    const stopWatch = watchMode(frame.refresh);
    if (endBefore !== null) keepEnd(parts.section, root, endBefore);
    return () => {
      stopWatch();
      stopInput();
      frame.destroy();
    };
  }, [section, endBefore]);
}
