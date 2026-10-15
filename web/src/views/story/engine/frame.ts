/**
 * The animation frame loop of the story: it eases toward the scroll position and paints.
 * React does not render while you scroll.
 * Used by engine/useStoryEngine.ts. It chooses the layout (horizontal, vertical or static) and keeps data-mode on the section.
 * It reads the layout once for each frame, before it writes, so it never thrashes. Native scroll only: it never moves the page by itself.
 */
import { clamp, type StoryGeometry } from "../thread";
import { clearMeasure, measureStage, type Layout } from "./measure";
import { readMode, type StoryMode } from "./mode";
import { paintHorizontal, readRail, readReveals, resetPaint, show, type StoryParts } from "./paint";
import type { ScrollRoot } from "./scroll-root";

/** How quickly the story catches up with the scroll position (ms time constant). */
const EASE_MS = 110;
/** The stacked spine reaches the point at this share of the box height from the top. */
const SPINE_LEAD = 0.75;

export interface Frame {
  mode(): StoryMode | "";
  layout(): Layout | null;
  /** How far the canvas has slid (u). */
  shift(): number;
  /** The size or a media query changed: choose the layout again and measure. */
  refresh(): void;
  /** The scroll position or the visibility changed: paint a frame soon. */
  wake(): void;
  setNearby(near: boolean): void;
  scrollToProgress(progress: number, behavior: ScrollBehavior): void;
  /** Move the page to a progress and paint at once (find-in-page uses it). */
  jumpTo(progress: number): void;
  destroy(): void;
}

export function createFrame(parts: StoryParts, geometry: StoryGeometry, root: ScrollRoot): Frame {
  const { section, stage, canvas, spine } = parts;
  const reveals = readReveals(section);
  const rail = readRail(section);
  let mode: StoryMode | "" = "";
  let layout: Layout | null = null;
  let frame = 0;
  let last = 0;
  let current = Number.NaN;
  let rendered = Number.NaN;
  let isNear = false;
  let revealer: IntersectionObserver | null = null;
  let sizes: ResizeObserver | null = null;

  /** Progress of the story from -1 (the section enters) to 1 (the end). The stacked layouts read the spine from 0 to 1. */
  function target(): number {
    const height = root.height();
    if (mode !== "horizontal") {
      const box = canvas.getBoundingClientRect();
      return clamp((height * SPINE_LEAD - (box.top - root.top())) / Math.max(1, box.height));
    }
    const box = section.getBoundingClientRect();
    const top = box.top - root.top();
    if (top > 0) return Math.max(-1, -top / height);
    // The pinned box, not the window, sets how far the section scrolls while pinned.
    return Math.min(1, -top / Math.max(1, box.height - stage.offsetHeight));
  }

  function render(progress: number): void {
    rendered = progress;
    if (mode === "horizontal" && layout) paintHorizontal(parts, geometry, layout, progress, reveals, rail);
    // A custom property would restyle the whole canvas in the stacked layout, so the spine gets a transform.
    else if (mode === "vertical") spine.style.transform = `scaleY(${progress.toFixed(4)})`;
  }

  function tick(now: number): void {
    frame = 0;
    const dt = last ? Math.min(64, now - last) : 16.7;
    last = now;
    const goal = target();
    if (Number.isNaN(current) || mode !== "horizontal") current = goal;
    else {
      current += (goal - current) * (1 - Math.exp(-dt / EASE_MS));
      if (Math.abs(goal - current) < 0.0002) current = goal;
    }
    if (current !== rendered) render(current);
    if (current !== goal) frame = requestAnimationFrame(tick);
    else last = 0;
  }

  function wake(): void {
    if (!frame && isNear && mode && mode !== "static") frame = requestAnimationFrame(tick);
  }

  /** In the stacked layout each chapter and plate fades in once when it comes into view. */
  function observeReveals(): void {
    const byElement = new Map(reveals.map((reveal) => [reveal.el, reveal]));
    revealer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const reveal = entry.isIntersecting ? byElement.get(entry.target as HTMLElement) : undefined;
          if (!reveal) continue;
          show(reveal, true);
          revealer?.unobserve(entry.target);
        }
      },
      { root: root.element, rootMargin: "0px 0px -10% 0px" },
    );
    for (const reveal of reveals) revealer.observe(reveal.el);
  }

  function reset(): void {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    revealer?.disconnect();
    revealer = null;
    sizes?.disconnect();
    sizes = null;
    resetPaint(parts, reveals, rail);
    clearMeasure(section);
    section.removeAttribute("data-ready");
    layout = null;
  }

  /** Measures the stage, and rests the window on the canvas (the canvas starts one canvas width in). */
  function measure(): void {
    layout = measureStage(section, stage, canvas);
    parts.window.scrollLeft = layout.rest;
  }

  function startHorizontal(): void {
    measure();
    // The stage can change width without a resize event (a scrollbar appears), so it is watched too.
    sizes = new ResizeObserver(refresh);
    sizes.observe(stage);
  }

  function refresh(): void {
    const next = readMode();
    if (next === mode) {
      if (mode === "horizontal") measure();
      rendered = Number.NaN;
      current = Number.NaN;
      wake();
      return;
    }
    reset();
    mode = next;
    section.dataset.mode = next;
    if (next === "static") return;
    if (next === "horizontal") startHorizontal();
    else observeReveals();
    // Paint the new layout at once, then let the reveals hide what the thread has not reached yet.
    render(target());
    current = rendered;
    section.toggleAttribute("data-ready", true);
  }

  function scrollToProgress(progress: number, behavior: ScrollBehavior): void {
    const box = section.getBoundingClientRect();
    root.scrollTo(root.scrollTop() + (box.top - root.top()) + progress * (box.height - stage.offsetHeight), behavior);
  }

  return {
    mode: () => mode,
    layout: () => layout,
    shift: () => Math.max(0, Number.isNaN(rendered) ? 0 : rendered) * geometry.travel,
    refresh,
    wake,
    setNearby(near) {
      isNear = near;
      current = Number.NaN;
      wake();
    },
    scrollToProgress,
    jumpTo(progress) {
      scrollToProgress(clamp(progress), "auto");
      current = target();
      render(current);
    },
    destroy() {
      reset();
      delete section.dataset.mode;
    },
  };
}
