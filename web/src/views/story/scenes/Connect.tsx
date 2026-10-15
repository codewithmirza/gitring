/**
 * Chapter 02: one URL connects each agent, and three hulls sit on main.
 * The hulls are named by the apps that scripts play in this example.
 * Used by Story.tsx. The apps and the address are real strings (example.ts). The stems and the hulls on main are wide only.
 */
import { CAPTIONS } from "../copy";
import { EXAMPLE } from "../example";
import type { AgentIndex } from "../geometry";
import { spot } from "../place";
import { AgentHull } from "./art";

const HULL_X = [118, 128, 138];
const MAIN_Y = 59;

export function Connect() {
  const { connect } = EXAMPLE;
  return (
    <>
      <div className="story-plate story-url story-place" {...spot({ x: 112, y: 40, thread: true, at: 110 })}>
        <span className="story-mono">{connect.url}</span>
      </div>
      {HULL_X.map((x) => (
        <span key={x} className="story-stem story-wide story-place" style={{ "--x": x, "--y": 44.4, "--h": 13.4 } as React.CSSProperties} data-at={x - 2} data-reveal="thread" aria-hidden="true" />
      ))}
      <ul className="story-apps" role="list">
        {connect.apps.map((name, index) => (
          <li key={name} className="story-app story-place" {...spot({ x: HULL_X[index], y: MAIN_Y, thread: true, at: HULL_X[index] - 2 })}>
            <AgentHull agent={(index + 1) as AgentIndex} size={22} heading={90} />
            <span className="story-label">{name}</span>
          </li>
        ))}
      </ul>
      <p className="story-caption story-place" {...spot({ x: 112, y: 70, thread: true, at: 138 })}>
        {CAPTIONS.scripts}
      </p>
    </>
  );
}
