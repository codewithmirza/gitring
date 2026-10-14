/**
 * Two actions in the head of an open file: "Why line N?" (the change that wrote the selected line, with
 * the record of its merge: task, plan, change requests, tests and the decision of a person) and "History"
 * (the changes of the file on main). Both open an anchored panel; nothing is modal.
 */
import { useRef, useState, type ReactNode } from "react";
import { Button, Popover } from "../../design/components";
import { Link } from "../../app/router";
import { ago, plural, shortSha } from "../../state/format";
import { CodeLink } from "./CodeLink";
import { changeText, historyUrl, requestStatusText, shortGoal, stepMeta, testsText, useJson, whyUrl, type HistoryAnswer, type HistoryStep, type WhyAnswer } from "./history";
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

/* ───────────── why is this line here ───────────── */

function WhyCard({ a, path, now }: { a: WhyAnswer; path: string; now: number }) {
  if (a.work) {
    const w = a.work;
    return (
      <div className="lh-card">
        <p className="lh-eyebrow">Line {a.line} · not merged</p>
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
        <p className="lh-eyebrow">Line {a.line}</p>
        <p>{a.summary}</p>
      </div>
    );
  }
  const r = a.record;
  return (
    <div className="lh-card">
      <p className="lh-eyebrow">
        Line {a.line} · {s.kind === "merge" ? "merged" : "on main"} {ago(s.at, now)}
      </p>
      <h3 className={s.kind === "merge" ? "lh-title voice-human" : "lh-title"}>{r?.task.title || s.subject}</h3>
      <p className="lh-meta voice-agent">{stepMeta(s)}</p>
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
        <p className="lh-facts">
          <span>{testsText(r?.tests ?? s.merge!.tests)}</span>
          {r && r.conflictChecks.length > 0 && <span>{plural(r.conflictChecks.length, "conflict check")}</span>}
          {r?.decision && (
            <span>
              {r.decision.by} decided{r.decision.rationale ? `: ${r.decision.rationale}` : ""}
            </span>
          )}
        </p>
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
  if (!res || res.status === "loading") return <Wait label={`Loading the history of line ${line}`} />;
  if (res.status === "error") return <Failed error={res.error} onRetry={() => setRetry((n) => n + 1)} />;
  return <WhyCard a={res.data} path={path} now={now} />;
}

/* ───────────── the changes of the file ───────────── */

function HistoryPanel({ projectId, path, version, now }: { projectId: string; path: string; version: string; now: number }) {
  const [retry, setRetry] = useState(0);
  const res = useJson<HistoryAnswer>(historyUrl(projectId, path, 30, version), retry);
  if (!res || res.status === "loading") return <Wait label={`Loading the changes of ${path}`} />;
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
                <p className="lh-meta voice-agent">
                  {stepMeta(s)} · {ago(s.at, now)}
                  {changeText(s) ? ` · ${changeText(s)}` : ""}
                </p>
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

export function LineHistory({ projectId, refName, path, line, version, now }: { projectId: string; refName: string; path: string; line: number | null; version: string; now: number }) {
  const whyBtn = useRef<HTMLButtonElement | null>(null);
  const histBtn = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState<"why" | "history" | null>(null);
  const toggle = (which: "why" | "history") => setOpen((o) => (o === which ? null : which));
  return (
    <>
      <button
        ref={whyBtn}
        type="button"
        className="cv-tool"
        aria-haspopup="dialog"
        aria-expanded={open === "why"}
        aria-disabled={!line || undefined}
        title={line ? `Why is line ${line} here?` : "Select a line number first. Then ask why the line is here."}
        onClick={() => line && toggle("why")}
      >
        {line ? `Why line ${line}?` : "Why?"}
      </button>
      <button ref={histBtn} type="button" className="cv-tool" aria-haspopup="dialog" aria-expanded={open === "history"} title={`The changes of ${path} on main`} onClick={() => toggle("history")}>
        History
      </button>
      <Popover anchor={whyBtn.current} open={open === "why" && Boolean(line)} onClose={() => setOpen(null)} label={`Why line ${line ?? ""} is here`} align="end" width={440}>
        {open === "why" && line ? <WhyPanel projectId={projectId} refName={refName} path={path} line={line} version={version} now={now} /> : null}
      </Popover>
      <Popover anchor={histBtn.current} open={open === "history"} onClose={() => setOpen(null)} label={`The changes of ${path}`} align="end" width={440}>
        {open === "history" ? <HistoryPanel projectId={projectId} path={path} version={version} now={now} /> : null}
      </Popover>
    </>
  );
}
