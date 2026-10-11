import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { AgentInfo, Attempt, Correction, CourseCheck, Intent, Landing } from "../../../src/core/types";
import {
  AttemptBadge,
  Badge,
  Button,
  Callsign,
  CorrectionNotice,
  DiffView,
  EmptyState,
  EvidenceBar,
  InlinePanel,
  IntentBadge,
  MethodBadge,
  PreviewFrame,
  SkeletonRows,
  toast,
} from "../design/components";
import { Icon } from "../design/icons";
import { IntentsRail } from "../app/IntentsRail";
import { LaunchButton } from "../app/LaunchControl";
import { codeHref, Link, navigate } from "../app/router";
import { useNow } from "../app/useNow";
import { harbor, harborOrNull, onHarbor, type DiffResult } from "../state/api";
import { ago, ATTEMPT_STATUS_TEXT, METHOD_TEXT, modelShort, plural, shortSha } from "../state/format";
import { useStore } from "../state/store";
import { useCanAct } from "../state/account";
import { byId, indexes, selectIntentGroups } from "../state/selectors";
import "./intents.css";

const SOURCE_TEXT: Record<Intent["source"]["kind"], string> = {
  ui: "the web app",
  mcp: "MCP",
  webhook: "a webhook",
  seed: "the starting code",
};

function sourceText(i: Intent): string {
  const ref = i.source.ref ?? "";
  if (ref.startsWith("github")) return `GitHub issue ${ref.split("#")[1] ? "#" + ref.split("#")[1] : ""}`.trim();
  if (ref.startsWith("slack")) return "Slack /gitring";
  return SOURCE_TEXT[i.source.kind] ?? i.source.kind;
}

/* ───────────── diffs: one request per work copy version, shared ───────────── */

const diffCache = new Map<string, Promise<DiffResult>>();

function loadDiff(a: Attempt): Promise<DiffResult> {
  const key = `${a.id}@${a.updatedAt}`;
  let p = diffCache.get(key);
  if (!p) {
    p = harbor().attemptDiff(a.id);
    diffCache.set(key, p);
    p.catch(() => diffCache.delete(key));
    // Keep the cache small: the oldest answers go first.
    while (diffCache.size > 24) diffCache.delete(diffCache.keys().next().value!);
  }
  return p;
}

/* ───────────── merge and GitHub ───────────── */

/** The merge button says what happens: into main, and to GitHub when the project syncs. */
function useMergeResult(): string {
  const github = useStore((s) => s.state?.project.settings.github);
  const status = useStore((s) => s.state?.project.github);
  if (!github?.repo || github.mode === "off") return "Merge into main";
  if (github.mode === "main") return "Merge into main and push to GitHub";
  return status?.prUrl ? "Merge into main and update the pull request" : "Merge into main and open a pull request on GitHub";
}

/** A reason for the merge record from the facts: the tests, the size, and how it compares. */
function suggestedReason(a: Attempt, all: Attempt[]): string {
  const run = a.composedChecks ?? a.checks;
  const tests = run ? `${run.passed} of ${run.passed + run.failed} tests pass` : "The tests pass";
  const size = (x: Attempt) => x.stats.additions + x.stats.deletions;
  const others = all.filter((x) => x.id !== a.id && x.status === "ready");
  const smallest = others.length > 0 && others.every((o) => size(o) >= size(a));
  return `${tests}. +${a.stats.additions} −${a.stats.deletions} in ${plural(a.stats.filesChanged, "file")}${smallest ? ", the smallest change" : ""}.`;
}

/* ───────────── task header: change the goal, pause ───────────── */

