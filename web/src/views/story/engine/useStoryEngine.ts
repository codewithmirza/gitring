/**
 * The React hook that starts the story engine when the story mounts and stops it when the story goes away.
 * Used by Story.tsx. The engine finds its parts by class name, so React renders them once and never again while you scroll.
 */
import { useEffect, type RefObject } from "react";
import { GEOMETRY } from "../geometry";
import { createFrame } from "./frame";
import { bindInput } from "./input";
import { watchMode } from "./mode";
import { readParts } from "./paint";
import { readScrollRoot } from "./scroll-root";

export function useStoryEngine(section: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = section.current;
    const parts = element && readParts(element);
    if (!parts) return;
    const root = readScrollRoot(parts.section);
    const frame = createFrame(parts, GEOMETRY, root);
    const stopInput = bindInput(parts, frame, root, GEOMETRY);
    frame.refresh();
    const stopWatch = watchMode(frame.refresh);
    return () => {
      stopWatch();
      stopInput();
      frame.destroy();
    };
  }, [section]);
}
