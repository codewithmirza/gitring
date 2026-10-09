import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CourseCheck, LandingMethod } from "../../../src/core/types";
import {
  Badge,
  Callsign,
  CodeBlock,
  CorrectionNotice,
  DiffView,
  EmptyState,
  EvidenceBar,
  MethodBadge,
  ProgressRule,
} from "../design/components";
import { Icon, type IconName } from "../design/icons";
import { Link } from "../app/router";
import { useNow } from "../app/useNow";
import { harbor, type LandingDetail } from "../state/api";
import { ago, clock, int, modelShort, plural, prob, shortSha } from "../state/format";
import { useStore } from "../state/store";
import { byId, indexes, selectLogbook, type LogbookRow } from "../state/selectors";
import "./logbook.css";

const EMPTY: LogbookRow[] = [];

function Row({ r, compact, selected, now }: { r: LogbookRow; compact: boolean; selected: boolean; now: number }) {
  const total = r.landing.checks.passed + r.landing.checks.failed;
  return (
    <li>
      <Link
        to={`/logbook/${r.landing.id}`}
        className={["lrow b-row", compact && "lrow--compact"].filter(Boolean).join(" ")}
        aria-current={selected ? "page" : undefined}
        aria-label={`${shortSha(r.landing.mainAfter)}: ${r.intent?.title ?? r.landing.intentId}. ${r.landing.method}. ${r.agent?.callsign ?? ""}. ${plural(
          r.corrections,
          "correction",
        )}. ${r.landing.checks.passed} of ${total} checks pass. ${ago(r.landing.at, now)}.`}
      >
        <span className="lrow__sha voice-agent">
          <Icon name="anchor" size={12} />
          {shortSha(r.landing.mainAfter)}
        </span>
        <span className="lrow__title voice-human">{r.intent?.title ?? r.landing.intentId}</span>
        <span className="lrow__method">
          <MethodBadge method={r.landing.method} />
        </span>
        <span className="lrow__agent">{r.agent && <Callsign callsign={r.agent.callsign} color={r.agent.color} model={r.agent.model} />}</span>
        <span className="lrow__corr">
          {r.corrections > 0 ? (
            <Badge tone="correction" icon="buoy">
              {plural(r.corrections, "correction")}
            </Badge>
          ) : (
            <span className="ink-3">No corrections</span>
          )}
        </span>
        <span className="lrow__checks voice-agent">
          <Icon name={r.landing.checks.ok ? "check" : "cross"} size={12} />
          {r.landing.checks.passed}/{total}
        </span>
        <span className="lrow__time ink-3">{ago(r.landing.at, now)}</span>
      </Link>
    </li>
  );
}

const LADDER: { method: LandingMethod; title: string; rule: string; icon: IconName }[] = [
  { method: "fast-forward", title: "Fast-forward", rule: "main is the attempt's base", icon: "fastforward" },
  { method: "merge", title: "3-way merge", rule: "the text merge is clean", icon: "merge" },
  { method: "rederive", title: "Re-derive", rule: "regenerate from the intent on main", icon: "rederive" },
];

