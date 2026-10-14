/**
 * The "Inside gitring" panel: the pipeline of the engine, one station for each stage.
 * The stage of the current step is lit. Below the pipeline, a card shows the facts of the latest step that has facts to
 * show: the conflict check with its distance ladder, rule, model and verdict; the tests; the merge queue; the compose;
 * the commit and its why-record.
 */
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { AgentInfo, CheckRun, CourseCheck, Range } from "../../../../src/core/types";
import { Callsign } from "../../design/components";
import { hullName } from "../../design/icons";
import { checkSourceText, CORRECTION_KIND_TEXT, METHOD_TEXT, modelShort, prob, RANGE_TEXT, RULE_TEXT, shortSha, TRIGGER_TEXT, VERDICT_TEXT } from "../../state/format";
import { STAGE_LINE, STAGE_NAME, STAGES, type Stage } from "./captions";
import { nearest, type ReplayScript, type ReplayStep, type World } from "./model";

const RANGES: Range[] = [0, 1, 2, 3, 4, 5];

/** Steps whose facts the card shows. A step of another kind (work, notes) keeps the card of the step before. */
export const DETAIL_KINDS = new Set<ReplayStep["kind"]>(["task", "plan", "check", "request", "deliver", "ack", "tests", "submit", "decision", "lease", "compose", "composed", "commit", "replot", "stale"]);

export function Pipeline({ stage, counts, children }: { stage: Stage | null; counts: Record<Stage, number>; children?: ReactNode }) {
  const list = useRef<HTMLOListElement | null>(null);
  const packet = useRef<HTMLSpanElement | null>(null);
  const at = stage ? STAGES.indexOf(stage) : -1;
  // The packet moves to the lit station (a CSS transition on transform). A note lights no station: the packet stays.
  useLayoutEffect(() => {
    if (stage && at < 0) return;
    const row = list.current?.children[Math.max(0, at)] as HTMLElement | undefined;
    if (!row || !packet.current) return;
    packet.current.style.transform = `translateY(${row.offsetTop + row.offsetHeight / 2}px)`;
    packet.current.style.opacity = at >= 0 ? "1" : "0";
    packet.current.dataset.stage = stage ?? "";
  }, [at, stage]);
  return (
    <section className="rp-pipe" aria-label="Inside gitring">
      <h2 className="rp-pipe__title">Inside gitring</h2>
      <div className="rp-pipe__rail">
        <span ref={packet} className="rp-pipe__packet" aria-hidden="true" />
        <ol ref={list} className="rp-pipe__list" role="list">
          {STAGES.map((s, i) => (
            <li key={s} className={["rp-stage", `rp-stage--${s}`, i === at && "is-now", i < at && "is-before", counts[s] > 0 && "is-seen"].filter(Boolean).join(" ")} aria-current={i === at ? "step" : undefined}>
              <span className="rp-stage__node" aria-hidden="true" />
              <span className="rp-stage__name">{STAGE_NAME[s]}</span>
              <span className="rp-stage__count voice-agent">{counts[s] || ""}</span>
              <span className="rp-stage__line">{STAGE_LINE[s]}</span>
            </li>
          ))}
        </ol>
      </div>
      {children}
    </section>
  );
}

/* ───────────── the card of the latest step with facts ───────────── */

interface FactsProps {
  step: ReplayStep;
  script: ReplayScript;
  world: World;
}

interface CardProps extends FactsProps {
  /** The card belongs to the step that shows now (else it is the card of an earlier step). */
  now: boolean;
}

export function DetailCard(p: CardProps) {
  const body = cardBody(p);
  return (
    <article key={p.step.id} className={["rp-card", `rp-card--${p.step.stage}`, p.now ? "is-now" : "is-earlier"].join(" ")} aria-live="off">
      <header className="rp-card__head">
        <span className="rp-card__stage">{STAGE_NAME[p.step.stage]}</span>
        <span className="rp-card__time voice-agent">{timeOf(p.step.at)}</span>
      </header>
      {body}
    </article>
  );
}

