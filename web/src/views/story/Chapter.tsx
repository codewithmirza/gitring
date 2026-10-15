/**
 * The opening and one chapter of the story: number, heading and text. The markup is the same in every layout.
 * Used by StaticStory (stacked, no drawings) and by Story (the pinned stage with scenes). It has no state.
 */
import type { ReactNode } from "react";
import { CHAPTERS, OPENING, chapterNumber } from "./copy";
import type { spot } from "./place";

type Spot = ReturnType<typeof spot>;

/** The heading, the text and the cue of the story. The heading names the section. */
export function Opening({ at }: { at?: Spot }) {
  return (
    <div className="story-chapter story-opening story-place" {...at}>
      <span className="story-node story-node--dot" aria-hidden="true" />
      <div className="story-text">
        <h2 id="story-h" className="story-title">
          {OPENING.heading}
        </h2>
        <p>{OPENING.text}</p>
        <p className="story-cue">{OPENING.cue}</p>
      </div>
    </div>
  );
}

/**
 * One chapter. `at` places its text on the canvas of the wide layout, `node` is the glyph on the spine
 * of the stacked layout, and the children are the scene of the chapter.
 */
export function Chapter({ index, at, node, children }: { index: number; at?: Spot; node?: ReactNode; children?: ReactNode }) {
  const chapter = CHAPTERS[index];
  return (
    <article className="story-chapter" id={`story-${chapter.id}`} data-chapter={chapter.id}>
      {node ?? <span className="story-node story-node--dot" aria-hidden="true" />}
      <div className="story-text story-place" {...at}>
        <h3 className="story-heading">
          <span className="story-num" aria-hidden="true">
            {chapterNumber(index)}
          </span>
          {chapter.heading}
        </h3>
        <p>{chapter.text}</p>
      </div>
      {children}
    </article>
  );
}
