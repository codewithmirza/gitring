/**
 * The approve page: one work copy that asks to merge into main, and the person who says yes or sends it back.
 * Address: /approve/<work copy id>?project=<project id>. The page follows the live state. When somebody else
 * answers, or the agent changes the work, the page shows that in place.
 */
import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { approvalLine, approvalPath, canDecide } from "../../../src/core/approvals";
import type { Attempt } from "../../../src/core/types";
import { AttemptBadge, Badge, Button, Callsign, DiffView, EmptyState, EvidenceBar, Kbd, SkeletonRows, Textarea } from "../design/components";
import { Icon } from "../design/icons";
import { SignInChoices } from "../app/Account";
import { answerApproval, useAnswering, type Answer } from "../app/approvalActions";
import { MOD } from "../app/keys";
import { codeHref, Link } from "../app/router";
import { useNow } from "../app/useNow";
import { harborOrNull, isAbort, type ApprovalResult, type DiffResult } from "../state/api";
import { cannotAnswerText, describeOutcome, phaseOf, useApproverRule, type Outcome, type Phase } from "../state/approvals";
import { ago, plural } from "../state/format";
import { useStore } from "../state/store";
import "./approve.css";

/* ───────────── small pieces ───────────── */

/** True while the viewport is at most `px` wide. */
function useNarrow(px = 900): boolean {
  const query = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia(query);
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

/** The pill next to the title: where the question stands. */
function StatusPill({ phase, attempt }: { phase: Phase; attempt: Attempt }) {
  switch (phase.kind) {
    case "waiting":
      return (
        <Badge tone="caution" icon="lighthouse">
          Waits for a yes
        </Badge>
      );
    case "merged":
      return (
        <Badge tone="clear" icon="anchor">
          Merged
        </Badge>
      );
    case "queued":
    case "redo":
      return (
        <Badge tone="clear" icon="check">
          Approved
        </Badge>
      );
    case "sent-back":
      return (
        <Badge tone="correction" icon="buoy">
          Sent back
        </Badge>
      );
    case "closed":
      return (
        <Badge tone="neutral" icon="park">
          Closed
        </Badge>
      );
    default:
      return <AttemptBadge status={attempt.status} />;
  }
}

/** The change itself: one request for each version of the work. Many files start collapsed. */
const ChangeDiff = memo(function ChangeDiff({ attemptId, version }: { attemptId: string; version: string }) {
  const [res, setRes] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setRes(null);
    setError(null);
    const client = harborOrNull();
    if (!client) {
      setError("The project is not loaded yet. Try again in 2 seconds.");
      return;
    }
    client
      .attemptDiff(attemptId, { version, signal: ctl.signal })
      .then((r) => setRes(r))
      .catch((e: Error) => {
        if (!isAbort(e)) setError(e.message);
      });
    return () => ctl.abort();
  }, [attemptId, version, nonce]);
  if (error)
    return (
      <p className="approve__error" role="alert">
        <Icon name="cross" size={12} /> gitring could not load the change: {error}{" "}
        <button type="button" className="approve__retry" onClick={() => setNonce((n) => n + 1)}>
          Try again
        </button>
      </p>
    );
  if (!res) return <SkeletonRows rows={4} label="Loading the change" />;
  return <DiffView files={res.files} onlyFirstOpen={res.files.length > 5} empty="This work copy changes no file." />;
});

/* ───────────── the answer ───────────── */

interface AnswerPanelProps {
  attempt: Attempt;
  phase: Phase;
  outcome: Outcome | null;
  signedIn: boolean;
  mayAnswer: boolean;
  reason: string;
  notice: string | null;
  error: string | null;
  outcomeRef: RefObject<HTMLDivElement | null>;
  onSend: (answer: Answer, note: string) => void;
}

