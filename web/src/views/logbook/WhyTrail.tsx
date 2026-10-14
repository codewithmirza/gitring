/**
 * The merge record of one merge, step by step: task, plan, change requests, conflict checks, tests, decision, diff and commit.
 * The record loads once (it never changes) and aborts when the row closes. Internal ids show only in "Show the raw merge record".
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Callsign, CodeBlock, CorrectionNotice, DiffView, EmptyState, EvidenceBar, MethodBadge } from "../../design/components";
import { Icon, type IconName } from "../../design/icons";
import { Link } from "../../app/router";
import { useNow } from "../../app/useNow";
import { harborOrNull, isAbort, type LandingDetail } from "../../state/api";
import { ago, clock, int, modelShort, plural, shortSha } from "../../state/format";
import { useStore } from "../../state/store";
import { byId, indexes } from "../../state/selectors";
import { codeHref } from "../code/links";
import { methodSentence, testsSentence, trainText } from "../trains-copy";
import { ChecksTable, Ladder } from "./Evidence";
import { openInApp, withProject } from "./links";

/* ───────────── parts of the record ───────────── */

function Step({ icon, title, children, tone, id }: { icon: IconName; title: ReactNode; children: ReactNode; tone?: string; id: string }) {
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
    <div className="lskel" role="status" aria-label="Please wait for the diff">
      {Array.from({ length: 8 }, (_, i) => (
        <span key={i} className="lskel__line" style={{ width: `${30 + ((i * 41) % 60)}%` }} />
      ))}
    </div>
  );
}

/** A step title with its small fact (a version, a count) apart from the words. */
function titleWith(words: string, fact: string | number): ReactNode {
  return (
    <>
      {words} <span className="trail__fact voice-agent">{fact}</span>
    </>
  );
}

/** The commit message in two parts: the text that people read, and the `Gitring-…` lines (ids and settings) at its end. */
function splitTrailers(message: string): { body: string; hasTrailers: boolean } {
  const paragraphs = message.trimEnd().split("\n\n");
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const isTrailer = paragraphs.length > 1 && last.split("\n").every((line) => /^Gitring-[A-Za-z-]+: /.test(line));
  return { body: isTrailer ? paragraphs.slice(0, -1).join("\n\n") : message.trimEnd(), hasTrailers: isTrailer };
}

/* ───────────── the merge record of one merge ───────────── */

export function WhyTrail({ id }: { id: string }) {
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
  const message = splitTrailers(landing.message);
  const goalChanges = intent?.amendments.length ?? 0;

  return (
    <article className="why" aria-labelledby="why-title">
      <header className="why__head">
        <div className="why__crumbs">
          <Link to="/history" className="backlink">
            <Icon name="arrow-left" size={14} />
            History
          </Link>
          <MethodBadge method={landing.method} />
          {trainText(landing) && <Badge tone="neutral">{trainText(landing)}</Badge>}
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
            {methodSentence(landing.method)}. {testsSentence(landing, total)}
          </span>
        </p>
      </header>

      <ol className="trail">
        <Step icon="amend" title={titleWith("Task", `v${intent?.version ?? 1}`)} id="intent">
          <p className="voice-human why__goal">{intent?.goal.replace(/`/g, "")}</p>
          {intent && intent.constraints.length > 0 && (
            <ul className="why__constraints">
              {intent.constraints.map((c) => (
                <li key={c}>{c.replace(/`/g, "")}</li>
              ))}
            </ul>
          )}
          <dl className="why__facts">
            <dt>Opened by</dt>
            <dd>{intent?.createdBy.name}</dd>
            {goalChanges > 0 && (
              <>
                <dt>Goal changed</dt>
                <dd>{plural(goalChanges, "time")}</dd>
              </>
            )}
          </dl>
          <p className="why__meta">
            <Link to={`/tasks/${landing.intentId}`}>Open the task</Link>
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
              <dl className="why__facts">
                <dt>Plan sent</dt>
                <dd>
                  {clock(attempt.course.declaredAt)} on base <span className="voice-agent">{shortSha(attempt.baseSha)}</span>
                </dd>
                <dt>Files</dt>
                <dd className="voice-agent">{attempt.course.files.join(", ")}</dd>
              </dl>
            </>
          )}
        </Step>

        <Step icon="buoy" title={titleWith("Change requests", corrections.length)} id="corrections" tone="correction">
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

        <Step icon="range" title={titleWith("Conflict checks", courseChecks.length)} id="course-checks">
          <ChecksTable checks={courseChecks} names={names} incoming={agent?.callsign ?? ""} mainAfter={landing.mainAfter} />
        </Step>

        <Step icon="check" title="Tests" id="checks" tone="clear">
          <div className="why__evidence">
            {attempt?.checks && <EvidenceBar run={attempt.checks} label="Tests in the work copy" />}
            <EvidenceBar run={landing.checks} label="Combined with main: the tests of all merged tasks" />
          </div>
        </Step>

        <Step icon="lighthouse" title="Decision" id="decision">
          {decision ? (
            <figure className="why__decision">
              <blockquote className="voice-human">“{decision.rationale}”</blockquote>
              <figcaption>
                <span>
                  <Icon name="human" size={12} /> {decision.by.name} {decision.attemptIds.length > 1 ? "chose" : "said yes to"}{" "}
                  <span className="voice-agent">{names(decision.attemptIds[0])}</span>
                  {decision.attemptIds.length > 1 ? ` over ${decision.attemptIds.slice(1).map(names).join(", ")}` : ""}
                </span>
                <span>{ago(decision.at, now)}</span>
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
                {plural(detail.diff.files.length, "file")} changed, +{int(detail.diff.files.reduce((s, f) => s + f.additions, 0))} −{int(detail.diff.files.reduce((s, f) => s + f.deletions, 0))}
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
          <CodeBlock code={message.body} label={`commit ${shortSha(landing.mainAfter)}`} copyLabel="Copy message" />
          <p className="why__meta">
            <a href={withProject(codeHref(null, landing.mainAfter))} onClick={(e) => openInApp(e, codeHref(null, landing.mainAfter))}>
              Open the code after this merge
            </a>
          </p>
          <details className="why__note">
            <summary>Show the raw merge record</summary>
            <dl className="why__facts why__ids">
              <dt>Task</dt>
              <dd className="voice-agent">{landing.intentId}</dd>
              <dt>Work copy</dt>
              <dd className="voice-agent">{landing.attemptId}</dd>
              <dt>Merge</dt>
              <dd className="voice-agent">{landing.id}</dd>
              {agent && (
                <>
                  <dt>Model</dt>
                  <dd className="voice-agent">{modelShort(agent.model)}</dd>
                </>
              )}
            </dl>
            {message.hasTrailers && <CodeBlock code={landing.message} label="Full commit message" copyLabel="Copy full message" />}
            {noteText && <CodeBlock code={noteText} label="refs/notes/gitring" copyLabel="Copy merge record" />}
          </details>
        </Step>
      </ol>
    </article>
  );
}
