/**
 * Pure maths of the story thread: waypoints, path, tip position, progress and rail parts.
 * Used by geometry.ts (builds the numbers) and engine/ (moves the tip). It has no DOM and no React, so a test can run it.
 *
 * The thread geometry (Catmull-Rom waypoints written as cubic Béziers, sampled once instead of calling
 * getPointAtLength) is adapted from https://github.com/SomehowLiving/portfolio-template under the MIT License:
 *
 * Copyright (c) 2026 Nidhi Prajapati
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ───── Types ─────

/** A point on the canvas: x in u (1% of the stage width), y in % of the stage height. */
export type Waypoint = [x: number, y: number];
export type Segment = [x0: number, y0: number, c1x: number, c1y: number, c2x: number, c2y: number, x1: number, y1: number];
/** Points along the thread. `reach` is the furthest x so far, so a binary search finds where the tip is. */
export type ThreadSamples = { xs: Float32Array; ys: Float32Array; reach: Float32Array };

export type StoryGeometry = {
  /** Width of the canvas in u. */
  canvas: number;
  /** How far the canvas slides left, in u. */
  travel: number;
  /** The tip of the thread stays at this x (u) on the stage while the canvas moves. */
  anchor: number;
  start: number;
  end: number;
  /** The last part of the scroll in which the tip runs ahead to reach the end. */
  catchUp: number;
  segments: Segment[];
  samples: ThreadSamples;
};

export type RailChapter = { title: string; from: string; to: string; go: string };

// ───── Path ─────

/** The path uses 10 path units for each u and for each % of the stage height. */
export const PATH_UNITS = 10;

/** Waypoints to cubic Bézier segments (Catmull-Rom). The first and last point repeat as their own neighbour. */
export function threadSegments(waypoints: Waypoint[]): Segment[] {
  const points = waypoints.map(([x, y]) => [x * PATH_UNITS, y * PATH_UNITS]);
  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    segments.push([
      p1[0],
      p1[1],
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1],
    ]);
  }
  return segments;
}

/** The path string. It uses only + - * / and toFixed, so a server and a browser write the same text. */
export function threadPath(segments: Segment[]): string {
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(segments[0][0])} ${f(segments[0][1])}`;
  for (const [, , c1x, c1y, c2x, c2y, x1, y1] of segments) d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(x1)} ${f(y1)}`;
  return d;
}

/** Points along the thread, straight from the Bézier formula. */
export function sampleThread(segments: Segment[], perSegment = 32): ThreadSamples {
  const count = segments.length * perSegment + 1;
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const reach = new Float32Array(count);
  let k = 0;
  segments.forEach(([x0, y0, c1x, c1y, c2x, c2y, x1, y1], index) => {
    for (let step = index === 0 ? 0 : 1; step <= perSegment; step += 1) {
      const t = step / perSegment;
      const u = 1 - t;
      xs[k] = u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1;
      ys[k] = u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1;
      reach[k] = Math.max(xs[k], k > 0 ? reach[k - 1] : xs[k]);
      k += 1;
    }
  });
  return { xs, ys, reach };
}

/** The index of the first sample whose reach is at least x (path units). The last index when x is past the end. */
export function sampleAt(reach: Float32Array, x: number): number {
  let low = 0;
  let high = reach.length - 1;
  if (reach[high] < x) return high;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (reach[middle] < x) low = middle + 1;
    else high = middle;
  }
  return low;
}

// ───── Tip and progress ─────

export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/** Where the tip is (u) at a progress from -1 (the section enters) to 1 (the end). */
export function tipX(g: StoryGeometry, progress: number): number {
  if (progress < 0) return g.start + (g.anchor - g.start) * (1 + progress);
  const t = clamp((progress - 1 + g.catchUp) / g.catchUp);
  const ahead = t * t * (3 - 2 * t) * (g.end + 0.5 - g.travel - g.anchor);
  return progress * g.travel + g.anchor + ahead;
}

/** The progress at which the tip arrives at x (u). The inverse of tipX for a progress from 0 to 1. */
export function progressAtTip(g: StoryGeometry, x: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 32; i += 1) {
    const middle = (low + high) / 2;
    if (tipX(g, middle) < x) low = middle;
    else high = middle;
  }
  return high;
}

// ───── Rail ─────

/**
 * A chapter fills its part of the rail while the thread crosses it. Its button scrolls until the chapter
 * is near the left of the stage, but not past the point where the next chapter starts.
 */
export function railChapters(g: StoryGeometry, chapterX: number[], titles: string[]): RailChapter[] {
  if (chapterX.length !== titles.length) throw new Error("Story: one chapter x for each chapter title");
  return titles.map((title, i) => {
    const from = i === 0 ? 0 : progressAtTip(g, chapterX[i]);
    const to = i + 1 < chapterX.length ? progressAtTip(g, chapterX[i + 1]) : 1;
    const left = Math.max(0, (chapterX[i] - 8) / g.travel);
    return { title, from: from.toFixed(4), to: to.toFixed(4), go: Math.min(left, to < 1 ? to - 0.002 : 1).toFixed(4) };
  });
}
