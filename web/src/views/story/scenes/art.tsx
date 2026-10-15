/**
 * The small drawings of the scenes: the diamond of a change request, an agent hull, the glyph of a node and the mark of a gate.
 * Used by Story.tsx and the scenes. They use the hulls and icons of the design system, so they are the objects that the map shows.
 */
import { Hull, Icon, hullName, type IconName } from "../../../design/icons";
import type { AgentIndex } from "../geometry";

/** The path of the change-request buoy of the map: a diamond. */
const DIAMOND_PATH = "M0 -7 L7 0 L0 7 L-7 0 Z";

/** The diamond of a change request. Magenta is for change requests only. */
export function Diamond({ size = 15 }: { size?: number }) {
  return (
    <svg className="story-diamond" width={size} height={size} viewBox="-8 -8 16 16" aria-hidden="true">
      <path d={DIAMOND_PATH} />
    </svg>
  );
}

/** The hull of an agent, in the colour that the map gives the agent. Agent 1 is a chevron, 2 a dart, 3 a kite. Heading 90 points right, along main. */
export function AgentHull({ agent, size = 20, heading = 0 }: { agent: AgentIndex; size?: number; heading?: number }) {
  return <Hull hull={hullName(agent)} size={size} heading={heading} color={`var(--v${agent})`} />;
}

/** The glyph on the spine of the stacked layout. It is page furniture, so it is hidden from a screen reader. */
export function SpineNode({ children }: { children: React.ReactNode }) {
  return (
    <span className="story-node" aria-hidden="true">
      {children}
    </span>
  );
}

export function NodeIcon({ name }: { name: IconName }) {
  return <Icon name={name} size={14} />;
}

/** The mark of a gate: a check for tests, a person for a question. */
export function GateMark({ kind }: { kind: "tests" | "person" }) {
  return (
    <span className="story-gate__mark" aria-hidden="true">
      <Icon name={kind === "tests" ? "check" : "human"} size={12} />
    </span>
  );
}

/** A dot on main: an agent joined it. A merge has no label. */
export function JoinDot() {
  return <span className="story-dot" aria-hidden="true" />;
}