function Ladder({ method, baseSha, mainBefore }: { method: LandingMethod; baseSha?: string; mainBefore: string }) {
  const used = LADDER.findIndex((l) => l.method === method);
  return (
    <ol className="ladder" aria-label="Landing ladder">
      {LADDER.map((l, i) => {
        const state = i < used ? "skipped" : i === used ? "used" : "unused";
        let why = "";
        if (state === "skipped") {
          why =
            i === 0
              ? `main moved: base ${shortSha(baseSha)} ≠ main ${shortSha(mainBefore)}`
              : "the merge conflicts or composed checks fail";
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

function ChecksTable({ checks, names, incoming }: { checks: CourseCheck[]; names: (id: string) => string; incoming: string }) {
  if (!checks.length) return <p className="ink-3">No course checks recorded.</p>;
  return (
    <div className="ctable-wrap">
      <table className="ctable">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Trigger</th>
            <th scope="col">Verdict</th>
            <th scope="col">Source</th>
            <th scope="col">Latency</th>
            <th scope="col">Confidence</th>
            <th scope="col">Traffic in range</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id}>
              <td className="voice-agent">{clock(c.at)}</td>
              <td>{c.trigger}</td>
              <td>
                {c.verdict === "clear" ? (
                  <Badge tone="clear" icon="check">
                    Clear
                  </Badge>
                ) : c.verdict === "correct" ? (
                  <Badge tone="correction" icon="buoy">
                    Correction
                  </Badge>
                ) : (
                  <Badge tone="caution" icon="lighthouse">
                    {c.verdict}
                  </Badge>
                )}
              </td>
              <td className="voice-agent">{c.source}</td>
              <td className="voice-agent">{c.latencyMs} ms</td>
              <td className="voice-agent">{prob(c.confidence)}</td>
              <td className="voice-agent ink-2">
                {c.assessments.length
                  ? c.assessments.map((a) => `${names(a.otherAttemptId)} ${prob(a.collision)}`).join(" · ")
                  : `none near ${incoming}`}
              </td>
            </tr>
          ))}
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

function WhyTrail({ id }: { id: string }) {
  const now = useNow(15_000);
  const st = useStore((s) => s.state);
  const [detail, setDetail] = useState<LandingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const landing = st?.landings.find((l) => l.id === id);

  useEffect(() => {
    if (!landing) return;
    setDetail(null);
    setError(null);
    harbor()
      .landing(id)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [id, landing?.id]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    if (st) for (const a of st.attempts) m.set(a.id, byId(st.agents).get(a.agentId)?.callsign ?? a.agentId);
    return (aid: string) => m.get(aid) ?? aid;
  }, [st]);

  if (!st) return null;
  if (!landing) {
    return (
      <div className="why">
        <h1 className="why__title" tabIndex={-1}>
          Landing not found
        </h1>
        <EmptyState text="This landing is not in the logbook. The demo harbor may have restarted. Wait for the next landing." action={<Link to="/logbook">Show the logbook</Link>} />
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
          <Link to="/logbook" className="backlink">
            <Icon name="arrow-left" size={14} />
            Logbook
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
            landed it with {landing.method === "fast-forward" ? "a fast-forward" : landing.method === "merge" ? "a 3-way merge" : "a re-derive from the intent"}.{" "}
            {landing.checks.passed}/{total} checks pass on main. Human merge fixes: 0.
          </span>
        </p>
      </header>

      <ol className="trail">
        <Step icon="amend" title={`Intent · v${intent?.version ?? 1}`} id="intent">
          <p className="voice-human why__goal">{intent?.goal.replace(/`/g, "")}</p>
          {intent && intent.constraints.length > 0 && (
            <ul className="why__constraints">
              {intent.constraints.map((c) => (
                <li key={c}>{c.replace(/`/g, "")}</li>
              ))}
            </ul>
          )}
          <p className="why__meta">
            Opened by {intent?.createdBy.name} · {plural(intent?.amendments.length ?? 0, "amendment")} ·{" "}
            <Link to={`/intents/${landing.intentId}`}>Open the intent</Link>
          </p>
        </Step>

        <Step icon="compass" title="Course" id="course">
          {predecessor && (
            <div className="why__lineage">
              <Badge tone="caution" icon="rederive">
                Generation {attempt?.lineage.generation}
              </Badge>
              <span>
                Re-derived from <span className="voice-agent">{names(predecessor.id)}</span>.{" "}
                {staleLog ? <span className="voice-agent ink-2">{staleLog.message}</span> : "The first attempt did not compose with main."}
              </span>
            </div>
          )}
          {attempt && (
            <>
              <p className="voice-agent why__approach">{attempt.course.approach}</p>
              <ol className="why__plan voice-agent">
                {attempt.course.plan.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
              <p className="why__meta">
                Declared {clock(attempt.course.declaredAt)} on base <span className="voice-agent">{shortSha(attempt.baseSha)}</span> · files{" "}
                <span className="voice-agent">{attempt.course.files.join(", ")}</span>
              </p>
            </>
          )}
        </Step>

        <Step icon="buoy" title={`Corrections · ${corrections.length}`} id="corrections" tone="correction">
          {corrections.length === 0 ? (
            <p className="ink-3">No corrections. The course stayed clear of all traffic.</p>
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

        <Step icon="range" title={`Course checks · ${courseChecks.length}`} id="course-checks">
          <ChecksTable checks={courseChecks} names={names} incoming={agent?.callsign ?? ""} />
        </Step>

        <Step icon="check" title="Checks" id="checks" tone="clear">
          <div className="why__evidence">
            {attempt?.checks && <EvidenceBar run={attempt.checks} label="Alone, in the attempt's fork" />}
            <EvidenceBar run={landing.checks} label="Composed with main: every landed intent's checks" />
          </div>
        </Step>

        <Step icon="lighthouse" title="Decision" id="decision">
          {decision ? (
            <figure className="why__decision">
              <blockquote className="voice-human">“{decision.rationale}”</blockquote>
              <figcaption>
                <Icon name="human" size={12} /> {decision.by.name} picked <span className="voice-agent">{names(decision.attemptIds[0])}</span>
                {decision.attemptIds.length > 1 ? ` over ${decision.attemptIds.slice(1).map(names).join(", ")}` : ""} · {ago(decision.at, now)}
              </figcaption>
            </figure>
          ) : (
            <p className="why__auto">
              No human pick was necessary. The intent had one live attempt and its checks passed, so Gitring landed it by itself
              {siblings.length ? ` (${plural(siblings.length, "alternate")} stay visible)` : ""}.
            </p>
          )}
          <Ladder method={landing.method} baseSha={attempt?.baseSha} mainBefore={landing.mainBefore} />
        </Step>

        <Step icon="diff" title="Diff" id="diff">
          {error ? (
            <p className="err">{error}</p>
          ) : !detail ? (
            <ProgressRule label="Loading the diff" />
          ) : (
            <>
              <p className="why__meta">
                main {shortSha(landing.mainBefore)} → {shortSha(landing.mainAfter)} · {plural(detail.diff.files.length, "file")} · +
                {int(detail.diff.files.reduce((s, f) => s + f.additions, 0))} −{int(detail.diff.files.reduce((s, f) => s + f.deletions, 0))}
              </p>
              <DiffView files={detail.diff.files} />
            </>
          )}
        </Step>

        <Step icon="commit" title="Commit and logbook note" id="commit">
          <CodeBlock code={landing.message} label={`commit ${shortSha(landing.mainAfter)}`} copyLabel="Copy message" />
          {noteText && (
            <details className="why__note">
              <summary>Show the raw logbook note (git note refs/notes/gitring)</summary>
              <CodeBlock code={noteText} label="gitring.logbook/v1" copyLabel="Copy note" />
            </details>
          )}
          <p className="why__meta">
            {agent ? `${agent.callsign} · ${modelShort(agent.model)} · ` : ""}attempt <span className="voice-agent">{landing.attemptId}</span>
          </p>
        </Step>
      </ol>
    </article>
  );
}

export function LogbookView({ id }: { id?: string }) {
  const rows = useStore((s) => (s.state ? selectLogbook(s.state) : EMPTY));
  const seed = useStore((s) => s.state?.project.createdAt ?? 0);
  const now = useNow(15_000);
  const compact = Boolean(id);
  return (
    <div className={["logbook", compact ? "has-detail" : "no-detail"].join(" ")}>
      <section className="logbook__list" aria-labelledby="logbook-title">
        <div className="logbook__head">
          {compact ? (
            <h2 className="logbook__title" id="logbook-title">
              Logbook <span className="voice-agent ink-3">{rows.length}</span>
            </h2>
          ) : (
            <>
              <h1 className="page__title" id="logbook-title" tabIndex={-1}>
                Logbook
              </h1>
              <p className="page__lede">Every landing on main, with its why: intent, course, corrections, checks and decision. Open a landing to read the trail.</p>
            </>
          )}
        </div>
        {!compact && rows.length > 0 && (
          <div className="lrow lrow--header" aria-hidden="true">
            <span>main</span>
            <span>Intent</span>
            <span>Method</span>
            <span>Agent</span>
            <span>Corrections</span>
            <span>Checks</span>
            <span>When</span>
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyState text="No landings yet. Gitring writes a logbook record for every landing." />
        ) : (
          <ol className="lrows" role="list">
            {rows.map((r) => (
              <Row key={r.landing.id} r={r} compact={compact} selected={r.landing.id === id} now={now} />
            ))}
          </ol>
        )}
        <p className="logbook__origin">
          <Icon name="commit" size={12} /> The logbook starts at the seed import{seed ? `, ${ago(seed, now)}` : ""}.
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
