/**
 * Two actions in the head of an open file: "Why line N?" and "History".
 * "Why line N?" shows the change that wrote the selected line, with the record of its merge: task, plan, change requests,
 * tests and the decision of a person. "History" shows the changes of the file on main.
 * "Why?" is always on. A click on a line number opens the answer at once (see view/renderMain.tsx).
 * On a desktop each answer is a panel that grows from its button. On a phone it is a sheet from the bottom (BottomSheet.tsx).
 * Nothing is modal.
 */
import { useRef, useState, type ReactNode } from "react";
import { Button, Popover } from "../../design/components";
import { Link } from "../../app/router";
import { plural, shortSha } from "../../state/format";
import { CodeLink } from "./CodeLink";
import { BottomSheet } from "./BottomSheet";
import { historyUrl, requestStatusText, shortGoal, stepFacts, stepWhat, stepWho, testsText, useJson, whyUrl, type HistoryAnswer, type HistoryStep, type StepFact, type WhyAnswer } from "./history";
import "./history.css";

/** A link to the file as it was after a change of main. */
function AtChange({ step, path, children }: { step: HistoryStep; path: string; children: ReactNode }) {
  return (
    <CodeLink className="b-btn b-btn--ghost b-btn--sm" to={{ ref: step.sha, path }}>
      {children}
    </CodeLink>
  );
}

