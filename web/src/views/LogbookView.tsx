/**
 * History: every merge into main, newest first, with its reasons. Dense rows grouped by day; a filter
 * (task, agent or file); j / k move between rows; each row links to the files it changed in the code view.
 * A merge opens its record: task, plan, change requests, conflict checks (with their evidence on demand),
 * tests, decision, diff and commit. Records never change, so they load once and stay in memory; a
 * record also starts to load when the pointer or the focus rests on its row.
 */
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { CourseCheck, LandingMethod } from "../../../src/core/types";
import { Badge, Button, Callsign, CodeBlock, CorrectionNotice, DiffView, EmptyState, EvidenceBar, MethodBadge } from "../design/components";
import { Icon, type IconName } from "../design/icons";
import { Link, navigate } from "../app/router";
import { openNewIntent } from "../app/ui";
import { useNow } from "../app/useNow";
import { useCanAct } from "../state/account";
import { harborOrNull, isAbort, type LandingDetail } from "../state/api";
import { ago, checkSourceText, clock, int, METHOD_TEXT, modelShort, plural, prob, shortSha, TRIGGER_TEXT, VERDICT_TEXT } from "../state/format";
import { dayLabel, lineRangeText } from "./labels";
import { useStore } from "../state/store";
import { byId, indexes, selectLogbook, type LogbookRow } from "../state/selectors";
import { codeHref } from "./code/links";
import "./logbook.css";

const EMPTY: LogbookRow[] = [];

/** Files that a merge changed (from the work copy's footprint), newest knowledge first. */
function changedFiles(r: LogbookRow): string[] {
  const fp = Object.keys(r.attempt?.footprint?.files ?? {});
  return fp.length ? fp : (r.attempt?.course.files ?? []);
}

/** Start loading a merge record (prefetch on hover or focus). Errors wait for the real open. */
function prefetchLanding(id: string) {
  void harborOrNull()
    ?.landing(id, { priority: "low" })
    .catch(() => undefined);
}

function rowLabel(r: LogbookRow, now: number, files: string[]): string {
  const total = r.landing.checks.passed + r.landing.checks.failed;
  return `${shortSha(r.landing.mainAfter)}: ${r.intent?.title ?? r.landing.intentId}. ${METHOD_TEXT[r.landing.method] ?? r.landing.method}. ${r.agent?.callsign ?? ""}. ${plural(
    r.corrections,
    "change request",
  )}. ${r.landing.checks.passed} of ${total} tests pass. ${plural(files.length, "file")} changed. ${ago(r.landing.at, now)}.`;
}

function Row({ r, compact, selected, now, onKey }: { r: LogbookRow; compact: boolean; selected: boolean; now: number; onKey: (e: KeyboardEvent<HTMLAnchorElement>) => void }) {
  const total = r.landing.checks.passed + r.landing.checks.failed;
  const files = changedFiles(r);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => prefetchLanding(r.landing.id), 90);
  };
  const cool = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(() => cool, []);
  return (
    <li className="lrow-item">
      <div className={["lrow", compact && "lrow--compact", selected && "is-selected"].filter(Boolean).join(" ")} onMouseEnter={warm} onMouseLeave={cool}>
        <span className="lrow__sha voice-agent">
          <Icon name="anchor" size={12} />
          {shortSha(r.landing.mainAfter)}
        </span>
        <span className="lrow__title voice-human">
          <Link
            to={`/history/${r.landing.id}`}
            className="lrow__link"
            data-lrow
            aria-current={selected ? "page" : undefined}
            aria-label={rowLabel(r, now, files)}
            onFocus={warm}
            onBlur={cool}
            onKeyDown={onKey}
          >
            {r.intent?.title ?? r.landing.intentId}
          </Link>
        </span>
        <span className="lrow__method">
          <MethodBadge method={r.landing.method} />
        </span>
        <span className="lrow__agent">{r.agent && <Callsign callsign={r.agent.callsign} color={r.agent.color} model={r.agent.model} />}</span>
        <span className="lrow__corr">
          {r.corrections > 0 ? (
            <Badge tone="correction" icon="buoy">
              {plural(r.corrections, "change request")}
            </Badge>
          ) : (
            <span className="ink-3">No change requests</span>
          )}
        </span>
        <span className={`lrow__checks voice-agent ${r.landing.checks.ok ? "is-ok" : "is-fail"}`}>
          <Icon name={r.landing.checks.ok ? "check" : "cross"} size={12} />
          {r.landing.checks.passed}/{total}
          <span className="vh">{r.landing.checks.ok ? " tests pass" : " tests fail"}</span>
        </span>
        <span className="lrow__time ink-3">{ago(r.landing.at, now)}</span>
        {!compact && files.length > 0 && (
          <span className="lrow__files">
            {files.slice(0, 4).map((f) => (
              <a key={f} className="lrow__file voice-agent" href={withProject(codeHref(f, r.landing.mainAfter))} onClick={(e) => openInApp(e, codeHref(f, r.landing.mainAfter))} title={`Open ${f} as it was after this merge`}>
                {f}
              </a>
            ))}
            {files.length > 4 && <span className="lrow__more">+{files.length - 4} more</span>}
          </span>
        )}
      </div>
    </li>
  );
}

