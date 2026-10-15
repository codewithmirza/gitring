/**
 * Puts a part of a scene on the canvas by x (u) and y (%), and tells the engine when to show it.
 * Used by the scenes. The CSS reads --x and --y; the engine reads data-at and data-reveal.
 */
import type { CSSProperties } from "react";

/** x is in u (1% of the stage width), y in % of the stage height. `at` is the x that shows the part. */
export type Place = { x: number; y: number; at?: number; thread?: boolean };

/**
 * The props of a placed part. An edge part shows when its x enters the right edge of the stage.
 * A thread part waits until the tip of the thread reaches `at` (the x of the part if `at` is missing).
 */
export function spot({ x, y, at, thread }: Place) {
  return {
    style: { "--x": x, "--y": y } as CSSProperties,
    "data-at": at ?? x,
    "data-reveal": thread ? "thread" : "edge",
  };
}
