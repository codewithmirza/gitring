/**
 * One lane of the task page: a work copy with its agent, plan, real changes, files, diff, preview and tests.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AgentInfo, Attempt, Correction, CourseCheck, Intent, Landing } from "../../../../src/core/types";
import { AttemptBadge, Button, Callsign, CorrectionNotice, DiffView, EvidenceBar, MethodBadge, PreviewFrame, SkeletonRows } from "../../design/components";
import { Icon } from "../../design/icons";
import { codeHref, Link } from "../../app/router";
import { harborOrNull, onHarbor, type DiffResult } from "../../state/api";
import { ago, ATTEMPT_STATUS_TEXT, modelShort, shortSha } from "../../state/format";
import { useStore } from "../../state/store";
import { lineRequester, mayRequestLines } from "../../app/lineRequest";
import type { LineRequestInput } from "../../design/components";
import { MergePanel, RedoPanel } from "./MergePanels";
import { loadDiff, useMergeResult } from "./helpers";

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

/**
 * The diff of a work copy, under its file list (one request per version of the work copy). With `onRequest`, a
 * person selects lines and asks the agent to change them.
 */
function LaneDiff({ attempt, onRequest }: { attempt: Attempt; onRequest?: (input: LineRequestInput) => Promise<void> }) {
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
  if (!res) return <SkeletonRows rows={3} label="Please wait for the diff" />;
  return <DiffView files={res.files} onRequest={onRequest} />;
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

export function Lane({ attempt: a, all, agent, intent, corrections, checks, names, landing, rederivedFromName, canAct, preview, mainSha, now }: LaneProps) {
  const callsign = agent?.callsign ?? a.agentId;
  const projectId = useStore((s) => s.projectId);
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
            merged change. If you say yes to this work copy, gitring redoes it on the new main.
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
        {showDiff && <LaneDiff attempt={a} onRequest={canAct && mayRequestLines(a) ? lineRequester(projectId, a.id, callsign) : undefined} />}
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
