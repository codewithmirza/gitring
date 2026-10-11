import { memo, type CSSProperties } from "react";
import type { AgentInfo, Attempt, Intent } from "../../../src/core/types";
import { Button, IconButton, Panel, SectionLabel } from "../design/components";
import { Icon } from "../design/icons";
import { useStore } from "../state/store";
import { byId, indexes, selectIntentGroups, type IntentGroup } from "../state/selectors";
import { ATTEMPT_STATUS_TEXT, shortSha } from "../state/format";
import { Link } from "./router";
import { dropPending, setUi, useUi, type PendingTask } from "./ui";
import { LaunchButton } from "./LaunchControl";
import { useCanAct } from "../state/account";
import { readDraft, TaskComposer, writeDraft } from "./Composer";

const EMPTY_GROUPS: IntentGroup[] = [];
const EMPTY_ATTEMPTS: Attempt[] = [];
const EMPTY_AGENTS = new Map<string, AgentInfo>();

/** Lane ticks: one tick per work copy, in the agent's identity color; shape shows the status. */
export function LaneTicks({ attempts, agents }: { attempts: Attempt[]; agents: Map<string, AgentInfo> }) {
  if (!attempts.length) return null;
  const summary = attempts.map((a) => `${agents.get(a.agentId)?.callsign ?? a.agentId} ${ATTEMPT_STATUS_TEXT[a.status].toLowerCase()}`).join(", ");
  return (
    <span className="ticks" role="img" aria-label={`${attempts.length} ${attempts.length === 1 ? "work copy" : "work copies"}: ${summary}`}>
      {attempts.map((a) => {
        const g = agents.get(a.agentId);
        const kind =
          a.status === "landed"
            ? "landed"
            : a.status === "alternate" || a.status === "abandoned"
              ? "alternate"
              : a.status === "stale"
                ? "stale"
                : a.status === "ready"
                  ? "ready"
                  : "active";
        return (
          <span
            key={a.id}
            className={`tick tick--${kind}`}
            style={{ "--vc": `var(--v${(g?.color ?? 0) % 12})` } as CSSProperties}
            title={`${g?.callsign ?? a.agentId} · ${ATTEMPT_STATUS_TEXT[a.status]}`}
          />
        );
      })}
    </span>
  );
}

function intentMeta(i: Intent, attempts: Attempt[]): string {
  const active = attempts.filter((a) => !["landed", "alternate", "abandoned", "failed"].includes(a.status));
  const ready = attempts.filter((a) => a.status === "ready").length;
  switch (i.status) {
    case "judging":
      return `${ready} ready · needs a yes`;
    case "landed":
      return `Merged ${shortSha(i.landedSha)}${attempts.length > 1 ? ` · ${attempts.length - 1} ${attempts.length > 2 ? "alternatives" : "alternative"}` : ""}`;
    case "parked":
      return "Paused";
    case "merged-into":
      return "Duplicate of another task";
    case "open":
    case "draft":
      return attempts.length ? `${attempts.length} ${attempts.length === 1 ? "work copy" : "work copies"}` : "No work copies yet";
    default:
      return `${active.length} ${active.length === 1 ? "agent works" : "agents work"}${ready ? ` · ${ready} ready` : ""}`;
  }
}

const IntentRow = memo(function IntentRow({
  intent,
  attempts,
  agents,
  selected,
}: {
  intent: Intent;
  attempts: Attempt[];
  agents: Map<string, AgentInfo>;
  selected: boolean;
}) {
  return (
    <li className={["irow", selected && "is-selected", intent.status === "judging" && "is-judging"].filter(Boolean).join(" ")}>
      <Link to={`/tasks/${intent.id}`} className="irow__main b-row" aria-current={selected ? "page" : undefined}>
        <span className="irow__title voice-human">
          {intent.priority === "high" && (
            <span className="irow__prio" title="High priority">
              <Icon name="chevron-up" size={12} />
              <span className="vh">High priority.</span>
            </span>
          )}
          {intent.title}
        </span>
        <span className="irow__meta">
          <LaneTicks attempts={attempts} agents={agents} />
          <span className="irow__status">
            {intent.status === "judging" && <Icon name="lighthouse" size={12} />}
            {intentMeta(intent, attempts)}
          </span>
        </span>
      </Link>
      {(intent.status === "open" || intent.status === "draft") && (
        <span className="irow__action">
          <LaunchButton intent={intent} label="Start" />
        </span>
      )}
    </li>
  );
});

