/**
 * The numbers of the landing story: seven chapters, a main line that only moves right, agent lines that start and
 * end on main, merges in order, the diamond at the end of a plan, and a pinned scroll of at most four screens.
 */
import { describe, expect, it } from "vitest";
import { CHAPTERS } from "../../web/src/views/story/copy";
import {
  CANVAS_U,
  CHAPTER_X,
  DEPARTURES,
  DIAMOND,
  GEOMETRY,
  GRATICULE_PATH,
  MAIN,
  MAIN_MOVED,
  MAIN_PATH,
  MAX_SCREENS,
  MERGES,
  RAIL,
  SCROLL_U,
  STRANDS,
  STRAND_PATHS,
  TRAVEL_U,
  pinnedScrollPx,
  type AgentIndex,
  type Strand,
} from "../../web/src/views/story/geometry";
import { progressAtTip, sampleAt } from "../../web/src/views/story/thread";

/** The y of main (in %) at an x (in u). */
function mainY(x: number): number {
  const { ys, reach } = GEOMETRY.samples;
  return ys[sampleAt(reach, x * 10)] / 10;
}

const chain = (agent: AgentIndex): Strand[] => STRANDS.filter((strand) => strand.agent === agent);
const first = (strand: Strand) => strand.points[0];
const last = (strand: Strand) => strand.points[strand.points.length - 1];

describe("the chapters and the rail", () => {
  it("has seven chapters, one rail part and one x for each", () => {
    expect(CHAPTERS).toHaveLength(7);
    expect(RAIL).toHaveLength(7);
    expect(CHAPTER_X).toHaveLength(7);
    expect(RAIL.map((part) => part.title)).toEqual(CHAPTERS.map((chapter) => chapter.rail));
  });

  it("has chapter anchors that are plain and different", () => {
    const ids = CHAPTERS.map((chapter) => chapter.id);
    expect(new Set(ids).size).toBe(7);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });

  it("puts the chapters in order on the canvas", () => {
    for (let i = 1; i < CHAPTER_X.length; i += 1) expect(CHAPTER_X[i]).toBeGreaterThan(CHAPTER_X[i - 1]);
    expect(CHAPTER_X.at(-1)!).toBeLessThan(CANVAS_U);
  });

  it("gives the rail the ranges of the plan", () => {
    const wanted = [
      [0, 0.1349, 0.1164],
      [0.1349, 0.2831, 0.2593],
      [0.2831, 0.4312, 0.4074],
      [0.4312, 0.5952, 0.5556],
      [0.5952, 0.7698, 0.7196],
      [0.7698, 0.891, 0.889],
      [0.891, 1, 1],
    ];
    RAIL.forEach((part, i) => {
      expect(Number(part.from)).toBeCloseTo(wanted[i][0], 3);
      expect(Number(part.to)).toBeCloseTo(wanted[i][1], 3);
      expect(Number(part.go)).toBeCloseTo(wanted[i][2], 3);
    });
  });
});

describe("main", () => {
  it("only moves right, in the waypoints and in the path", () => {
    for (let i = 1; i < MAIN.length; i += 1) expect(MAIN[i][0]).toBeGreaterThan(MAIN[i - 1][0]);
    const xs = MAIN_PATH.split(/[MC]/)
      .filter(Boolean)
      .map((part) => Number(part.trim().split(" ").at(-2)));
    expect(xs.length).toBeGreaterThan(10);
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });

  it("starts and ends inside the canvas, and the tip can reach the end", () => {
    expect(MAIN[0][0]).toBe(GEOMETRY.start);
    expect(MAIN.at(-1)![0]).toBe(GEOMETRY.end);
    expect(GEOMETRY.end).toBeLessThan(CANVAS_U);
    expect(GEOMETRY.travel).toBe(TRAVEL_U);
    expect(progressAtTip(GEOMETRY, GEOMETRY.end)).toBeLessThanOrEqual(1);
  });

  it("draws a graticule path inside the canvas", () => {
    expect(GRATICULE_PATH.startsWith("M0 0V1000")).toBe(true);
    expect(GRATICULE_PATH).toContain(`M${CANVAS_U * 10 - (CANVAS_U % 20) * 10} 0V1000`);
  });
});

