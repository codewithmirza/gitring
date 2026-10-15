/**
 * Chapter 01: the three ways to start a project (a sentence, a template, one tool call) join the first point of main.
 * Used by Story.tsx. The words in the plates are real strings (example.ts). The lines that join them are in the thread.
 */
import { EXAMPLE } from "../example";
import { spot } from "../place";

/** The inputs start at x 6 and are 30 u wide, so their right edge is at 36, where the lines of INPUT_LINES start. Their centres are at 43, 57 and 71 %. */
const X = 6;
/** The inputs show with the first point of main. */
const AT = 48;

export function Start() {
  const { start } = EXAMPLE;
  return (
    <>
      <span className="story-mono story-label story-main-label story-wide story-place" {...spot({ x: 48, y: 56, thread: true, at: AT })}>
        main
      </span>
      <ul className="story-inputs" role="list">
        <li className="story-plate story-input story-place" {...spot({ x: X, y: 43, thread: true, at: AT })}>
          <span className="story-label">{start.describeLabel}</span>
          <span className="story-serif">{start.describe}</span>
        </li>
        <li className="story-plate story-input story-place" {...spot({ x: X, y: 57, thread: true, at: AT })}>
          <span className="story-label">{start.templateLabel}</span>
          <span>{start.template}</span>
        </li>
        <li className="story-plate story-input story-place" {...spot({ x: X, y: 71, thread: true, at: AT })}>
          <span className="story-mono">{start.tool}</span>
        </li>
      </ul>
    </>
  );
}