function AnswerPanel({ attempt, phase, outcome, signedIn, mayAnswer, reason, notice, error, outcomeRef, onSend }: AnswerPanelProps) {
  const approval = attempt.approval;
  const wide = !useNarrow();
  const sending = useAnswering(approval?.id ?? "");
  const busy = sending !== null;
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const uid = useId();
  const noteId = `${uid}-note`;
  const reasonId = `${uid}-reason`;
  const toggle = useRef<HTMLButtonElement | null>(null);
  const showNote = wide || noteOpen;

  const closeNote = () => {
    setNoteOpen(false);
    requestAnimationFrame(() => toggle.current?.focus());
  };
  const onNoteKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (mayAnswer && !busy) onSend("send-back", note);
    } else if (e.key === "Escape" && !wide) {
      e.preventDefault();
      e.stopPropagation();
      closeNote();
    }
  };

  return (
    <>
      <h2 className="approve__panelh">Your answer</h2>
      {notice && (
        <p className="approve__notice" role="status">
          <Icon name="info" size={14} /> {notice}
        </p>
      )}
      {outcome ? (
        <div className={`approve__outcome is-${outcome.tone}`} ref={outcomeRef} tabIndex={-1}>
          <h3 className="approve__outcomeh">{outcome.headline}</h3>
          {outcome.lines.map((l) => (
            <p key={l} className="approve__outcomep">
              {l}
            </p>
          ))}
          {outcome.note && (
            <p className="approve__outcomenote voice-human">
              <span className="approve__opt">Note · </span>
              {outcome.note}
            </p>
          )}
          {outcome.landingId && (
            <Link to={`/history/${outcome.landingId}`} className="approve__outcomelink">
              Read the merge record
            </Link>
          )}
          {phase.kind !== "none" && (
            <Link to={`/tasks/${attempt.intentId}`} className="approve__outcomelink">
              Open the task
            </Link>
          )}
        </div>
      ) : !signedIn ? (
        <SignInChoices reason="Sign in to answer." />
      ) : (
        <div className="approve__form">
          <Button
            variant="primary"
            icon="merge"
            block
            busy={sending === "approve"}
            disabled={!mayAnswer || (busy && sending !== "approve")}
            aria-describedby={!mayAnswer ? reasonId : undefined}
            onClick={() => onSend("approve", "")}
          >
            Yes, merge it
          </Button>
          {!showNote && (
            <Button ref={toggle} block aria-expanded={false} disabled={!mayAnswer} aria-describedby={!mayAnswer ? reasonId : undefined} onClick={() => setNoteOpen(true)}>
              Send back…
            </Button>
          )}
          {showNote && (
            <div className="approve__note" onKeyDown={onNoteKey}>
              <label className="approve__label" htmlFor={noteId}>
                Tell the agent what to change <span className="approve__opt">(optional)</span>
              </label>
              <Textarea
                id={noteId}
                voice="human"
                rows={wide ? 4 : 2}
                value={note}
                disabled={!mayAnswer}
                autoFocus={!wide}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                onChange={(e) => setNote(e.target.value)}
                placeholder="For example: keep the old name of the function."
              />
              <p className="approve__hint">
                <Kbd>{MOD}</Kbd> + <Kbd>Enter</Kbd> sends it back.
              </p>
              <div className="approve__noteacts">
                <Button block={wide} busy={sending === "send-back"} disabled={!mayAnswer || (busy && sending !== "send-back")} aria-describedby={!mayAnswer ? reasonId : undefined} onClick={() => onSend("send-back", note)}>
                  Send back
                </Button>
                {!wide && (
                  <Button variant="ghost" onClick={closeNote}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
          {!mayAnswer && (
            <p className="approve__reason" id={reasonId}>
              {reason}
            </p>
          )}
          {mayAnswer && <p className="approve__hint">A yes merges the work into main. Send back tells the agent what to change.</p>}
          {error && (
            <p className="approve__error" role="alert">
              <Icon name="cross" size={12} /> {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}

/* ───────────── the page ───────────── */

function Missing() {
  return (
    <div className="approve approve--missing">
      <h1 className="approve__title" tabIndex={-1}>
        Work copy not found
      </h1>
      <EmptyState text="This work copy is not in this project." action={<Link to="/tasks">Open the tasks</Link>} />
    </div>
  );
}

/** Work copies of the same task that are still open: they compete with this one. */
const OPEN = new Set(["declared", "underway", "submitted", "checking", "ready", "landing", "rederiving"]);

function Question({ attempt }: { attempt: Attempt }) {
  const now = useNow(15_000);
  const intent = useStore((s) => s.state?.intents.find((i) => i.id === attempt.intentId));
  const agent = useStore((s) => s.state?.agents.find((a) => a.id === attempt.agentId));
  const landing = useStore((s) => s.state?.landings.find((l) => l.attemptId === attempt.id));
  const attempts = useStore((s) => s.state?.attempts);
  const agents = useStore((s) => s.state?.agents);
  const projectId = useStore((s) => s.state?.project.id ?? "");
  const me = useStore((s) => s.me?.user ?? null);
  const role = useStore((s) => s.access);
  const rule = useApproverRule();
  const h1 = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const outcomeRef = useRef<HTMLDivElement | null>(null);

  const approval = attempt.approval;
  const [answered, setAnswered] = useState<{ approvalId: string; result: ApprovalResult } | null>(null);
  const [notice, setNotice] = useState<{ approvalId: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState("");

  // What the Worker said to this person's own answer (the merge, before the live state brings it).
  const mine = answered && approval && answered.approvalId === approval.id ? answered.result : null;
  const phase = phaseOf(attempt, landing ?? mine?.landing);
  const mayAnswer = canDecide(approval, { id: me?.id, role }, rule);
  const reason = cannotAnswerText({ signedIn: Boolean(me), role }, approval?.approver, rule);
  const callsign = agent?.callsign ?? attempt.agentId.toUpperCase();
  const title = intent?.title ?? "Unknown task";
  const mergeUntil = attempt.mergeWait?.until ?? mine?.waits?.until;
  const outcome = describeOutcome({ phase, approval, me: me?.id ?? "", builtin: agent?.kind === "builtin", mergeUntil, now });

  // The other work copies of this task that are still open.
  const rivals = useMemo(() => (attempts ?? []).filter((a) => a.intentId === attempt.intentId && a.id !== attempt.id && OPEN.has(a.status)), [attempts, attempt.intentId, attempt.id]);
  const nameOf = (agentId: string) => agents?.find((a) => a.id === agentId);

  // After a person answers here, focus goes to the result. An answer from somebody else is announced.
  const askedHere = useRef(false);
  const wasWaiting = useRef(phase.kind === "waiting");
  useEffect(() => {
    const was = wasWaiting.current;
    wasWaiting.current = phase.kind === "waiting";
    if (!was || phase.kind === "waiting" || !outcome) return;
    if (askedHere.current) {
      askedHere.current = false;
      outcomeRef.current?.focus();
    } else setLive(`${outcome.headline}. ${outcome.lines.join(" ")}`);
    // Only a change of the phase counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  const send = async (answer: Answer, note: string) => {
    if (!approval) return;
    setError(null);
    setNotice(null);
    const r = await answerApproval({ attemptId: attempt.id, approvalId: approval.id, answer, note, title, quiet: true });
    if (!r.ok) {
      setError(`The answer did not send: ${r.error}`);
      return;
    }
    if (r.kind === "refused") {
      setError(r.result.message);
      return;
    }
    // An old question has no answer here: the notice says why, and the page shows the new question.
    if (r.kind === "old") setNotice({ approvalId: approval.id, text: r.result.message });
    else askedHere.current = true;
    setAnswered({ approvalId: approval.id, result: r.result });
  };

  // "This question is old": the page shows the new question when the work waits again.
  const noticeText = useMemo(() => {
    if (!notice) return null;
    return approval && approval.id !== notice.approvalId && phase.kind === "waiting" ? "This question is old: the agent changed the work. The new question is below." : notice.text;
  }, [notice, approval, phase.kind]);

  if (!intent) return <Missing />;
  const files = attempt.stats.filesChanged;
  const waiting = phase.kind === "waiting";
  const asked = approval ? new Date(approval.askedAt) : null;
  const goToAnswer = () => {
    panelRef.current?.scrollIntoView({ block: "nearest" });
    panelRef.current?.focus({ preventScroll: true });
  };

  return (
    <article className="approve" aria-labelledby={h1}>
      <header className="approve__head">
        <div className="approve__crumbs">
          <Link to={`/tasks/${intent.id}`} className="backlink">
            <Icon name="arrow-left" size={14} />
            Task
          </Link>
          <StatusPill phase={phase} attempt={attempt} />
        </div>
        <h1 className="approve__title voice-human" id={h1} tabIndex={-1}>
          {title}
        </h1>
        <p className="approve__ask">
          <Callsign callsign={callsign} color={agent?.color ?? 0} model={agent?.model} size="md" /> {waiting ? "asks" : "asked"} to merge this into main
        </p>
        <p className="approve__meta">
          {attempt.sender ? <>Sent by {attempt.sender.name}</> : <>No person sent this agent</>}
          {asked && (
            <>
              {" · "}
              Asked{" "}
              <time dateTime={asked.toISOString()} title={asked.toLocaleString()}>
                {ago(asked.getTime(), now)}
              </time>
            </>
          )}
        </p>
        {waiting && (
          <button type="button" className="approve__skip" onClick={goToAnswer}>
            Go to your answer
          </button>
        )}
      </header>

      <div className="approve__grid">
        <div className="approve__main">
          {approval && approval.why.length > 0 && (
            <section className="approve__sec" aria-labelledby={`${h1}-why`}>
              <h2 className="approve__h" id={`${h1}-why`}>
                Why a person must say yes
              </h2>
              <ul className="approve__why">
                {approval.why.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="approve__sec" aria-labelledby={`${h1}-tests`}>
            <h2 className="approve__h" id={`${h1}-tests`}>
              Size and tests
            </h2>
            <p className="approve__line">{approvalLine(attempt)}</p>
            <EvidenceBar run={attempt.checks} checking={attempt.status === "checking" || attempt.status === "submitted"} pending={intent.checks.length * 4} label="Alone" />
            {attempt.composedChecks && <EvidenceBar run={attempt.composedChecks} label="Combined with main" showFailures />}
          </section>

          <section className="approve__sec" aria-labelledby={`${h1}-change`}>
            <h2 className="approve__h" id={`${h1}-change`}>
              The change <span className="approve__count voice-agent">{plural(files, "file")} · +{attempt.stats.additions} −{attempt.stats.deletions}</span>
            </h2>
            <p className="approve__tools">
              <Link to={codeHref(attempt.id, undefined, { diff: true })}>Open in code</Link>
            </p>
            <ChangeDiff attemptId={attempt.id} version={approval?.digest || String(attempt.updatedAt)} />
          </section>

          <section className="approve__sec" aria-labelledby={`${h1}-task`}>
            <h2 className="approve__h" id={`${h1}-task`}>
              The task
            </h2>
            <p className="approve__goal voice-human">{intent.goal.replace(/`/g, "")}</p>
            <h3 className="approve__h3">Plan of {callsign}</h3>
            {attempt.course.approach && <p className="approve__approach voice-agent">{attempt.course.approach}</p>}
            {attempt.course.plan.length > 0 && (
              <ol className="approve__plan voice-agent">
                {attempt.course.plan.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            )}
            {attempt.summary && (
              <p className="approve__summary">
                <span className="approve__opt">Summary · </span>
                <span className="voice-agent">{attempt.summary}</span>
              </p>
            )}
          </section>

          {rivals.length > 0 && (
            <section className="approve__sec" aria-labelledby={`${h1}-others`}>
              <h2 className="approve__h" id={`${h1}-others`}>
                Other work copies of this task
              </h2>
              <ul className="approve__rivals">
                {rivals.map((r) => {
                  const a = nameOf(r.agentId);
                  const name = a?.callsign ?? r.agentId.toUpperCase();
                  const asks = r.approval?.status === "waiting" && r.status === "ready";
                  return (
                    <li key={r.id} className="approve__rival">
                      <Callsign callsign={name} color={a?.color ?? 0} />
                      <span className="approve__rivalline">{r.status === "ready" ? approvalLine(r) : <AttemptBadge status={r.status} />}</span>
                      <Link to={asks ? approvalPath(projectId, r.id) : `/tasks/${r.intentId}`} aria-label={asks ? `Review the work of ${name}` : `Open the task to see the work of ${name}`}>
                        {asks ? "Review" : "Open the task"}
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {waiting && <p className="approve__hint">If you say yes to one, gitring closes the others.</p>}
            </section>
          )}
        </div>

        <aside className={["approve__panel", waiting && "is-waiting"].filter(Boolean).join(" ")} id="approve-answer" ref={panelRef} tabIndex={-1} aria-label="Your answer">
          <AnswerPanel
            attempt={attempt}
            phase={phase}
            outcome={outcome}
            signedIn={Boolean(me)}
            mayAnswer={mayAnswer}
            reason={reason}
            notice={noticeText}
            error={error}
            outcomeRef={outcomeRef}
            onSend={(a, n) => void send(a, n)}
          />
        </aside>
      </div>

      <div className="vh" role="status" aria-live="polite">
        {live}
      </div>
    </article>
  );
}

export function ApproveView({ id }: { id: string }) {
  const attempt = useStore((s) => s.state?.attempts.find((a) => a.id === id));
  if (!attempt) return <Missing />;
  return <Question attempt={attempt} />;
}