function Failed({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="lh-msg" role="alert">
      <p>{error}</p>
      <Button size="sm" icon="reload" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function Wait({ label }: { label: string }) {
  return (
    <div className="lh-wait" role="status" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  );
}

/** Facts with a label, one in each row. */
function Facts({ rows }: { rows: StepFact[] }) {
  return (
    <dl className="lh-rows">
      {rows.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd className={f.agent ? "voice-agent" : undefined}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ───────────── why is this line here ───────────── */

function WhyCard({ a, path, now }: { a: WhyAnswer; path: string; now: number }) {
  if (a.work) {
    const w = a.work;
    return (
      <div className="lh-card">
        <p className="lh-eyebrow lh-eyebrow--line">Line {a.line}</p>
        <h3 className="lh-title voice-human">{w.title}</h3>
        <p>
          The work copy of <strong>{w.callsign}</strong> wrote this line. It is not merged yet.
        </p>
        {w.approach && <p className="lh-agent voice-agent">{w.approach}</p>}
        <div className="lh-acts">
          <CodeLink className="b-btn b-btn--secondary b-btn--sm" to={{ ref: w.attemptId, path, view: "diff" }}>
            Show the change
          </CodeLink>
          <Link className="b-btn b-btn--ghost b-btn--sm" to={`/overview?v=${encodeURIComponent(w.attemptId)}`}>
            Open the work copy
          </Link>
        </div>
      </div>
    );
  }
  const s = a.step;
  if (!s) {
    return (
      <div className="lh-card">
        <p className="lh-eyebrow lh-eyebrow--line">Line {a.line}</p>
        <p>{a.summary}</p>
      </div>
    );
  }
  const r = a.record;
  return (
    <div className="lh-card">
      <p className="lh-eyebrow lh-eyebrow--line">Line {a.line}</p>
      <h3 className={s.kind === "merge" ? "lh-title voice-human" : "lh-title"}>{r?.task.title || s.subject}</h3>
      <Facts rows={stepFacts(s, now)} />
      {s.kind !== "merge" && (
        <p>{s.kind === "root" ? "This line was on main before gitring recorded history." : "Main moved to this commit without a merge of gitring: an import, a pull or a push."}</p>
      )}
      {r?.task.goal && <p className="lh-goal voice-human">{shortGoal(r.task.goal)}</p>}
      {r && (r.plan.approach || r.plan.steps.length > 0) && (
        <section className="lh-sec" aria-label="The plan">
          <h4>The plan</h4>
          {r.plan.approach && <p className="lh-agent voice-agent">{r.plan.approach}</p>}
          {r.plan.steps.length > 0 && (
            <ol className="lh-plan voice-agent">
              {r.plan.steps.slice(0, 6).map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
          )}
        </section>
      )}
      {r && r.changeRequests.length > 0 && (
        <section className="lh-sec" aria-label="Change requests">
          <h4>{plural(r.changeRequests.length, "change request")}</h4>
          <ul className="lh-reqs">
            {r.changeRequests.slice(0, 4).map((c) => (
              <li key={c.id}>
                <span className="voice-agent">{c.message}</span>
                <span className="lh-dim">
                  {requestStatusText(c.status)}
                  {c.ackNote ? `: ${c.ackNote}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(r || s.merge) && (
        <ul className="lh-facts">
          <li>{testsText(r?.tests ?? s.merge!.tests)}</li>
          {r && r.conflictChecks.length > 0 && <li>{plural(r.conflictChecks.length, "conflict check")}</li>}
          {r?.decision && (
            <li>
              {r.decision.by} decided{r.decision.rationale ? `: ${r.decision.rationale}` : ""}
            </li>
          )}
        </ul>
      )}
      <div className="lh-acts">
        {s.merge && (
          <Link className="b-btn b-btn--secondary b-btn--sm" to={`/history/${encodeURIComponent(s.merge.landingId)}`}>
            Open the merge record
          </Link>
        )}
        <AtChange step={s} path={path}>
          The file after {shortSha(s.sha)}
        </AtChange>
      </div>
    </div>
  );
}

function WhyPanel({ projectId, refName, path, line, version, now }: { projectId: string; refName: string; path: string; line: number; version: string; now: number }) {
  const [retry, setRetry] = useState(0);
  const res = useJson<WhyAnswer>(whyUrl(projectId, refName, path, line, version), retry);
  if (!res || res.status === "loading") return <Wait label={`Please wait for the history of line ${line}`} />;
  if (res.status === "error") return <Failed error={res.error} onRetry={() => setRetry((n) => n + 1)} />;
  return <WhyCard a={res.data} path={path} now={now} />;
}

/* ───────────── the changes of the file ───────────── */

function HistoryPanel({ projectId, path, version, now }: { projectId: string; path: string; version: string; now: number }) {
  const [retry, setRetry] = useState(0);
  const res = useJson<HistoryAnswer>(historyUrl(projectId, path, 30, version), retry);
  if (!res || res.status === "loading") return <Wait label={`Please wait for the changes of ${path}`} />;
  if (res.status === "error") return <Failed error={res.error} onRetry={() => setRetry((n) => n + 1)} />;
  const h = res.data;
  return (
    <div className="lh-card">
      <p className="lh-eyebrow">Changes of {path} on main</p>
      {h.steps.length ? (
        <ol className="lh-steps" role="list">
          {h.steps.map((s) => (
            <li key={s.sha} className="lh-step">
              <span className={`lh-step__mark is-${s.kind}`} aria-hidden="true" />
              <div className="lh-step__body">
                <p className={s.kind === "merge" ? "lh-step__title voice-human" : "lh-step__title"}>{s.subject}</p>
                <p className="lh-meta">{stepWho(s, now)}</p>
                <p className="lh-meta voice-agent">{stepWhat(s)}</p>
                <p className="lh-step__acts">
                  {s.merge && <Link to={`/history/${encodeURIComponent(s.merge.landingId)}`}>Merge record</Link>}
                  {s.change?.status !== "D" && (
                    <CodeLink to={{ ref: s.sha, path }}>
                      The file after {shortSha(s.sha)}
                    </CodeLink>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p>{h.summary}</p>
      )}
      {h.more && <p className="lh-dim">gitring shows the newest {plural(h.steps.length, "change")}.</p>}
    </div>
  );
}

/* ───────────── the two actions ───────────── */

interface LineHistoryProps {
  projectId: string;
  refName: string;
  path: string;
  /** The selected line, or null. */
  line: number | null;
  version: string;
  now: number;
  /** Which answer is open. The page owns it, so that a click on a line number can open it. */
  answer: "why" | "history" | null;
  onAnswer: (answer: "why" | "history" | null) => void;
  /** Select the line under the caret, or the first changed line on screen. Used when "Why?" finds no selected line. */
  chooseLine: () => void;
  /** A phone: answers open as a sheet from the bottom. */
  sheet: boolean;
}

export function LineHistory({ projectId, refName, path, line, version, now, answer, onAnswer, chooseLine, sheet }: LineHistoryProps) {
  const whyBtn = useRef<HTMLButtonElement | null>(null);
  const histBtn = useRef<HTMLButtonElement | null>(null);
  const whyOpen = answer === "why" && Boolean(line);
  const historyOpen = answer === "history";
  const askWhy = () => {
    if (answer === "why") return onAnswer(null);
    if (!line) chooseLine();
    onAnswer("why");
  };
  const close = () => onAnswer(null);
  const whyLabel = `Why line ${line ?? ""} is here`;
  const historyLabel = `The changes of ${path}`;
  const why = whyOpen && line ? <WhyPanel projectId={projectId} refName={refName} path={path} line={line} version={version} now={now} /> : null;
  const history = historyOpen ? <HistoryPanel projectId={projectId} path={path} version={version} now={now} /> : null;
  return (
    <>
      <button
        ref={whyBtn}
        type="button"
        className="cv-tool cv-tool--why"
        aria-haspopup="dialog"
        aria-expanded={whyOpen}
        title={line ? `Why is line ${line} here?` : "Ask why a line is here. Click a line number to choose the line."}
        onClick={askWhy}
      >
        {line ? `Why line ${line}?` : "Why?"}
      </button>
      <button ref={histBtn} type="button" className="cv-tool" aria-haspopup="dialog" aria-expanded={historyOpen} title={`The changes of ${path} on main`} onClick={() => onAnswer(historyOpen ? null : "history")}>
        History
      </button>
      {sheet ? (
        <>
          <BottomSheet open={whyOpen} onClose={close} label={whyLabel} title={`Why is line ${line ?? ""} here?`} returnTo={whyBtn.current} keepInView={line}>
            {why}
          </BottomSheet>
          <BottomSheet open={historyOpen} onClose={close} label={historyLabel} title="The changes of this file" returnTo={histBtn.current} keepInView={line}>
            {history}
          </BottomSheet>
        </>
      ) : (
        <>
          <Popover anchor={whyBtn.current} open={whyOpen} onClose={close} label={whyLabel} align="end" width={440}>
            {why}
          </Popover>
          <Popover anchor={histBtn.current} open={historyOpen} onClose={close} label={historyLabel} align="end" width={440}>
            {history}
          </Popover>
        </>
      )}
    </>
  );
}