describe("the agent lines", () => {
  it("has a path for each strand, and the strands only move right", () => {
    expect(STRAND_PATHS).toHaveLength(STRANDS.length);
    for (const strand of STRANDS) {
      for (let i = 1; i < strand.points.length; i += 1) expect(strand.points[i][0], strand.id).toBeGreaterThan(strand.points[i - 1][0]);
      expect(first(strand)[0]).toBeGreaterThan(MAIN[0][0]);
      expect(last(strand)[0]).toBeLessThan(CANVAS_U);
    }
  });

  it("starts each agent line on main and ends it on main", () => {
    for (const agent of [1, 2, 3] as const) {
      const strands = chain(agent);
      expect(Math.abs(first(strands[0])[1] - mainY(first(strands[0])[0])), `agent ${agent} start`).toBeLessThanOrEqual(0.5);
      const end = last(strands.at(-1)!);
      expect(Math.abs(end[1] - mainY(end[0])), `agent ${agent} end`).toBeLessThanOrEqual(0.5);
    }
  });

  it("starts each strand where the one before ends", () => {
    for (const agent of [1, 2, 3] as const) {
      const strands = chain(agent);
      for (let i = 1; i < strands.length; i += 1) expect(first(strands[i])).toEqual(last(strands[i - 1]));
    }
  });

  it("makes every plan dashed and every piece of work solid", () => {
    for (const strand of STRANDS) expect(strand.dashed, strand.id).toBe(/plan|wait/.test(strand.id));
  });

  it("splits A and B together, and C later, at the departures", () => {
    expect(first(chain(1)[0])[0]).toBe(DEPARTURES.first);
    expect(first(chain(2)[0])[0]).toBe(DEPARTURES.first);
    expect(first(chain(3)[0])[0]).toBe(DEPARTURES.second);
  });

  it("merges in order: A first, then B, then C, at the end of each line", () => {
    expect(MERGES[1][0]).toBeLessThan(MERGES[2][0]);
    expect(MERGES[2][0]).toBeLessThan(MERGES[3][0]);
    for (const agent of [1, 2, 3] as const) expect(last(chain(agent).at(-1)!)).toEqual(MERGES[agent]);
  });

  it("shows main moved to the right of the merge of A, the cause of it, and before B joins", () => {
    expect(MAIN_MOVED.x).toBeGreaterThan(MERGES[1][0]);
    expect(MAIN_MOVED.at).toBeGreaterThan(MERGES[1][0]);
    expect(MAIN_MOVED.at).toBeLessThan(MERGES[2][0]);
  });

  it("puts the diamond at the end of the plan of agent B, not on its work", () => {
    expect(DIAMOND).toEqual(last(STRANDS.find((strand) => strand.id === "b-plan")!));
    expect(DIAMOND).toEqual(first(STRANDS.find((strand) => strand.id === "b-work")!));
  });
});

describe("the length of the scroll", () => {
  it("pins the stage for at most four screens on the usual windows", () => {
    expect(MAX_SCREENS).toBe(4);
    for (const [width, height] of [
      [1280, 720],
      [1440, 900],
      [1920, 1080],
      [1024, 640],
      [2560, 1440],
    ]) {
      expect(pinnedScrollPx(width, height) / height).toBeLessThanOrEqual(4);
    }
    expect(Math.round(pinnedScrollPx(1440, 900))).toBe(3600);
    expect(Math.round(pinnedScrollPx(1280, 720))).toBe(2880);
  });

  it("moves the canvas about 1.5 px for each px of scroll", () => {
    expect(SCROLL_U).toBeCloseTo(252, 5);
  });
});
