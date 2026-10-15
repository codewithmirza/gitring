/**
 * Chapter 05: tests are a gate on each agent line, and the merges come one after the other.
 * HERON-2 joins main first. Then main has moved, and PETREL-9 joins after it.
 * Used by Story.tsx. A merge is a dot on main with no label. The test lines are real answers (example.ts).
 */
import { Callsign } from "../../../design/components";
import { EXAMPLE } from "../example";
import { MAIN_MOVED, MERGES } from "../geometry";
import { spot } from "../place";
import { GateMark, JoinDot } from "./art";

/** A test gate on a lane. In the stacked layout it is one row: the mark, the agent and the answer of the tests. */
function TestGate({ callsign, color, text, label, x, y, at }: { callsign: string; color: number; text: string; label: "above" | "below"; x: number; y: number; at: number }) {
  return (
    <div className="story-gate story-place" data-label={label} {...spot({ x, y, thread: true, at })}>
      <GateMark kind="tests" />
      <span className="story-narrow-only">
        <Callsign callsign={callsign} color={color} />
      </span>
      <span className="story-mono story-gate__label">{text}</span>
    </div>
  );
}

export function Merge() {
  const { merge, plans } = EXAMPLE;
  return (
    <>
      <TestGate callsign={plans.first.callsign} color={1} text={merge.first} label="above" x={291} y={45} at={290} />
      <span className="story-join story-wide story-place" {...spot({ x: MERGES[1][0], y: MERGES[1][1], thread: true, at: MERGES[1][0] })}>
        <JoinDot />
      </span>
      <span className="story-mono story-label story-wide story-place" {...spot({ x: MAIN_MOVED.x, y: MAIN_MOVED.y, thread: true, at: MAIN_MOVED.at })}>
        {merge.moved}
      </span>
      <TestGate callsign={plans.second.callsign} color={2} text={merge.second} label="below" x={325} y={66} at={324} />
      <span className="story-join story-wide story-place" {...spot({ x: MERGES[2][0], y: MERGES[2][1], thread: true, at: MERGES[2][0] })}>
        <JoinDot />
      </span>
    </>
  );
}