/** An app link with the ?project= of the address (for links that the router's Link cannot build: with #). */
function withProject(to: string): string {
  const p = new URLSearchParams(location.search).get("project");
  if (!p) return to;
  const hash = to.includes("#") ? to.slice(to.indexOf("#")) : "";
  const base = hash ? to.slice(0, to.indexOf("#")) : to;
  return `${base}${base.includes("?") ? "&" : "?"}project=${encodeURIComponent(p)}${hash}`;
}

function openInApp(e: MouseEvent<HTMLAnchorElement>, to: string) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(to);
}

/** Merge methods, in the order gitring tries them. */
const LADDER: { method: LandingMethod; title: string; rule: string; icon: IconName }[] = [
  { method: "fast-forward", title: "Fast-forward", rule: "main is the base of the work copy", icon: "fastforward" },
  { method: "merge", title: "3-way merge", rule: "the text merge is clean", icon: "merge" },
  { method: "rederive", title: "Redo", rule: "an agent does the task again on the new main", icon: "rederive" },
];

function Ladder({ method, baseSha, mainBefore }: { method: LandingMethod; baseSha?: string; mainBefore: string }) {
  const used = LADDER.findIndex((l) => l.method === method);
  return (
    <ol className="ladder" aria-label="Merge methods">
      {LADDER.map((l, i) => {
        const state = i < used ? "skipped" : i === used ? "used" : "unused";
        let why = "";
        if (state === "skipped") {
          why = i === 0 ? `main moved: base ${shortSha(baseSha)} ≠ main ${shortSha(mainBefore)}` : "the merge has conflicts, or the tests fail on the combined code";
        } else if (state === "used") why = `used: ${l.rule}`;
        else why = "not needed";
        return (
          <li key={l.method} className={`ladder__rung is-${state}`}>
            <span className="ladder__n voice-agent">{i + 1}</span>
            <Icon name={state === "skipped" ? "cross" : state === "used" ? l.icon : "ring"} size={14} />
            <span className="ladder__title">{l.title}</span>
            <span className="ladder__why">{why}</span>
          </li>
        );
      })}
    </ol>
  );
}

function verdictBadge(c: CourseCheck) {
  if (c.verdict === "clear")
    return (
      <Badge tone="clear" icon="check">
        {VERDICT_TEXT.clear}
      </Badge>
    );
  if (c.verdict === "correct")
    return (
      <Badge tone="correction" icon="buoy">
        {VERDICT_TEXT.correct}
      </Badge>
    );
  return (
    <Badge tone="caution" icon="lighthouse">
      {VERDICT_TEXT[c.verdict] ?? c.verdict}
    </Badge>
  );
}

