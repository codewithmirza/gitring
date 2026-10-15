/**
 * Chapter 03: two agents leave main on dashed plan lines. Each plan note names the task and the function, so the visitor sees the plans will collide.
 * Used by Story.tsx. The notes are real plans (example.ts). The tags are the callsign component of the map.
 */
import { Callsign } from "../../../design/components";
import { EXAMPLE } from "../example";
import { spot } from "../place";

interface Plan {
  callsign: string;
  title: string;
  files: string;
  symbols: string;
}

/** One plan note: the task title in the voice of people, the files and the function in the voice of agents. */
function PlanNote({ plan, tool, ...place }: { plan: Plan; tool?: string; x: number; y: number; at: number }) {
  return (
    <div className="story-plate story-note story-place" {...spot({ ...place, thread: true })}>
      {tool && <span className="story-mono story-note__tool">{tool}</span>}
      <span className="story-serif story-note__title">{plan.title}</span>
      <span className="story-mono">files: {plan.files}</span>
      <span className="story-mono">symbols: {plan.symbols}</span>
    </div>
  );
}

export function Plans() {
  const { plans } = EXAMPLE;
  return (
    <>
      <span className="story-mono story-label story-main-label story-wide story-place" {...spot({ x: 162, y: 56, thread: true, at: 162 })}>
        main
      </span>
      <div className="story-tag story-place" {...spot({ x: 158, y: 48.5, thread: true, at: 172 })}>
        <Callsign callsign={plans.first.callsign} color={1} />
      </div>
      <PlanNote plan={plans.first} tool={plans.tool} x={188} y={29} at={186} />
      <div className="story-tag story-place" {...spot({ x: 158, y: 66, thread: true, at: 172 })}>
        <Callsign callsign={plans.second.callsign} color={2} />
      </div>
      <PlanNote plan={plans.second} x={188} y={78} at={186} />
    </>
  );
}