/** A task on its way to the server ("Sending…"), or one that did not arrive (with Edit). */
function PendingRow({ p, projectId }: { p: PendingTask; projectId: string }) {
  const edit = () => {
    if (p.draft) {
      const cur = readDraft(projectId);
      // Keep both texts: the failed one goes into the composer, a newer draft goes into its goal.
      const merged = cur.title.trim() || cur.goal.trim() ? { ...p.draft, goal: [p.draft.goal, cur.title, cur.goal].filter(Boolean).join("\n\n") } : p.draft;
      writeDraft(projectId, merged);
    }
    dropPending(p.key);
    setUi({ composer: true, composerFocus: Date.now() });
  };
  return (
    <li className={["irow", "irow--pending", p.state === "error" && "is-error"].filter(Boolean).join(" ")}>
      <div className="irow__main b-row" aria-busy={p.state === "sending" || undefined}>
        <span className="irow__title voice-human">{p.title}</span>
        <span className="irow__meta" role={p.state === "error" ? "alert" : "status"}>
          {p.state === "sending" ? (
            <>
              <span className="irow__spin" aria-hidden="true" />
              Sending…
            </>
          ) : (
            <>
              <Icon name="cross" size={12} />
              Not created: {p.error}
            </>
          )}
        </span>
      </div>
      {p.state === "error" && (
        <span className="irow__action irow__action--pending">
          {p.draft && (
            <Button size="sm" onClick={edit}>
              Edit
            </Button>
          )}
          <IconButton size="sm" icon="close" label={`Dismiss “${p.title}”`} onClick={() => dropPending(p.key)} tooltip={false} />
        </span>
      )}
    </li>
  );
}

export function IntentsRail({ selectedId }: { selectedId?: string }) {
  const groups = useStore((s) => (s.state ? selectIntentGroups(s.state) : EMPTY_GROUPS));
  const byIntent = useStore((s) => (s.state ? indexes(s.state).attemptsByIntent : null));
  const agents = useStore((s) => (s.state ? byId(s.state.agents) : null));
  const projectId = useStore((s) => s.projectId);
  const { pending } = useUi();
  const total = groups.reduce((n, g) => n + g.intents.length, 0);
  const canAct = useCanAct();
  return (
    <Panel title="Tasks" count={total} headingId="intents-rail-title" className="rail rail--intents">
      {canAct && (
        <div className="rail__compose">
          <TaskComposer autoOpen={total === 0} />
        </div>
      )}
      {pending.length > 0 && (
        <ul role="list" className="igroup igroup--pending" aria-label="Tasks on their way">
          {pending.map((p) => (
            <PendingRow key={p.key} p={p} projectId={projectId} />
          ))}
        </ul>
      )}
      {total === 0 && pending.length === 0 ? (
        <p className="rail__empty">{canAct ? "Write the first task. Agents read the title and the goal." : "No tasks yet. Members write tasks here."}</p>
      ) : (
        groups.map((g) => (
          <div key={g.id} className="igroup">
            <SectionLabel count={g.intents.length} id={`ig-${g.id}`}>
              {g.label}
            </SectionLabel>
            <ul role="list" aria-labelledby={`ig-${g.id}`}>
              {g.intents.map((i) => (
                <IntentRow key={i.id} intent={i} attempts={byIntent?.get(i.id) ?? EMPTY_ATTEMPTS} agents={agents ?? EMPTY_AGENTS} selected={i.id === selectedId} />
              ))}
            </ul>
          </div>
        ))
      )}
    </Panel>
  );
}
