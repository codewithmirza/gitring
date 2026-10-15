/**
 * Reads the size of the stage and turns it into units: u (1% of the stage width) in px, and the scale of the path.
 * Used by engine/frame.ts. It writes only --u and the height of the section. Measure rarely: it forces a layout.
 */
import { pinnedScrollPx } from "../geometry";
import { PATH_UNITS } from "../thread";

/** What the frame needs to move things in px. */
export interface Layout {
  /** px for 1 u. */
  unit: number;
  /** px for 1 path unit along x and along y. */
  scaleX: number;
  scaleY: number;
  stageWidth: number;
  stageHeight: number;
  /** The width of the canvas in px. */
  canvasWidth: number;
  /** The canvas rests at this x inside its window, so find-in-page can scroll the window either way. */
  rest: number;
}

export function measureStage(section: HTMLElement, stage: HTMLElement, canvas: HTMLElement): Layout {
  // The scroll box can have a scrollbar, so the stage measures itself and never uses vw.
  const stageWidth = stage.clientWidth;
  const stageHeight = stage.offsetHeight;
  const unit = stageWidth / 100;
  section.style.setProperty("--u", `${unit.toFixed(3)}px`);
  // One screen of stage plus the pinned scroll: the page scrolls for as long as the canvas travels.
  section.style.height = `${(stageHeight + pinnedScrollPx(stageWidth, stageHeight)).toFixed(1)}px`;
  return {
    unit,
    scaleX: unit / PATH_UNITS,
    scaleY: canvas.clientHeight / (PATH_UNITS * 100),
    stageWidth,
    stageHeight,
    canvasWidth: canvas.clientWidth,
    rest: canvas.offsetLeft,
  };
}

/** Takes back what measureStage wrote. */
export function clearMeasure(section: HTMLElement): void {
  section.style.removeProperty("--u");
  section.style.removeProperty("height");
}
