/**
 * Writes the state of the story to the DOM: the canvas, the tip, the clip of the thread, the reveals and the rail.
 * Used by engine/frame.ts, once for each animation frame. It reads nothing from the layout, so it never forces one.
 */
import { clamp, pointAt, tipX, PATH_UNITS, type StoryGeometry } from "../thread";
import type { Layout } from "./measure";

export interface StoryParts {
  section: HTMLElement;
  stage: HTMLElement;
  /** The window that clips the canvas. Find-in-page scrolls it sideways. */
  window: HTMLElement;
  canvas: HTMLElement;
  thread: SVGSVGElement;
  tip: HTMLElement;
  /** The line of the stacked layout. */
  spine: HTMLElement;
}

/** A part of a scene that shows once: when its x enters the right edge (edge) or when the tip reaches it (thread). */
export interface Reveal {
  el: HTMLElement;
  at: number;
  thread: boolean;
  shown: boolean;
}

/** One chapter button of the rail. `fill` is the text that was written last, so unchanged values cost nothing. */
export interface RailPart {
  el: HTMLElement;
  from: number;
  to: number;
  fill: string;
  current: boolean;
}

/** A part shows when its x is this far (u) inside the right edge of the stage. */
const REVEAL_INSET = 4;

export function readParts(section: HTMLElement): StoryParts | null {
  const find = <T extends Element>(selector: string) => section.querySelector<T>(selector);
  const stage = find<HTMLElement>(".story-stage");
  const viewport = find<HTMLElement>(".story-window");
  const canvas = find<HTMLElement>(".story-canvas");
  const thread = find<SVGSVGElement>(".story-thread");
  const tip = find<HTMLElement>(".story-tip");
  const spine = find<HTMLElement>(".story-spine");
  if (!stage || !viewport || !canvas || !thread || !tip || !spine) return null;
  return { section, stage, window: viewport, canvas, thread, tip, spine };
}

export function readReveals(section: HTMLElement): Reveal[] {
  return Array.from(section.querySelectorAll<HTMLElement>("[data-at]"), (el) => ({ el, at: Number(el.dataset.at), thread: el.dataset.reveal === "thread", shown: false }));
}

export function readRail(section: HTMLElement): RailPart[] {
  return Array.from(section.querySelectorAll<HTMLElement>(".story-rail [data-from]"), (el) => ({ el, from: Number(el.dataset.from), to: Number(el.dataset.to), fill: "", current: false }));
}

export function show(reveal: Reveal, shown: boolean): void {
  if (reveal.shown === shown) return;
  reveal.shown = shown;
  reveal.el.toggleAttribute("data-shown", shown);
}

/** A chapter fills its part of the rail while the thread crosses it. The current part is marked for the eye and for a screen reader. */
function paintRail(rail: RailPart[], along: number): void {
  for (const part of rail) {
    const fill = clamp((along - part.from) / (part.to - part.from)).toFixed(3);
    if (fill !== part.fill) {
      part.fill = fill;
      part.el.style.setProperty("--fill", fill);
    }
    const current = along >= part.from && (along < part.to || part.to >= 1);
    if (current === part.current) continue;
    part.current = current;
    part.el.toggleAttribute("data-current", current);
    if (current) part.el.setAttribute("aria-current", "step");
    else part.el.removeAttribute("aria-current");
  }
}

/** The wide layout at a progress: slide the canvas, put the tip on main, clip the thread at the tip, show what it reached. */
export function paintHorizontal(parts: StoryParts, geometry: StoryGeometry, layout: Layout, progress: number, reveals: Reveal[], rail: RailPart[]): void {
  const shift = Math.max(0, progress) * geometry.travel;
  parts.canvas.style.transform = `translate3d(${(-shift * layout.unit).toFixed(2)}px, 0, 0)`;
  const tipAt = tipX(geometry, progress);
  const [, y] = pointAt(geometry.samples, tipAt * PATH_UNITS);
  const tipPx = tipAt * layout.unit;
  parts.tip.style.transform = `translate3d(${tipPx.toFixed(2)}px, ${(y * layout.scaleY).toFixed(2)}px, 0)`;
  // Every line of the thread is x-monotone, so a clip at the tip draws main and the agent lines together.
  parts.thread.style.clipPath = `inset(-8px ${(layout.canvasWidth - tipPx).toFixed(1)}px -8px 0)`;
  const edge = shift + 100 - REVEAL_INSET;
  for (const reveal of reveals) show(reveal, (reveal.thread ? tipAt : edge) >= reveal.at);
  paintRail(rail, Math.max(0, progress));
}

/** Takes back everything that the engine wrote, so the stacked layout is the plain page again. */
export function resetPaint(parts: StoryParts, reveals: Reveal[], rail: RailPart[]): void {
  parts.canvas.style.transform = "";
  parts.tip.style.transform = "";
  parts.thread.style.clipPath = "";
  parts.spine.style.transform = "";
  parts.window.scrollLeft = 0;
  for (const reveal of reveals) show(reveal, false);
  for (const part of rail) {
    part.el.style.removeProperty("--fill");
    part.el.removeAttribute("data-current");
    part.el.removeAttribute("aria-current");
    part.fill = "";
    part.current = false;
  }
}
