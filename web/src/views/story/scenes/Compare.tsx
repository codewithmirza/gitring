/**
 * Chapter 04, the peak of the story: both plans end on one parcel, a magenta distance line joins them, and the request reaches one agent.
 * Used by Story.tsx. Magenta is for change requests only, so this is the one place that holds it. The request text is real (example.ts).
 */
import { CAPTIONS } from "../copy";
import { EXAMPLE } from "../example";
import { DIAMOND } from "../geometry";
import { spot } from "../place";
import { Diamond } from "./art";

export function Compare() {
  const { check } = EXAMPLE;
  return (
    <>
      <div className="story-parcel story-wide story-place" {...spot({ x: 214, y: 52, thread: true, at: 212 })}>
        <span className="story-mono">src/price.js</span>
      </div>
      <span className="story-distance story-wide story-place" style={{ "--x": 224, "--y": 45, "--h": 28 } as React.CSSProperties} data-at={224} data-reveal="thread" aria-hidden="true" />
      <span className="story-chip story-wide story-place" {...spot({ x: 228, y: 52, thread: true, at: 226 })}>
        {check.distance}
      </span>
      <span className="story-mono story-label story-clear story-wide story-place" {...spot({ x: 228, y: 41, thread: true, at: 228 })}>
        {check.clear}
      </span>
      <span className="story-flag story-wide story-place" {...spot({ x: DIAMOND[0], y: DIAMOND[1], thread: true, at: 228 })}>
        <Diamond />
      </span>
      <div className="story-plate story-request story-place" {...spot({ x: 224, y: 77, thread: true, at: 232 })}>
        <span className="story-request__label">{CAPTIONS.request}</span>
        <p className="story-mono">
          <span className="story-request__reason">{check.reason}</span> {check.request} …
        </p>
        <p className="story-distance-text">{CAPTIONS.distance}</p>
      </div>
    </>
  );
}