function cardBody({ step, script, world }: FactsProps): ReactNode {
  switch (step.kind) {
    case "check":
      return step.check ? <CheckFacts check={step.check} script={script} /> : null;
    case "request":
    case "deliver":
    case "ack":
      return <RequestFacts step={step} script={script} world={world} />;
    case "tests":
    case "composed":
      return <TestFacts step={step} script={script} />;
    case "submit":
    case "decision":
    case "lease":
      return <QueueFacts step={step} script={script} world={world} />;
    case "compose":
      return <ComposeFacts step={step} script={script} />;
    case "commit":
      return <CommitFacts step={step} script={script} />;
    case "replot":
      return <ReplotFacts step={step} script={script} world={world} />;
    case "task":
      return <TaskFacts step={step} script={script} />;
    case "plan":
      return <PlanFacts step={step} script={script} />;
    default:
      return (
        <>
          <p className="rp-card__lead">{step.caption}</p>
          {step.detail && <p className="rp-card__text">{step.detail}</p>}
        </>
      );
  }
}

function timeOf(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function agentOf(script: ReplayScript, attemptId: string | undefined): AgentInfo | undefined {
  const a = attemptId ? script.attempts.get(attemptId) : undefined;
  return a ? script.agents.get(a.agentId) : undefined;
}

function Agent({ script, attemptId, model }: { script: ReplayScript; attemptId: string | undefined; model?: boolean }) {
  const g = agentOf(script, attemptId);
  if (!g) return <span className="rp-agent">an agent</span>;
  return <Callsign callsign={g.callsign} color={g.color} hull={hullName(g.color)} model={g.model ?? g.client} showModel={model} size="md" />;
}

function nameOf(script: ReplayScript, attemptId: string | undefined): string {
  return agentOf(script, attemptId)?.callsign ?? "an agent";
}

function titleOf(script: ReplayScript, attemptId: string | undefined): string {
  const a = attemptId ? script.attempts.get(attemptId) : undefined;
  return (a && script.intents.get(a.intentId)?.title) ?? "a task";
}

const ruleId = (rule: string) => rule.split("-")[0];

/** The conflict check: the candidates on the distance ladder, the facts of the nearest one, the rule, the model, the verdict. */
function CheckFacts({ check, script }: { check: CourseCheck; script: ReplayScript }) {
  const near = nearest(check);
  const facts = [...(check.facts ?? [])].sort((a, b) => a.range - b.range);
  const a = near?.assessment;
  const adapts = a ? (a.giveWay === "incoming" ? nameOf(script, check.attemptId) : nameOf(script, a.otherAttemptId)) : null;
  const f = near?.facts;
  const lines: string[] = [];
  if (f) {
    if (f.hunkOverlaps.length) lines.push(...f.hunkOverlaps.slice(0, 2).map((h) => `Same lines: ${h.path} ${h.incoming[0]}–${h.incoming[1]} and ${h.other[0]}–${h.other[1]}`));
    if (f.interfaceHits.length) lines.push(...f.interfaceHits.slice(0, 2).map((h) => `Shared function: ${h.symbol}`));
    if (f.sharedSymbols.length) lines.push(`Same function: ${f.sharedSymbols.slice(0, 2).join(", ")}`);
    if (f.sharedFiles.length) lines.push(`Same file: ${f.sharedFiles.slice(0, 2).join(", ")}${f.sharedFiles.length > 2 ? ` and ${f.sharedFiles.length - 2} more` : ""}`);
    if (f.closing) lines.push("The two plans come closer.");
    if (f.intentSimilarity >= 0.5) lines.push(`Similar task titles: ${prob(f.intentSimilarity)}`);
    if (!lines.length) lines.push("No shared file, line or function.");
  }
  return (
    <>
      <p className="rp-card__who">
        <Agent script={script} attemptId={check.attemptId} />
        <span className="ink-3"> after its {TRIGGER_TEXT[check.trigger] ?? check.trigger}</span>
      </p>
      <div className="rp-ladder" role="list" aria-label="Distance ladder: 0 is the closest">
        {RANGES.map((r) => {
          const here = facts.filter((x) => x.range === r).slice(0, 3);
          return (
            <div key={r} role="listitem" data-r={r} className={["rp-rung", near && near.facts.range === r && "is-nearest", here.length > 0 && "has-work"].filter(Boolean).join(" ")}>
              <span className="rp-rung__n voice-agent">{r}</span>
              <span className="rp-rung__text">{RANGE_TEXT[r]}</span>
              <span className="rp-rung__who">
                {here.map((x, i) => {
                  const g = agentOf(script, x.otherAttemptId);
                  return (
                    <span key={x.otherAttemptId} className="rp-chip" style={{ "--vc": `var(--v${(g?.color ?? 0) % 12})`, animationDelay: `${120 + i * 90 + r * 40}ms` } as CSSProperties}>
                      {g?.callsign ?? "agent"}
                    </span>
                  );
                })}
              </span>
            </div>
          );
        })}
      </div>
      {!facts.length && <p className="rp-card__text">No other work is near. gitring passes the plan without a model call.</p>}
      {lines.length > 0 && (
        <ul className="rp-facts" role="list">
          {lines.slice(0, 4).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {a && (
        <p className="rp-rule">
          <span className="rp-rule__id voice-agent">{ruleId(a.rule)}</span>
          <span>{RULE_TEXT[a.rule] ?? a.rule}.</span>
          {adapts && check.verdict !== "clear" && <strong> {adapts} adapts.</strong>}
        </p>
      )}
      <p className="rp-model">
        <span className="rp-model__tag">{checkSourceText(check.source)}</span>
        <span className="voice-agent">{check.source !== "rules" ? `${check.source} · ` : ""}{check.latencyMs} ms</span>
        {check.source !== "rules" && <span className="voice-agent ink-3">confidence {prob(check.confidence)}</span>}
      </p>
      <p className={`rp-verdict rp-verdict--${check.verdict}`}>{VERDICT_TEXT[check.verdict]}</p>
    </>
  );
}

function RequestFacts({ step, script, world }: FactsProps) {
  const c = step.correction ?? (step.detail ? script.corrections.get(step.detail) : undefined) ?? [...script.corrections.values()].filter((x) => x.attemptId === step.attemptId && x.createdAt <= step.at).pop();
  if (!c) return <p className="rp-card__lead">{step.caption}</p>;
  const reached = Boolean(c.deliveredAt && c.deliveredAt <= world.at);
  const applied = world.buoys.some((b) => b.id === c.id && b.done) || Boolean(c.acknowledgedAt && c.acknowledgedAt <= world.at);
  return (
    <>
      <p className="rp-card__who">
        <span className="rp-kind voice-agent">{CORRECTION_KIND_TEXT[c.kind]}</span>
        <span className="ink-3">to</span> <Agent script={script} attemptId={c.attemptId} />
      </p>
      {c.standOnAttemptId && (
        <p className="rp-card__text">
          {nameOf(script, c.standOnAttemptId)} continues. {c.rule !== "human" && <span className="voice-agent ink-3">{ruleId(c.rule)}</span>}
        </p>
      )}
      <blockquote className="rp-quote voice-agent">{firstLines(c.message)}</blockquote>
      <ol className="rp-steps" role="list" aria-label="Path of the change request">
        <li className="is-done">Sent</li>
        <li className={reached ? "is-done" : undefined}>Reached the agent</li>
        <li className={applied ? "is-done" : undefined}>Applied</li>
      </ol>
      {step.quote && <p className="rp-card__text">The agent says: <span className="voice-agent">{step.quote}</span></p>}
    </>
  );
}

function firstLines(text: string): string {
  const parts = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).slice(0, 3).join(" ");
  return parts.length > 260 ? `${parts.slice(0, 259)}…` : parts;
}

function TestFacts({ step, script }: { step: ReplayStep; script: ReplayScript }) {
  const t = step.tests;
  if (!t) return <p className="rp-card__lead">{step.caption}</p>;
  if (t.waits) return <p className="rp-card__lead">{step.caption}</p>;
  const cases: CheckRun["cases"] = t.cases ?? [];
  return (
    <>
      <p className="rp-card__who">
        <Agent script={script} attemptId={step.attemptId} />
        <span className="ink-3">{t.scope === "composed" ? " on main plus its work" : " on its work alone"}</span>
      </p>
      <p className={["rp-score", t.ok ? "is-pass" : "is-fail"].join(" ")}>
        <span className="voice-agent">
          {t.passed}/{t.total}
        </span>
        <span>{t.ok ? "pass" : "fail"}</span>
        {t.ms !== undefined && <span className="rp-score__ms voice-agent">{Math.round(t.ms)} ms</span>}
      </p>
      {cases.length > 0 && (
        <ul className="rp-cases" role="list">
          {cases.slice(0, 6).map((c, i) => (
            <li key={`${c.file}:${c.name}:${i}`} className={c.ok ? "is-pass" : "is-fail"} style={{ animationDelay: `${i * 70}ms` }}>
              <span className="rp-cases__mark" aria-hidden="true">
                {c.ok ? "✓" : "✗"}
              </span>
              <span className="voice-agent">{c.name}</span>
              <span className="ink-3 voice-agent">{c.file}</span>
            </li>
          ))}
          {cases.length > 6 && <li className="ink-3">{cases.length - 6} more</li>}
        </ul>
      )}
    </>
  );
}

function QueueFacts({ step, script, world }: FactsProps) {
  return (
    <>
      <p className="rp-card__lead">{step.caption}</p>
      <div className="rp-queue">
        <div className="rp-queue__lease">
          <span className="rp-queue__label">Holds the lease</span>
          {world.lease ? <Agent script={script} attemptId={world.lease} /> : <span className="ink-3">no merge runs now</span>}
        </div>
        <div className="rp-queue__wait">
          <span className="rp-queue__label">Waits in the queue</span>
          <span className="rp-queue__list">
            {world.queue.length ? world.queue.map((id) => <Agent key={id} script={script} attemptId={id} />) : <span className="ink-3">nobody</span>}
          </span>
        </div>
      </div>
      <p className="rp-card__text ink-3">One merge runs at a time. If a merge stops, its lease ends after 5 minutes.</p>
    </>
  );
}

function ComposeFacts({ step, script }: { step: ReplayStep; script: ReplayScript }) {
  const l = step.landing;
  if (!l) return <p className="rp-card__lead">{step.caption}</p>;
  const a = script.attempts.get(l.attemptId);
  const moved = a ? a.baseSha !== l.mainBefore : l.method !== "fast-forward";
  return (
    <>
      <p className="rp-card__who">
        <Agent script={script} attemptId={l.attemptId} />
        <span className="rp-kind voice-agent">{METHOD_TEXT[l.method]}</span>
      </p>
      <svg className={`rp-graph rp-graph--${l.method}`} viewBox="0 0 280 92" role="img" aria-label={`${METHOD_TEXT[l.method]} of the work onto main ${shortSha(l.mainBefore)}`}>
        <line className="rp-graph__main" x1="12" y1="30" x2={moved ? 196 : 120} y2="30" />
        <circle className="rp-graph__dot" cx="40" cy="30" r="6" />
        <text className="rp-graph__text" x="40" y="14">
          base
        </text>
        {moved && <circle className="rp-graph__dot" cx="120" cy="30" r="6" />}
        {moved && (
          <text className="rp-graph__text" x="120" y="14">
            main {shortSha(l.mainBefore)}
          </text>
        )}
        <path className="rp-graph__work" d={moved ? "M40 30 C70 72 110 72 150 70" : "M40 30 C70 30 80 30 120 30"} />
        <circle className="rp-graph__dot rp-graph__dot--work" cx={moved ? 150 : 120} cy={moved ? 70 : 30} r="6" />
        <text className="rp-graph__text" x={moved ? 150 : 120} y={moved ? 90 : 50}>
          work
        </text>
        {moved && <path className="rp-graph__join" d="M120 30 L196 30 M150 70 C170 70 186 50 196 30" />}
        <circle className="rp-graph__dot rp-graph__dot--new" cx={moved ? 196 : 120} cy="30" r="7" />
        <text className="rp-graph__text rp-graph__text--new" x={moved ? 240 : 190} y="34">
          {shortSha(l.mainAfter)}
        </text>
      </svg>
      <p className="rp-card__text">{step.caption}</p>
    </>
  );
}

function CommitFacts({ step, script }: { step: ReplayStep; script: ReplayScript }) {
  const l = step.landing;
  if (!l) return <p className="rp-card__lead">{step.caption}</p>;
  const a = script.attempts.get(l.attemptId);
  const g = agentOf(script, l.attemptId);
  const checks = [...script.checks.values()].filter((k) => k.attemptId === l.attemptId).length;
  const requests = [...script.corrections.values()].filter((c) => c.attemptId === l.attemptId).length;
  const total = l.checks.passed + l.checks.failed || l.checks.cases.length;
  const rows: [string, string][] = [
    ["Task", `"${script.intents.get(l.intentId)?.title ?? "a task"}"`],
    ["Plan", a?.course.approach || a?.course.plan[0] || "—"],
    ["Agent", `${g?.callsign ?? "an agent"}${g?.model || g?.client ? ` · ${modelShort(g.model ?? g.client)}` : ""}`],
    ["Conflict checks", String(checks)],
    ["Change requests", String(requests)],
    ["Tests on main + work", `${l.checks.passed}/${total} pass`],
    ["How", METHOD_TEXT[l.method]],
  ];
  return (
    <>
      <p className="rp-commit">
        <span className="rp-commit__sha voice-agent">{shortSha(l.mainAfter)}</span>
        <span className="rp-commit__title voice-human">{script.intents.get(l.intentId)?.title ?? "a task"}</span>
      </p>
      <p className="rp-card__label">Why-record (git notes)</p>
      <dl className="rp-why">
        {rows.map(([k, v], i) => (
          <div key={k} style={{ animationDelay: `${150 + i * 110}ms` }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function ReplotFacts({ step, script, world }: FactsProps) {
  return (
    <>
      <p className="rp-card__lead">
        Main is now <span className="voice-agent">{shortSha(world.mainSha)}</span>.
      </p>
      <p className="rp-queue__list">
        {(step.others ?? []).map((id) => (
          <Agent key={id} script={script} attemptId={id} />
        ))}
      </p>
      <p className="rp-card__text">{step.others && step.others.length > 1 ? "Their work moves" : "Its work moves"} onto the new main. The agents do not stop.</p>
    </>
  );
}

function TaskFacts({ step, script }: { step: ReplayStep; script: ReplayScript }) {
  const i = step.intentId ? script.intents.get(step.intentId) : undefined;
  if (!i) return <p className="rp-card__lead">{step.caption}</p>;
  return (
    <>
      <p className="rp-commit__title voice-human">{i.title}</p>
      <p className="rp-card__text ink-3">Opened by {i.createdBy?.name ?? "a person"}</p>
      {i.checks.length > 0 && (
        <ul className="rp-files" role="list">
          {i.checks.slice(0, 3).map((c) => (
            <li key={c.id} className="voice-agent">
              {c.path}
            </li>
          ))}
        </ul>
      )}
      <p className="rp-card__text">{i.checks.length ? `${i.checks.length} test ${i.checks.length === 1 ? "file decides" : "files decide"} when the task is done.` : "The tests of the project decide when the task is done."}</p>
    </>
  );
}

function PlanFacts({ step, script }: { step: ReplayStep; script: ReplayScript }) {
  const a = step.attemptId ? script.attempts.get(step.attemptId) : undefined;
  if (!a) return <p className="rp-card__lead">{step.caption}</p>;
  return (
    <>
      <p className="rp-card__who">
        <Agent script={script} attemptId={a.id} model />
      </p>
      <p className="rp-card__text">
        for <span className="voice-human">"{titleOf(script, a.id)}"</span>
      </p>
      {a.course.plan.length > 0 && (
        <ol className="rp-plan" role="list">
          {a.course.plan.slice(0, 4).map((s, i) => (
            <li key={i} style={{ animationDelay: `${100 + i * 90}ms` }}>
              {s}
            </li>
          ))}
        </ol>
      )}
      {a.course.files.length > 0 && (
        <ul className="rp-files" role="list">
          {a.course.files.slice(0, 4).map((f) => (
            <li key={f} className="voice-agent">
              {f}
            </li>
          ))}
          {a.course.files.length > 4 && <li className="ink-3">{a.course.files.length - 4} more</li>}
        </ul>
      )}
      <p className="rp-card__text ink-3">gitring checks this plan before the agent writes code.</p>
    </>
  );
}