/** What a conflict check saw, for one other work copy: shared files, overlapping lines, interfaces. */
function Evidence({ c, names, mainAfter }: { c: CourseCheck; names: (id: string) => string; mainAfter: string }) {
  if (!c.facts.length) return <p className="ink-3">No other work was near. Nothing to compare.</p>;
  return (
    <ul className="evid" role="list">
      {c.facts.map((f) => {
        const a = c.assessments.find((x) => x.otherAttemptId === f.otherAttemptId);
        return (
          <li key={f.otherAttemptId} className="evid__item">
            <p className="evid__head">
              Near <strong className="voice-agent">{names(f.otherAttemptId)}</strong> ({f.otherState === "landed" ? "merged" : f.otherState === "waiting" ? "waits to merge" : "works"}) · distance {f.range}
              {f.closing ? " · moving closer" : ""}
              {a ? ` · collision ${prob(a.collision)} · ${a.giveWay === "incoming" ? "this work adapts" : "the other work adapts"}` : ""}
            </p>
            {f.sharedFiles.length > 0 && (
              <p>
                Same files:{" "}
                {f.sharedFiles.map((p, i) => (
                  <Fragment key={p}>
                    {i > 0 && ", "}
                    <a className="voice-agent" href={withProject(codeHref(p, mainAfter))} onClick={(e) => openInApp(e, codeHref(p, mainAfter))}>
                      {p}
                    </a>
                  </Fragment>
                ))}
              </p>
            )}
            {f.hunkOverlaps.length > 0 && (
              <p>
                Same lines:{" "}
                {f.hunkOverlaps.map((h, i) => (
                  <Fragment key={i}>
                    {i > 0 && "; "}
                    <span className="voice-agent">{h.path}</span> {lineRangeText(h.incoming)} and {lineRangeText(h.other)}
                  </Fragment>
                ))}
              </p>
            )}
            {f.interfaceHits.length > 0 && (
              <p>
                Interfaces:{" "}
                {f.interfaceHits.map((h, i) => (
                  <Fragment key={i}>
                    {i > 0 && "; "}
                    <span className="voice-agent">{h.symbol}</span> changed by {h.changedBy === "incoming" ? "this work" : names(f.otherAttemptId)}
                    {h.usedAt.length ? `, used in ${h.usedAt.slice(0, 3).join(", ")}` : ""}
                  </Fragment>
                ))}
              </p>
            )}
            {f.sharedSymbols.length > 0 && (
              <p>
                Same functions: <span className="voice-agent">{f.sharedSymbols.slice(0, 6).join(", ")}</span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ChecksTable({ checks, names, incoming, mainAfter }: { checks: CourseCheck[]; names: (id: string) => string; incoming: string; mainAfter: string }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(checks.filter((c) => c.verdict !== "clear").slice(-1).map((c) => c.id)));
  if (!checks.length) return <p className="ink-3">No conflict checks recorded.</p>;
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className="ctable-wrap">
      <table className="ctable">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">After</th>
            <th scope="col">Result</th>
            <th scope="col">Decided by</th>
            <th scope="col">Duration</th>
            <th scope="col">Confidence</th>
            <th scope="col">Work nearby</th>
            <th scope="col">
              <span className="vh">Evidence</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => {
            const isOpen = open.has(c.id);
            return (
              <Fragment key={c.id}>
                <tr className={isOpen ? "is-open" : undefined}>
                  <td className="voice-agent">{clock(c.at)}</td>
                  <td>{TRIGGER_TEXT[c.trigger] ?? c.trigger}</td>
                  <td>{verdictBadge(c)}</td>
                  <td>{checkSourceText(c.source)}</td>
                  <td className="voice-agent">{c.latencyMs} ms</td>
                  <td className="voice-agent">{prob(c.confidence)}</td>
                  <td className="voice-agent ink-2">{c.assessments.length ? c.assessments.map((a) => `${names(a.otherAttemptId)} ${prob(a.collision)}`).join(" · ") : `no work near ${incoming}`}</td>
                  <td>
                    <button type="button" className="ctable__why" aria-expanded={isOpen} aria-controls={`ev-${c.id}`} onClick={() => toggle(c.id)}>
                      {isOpen ? "Hide why" : "Why"}
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="ctable__evrow">
                    <td colSpan={8} id={`ev-${c.id}`}>
                      <Evidence c={c} names={names} mainAfter={mainAfter} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Step({ icon, title, children, tone, id }: { icon: IconName; title: string; children: ReactNode; tone?: string; id: string }) {
  return (
    <li className={["trail__step", tone && `is-${tone}`].filter(Boolean).join(" ")} aria-labelledby={`trail-${id}`}>
      <span className="trail__marker" aria-hidden="true">
        <Icon name={icon} size={14} />
      </span>
      <h2 className="trail__title" id={`trail-${id}`}>
        {title}
      </h2>
      <div className="trail__body">{children}</div>
    </li>
  );
}

/** A record that loads once (merge records never change). Aborts when the record closes. */
function useLandingDetail(id: string, enabled: boolean): { detail: LandingDetail | null; error: string | null; retry: () => void } {
  const [state, setState] = useState<{ id: string; detail: LandingDetail | null; error: string | null }>({ id, detail: null, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const client = harborOrNull();
    if (!client) return;
    const ctl = new AbortController();
    setState((s) => (s.id === id && s.detail ? s : { id, detail: null, error: null }));
    client
      .landing(id, { signal: ctl.signal })
      .then((d) => setState({ id, detail: d, error: null }))
      .catch((e) => {
        if (isAbort(e)) return;
        setState({ id, detail: null, error: (e as Error).message });
      });
    return () => ctl.abort();
  }, [id, enabled, n]);
  const retry = useCallback(() => setN((x) => x + 1), []);
  if (state.id !== id) return { detail: null, error: null, retry };
  return { detail: state.detail, error: state.error, retry };
}

function DiffSkeleton() {
  return (
    <div className="lskel" role="status" aria-label="Loading the diff">
      {Array.from({ length: 8 }, (_, i) => (
        <span key={i} className="lskel__line" style={{ width: `${30 + ((i * 41) % 60)}%` }} />
      ))}
    </div>
  );
}

function WhyTrail({ id }: { id: string }) {
  const now = useNow(15_000);
  const st = useStore((s) => s.state);
  const landing = st?.landings.find((l) => l.id === id);
  const { detail, error, retry } = useLandingDetail(id, Boolean(landing));
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (detail || error) return;
    const t = setTimeout(() => setSlow(true), 150);
    return () => clearTimeout(t);
  }, [detail, error, id]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    if (st) {
      const agents = byId(st.agents);
      for (const a of st.attempts) m.set(a.id, agents.get(a.agentId)?.callsign ?? a.agentId);
    }
    return (aid: string) => m.get(aid) ?? aid;
  }, [st]);

  if (!st) return null;
  if (!landing) {
    return (
      <div className="why">
        <h1 className="why__title" tabIndex={-1}>
          Merge not found
        </h1>
        <EmptyState text="This merge is not in the history of this project." action={<Link to="/history">Show the history</Link>} />
      </div>
    );
  }
  const idx = indexes(st);
  const intent = idx.intentById.get(landing.intentId);
  const attempt = idx.attemptById.get(landing.attemptId);
  const agent = idx.agentById.get(landing.agentId);
  const predecessor = attempt?.lineage.rederivedFrom ? idx.attemptById.get(attempt.lineage.rederivedFrom) : undefined;
  const lineage = [predecessor, attempt].filter(Boolean) as NonNullable<typeof attempt>[];
  const corrections = lineage.flatMap((a) => idx.correctionsByAttempt.get(a.id) ?? []);
  const courseChecks = lineage.flatMap((a) => idx.checksByAttempt.get(a.id) ?? []).sort((a, b) => a.at - b.at);
  const decision = (idx.decisionsByIntent.get(landing.intentId) ?? []).find((d) => d.kind === "pick" && d.attemptIds[0] === landing.attemptId);
  const staleLog = predecessor ? st.logs.find((l) => l.attemptId === predecessor.id && l.kind === "stale") : undefined;
  const siblings = (idx.attemptsByIntent.get(landing.intentId) ?? []).filter((a) => a.id !== landing.attemptId && a.id !== predecessor?.id);
  const total = landing.checks.passed + landing.checks.failed;
  const note = detail?.note;
  const noteText = typeof note === "string" ? note : note ? JSON.stringify(note, null, 2) : "";

  return (
    <article className="why" aria-labelledby="why-title">
      <header className="why__head">
        <div className="why__crumbs">
          <Link to="/history" className="backlink">
            <Icon name="arrow-left" size={14} />
            History
          </Link>
          <MethodBadge method={landing.method} />
          <span className="voice-agent ink-2">
            {shortSha(landing.mainBefore)} → {shortSha(landing.mainAfter)}
          </span>
          <span className="ink-3">{ago(landing.at, now)}</span>
        </div>
        <h1 className="why__title voice-human" id="why-title" tabIndex={-1}>
          {intent?.title ?? landing.intentId}
        </h1>
        <p className="why__lede">
          {agent && <Callsign callsign={agent.callsign} color={agent.color} model={agent.model} showModel />}
          <span>
            merged it with {landing.method === "fast-forward" ? "a fast-forward" : landing.method === "merge" ? "a 3-way merge" : "a redo on the new main"}. {landing.checks.passed}/{total} tests pass on main.
          </span>
        </p>
      </header>

      <ol className="trail">
        <Step icon="amend" title={`Task · v${intent?.version ?? 1}`} id="intent">
          <p className="voice-human why__goal">{intent?.goal.replace(/`/g, "")}</p>
          {intent && intent.constraints.length > 0 && (
            <ul className="why__constraints">
              {intent.constraints.map((c) => (
                <li key={c}>{c.replace(/`/g, "")}</li>
              ))}
            </ul>
          )}
          <p className="why__meta">
            Opened by {intent?.createdBy.name} · {plural(intent?.amendments.length ?? 0, "change")} to the task · <Link to={`/tasks/${landing.intentId}`}>Open the task</Link>
          </p>
        </Step>

        <Step icon="compass" title="Plan" id="course">
          {predecessor && (
            <div className="why__lineage">
              <Badge tone="caution" icon="rederive">
                Generation {attempt?.lineage.generation}
              </Badge>
              <span>
                Redo of <span className="voice-agent">{names(predecessor.id)}</span>.{" "}
                {staleLog ? <span className="voice-agent ink-2">{staleLog.message}</span> : "The first work copy did not merge cleanly with main."}
              </span>
            </div>
          )}
          {attempt && (
            <>
              <p className="voice-agent why__approach">{attempt.course.approach}</p>
              <details className="why__plandetails" open={attempt.course.plan.length <= 6}>
                <summary>{plural(attempt.course.plan.length, "plan step")}</summary>
                <ol className="why__plan voice-agent">
                  {attempt.course.plan.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ol>
              </details>
              <p className="why__meta">
                Plan sent at {clock(attempt.course.declaredAt)} on base <span className="voice-agent">{shortSha(attempt.baseSha)}</span> · files{" "}
                <span className="voice-agent">{attempt.course.files.join(", ")}</span>
              </p>
            </>
          )}
        </Step>

        <Step icon="buoy" title={`Change requests · ${corrections.length}`} id="corrections" tone="correction">
          {corrections.length === 0 ? (
            <p className="ink-3">No change requests. The plan had no conflict with other work.</p>
          ) : (
            <div className="why__corrs">
              {corrections.map((c) => (
                <CorrectionNotice
                  key={c.id}
                  correction={c}
                  to={names(c.attemptId)}
                  from={c.standOnAttemptId ? names(c.standOnAttemptId) : undefined}
                  check={idx.checkById.get(c.checkId)}
                  nameOf={names}
                  expanded={c.kind !== "upstream"}
                  size="lg"
                  now={now}
                />
              ))}
            </div>
          )}
        </Step>

        <Step icon="range" title={`Conflict checks · ${courseChecks.length}`} id="course-checks">
          <ChecksTable checks={courseChecks} names={names} incoming={agent?.callsign ?? ""} mainAfter={landing.mainAfter} />
        </Step>

        <Step icon="check" title="Tests" id="checks" tone="clear">
          <div className="why__evidence">
            {attempt?.checks && <EvidenceBar run={attempt.checks} label="Alone, in the work copy" />}
            <EvidenceBar run={landing.checks} label="Combined with main: the tests of all merged tasks" />
          </div>
        </Step>

        <Step icon="lighthouse" title="Decision" id="decision">
          {decision ? (
            <figure className="why__decision">
              <blockquote className="voice-human">“{decision.rationale}”</blockquote>
              <figcaption>
                <Icon name="human" size={12} /> {decision.by.name} {decision.attemptIds.length > 1 ? "chose" : "said yes to"} <span className="voice-agent">{names(decision.attemptIds[0])}</span>
                {decision.attemptIds.length > 1 ? ` over ${decision.attemptIds.slice(1).map(names).join(", ")}` : ""} · {ago(decision.at, now)}
              </figcaption>
            </figure>
          ) : (
            <p className="why__auto">
              No person had to say yes. The tests passed, so gitring merged the work by itself
              {siblings.length ? ` (${plural(siblings.length, "alternative")} stay visible)` : ""}.
            </p>
          )}
          <Ladder method={landing.method} baseSha={attempt?.baseSha} mainBefore={landing.mainBefore} />
        </Step>

        <Step icon="diff" title="Diff" id="diff">
          {error ? (
            <div className="why__err" role="alert">
              <p>gitring could not load the diff. {error}</p>
              <Button size="sm" icon="reload" onClick={retry}>
                Try again
              </Button>
            </div>
          ) : !detail ? (
            slow ? <DiffSkeleton /> : <div className="lskel-wait" aria-busy="true" />
          ) : (
            <>
              <p className="why__meta">
                main {shortSha(landing.mainBefore)} → {shortSha(landing.mainAfter)} · {plural(detail.diff.files.length, "file")} · +{int(detail.diff.files.reduce((s, f) => s + f.additions, 0))} −
                {int(detail.diff.files.reduce((s, f) => s + f.deletions, 0))}
              </p>
              {detail.diff.files.length > 0 && (
                <ul className="why__files" role="list" aria-label="Changed files">
                  {detail.diff.files.map((f) => (
                    <li key={f.path}>
                      <span className={`why__fstatus is-${f.status}`}>{f.status === "A" ? "Added" : f.status === "D" ? "Deleted" : "Changed"}</span>
                      {f.status === "D" ? (
                        <span className="voice-agent">{f.path}</span>
                      ) : (
                        <a className="voice-agent" href={withProject(codeHref(f.path, landing.mainAfter))} onClick={(e) => openInApp(e, codeHref(f.path, landing.mainAfter))}>
                          {f.path}
                        </a>
                      )}
                      <span className="voice-agent why__fstat">
                        <span className="why__plus">+{f.additions}</span> <span className="why__minus">−{f.deletions}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <DiffView files={detail.diff.files} />
            </>
          )}
        </Step>

        <Step icon="commit" title="Commit and merge record" id="commit">
          <CodeBlock code={landing.message} label={`commit ${shortSha(landing.mainAfter)}`} copyLabel="Copy message" />
          {noteText && (
            <details className="why__note">
              <summary>Show the raw merge record (git note refs/notes/gitring)</summary>
              <CodeBlock code={noteText} label="refs/notes/gitring" copyLabel="Copy record" />
            </details>
          )}
          <p className="why__meta">
            {agent ? `${agent.callsign} · ${modelShort(agent.model)} · ` : ""}work copy <span className="voice-agent">{landing.attemptId}</span> ·{" "}
            <a href={withProject(codeHref(null, landing.mainAfter))} onClick={(e) => openInApp(e, codeHref(null, landing.mainAfter))}>
              Open the code after this merge
            </a>
          </p>
        </Step>
      </ol>
    </article>
  );
}

/** Search text of a row: task, agent, files, method and the commit. */
function searchText(r: LogbookRow): string {
  return [r.intent?.title ?? r.landing.intentId, r.agent?.callsign ?? "", r.agent?.model ?? "", METHOD_TEXT[r.landing.method] ?? "", r.landing.mainAfter, ...changedFiles(r)].join(" ").toLowerCase();
}

export function LogbookView({ id }: { id?: string }) {
  const rows = useStore((s) => (s.state ? selectLogbook(s.state) : EMPTY));
  const createdAt = useStore((s) => s.state?.project.createdAt ?? 0);
  const canAct = useCanAct();
  const now = useNow(15_000);
  const compact = Boolean(id);
  const [filter, setFilter] = useState("");
  const q = useDeferredValue(filter.trim().toLowerCase());
  const index = useMemo(() => rows.map((r) => ({ r, text: searchText(r) })), [rows]);
  const shown = useMemo(() => (q ? index.filter((x) => q.split(/\s+/).every((w) => x.text.includes(w))).map((x) => x.r) : rows), [index, q, rows]);
  const listRef = useRef<HTMLOListElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const groups = useMemo(() => {
    const out: { day: string; rows: LogbookRow[] }[] = [];
    for (const r of shown) {
      const day = dayLabel(r.landing.at, now);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(r);
      else out.push({ day, rows: [r] });
    }
    return out;
  }, [shown, now]);

  const rowLinks = () => [...(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-lrow]") ?? [])];
  const moveFocus = useCallback((from: HTMLElement | null, d: 1 | -1) => {
    const links = rowLinks();
    if (!links.length) return;
    const i = from ? links.indexOf(from as HTMLAnchorElement) : -1;
    const next = links[Math.max(0, Math.min(links.length - 1, i === -1 ? (d === 1 ? 0 : links.length - 1) : i + d))];
    next?.focus();
    next?.closest(".lrow")?.scrollIntoView({ block: "nearest" });
  }, []);
  const onRowKey = useCallback(
    (e: KeyboardEvent<HTMLAnchorElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveFocus(e.currentTarget, 1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (rowLinks()[0] === e.currentTarget) filterRef.current?.focus();
        else moveFocus(e.currentTarget, -1);
      }
    },
    [moveFocus],
  );

  // j / k from anywhere on the page start at the first or last row; Escape closes an open record.
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog'], .b-pop, .b-popover")) return;
      // A row handles its own j / k; Escape works from anywhere.
      if (t?.closest?.("a[data-lrow]") && e.key !== "Escape") return;
      if (e.key === "g") {
        gAt = Date.now();
        return;
      }
      if (Date.now() - gAt < 1200) {
        gAt = 0;
        return;
      }
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const cur = rowLinks().find((a) => a.getAttribute("aria-current") === "page") ?? null;
        moveFocus(cur, e.key === "j" ? 1 : -1);
      } else if (e.key === "Escape" && id) {
        e.preventDefault();
        navigate("/history");
        // Focus goes back to the row of the record that was open.
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`a[data-lrow][href^="/history/${CSS.escape(id)}"]`)?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, moveFocus]);

  return (
    <div className={["logbook", compact ? "has-detail" : "no-detail"].join(" ")}>
      <section className="logbook__list" aria-labelledby="logbook-title">
        <div className="logbook__head">
          {compact ? (
            <h2 className="logbook__title" id="logbook-title">
              History <span className="voice-agent ink-3">{rows.length}</span>
            </h2>
          ) : (
            <>
              <h1 className="page__title" id="logbook-title" tabIndex={-1}>
                History
              </h1>
              <p className="page__lede">Every merge into main, with its reasons: task, plan, change requests, tests and decision. Open a merge to read its record.</p>
            </>
          )}
          {rows.length > 0 && (
            <div className="logbook__tools">
              <label className="vh" htmlFor="lb-filter">
                Filter the merges
              </label>
              <input
                ref={filterRef}
                id="lb-filter"
                className="b-input logbook__filter"
                type="search"
                placeholder="Filter by task, agent or file"
                autoComplete="off"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    moveFocus(null, 1);
                  } else if (e.key === "Escape" && filter) {
                    e.stopPropagation();
                    setFilter("");
                  }
                }}
              />
              {!compact && (
                <span className="logbook__keys ink-3" aria-hidden="true">
                  <kbd className="b-kbd">j</kbd>
                  <kbd className="b-kbd">k</kbd> move · <kbd className="b-kbd">Enter</kbd> open
                </span>
              )}
              {q && (
                <span className="logbook__count ink-3" role="status">
                  {shown.length} of {rows.length}
                </span>
              )}
            </div>
          )}
        </div>
        {!compact && shown.length > 0 && (
          <div className="lrow lrow--header" aria-hidden="true">
            <span>main</span>
            <span>Task</span>
            <span>Method</span>
            <span>Agent</span>
            <span>Change requests</span>
            <span>Tests</span>
            <span>When</span>
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyState
            text={canAct ? "No merges yet. Write a task: agents send plans, gitring checks them and merges work when its tests pass." : "No merges yet. gitring writes a record here for each merge."}
            action={
              canAct ? (
                <Button variant="primary" icon="plus" onClick={() => openNewIntent()}>
                  Write a task
                </Button>
              ) : undefined
            }
          />
        ) : shown.length === 0 ? (
          <p className="logbook__none" role="status">
            No merge matches “{filter.trim()}”.{" "}
            <button type="button" className="logbook__clear" onClick={() => setFilter("")}>
              Clear the filter
            </button>
          </p>
        ) : (
          <ol className="lrows" role="list" ref={listRef}>
            {groups.map((g) => (
              <li key={g.day} className="lday">
                {compact ? <h3 className="lday__label">{g.day}</h3> : <h2 className="lday__label">{g.day}</h2>}
                <ol className="lday__rows" role="list">
                  {g.rows.map((r) => (
                    <Row key={r.landing.id} r={r} compact={compact} selected={r.landing.id === id} now={now} onKey={onRowKey} />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
        <p className="logbook__origin">
          <Icon name="commit" size={12} /> The history starts with the import of the starting code{createdAt ? `, ${ago(createdAt, now)}` : ""}.
        </p>
      </section>
      {id && (
        <div className="logbook__detail">
          <WhyTrail id={id} />
        </div>
      )}
    </div>
  );
}
