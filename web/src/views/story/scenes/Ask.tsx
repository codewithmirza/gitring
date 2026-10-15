/**
 * Chapter 06: TERN-7 stops at a gate. The real question waits for a person, who can answer in the chat, in the app, or in both.
 * Used by Story.tsx. The question and the answer places are real strings (example.ts). The buttons are a drawing and do nothing.
 */
import { Callsign } from "../../../design/components";
import { Icon } from "../../../design/icons";
import { CAPTIONS } from "../copy";
import { EXAMPLE } from "../example";
import { MERGES } from "../geometry";
import { spot } from "../place";
import { GateMark, JoinDot } from "./art";

/** The three places where a person can answer, one under the other at the right of the question. */
const PLACE_Y = [61, 68.5, 76];

export function Ask() {
  const { ask } = EXAMPLE;
  return (
    <>
      <span className="story-mono story-label story-main-label story-wide story-place" {...spot({ x: 340, y: 56, thread: true, at: 340 })}>
        main
      </span>
      <div className="story-gate story-gate--person story-place" {...spot({ x: 378, y: 45, thread: true, at: 377 })}>
        <GateMark kind="person" />
        <span className="story-narrow-only">
          <Callsign callsign="TERN-7" color={3} />
        </span>
        <span className="story-label story-gate__label">{ask.waits}</span>
      </div>
      <div className="story-plate story-question story-place" {...spot({ x: 360, y: 64, thread: true, at: 372 })}>
        <span className="story-serif story-question__task">{ask.task}</span>
        <span className="story-mono">{ask.facts}</span>
        <span className="story-mono">{ask.why}</span>
        <span className="story-question__acts" aria-hidden="true">
          <span className="story-button story-button--primary">{ask.yes}</span>
          <span className="story-button">{ask.back}</span>
        </span>
      </div>
      <ul className="story-places" role="list">
        {ask.places.map((place, index) => (
          <li key={place} className="story-plate story-place story-place-option" {...spot({ x: 390, y: PLACE_Y[index], thread: true, at: 386 })}>
            <Icon name="ring" size={12} />
            <span className="story-label">{place}</span>
          </li>
        ))}
      </ul>
      <p className="story-caption story-place" {...spot({ x: 405, y: 67.5, thread: true, at: 388 })}>
        {CAPTIONS.noAgent}
      </p>
      <span className="story-join story-wide story-place" {...spot({ x: MERGES[3][0], y: MERGES[3][1], thread: true, at: MERGES[3][0] })}>
        <JoinDot />
      </span>
    </>
  );
}
