/**
 * The pinned story: a stage, a canvas that slides left while the page scrolls, the thread, the chapters with their scenes, and the rail.
 * A separate chunk: StorySection loads it when the section is near. Read engine/ for the motion and scenes/ for the drawings.
 * Reading order is the order of the chapters. Every drawing is hidden from a screen reader; every chapter has its text in the DOM.
 */
import type { ComponentType, ReactNode, RefObject } from "react";
import { Chapter, Opening } from "./Chapter";
import { CHAPTERS, SMALL, chapterNumber } from "./copy";
import { useStoryEngine } from "./engine/useStoryEngine";
import { CANVAS_U, CHAPTER_X, GRATICULE_PATH, INPUT_PATHS, MAIN_PATH, RAIL, START, STRAND_PATHS } from "./geometry";
import { spot } from "./place";
import { AgentHull, Diamond, NodeIcon, SpineNode } from "./scenes/art";
import { Ask } from "./scenes/Ask";
import { Compare } from "./scenes/Compare";
import { Connect } from "./scenes/Connect";
import { Merge } from "./scenes/Merge";
import { Plans } from "./scenes/Plans";
import { Start } from "./scenes/Start";
import { Why } from "./scenes/Why";
import "./story-wide.css";
import "./story-scenes.css";

/** The size of the path space: 10 units for each u and for each % of the height. */
const VIEW_BOX = `0 0 ${CANVAS_U * 10} 1000`;

/** The text of a chapter stands at its x, in the band above the scenes. */
const TEXT_Y = 9;

/** The scene of each chapter, in the order of CHAPTERS. */
const SCENES: ComponentType[] = [Start, Connect, Plans, Compare, Merge, Ask, Why];

/** The glyph on the spine of the stacked layout. The first chapter keeps the plain dot. */
const NODES: ReactNode[] = [
  null,
  <SpineNode key="connect">
    <AgentHull agent={1} size={14} />
  </SpineNode>,
  <SpineNode key="plans">
    <AgentHull agent={2} size={14} />
  </SpineNode>,
  <SpineNode key="check">
    <Diamond size={14} />
  </SpineNode>,
  <SpineNode key="merge">
    <NodeIcon name="check" />
  </SpineNode>,
  <SpineNode key="yes">
    <NodeIcon name="human" />
  </SpineNode>,
  <SpineNode key="why">
    <NodeIcon name="logbook" />
  </SpineNode>,
];

function Thread() {
  return (
    <svg className="story-thread story-wide" viewBox={VIEW_BOX} preserveAspectRatio="none" aria-hidden="true">
      {INPUT_PATHS.map((d) => (
        <path key={d} className="story-line story-line--input" d={d} />
      ))}
      {STRAND_PATHS.map((strand) => (
        <path key={strand.id} className={strand.dashed ? "story-line story-line--agent is-dashed" : "story-line story-line--agent"} data-agent={strand.agent} d={strand.d} />
      ))}
      <path className="story-line story-line--main" d={MAIN_PATH} />
    </svg>
  );
}

function Rail() {
  return (
    <nav className="story-rail" aria-label={SMALL.railLabel}>
      {RAIL.map((part, index) => (
        <button key={part.title} type="button" data-go={part.go} data-from={part.from} data-to={part.to} data-chapter={CHAPTERS[index].id}>
          <span className="story-rail__n" aria-hidden="true">
            {chapterNumber(index)}
          </span>
          {part.title}
        </button>
      ))}
      <a href="#wl-closing">{SMALL.skip}</a>
    </nav>
  );
}

export default function Story({ section }: { section: RefObject<HTMLElement | null> }) {
  useStoryEngine(section);
  return (
    <div className="story-stage">
      <div className="story-window">
        <div className="story-canvas">
          <span className="story-spine" aria-hidden="true" />
          <svg className="story-graticule story-wide" viewBox={VIEW_BOX} preserveAspectRatio="none" aria-hidden="true">
            <path d={GRATICULE_PATH} />
          </svg>
          <Thread />
          <span className="story-start story-place story-wide" {...spot({ x: START[0], y: START[1], thread: true })} aria-hidden="true" />
          <span className="story-tip story-wide" aria-hidden="true" />
          <Opening at={spot({ x: 6, y: TEXT_Y, at: START[0], thread: true })} />
          {CHAPTERS.map((chapter, index) => {
            const Scene = SCENES[index];
            return (
              <Chapter key={chapter.id} index={index} at={spot({ x: CHAPTER_X[index], y: TEXT_Y })} node={NODES[index]}>
                <Scene />
              </Chapter>
            );
          })}
        </div>
      </div>
      <Rail />
    </div>
  );
}
