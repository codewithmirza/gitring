/**
 * The task rail: the composer, a filter when the list is long, then the tasks grouped by status, each with a tick for
 * every work copy. A group of more than 20 tasks is split by day. "Start agents" shows on hover and focus only.
 * Read by the overview and the tasks page. The composer is in ./Composer.tsx. The styles are in ../views/intents/rail.css.
 */
import { memo, useDeferredValue, useMemo, useState, type CSSProperties } from "react";
import type { AgentInfo, Attempt, Intent } from "../../../src/core/types";
import { Button, IconButton, Panel, SectionLabel } from "../design/components";
import { Icon } from "../design/icons";
import { useStore } from "../state/store";
import { byId, indexes, selectIntentGroups, type IntentGroup } from "../state/selectors";
import { ATTEMPT_STATUS_TEXT, shortSha } from "../state/format";
import { Link } from "./router";
import { dropPending, setUi, useUi, type PendingTask } from "./ui";
import { LaunchButton } from "./LaunchControl";
import { useNow } from "./useNow";
import { useCanAct } from "../state/account";
import { dayLabel } from "../views/labels";
import { readDraft, TaskComposer, writeDraft } from "./Composer";
import "../views/intents/rail.css";

/* ───────────── constants ───────────── */

/** A list this long gets a filter field. A shorter list is quick to read. */
const FILTER_FROM = 8;
/** A group with more tasks than this is split by day. */
const SPLIT_BY_DAY_FROM = 20;
const EMPTY_GROUPS: IntentGroup[] = [];
const EMPTY_ATTEMPTS: Attempt[] = [];
const EMPTY_AGENTS = new Map<string, AgentInfo>();

/* ───────────── parts of the rail ───────────── */

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
            title={`${g?.callsign ?? a.agentId}: ${ATTEMPT_STATUS_TEXT[a.status]}`}
          />
        );
      })}
    </span>
  );
}

/** The facts under a task title, one text for each fact. The row shows each fact apart, with no dot between them. */
function intentFacts(i: Intent, attempts: Attempt[]): string[] {
  const active = attempts.filter((a) => !["landed", "alternate", "abandoned", "failed"].includes(a.status));
  const ready = attempts.filter((a) => a.status === "ready").length;
  switch (i.status) {
    case "judging":
      return [`${ready} ready for a yes`];
    case "landed":
      return [`Merged ${shortSha(i.landedSha)}`, ...(attempts.length > 1 ? [`${attempts.length - 1} ${attempts.length > 2 ? "alternatives" : "alternative"}`] : [])];
    case "parked":
      return ["Paused"];
    case "merged-into":
      return ["Duplicate of another task"];
    case "open":
    case "draft":
      return [attempts.length ? `${attempts.length} ${attempts.length === 1 ? "work copy" : "work copies"}` : "No work copies yet"];
    default:
      return [`${active.length} ${active.length === 1 ? "agent works" : "agents work"}`, ...(ready ? [`${ready} ready`] : [])];
  }
}

/** The tasks that have every word of the filter, in the title or the goal. An empty list of words keeps all tasks. */
function matchFilter(i: Intent, words: string[]): boolean {
  const text = `${i.title} ${i.goal}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** A group of tasks, or the part of it that one day holds. */
interface RowGroup {
  key: string;
  label?: string;
  intents: Intent[];
}

/** Splits a long group by the day that each task was opened (merged tasks: the day of the merge). */
function splitByDay(g: IntentGroup, now: number): RowGroup[] {
  if (g.intents.length <= SPLIT_BY_DAY_FROM) return [{ key: g.id, intents: g.intents }];
  const days: RowGroup[] = [];
  for (const i of g.intents) {
    const label = dayLabel(g.id === "landed" ? i.updatedAt : i.createdAt, now);
    const last = days[days.length - 1];
    if (last?.label === label) last.intents.push(i);
    else days.push({ key: `${g.id}-${days.length}`, label, intents: [i] });
  }
  return days;
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
          {intentFacts(intent, attempts).map((fact, n) => (
            <span key={fact} className="irow__status">
              {n === 0 && intent.status === "judging" && <Icon name="lighthouse" size={12} />}
              {fact}
            </span>
          ))}
        </span>
      </Link>
      {(intent.status === "open" || intent.status === "draft") && (
        <span className="irow__action">
          <LaunchButton intent={intent} />
        </span>
      )}
    </li>
  );
});

/** A task on its way to the server ("On its way"), or one that did not arrive (with Edit). */
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
              On its way
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

/* ───────────── the rail ───────────── */

export function IntentsRail({ selectedId }: { selectedId?: string }) {
  const groups = useStore((s) => (s.state ? selectIntentGroups(s.state) : EMPTY_GROUPS));
  const byIntent = useStore((s) => (s.state ? indexes(s.state).attemptsByIntent : null));
  const agents = useStore((s) => (s.state ? byId(s.state.agents) : null));
  const projectId = useStore((s) => s.projectId);
  const { pending } = useUi();
  const total = groups.reduce((n, g) => n + g.intents.length, 0);
  const canAct = useCanAct();
  const now = useNow(60_000);
  const [filter, setFilter] = useState("");
  const wordKey = useDeferredValue(filter.trim().toLowerCase());
  const shownGroups = useMemo(() => {
    const words = wordKey.split(/\s+/).filter(Boolean);
    if (!words.length) return groups;
    return groups.map((g) => ({ ...g, intents: g.intents.filter((i) => matchFilter(i, words)) })).filter((g) => g.intents.length > 0);
  }, [groups, wordKey]);
  const shown = shownGroups.reduce((n, g) => n + g.intents.length, 0);
  return (
    <Panel title="Tasks" count={total} headingId="intents-rail-title" className="rail rail--intents">
      {canAct && (
        <div className="rail__compose">
          <TaskComposer autoOpen={total === 0} />
        </div>
      )}
      {(total > FILTER_FROM || filter) && (
        <div className="rail__filter">
          <label className="vh" htmlFor="rail-filter">
            Filter the tasks
          </label>
          <input
            id="rail-filter"
            className="b-input"
            type="search"
            placeholder="Filter tasks"
            autoComplete="off"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filter) {
                e.stopPropagation();
                setFilter("");
              }
            }}
          />
          {wordKey && (
            <span className="rail__count" role="status">
              {shown} of {total}
            </span>
          )}
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
      ) : shown === 0 ? (
        <p className="rail__empty" role="status">
          No task matches “{filter.trim()}”.{" "}
          <button type="button" className="rail__clear" onClick={() => setFilter("")}>
            Clear the filter
          </button>
        </p>
      ) : (
        shownGroups.map((g) => (
          <div key={g.id} className="igroup">
            <SectionLabel count={g.intents.length} id={`ig-${g.id}`}>
              {g.label}
            </SectionLabel>
            {splitByDay(g, now).map((part) => (
              <div key={part.key} className={part.label ? "iday" : undefined}>
                {part.label && (
                  <p className="iday__label" id={`ig-${part.key}`}>
                    {part.label}
                  </p>
                )}
                <ul role="list" aria-labelledby={part.label ? `ig-${g.id} ig-${part.key}` : `ig-${g.id}`}>
                  {part.intents.map((i) => (
                    <IntentRow key={i.id} intent={i} attempts={byIntent?.get(i.id) ?? EMPTY_ATTEMPTS} agents={agents ?? EMPTY_AGENTS} selected={i.id === selectedId} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))
      )}
    </Panel>
  );
}
