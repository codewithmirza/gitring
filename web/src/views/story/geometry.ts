/**
 * The numbers of the story: the size of the canvas, the line called main, the lines of the agents and the rail.
 * Used by Story.tsx (draws the paths), engine/ (moves the tip) and the geometry test. It has no DOM and no React.
 * Units: 1 u is 1% of the stage width. A y value is a percent of the stage height. The plan is docs/design/landing-story.md.
 */
import { CHAPTERS } from "./copy";
import { railChapters, sampleThread, threadPath, threadSegments, type RailChapter, type StoryGeometry, type Waypoint } from "./thread";

// ───── Numbers ─────

/** Width of the canvas in u. */
export const CANVAS_U = 478;
/** How far the canvas slides left (the canvas minus one stage). */
export const TRAVEL_U = CANVAS_U - 100;
/** The tip of the thread stays at this x (u) on the stage. */
export const ANCHOR = 55;
/** The last part of the scroll lets the tip run ahead to the end. */
export const CATCH_UP = 0.2;
/** The canvas moves about this many px for each px of scroll. */
export const SPEED = 1.5;
/** Scroll length while the stage is pinned, in u of the stage width, before the cap. */
export const SCROLL_U = TRAVEL_U / SPEED;
/** The pinned part never lasts more than this many screens. */
export const MAX_SCREENS = 4;

/** The first point of main: the first commit of the project. */
export const START: Waypoint = [48, 60];
/** The last point of main. The tip stops here. */
export const END: Waypoint = [470, 62];

/** Where each chapter starts on the canvas (u). The text of a chapter stands here. */
export const CHAPTER_X = [52, 106, 162, 218, 280, 346, 408];

/** The y of the lanes (%): agent A and agent C above main, main, agent B below. */
export const LANE = { upper: 45, main: 59, lower: 73 } as const;

// ───── Main ─────

/** Main is almost straight on purpose: it is the datum line of the chart. The bends belong to the agents. */
export const MAIN: Waypoint[] = [
  START,
  [72, 58.5],
  [96, 59.5],
  [120, 59],
  [150, 59],
  [170, 59],
  [200, 59],
  [240, 59],
  [280, 59],
  [320, 59],
  [360, 59],
  [400, 59],
  [430, 59],
  [452, 60.5],
  END,
];

// ───── Agent lines ─────

/** The agent that owns a line. The colour is --v1, --v2 or --v3: the colours of the second to fourth agent of a project. */
export type AgentIndex = 1 | 2 | 3;

export interface Strand {
  /** A short name for tests and for the data-strand attribute. */
  id: string;
  agent: AgentIndex;
  /** A plan is dashed (no code yet). Work is a solid line. */
  dashed: boolean;
  points: Waypoint[];
}

/** An agent line is a chain of strands: a plan, the work, and for agent C a wait for a person. */
export const STRANDS: Strand[] = [
  { id: "a-plan", agent: 1, dashed: true, points: [[172, 59], [180, 53.5], [190, 47], [204, 45], [224, 45]] },
  { id: "a-work", agent: 1, dashed: false, points: [[224, 45], [262, 45], [292, 45], [302, 47.5], [312, 59]] },
  { id: "b-plan", agent: 2, dashed: true, points: [[172, 59], [180, 64.5], [190, 71], [204, 73], [224, 73]] },
  { id: "b-work", agent: 2, dashed: false, points: [[224, 73], [246, 73], [292, 73], [310, 72], [326, 66], [338, 59]] },
  { id: "c-plan", agent: 3, dashed: true, points: [[350, 59], [358, 53], [364, 47], [368, 45]] },
  { id: "c-work", agent: 3, dashed: false, points: [[368, 45], [378, 45]] },
  { id: "c-wait", agent: 3, dashed: true, points: [[378, 45], [388, 45]] },
  { id: "c-after", agent: 3, dashed: false, points: [[388, 45], [393, 46.5], [398, 59]] },
];

/** Where an agent joins main (u, %). A merge is a dot on main. */
export const MERGES: Record<AgentIndex, Waypoint> = { 1: [312, 59], 2: [338, 59], 3: [398, 59] };

/** Where agents leave main (u): A and B together, C later. */
export const DEPARTURES = { first: 172, second: 350 } as const;

/** The end of the plan of agent B: the change request arrives here, before any code exists. */
export const DIAMOND: Waypoint = [224, 73];

/** The label "main moved" stands to the right of the merge of agent A, because that merge is its cause. */
export const MAIN_MOVED = { x: 322, y: 79, at: 320 } as const;

/** The three ways to start a project (chapter 01) join the first point of main. Each line starts at the right edge of an input. */
export const INPUT_LINES: Waypoint[][] = [
  [[40, 43], [43, 46], [45.5, 53], START],
  [[40, 57], [44, 58.5], START],
  [[40, 71], [43, 68], [45.5, 64], START],
];

// ───── Built geometry ─────

const mainSegments = threadSegments(MAIN);

export const GEOMETRY: StoryGeometry = {
  canvas: CANVAS_U,
  travel: TRAVEL_U,
  anchor: ANCHOR,
  start: START[0],
  end: END[0],
  catchUp: CATCH_UP,
  segments: mainSegments,
  samples: sampleThread(mainSegments),
};

/** The path strings of main and of the strands. They are the same text on a server and in a browser. */
export const MAIN_PATH = threadPath(mainSegments);
export const INPUT_PATHS = INPUT_LINES.map((points) => threadPath(threadSegments(points)));
export const STRAND_PATHS = STRANDS.map((strand) => ({ ...strand, d: threadPath(threadSegments(strand.points)) }));

/** One rail part for each chapter, in order, with the progress range that fills it. */
export const RAIL: RailChapter[] = railChapters(
  GEOMETRY,
  CHAPTER_X,
  CHAPTERS.map((chapter) => chapter.rail),
);

/** The graticule of the chart: a hairline every 20 u and every 20%, as one path in path units. */
function graticulePath(): string {
  const lines: string[] = [];
  for (let x = 0; x <= CANVAS_U; x += 20) lines.push(`M${x * 10} 0V1000`);
  for (let y = 0; y <= 100; y += 20) lines.push(`M0 ${y * 10}H${CANVAS_U * 10}`);
  return lines.join("");
}
export const GRATICULE_PATH = graticulePath();

/** How far the page scrolls while the stage is pinned, in px, for a stage of this size. */
export function pinnedScrollPx(stageWidth: number, stageHeight: number): number {
  return Math.min((SCROLL_U * stageWidth) / 100, MAX_SCREENS * stageHeight);
}