function AmendPanel({ intent, onClose, returnFocus }: { intent: Intent; onClose: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  const [goal, setGoal] = useState(intent.goal);
  const [constraint, setConstraint] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = goal.trim() !== intent.goal.trim() || constraint.trim();
  const submit = async () => {
    if (!changed) {
      setError("Change the goal or add a constraint first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await harbor().amendIntent(intent.id, {
        goal: goal.trim() !== intent.goal ? goal.trim() : undefined,
        constraints: constraint.trim() ? [constraint.trim()] : undefined,
        reason: reason.trim() || "Changed in the web app.",
      });
      toast({ tone: "info", title: `Goal changed (version ${intent.version + 1})`, text: "Active work copies get a change request with the new text." });
      onClose();
    } catch (e) {
      setError(`The change did not save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <InlinePanel label="Change the goal" onClose={onClose} returnFocus={returnFocus} onSubmit={() => void submit()} className="amend">
      <label className="inline__label" htmlFor="amend-goal">
        Goal <span className="ink-3">· version {intent.version} → {intent.version + 1}</span>
      </label>
      <textarea id="amend-goal" className="b-textarea voice-human" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} data-autofocus />
      <div className="amend__row">
        <div className="amend__field">
          <label className="inline__label" htmlFor="amend-constraint">
            Add a constraint <span className="ink-3">(optional)</span>
          </label>
          <input id="amend-constraint" className="b-input voice-human" value={constraint} onChange={(e) => setConstraint(e.target.value)} placeholder="Show at most 20 results." />
        </div>
        <div className="amend__field">
          <label className="inline__label" htmlFor="amend-reason">
            Reason <span className="ink-3">(optional)</span>
          </label>
          <input id="amend-reason" className="b-input voice-human" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Long result lists are slow on phones." />
        </div>
      </div>
      <p className="inline__help">gitring keeps every version. Active work copies get the change as a change request.</p>
      {error && (
        <p className="inline__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      <div className="inline__actions">
        <Button type="submit" size="sm" variant="primary" icon="amend" busy={busy}>
          Save as version {intent.version + 1}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </InlinePanel>
  );
}

function PausePanel({ intent, onClose, returnFocus }: { intent: Intent; onClose: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await harbor().park(intent.id, reason.trim() || "Paused in the web app.");
      toast({ tone: "info", title: "Task paused", text: `“${intent.title}” stops. Its work copies stay visible.` });
      onClose();
    } catch (e) {
      setError(`The task did not pause: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <InlinePanel label="Pause the task" onClose={onClose} returnFocus={returnFocus} onSubmit={() => void submit()} className="pause">
      <p className="inline__lead">Pausing stops all work copies of this task. gitring keeps them. You can open a new task later.</p>
      <label className="inline__label" htmlFor="pause-reason">
        Reason <span className="ink-3">(optional, the history keeps it)</span>
      </label>
      <input id="pause-reason" className="b-input voice-human" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The shop does not need a search yet." data-autofocus />
      {error && (
        <p className="inline__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      <div className="inline__actions">
        <Button type="submit" size="sm" variant="danger" icon="park" busy={busy}>
          Pause the task
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Keep working
        </Button>
      </div>
    </InlinePanel>
  );
}

/* ───────────── spec ───────────── */

function LivingSpec({ intent, now }: { intent: Intent; now: number }) {
  const versions = [
    { version: 1, at: intent.createdAt, by: intent.createdBy, reason: `Opened from ${sourceText(intent)}.`, text: "" },
    ...intent.amendments,
  ].reverse();
  return (
    <section className="spec" aria-labelledby="spec-title">
      <h2 className="spec__title" id="spec-title">
        Versions <span className="voice-agent ink-3">v{intent.version}</span>
      </h2>
      <ol className="timeline">
        {versions.map((a, i) => (
          <li key={`${a.version}-${a.at}-${i}`} className={["timeline__item", a.by.kind === "human" ? "is-human" : "is-system"].join(" ")}>
            <span className="timeline__dot" aria-hidden="true" />
            <div className="timeline__head">
              <span className="voice-agent">v{a.version}</span>
              <span className="timeline__by">
                <Icon name={a.by.kind === "human" ? "human" : "compass"} size={12} />
                {a.by.name}
              </span>
              <span className="ink-3">{ago(a.at, now)}</span>
            </div>
            <p className={a.by.kind === "human" ? "voice-human timeline__reason" : "timeline__reason"}>{a.reason}</p>
            {a.text && <p className={a.by.kind === "human" ? "voice-human timeline__text" : "voice-agent timeline__text"}>{a.text}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ───────────── lanes ───────────── */

function FileList({ attempt }: { attempt: Attempt }) {
  const files = Object.entries(attempt.footprint.files).sort(([a], [b]) => a.localeCompare(b));
  if (!files.length) return <p className="ink-3 lane__empty">No files changed yet.</p>;
  const max = Math.max(...files.map(([, f]) => f.additions + f.deletions), 1);
  return (
    <ul className="lane__files" role="list">
      {files.map(([path, f]) => (
        <li key={path}>
          <span className={`lane__fstatus is-${f.status}`} title={{ A: "Added", M: "Changed", D: "Deleted" }[f.status]}>
            {f.status}
            <span className="vh">{{ A: " added", M: " changed", D: " deleted" }[f.status]}</span>
          </span>
          <Link to={codeHref(attempt.id, path, { diff: true })} className="lane__fpath voice-agent" title={`Open the diff of ${path} in the code view`}>
            {path}
          </Link>
          <span className="lane__fbar" aria-hidden="true">
            <span className="add" style={{ width: `${(f.additions / max) * 100}%` }} />
            <span className="del" style={{ width: `${(f.deletions / max) * 100}%` }} />
          </span>
          <span className="lane__fnum voice-agent">
            <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The diff of a work copy, under its file list (one request per version of the work copy). */
function LaneDiff({ attempt }: { attempt: Attempt }) {
  const [res, setRes] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    loadDiff(attempt)
      .then((r) => live && setRes(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [attempt, nonce]);
  if (error)
    return (
      <p className="inline__error" role="alert">
        <Icon name="cross" size={12} /> gitring could not load the diff: {error}{" "}
        <button type="button" className="lane__retry" onClick={() => setNonce((n) => n + 1)}>
          Try again
        </button>
      </p>
    );
  if (!res) return <SkeletonRows rows={3} label="Loading the diff" />;
  return <DiffView files={res.files} />;
}

type LanePanel = "merge" | "redo" | null;

interface LaneProps {
  attempt: Attempt;
  all: Attempt[];
  agent?: AgentInfo;
  intent: Intent;
  corrections: Correction[];
  checks: Map<string, CourseCheck>;
  names: (id: string) => string;
  landing?: Landing;
  rederivedFromName?: string;
  canAct: boolean;
  /** Main is a Cloudflare Workers app (src/index.js): the work copy has a live preview. */
  preview: boolean;
  mainSha: string;
  now: number;
}

function Lane({ attempt: a, all, agent, intent, corrections, checks, names, landing, rederivedFromName, canAct, preview, mainSha, now }: LaneProps) {
  const callsign = agent?.callsign ?? a.agentId;
  const alternate = a.status === "alternate" || a.status === "abandoned" || (a.status === "stale" && intent.status === "landed");
  const landed = a.status === "landed";
  const canLand = a.status === "ready";
  const closed = intent.status === "landed" || intent.status === "parked";
  const [doc, setDoc] = useState<{ src: string | null }>({ src: null });
  const [panel, setPanel] = useState<LanePanel>(null);
  const [showDiff, setShowDiff] = useState(false);
  const mergeBtn = useRef<HTMLButtonElement | null>(null);
  const redoBtn = useRef<HTMLButtonElement | null>(null);
  const mergeResult = useMergeResult();

  useEffect(() => {
    if (!preview) return;
    const load = () => {
      const h = harborOrNull();
      if (!h) return;
      setDoc({ src: h.previewUrl(a.id) });
    };
    load();
    return onHarbor(load);
    // Rebuild the preview when the work copy changes files.
  }, [a.id, a.stats.steps, a.status, preview]);

  // A panel for an action that no longer applies closes by itself (the work copy merged or changed).
  useEffect(() => {
    if (panel === "merge" && (!canLand || closed)) setPanel(null);
    if (panel === "redo" && (closed || landed)) setPanel(null);
  }, [panel, canLand, closed, landed]);

  const style = { "--vc": `var(--v${(agent?.color ?? 0) % 12})` } as CSSProperties;
  return (
    <article
      className={["lane", alternate && "is-alternate", landed && "is-landed", canLand && "is-ready"].filter(Boolean).join(" ")}
      style={style}
      aria-label={`Work copy of ${callsign}: ${ATTEMPT_STATUS_TEXT[a.status]}`}
    >
      <header className="lane__head">
        <div className="lane__id">
          <Callsign callsign={callsign} color={agent?.color ?? 0} model={agent?.model} size="md" />
          <AttemptBadge status={alternate && a.status !== "alternate" ? "alternate" : a.status} failing={Boolean(a.checks && !a.checks.ok && a.status === "underway")} />
        </div>
        <div className="lane__meta">
          <span className="voice-agent">{modelShort(agent?.model)}</span>
          {agent?.kind === "mcp" && <span className="ink-3">via MCP · {agent.client}</span>}
          {agent && <span className="ink-3">seen {ago(agent.lastSeen, now)}</span>}
          {a.lineage.generation > 1 && (
            <span className="lane__gen">
              <Icon name="rederive" size={12} /> try {a.lineage.generation}
              {rederivedFromName ? ` · redo of ${rederivedFromName}` : ""}
            </span>
          )}
          <span className="ink-3">base {shortSha(a.baseSha)}</span>
        </div>
        {alternate && <p className="lane__note">Alternative. gitring keeps it with its diff.</p>}
        {a.returned && !landed && !alternate && (
          <p className="lane__note lane__note--drift">
            <Icon name="rederive" size={14} />
            The work could not merge, so gitring gave it back to {callsign}. {a.returned.reason} If the agent does not answer by{" "}
            <time dateTime={new Date(a.returned.until).toISOString()}>{new Date(a.returned.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            {a.returned.policy === "agent-first" ? ", a built-in agent does the task again." : ", a person decides."}
          </p>
        )}
        {a.drift && !landed && !alternate && (
          <p className="lane__note lane__note--drift">
            <Icon name="rederive" size={14} />
            Main moved to <span className="voice-agent">{shortSha(a.drift.mainSha)}</span>. {a.drift.overlaps.join(", ")} overlap{a.drift.overlaps.length > 1 ? "" : "s"} the
            merged change. If you choose this work copy, gitring redoes it on the new main.
          </p>
        )}
        {landed && landing && (
          <p className="lane__note lane__note--landed">
            <Icon name="anchor" size={14} />
            Merged into main <span className="voice-agent">{shortSha(landing.mainAfter)}</span> with <MethodBadge method={landing.method} />{" "}
            <Link to={`/history/${landing.id}`}>Read the merge record</Link>
          </p>
        )}
      </header>

      <section className="lane__sec lane__evidence" aria-label="Tests">
        <h3 className="lane__h">Tests</h3>
        <EvidenceBar run={a.checks} checking={a.status === "checking" || a.status === "submitted"} pending={intent.checks.length * 4} label="Alone" />
        {a.composedChecks && <EvidenceBar run={a.composedChecks} label="Combined with main" showFailures />}
        {(a.composedChecks?.log ?? a.checks?.log) && (
          <details className="lane__log">
            <summary>Output of the test container</summary>
            <pre className="voice-agent">{(a.composedChecks?.log ?? a.checks?.log ?? "").slice(-4000)}</pre>
          </details>
        )}
      </section>

      {preview && (
        <section className="lane__sec lane__preview" aria-label="Live preview">
          <h3 className="lane__h">
            Live preview <span className="ink-3">· the real code of this work copy</span>
          </h3>
          {doc.src ? <PreviewFrame title={callsign} src={doc.src} height={300} /> : <div className="lane__nopreview">The preview starts when the work copy exists.</div>}
        </section>
      )}

      <section className="lane__sec" aria-label="Files changed">
        <h3 className="lane__h">
          Files <span className="ink-3 voice-agent">+{a.stats.additions} −{a.stats.deletions}</span>
          {a.stats.filesChanged > 0 && (
            <button type="button" className="lane__toggle" aria-expanded={showDiff} onClick={() => setShowDiff(!showDiff)}>
              <Icon name="chevron-right" size={12} />
              {showDiff ? "Hide the diff" : "Show the diff"}
            </button>
          )}
        </h3>
        <FileList attempt={a} />
        {showDiff && <LaneDiff attempt={a} />}
      </section>

      <section className="lane__sec" aria-label="Plan">
        <h3 className="lane__h">Plan</h3>
        <p className="lane__approach voice-agent">{a.course.approach}</p>
        <ol className="lane__plan voice-agent">
          {a.course.plan.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ol>
        {a.summary && (
          <p className="lane__summary">
            <span className="ink-3">Summary · </span>
            <span className="voice-agent">{a.summary}</span>
          </p>
        )}
      </section>

      <section className="lane__sec" aria-label="Change requests received">
        <h3 className="lane__h">
          Change requests <span className="ink-3 voice-agent">{corrections.length}</span>
        </h3>
        {corrections.length === 0 ? (
          <p className="ink-3 lane__empty">No change requests. The plan had no conflict.</p>
        ) : (
          <div className="lane__corrs">
            {corrections.map((c) => (
              <CorrectionNotice key={c.id} correction={c} to={callsign} from={c.standOnAttemptId ? names(c.standOnAttemptId) : undefined} check={checks.get(c.checkId)} nameOf={names} now={now} />
            ))}
          </div>
        )}
      </section>

      <footer className="lane__actions">
        <div className="lane__buttons">
          {canAct && (
            <Button
              ref={mergeBtn}
              variant="primary"
              icon="anchor"
              disabled={!canLand || closed}
              aria-expanded={panel === "merge"}
              onClick={() => setPanel(panel === "merge" ? null : "merge")}
              title={canLand ? undefined : "Only a ready work copy can merge."}
            >
              Merge
            </Button>
          )}
          <Link to={codeHref(a.id, undefined, { diff: true })} className="b-btn b-btn--secondary">
            <Icon name="code" />
            Open in code
          </Link>
          {canAct && (
            <Button ref={redoBtn} variant="ghost" icon="rederive" disabled={closed || landed} aria-expanded={panel === "redo"} onClick={() => setPanel(panel === "redo" ? null : "redo")}>
              Redo
            </Button>
          )}
        </div>
        {panel === "merge" && <MergePanel attempt={a} all={all} callsign={callsign} intent={intent} mainSha={mainSha} result={mergeResult} onClose={() => setPanel(null)} returnFocus={mergeBtn} />}
        {panel === "redo" && <RedoPanel attempt={a} callsign={callsign} onClose={() => setPanel(null)} returnFocus={redoBtn} />}
      </footer>
    </article>
  );
}

function MergePanel({
  attempt,
  all,
  callsign,
  intent,
  mainSha,
  result,
  onClose,
  returnFocus,
}: {
  attempt: Attempt;
  all: Attempt[];
  callsign: string;
  intent: Intent;
  mainSha: string;
  result: string;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const [reason, setReason] = useState(() => suggestedReason(attempt, all));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = all.filter((x) => x.id !== attempt.id && !["landed", "alternate", "abandoned", "failed"].includes(x.status)).length;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await harbor().land(attempt.id, reason.trim() || suggestedReason(attempt, all));
      if (res.landing) {
        toast({
          tone: "clear",
          title: `Merged into main ${shortSha(res.landing.mainAfter)}`,
          text: `“${intent.title}” · ${METHOD_TEXT[res.landing.method] ?? res.landing.method}.`,
          action: { label: "Read the merge record", onClick: () => navigate(`/history/${res.landing!.id}`) },
        });
      } else {
        toast({ tone: "info", title: res.waits ? "The merge waits" : "Redo scheduled", text: res.message ?? "The work copy does not merge cleanly with main. gitring does it again on the new main." });
      }
      onClose();
    } catch (e) {
      setError(`The merge did not start: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <InlinePanel label={`Merge the work of ${callsign}`} onClose={onClose} returnFocus={returnFocus} onSubmit={() => void submit()} className="lane__panel">
      <p className="inline__lead">
        gitring combines this work copy with main <span className="voice-agent">{shortSha(mainSha)}</span>, runs the tests of all merged tasks, then merges it.
        {others === 1 ? " The other work copy stays as an alternative." : others > 1 ? ` The other ${others} work copies stay as alternatives.` : ""}
      </p>
      <label className="inline__label" htmlFor={`why-${attempt.id}`}>
        Why this work copy? <span className="ink-3">(filled in from the tests and the diff)</span>
      </label>
      <textarea id={`why-${attempt.id}`} className="b-textarea voice-human" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && (
        <p className="inline__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      <div className="inline__actions">
        <Button type="submit" size="sm" variant="primary" icon="anchor" busy={busy} data-autofocus="">
          {result}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </InlinePanel>
  );
}

function RedoPanel({ attempt, callsign, onClose, returnFocus }: { attempt: Attempt; callsign: string; onClose: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await harbor().rederive(attempt.id, reason.trim());
      toast({ tone: "info", title: "Redo started", text: `${callsign} sends a new plan on the current main.` });
      onClose();
    } catch (e) {
      setError(`The redo did not start: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <InlinePanel label={`Redo the work of ${callsign}`} onClose={onClose} returnFocus={returnFocus} onSubmit={() => void submit()} className="lane__panel">
      <p className="inline__lead">A new work copy starts from the task on the current main. This work copy stays as an alternative.</p>
      <label className="inline__label" htmlFor={`redo-${attempt.id}`}>
        What must change? <span className="ink-3">(optional, the agent reads it)</span>
      </label>
      <textarea
        id={`redo-${attempt.id}`}
        className="b-textarea voice-human"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="The toggle hides the search field on small screens."
        data-autofocus
      />
      {error && (
        <p className="inline__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      <div className="inline__actions">
        <Button type="submit" size="sm" variant="primary" icon="rederive" busy={busy}>
          Redo on the new main
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </InlinePanel>
  );
}

/* ───────────── intent detail ───────────── */

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
              ? `${ready.length} work copies are ready. Compare the tests${preview ? " and the previews" : ""}. Merge one. The others stay as alternatives.`
              : intent.status === "landed"
                ? pick
                  ? `${pick.by.name} chose ${names(pick.attemptIds[0])}: “${pick.rationale}”`
                  : "gitring merged the work copy that passed its tests. Alternatives stay below."
                : n === 0
                  ? "No work copies yet. Start 1 to 4 agents, or let your own agent take the task through MCP."
                  : "Each agent works in its own work copy. gitring checks each plan against all other active work."}
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
