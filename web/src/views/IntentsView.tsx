/**
 * The tasks page ("/tasks" and "/tasks/:id"): the task rail and the detail of one task.
 *
 * The detail shows the goal and its versions, then one lane for each work copy with its plan, files, diff and
 * tests, and the panels to merge, redo or pause. Read next: intents/ (the lane, the panels, the helpers).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AgentInfo, Attempt, Intent } from "../../../src/core/types";
import { Badge, Button, EmptyState, IntentBadge } from "../design/components";
import { Icon } from "../design/icons";
import { IntentsRail } from "../app/IntentsRail";
import { LaunchButton } from "../app/LaunchControl";
import { Link, navigate } from "../app/router";
import { useNow } from "../app/useNow";
import { ago, plural } from "../state/format";
import { useStore } from "../state/store";
import { useCanAct } from "../state/account";
import { byId, indexes, selectIntentGroups } from "../state/selectors";
import { Lane } from "./intents/Lane";
import { AmendPanel, LivingSpec, PausePanel } from "./intents/TaskPanels";
import { sourceText } from "./intents/helpers";
import "./intents.css";

/* ───────────── the detail of a task ───────────── */

function IntentDetail({ intent }: { intent: Intent }) {
  const now = useNow(15_000);
  const st = useStore((s) => s.state);
  const idx = st ? indexes(st) : null;
  const [panel, setPanel] = useState<"amend" | "pause" | null>(null);
  const amendBtn = useRef<HTMLButtonElement | null>(null);
  const pauseBtn = useRef<HTMLButtonElement | null>(null);
  const canAct = useCanAct();

  const attempts = useMemo(() => {
    const list = idx?.attemptsByIntent.get(intent.id) ?? [];
    const rank = (a: Attempt) =>
      a.status === "landed" ? 0 : ["ready", "landing", "checking", "submitted", "underway", "declared", "rederiving"].includes(a.status) ? 1 : 2;
    return [...list].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  }, [idx, intent.id]);
  const agents = st ? byId(st.agents) : new Map<string, AgentInfo>();
  const names = (id: string) => {
    const a = idx?.attemptById.get(id);
    return (a && agents.get(a.agentId)?.callsign) ?? id;
  };
  const ready = attempts.filter((a) => a.status === "ready");
  const mainSha = st?.project.mainSha ?? "";
  const decisions = idx?.decisionsByIntent.get(intent.id) ?? [];
  const pick = [...decisions].reverse().find((d) => d.kind === "pick");
  const n = attempts.length;
  const done = intent.status === "landed" || intent.status === "parked";
  // Live previews run Cloudflare Workers apps: main must have src/index.js.
  const preview = useStore((s) => Boolean(s.state?.files.some((f) => f.path === "src/index.js")));

  useEffect(() => {
    if (done) setPanel(null);
  }, [done]);

  return (
    <article className="intent" aria-labelledby="intent-title">
      <header className="intent__head">
        <div className="intent__crumbs">
          <Link to="/tasks" className="backlink">
            <Icon name="arrow-left" size={14} />
            Tasks
          </Link>
          <IntentBadge status={intent.status} />
          {intent.priority === "high" && (
            <Badge tone="accent" icon="chevron-up">
              High priority
            </Badge>
          )}
          <span className="ink-3">
            <span className="voice-agent">v{intent.version}</span> · from {sourceText(intent)} · {intent.createdBy.name} · {ago(intent.createdAt, now)}
          </span>
        </div>
        <h1 className="intent__title voice-human" id="intent-title" tabIndex={-1}>
          {intent.title}
        </h1>
        {panel === "amend" ? (
          <AmendPanel intent={intent} onClose={() => setPanel(null)} returnFocus={amendBtn} />
        ) : (
          <p className="intent__goal voice-human">{intent.goal.replace(/`/g, "")}</p>
        )}
        {canAct && (
          <div className="intent__actions">
            <LaunchButton intent={intent} size="md" variant={n === 0 ? "primary" : "secondary"} />
            <Button ref={amendBtn} icon="amend" onClick={() => setPanel(panel === "amend" ? null : "amend")} disabled={done} aria-expanded={panel === "amend"}>
              Change the goal
            </Button>
            <Button ref={pauseBtn} variant="ghost" icon="park" onClick={() => setPanel(panel === "pause" ? null : "pause")} disabled={done} aria-expanded={panel === "pause"}>
              Pause the task
            </Button>
          </div>
        )}
        {panel === "pause" && <PausePanel intent={intent} onClose={() => setPanel(null)} returnFocus={pauseBtn} />}
      </header>

      <div className="intent__spec">
        <div className="intent__specmain">
          <section aria-labelledby="constraints-title">
            <h2 className="intent__h2" id="constraints-title">
              Constraints <span className="voice-agent ink-3">{intent.constraints.length}</span>
            </h2>
            {intent.constraints.length === 0 ? (
              <p className="ink-3">No constraints yet. People and change requests add them.</p>
            ) : (
              <ul className="constraints">
                {intent.constraints.map((c) => {
                  const human = intent.amendments.find((a) => a.text.includes(c))?.by.kind === "human";
                  return (
                    <li key={c} className={human ? "voice-human" : "voice-agent"}>
                      <Icon name={human ? "human" : "buoy"} size={12} />
                      <span>{c.replace(/`/g, "")}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section aria-labelledby="checks-title">
            <h2 className="intent__h2" id="checks-title">
              Tests <span className="voice-agent ink-3">{intent.checks.length}</span>
            </h2>
            {intent.checks.length === 0 ? (
              <p className="ink-3">No test files for this task. gitring runs the tests of the repository.</p>
            ) : (
              <ul className="checklist">
                {intent.checks.map((c) => {
                  const cases = [...c.content.matchAll(/\btest\(\s*"((?:[^"\\]|\\.)+)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
                  return (
                    <li key={c.id}>
                      <div className="checklist__head">
                        <Icon name="check" size={14} />
                        <span className="voice-agent">{c.path}</span>
                        <span className="ink-3">{plural(cases.length, "test")}</span>
                      </div>
                      <p className="checklist__desc">{c.description}</p>
                      {cases.length > 0 && (
                        <ul className="checklist__cases voice-agent">
                          {cases.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
        <LivingSpec intent={intent} now={now} />
      </div>

      <section className="compare" aria-labelledby="compare-title">
        <div className="compare__head">
          <h2 className="intent__h2" id="compare-title">
            {n === 0 ? "Work copies" : n === 1 ? "1 work copy" : `Compare ${n} work copies`}
          </h2>
          <p className="compare__help">
            {intent.status === "judging"
              ? ready.length > 1
                ? `${ready.length} work copies are ready. A person must say yes to one. Compare the tests${preview ? " and the previews" : ""}. The others stay as alternatives.`
                : ready.length === 1
                  ? `1 work copy is ready. A person must say yes before it merges. Check the tests${preview ? " and the preview" : ""}.`
                  : "No work copy is ready. The work could not merge. Redo it on the new main, or pause the task."
              : intent.status === "landed"
                ? pick
                  ? `${pick.by.name} chose ${names(pick.attemptIds[0])}: “${pick.rationale}”`
                  : "gitring merged the work copy that passed its tests. Alternatives stay below."
                : n === 0
                  ? "No work copies yet. Start 1 to 4 agents, or let your own agent take the task through MCP."
                  : "Each agent works in its own work copy. gitring checks each plan against the 20 nearest active plans."}
          </p>
          {n > 0 && !preview && <p className="compare__note">Preview works for Cloudflare Workers apps (src/index.js).</p>}
        </div>
        {n === 0 ? (
          <EmptyState
            text={
              canAct
                ? `Start agents to fill this view. Each work copy shows its tests${preview ? ", its live preview" : ""} and its diff.`
                : "No work copies yet. Members start agents for this task."
            }
            action={
              canAct ? (
                <div className="c-empty__actions">
                  <LaunchButton intent={intent} size="md" variant="primary" />
                  <Link to="/connect" className="b-btn b-btn--ghost">
                    Connect your own agent
                  </Link>
                </div>
              ) : undefined
            }
          />
        ) : (
          <div className="lanes-scroll">
            <div className={["lanes", !preview && "lanes--nopreview"].filter(Boolean).join(" ")} style={{ "--n": n } as CSSProperties}>
              {attempts.map((a) => (
                <Lane
                  key={a.id}
                  attempt={a}
                  all={attempts}
                  agent={agents.get(a.agentId)}
                  intent={intent}
                  corrections={idx?.correctionsByAttempt.get(a.id) ?? []}
                  checks={idx?.checkById ?? new Map()}
                  names={names}
                  landing={idx?.landingByAttempt.get(a.id)}
                  rederivedFromName={a.lineage.rederivedFrom ? names(a.lineage.rederivedFrom) : undefined}
                  canAct={canAct}
                  preview={preview}
                  mainSha={mainSha}
                  now={now}
                />
              ))}
            </div>
          </div>
        )}
      </section>
    </article>
  );
}

/* ───────────── the page ───────────── */

export function IntentsView({ id }: { id?: string }) {
  const intent = useStore((s) => (id ? s.state?.intents.find((i) => i.id === id) : undefined));
  const groups = useStore((s) => (s.state ? selectIntentGroups(s.state) : null));
  const exists = useStore((s) => s.state !== null);

  useEffect(() => {
    if (id || !groups || window.matchMedia("(max-width: 760px)").matches) return;
    const first = groups[0]?.intents[0];
    if (first) navigate(`/tasks/${first.id}`, { replace: true });
  }, [id, groups]);

  return (
    <div className={["intents-view", id ? "has-detail" : "no-detail"].join(" ")}>
      <aside className="intents-view__rail" aria-label="Tasks">
        <IntentsRail selectedId={id} />
      </aside>
      <div className="intents-view__main">
        {intent ? (
          <IntentDetail key={intent.id} intent={intent} />
        ) : id && exists ? (
          <div className="page">
            <h1 className="page__title" tabIndex={-1}>
              Task not found
            </h1>
            <EmptyState text="This task does not exist in this project." action={<Link to="/tasks">Show all tasks</Link>} />
          </div>
        ) : (
          <div className="page">
            <h1 className="page__title" tabIndex={-1}>
              Tasks
            </h1>
            <p className="page__lede">A task is the source of the work: a goal and the tests that prove it. Write one on the left, or select a task to compare its work copies.</p>
          </div>
        )}
      </div>
    </div>
  );
}
