/**
 * The pure maths of the landing story thread: segments, path text, samples, the tip, progress and the rail parts.
 * The functions are adapted from the portfolio of the founder; this test is adapted from his test too.
 */
import { describe, expect, it } from "vitest";
import {
  clamp,
  progressAtTip,
  railChapters,
  sampleAt,
  sampleThread,
  threadPath,
  threadSegments,
  tipX,
  type StoryGeometry,
  type Waypoint,
} from "../../web/src/views/story/thread";

const POINTS: Waypoint[] = [
  [0, 50],
  [10, 40],
  [20, 60],
  [40, 50],
];

function geometryOf(points: Waypoint[], over: Partial<StoryGeometry> = {}): StoryGeometry {
  const segments = threadSegments(points);
  return {
    canvas: 200,
    travel: 100,
    anchor: 55,
    start: points[0][0],
    end: points[points.length - 1][0],
    catchUp: 0.2,
    segments,
    samples: sampleThread(segments),
    ...over,
  };
}

describe("threadSegments", () => {
  it("makes one segment between each pair of waypoints, in path units", () => {
    const segments = threadSegments(POINTS);
    expect(segments).toHaveLength(POINTS.length - 1);
    expect(segments[0].slice(0, 2)).toEqual([0, 500]);
    expect(segments.at(-1)!.slice(6)).toEqual([400, 500]);
  });

  it("joins each segment to the one before it", () => {
    const segments = threadSegments(POINTS);
    for (let i = 1; i < segments.length; i += 1) expect(segments[i].slice(0, 2)).toEqual(segments[i - 1].slice(6));
  });

  it("makes one straight segment of two points", () => {
    const [segment] = threadSegments([
      [0, 10],
      [30, 10],
    ]);
    expect(segment[3]).toBe(100);
    expect(segment[5]).toBe(100);
  });
});

describe("threadPath", () => {
  it("writes the same text each time, with one decimal", () => {
    const d = threadPath(
      threadSegments([
        [0, 10],
        [30, 10],
      ]),
    );
    expect(d).toBe("M0.0 100.0C50.0 100.0 250.0 100.0 300.0 100.0");
    expect(threadPath(threadSegments(POINTS))).toBe(threadPath(threadSegments(POINTS)));
  });
});

describe("sampleThread and sampleAt", () => {
  it("samples from the first point to the last, and the reach never falls", () => {
    const { xs, ys, reach } = sampleThread(threadSegments(POINTS));
    expect(xs[0]).toBeCloseTo(0);
    expect(ys[0]).toBeCloseTo(500);
    expect(xs.at(-1)).toBeCloseTo(400);
    for (let i = 1; i < reach.length; i += 1) expect(reach[i]).toBeGreaterThanOrEqual(reach[i - 1]);
  });

  it("finds the first sample that reaches an x, and the last one past the end", () => {
    const { xs, reach } = sampleThread(threadSegments(POINTS));
    const i = sampleAt(reach, 200);
    expect(reach[i]).toBeGreaterThanOrEqual(200);
    expect(i === 0 || reach[i - 1] < 200).toBe(true);
    expect(sampleAt(reach, 99999)).toBe(xs.length - 1);
    expect(sampleAt(reach, -5)).toBe(0);
  });
});

describe("tipX and progressAtTip", () => {
  const g = geometryOf(POINTS, { start: 5, end: 190, canvas: 200, travel: 100 });

  it("starts at the start, comes to the anchor at progress 0, and stops at the end", () => {
    expect(tipX(g, -1)).toBe(5);
    expect(tipX(g, 0)).toBe(55);
    expect(tipX(g, 1)).toBeCloseTo(190.5);
  });

  it("only moves right", () => {
    let last = -Infinity;
    for (let p = -1; p <= 1.0001; p += 0.01) {
      const x = tipX(g, p);
      expect(x).toBeGreaterThanOrEqual(last);
      last = x;
    }
  });

  it("runs ahead only in the last part of the scroll", () => {
    expect(tipX(g, 0.5)).toBeCloseTo(0.5 * g.travel + g.anchor);
    expect(tipX(g, 0.8)).toBeCloseTo(0.8 * g.travel + g.anchor);
    expect(tipX(g, 0.95)).toBeGreaterThan(0.95 * g.travel + g.anchor);
  });

  it("finds the progress of an x, the inverse of tipX", () => {
    for (const p of [0, 0.1, 0.4, 0.7, 0.9, 1]) expect(progressAtTip(g, tipX(g, p))).toBeCloseTo(p, 3);
    expect(progressAtTip(g, 0)).toBeCloseTo(0, 5);
  });
});

describe("railChapters", () => {
  const g = geometryOf(POINTS, { start: 5, end: 190, canvas: 200, travel: 100 });
  const parts = railChapters(g, [10, 60, 110, 150], ["A", "B", "C", "D"]);

  it("has one part for each chapter, from 0 to 1, with no gap", () => {
    expect(parts).toHaveLength(4);
    expect(Number(parts[0].from)).toBe(0);
    expect(Number(parts.at(-1)!.to)).toBe(1);
    parts.forEach((part, i) => {
      expect(Number(part.to)).toBeGreaterThan(Number(part.from));
      if (i) expect(part.from).toBe(parts[i - 1].to);
    });
  });

  it("scrolls each button to a progress inside 0 to 1, before the next chapter starts", () => {
    parts.forEach((part, i) => {
      const go = Number(part.go);
      expect(go).toBeGreaterThanOrEqual(0);
      expect(go).toBeLessThanOrEqual(1);
      if (i + 1 < parts.length) expect(go).toBeLessThan(Number(part.to));
    });
  });

  it("throws when the chapters and the titles differ in number", () => {
    expect(() => railChapters(g, [10, 60], ["A"])).toThrow(/one chapter x/);
  });
});

describe("clamp", () => {
  it("keeps a value inside a range, 0 to 1 by default", () => {
    expect(clamp(-3)).toBe(0);
    expect(clamp(0.4)).toBe(0.4);
    expect(clamp(7)).toBe(1);
    expect(clamp(12, 5, 10)).toBe(10);
  });
});
