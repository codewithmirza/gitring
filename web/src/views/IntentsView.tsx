import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { AgentInfo, Attempt, Correction, CourseCheck, Intent, Landing } from "../../../src/core/types";
import {
  AttemptBadge,
  Badge,
  Button,
  Callsign,
  CorrectionNotice,
  Dialog,
  EmptyState,
  EvidenceBar,
  Field,
  Input,
  IntentBadge,
  MethodBadge,
  PreviewFrame,
  Textarea,
  toast,
} from "../design/components";
import { Icon } from "../design/icons";
import { IntentsRail } from "../app/IntentsRail";
import { LaunchButton } from "../app/LaunchControl";
import { Link, navigate } from "../app/router";
import { openDiff, openFile } from "../app/ui";
import { useNow } from "../app/useNow";
import { harbor, harborOrNull, onHarbor } from "../state/api";
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

/* ───────────── dialogs ───────────── */

function ReasonDialog({
  open,
  onClose,
  title,
  description,
  label,
  help,
  placeholder,
  action,
  danger,
  onSubmit,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  label: string;
  help?: string;
  placeholder: string;
  action: string;
  danger?: boolean;
  onSubmit: (reason: string) => Promise<void>;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setReason("");
      setTried(false);
    }
  }, [open]);
  const submit = async () => {
    setTried(true);
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await onSubmit(reason.trim());
      onClose();
    } catch (e) {
      toast({ tone: "danger", title: `${action} failed`, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={submit}>
            {action}
          </Button>
        </>
      }
    >
      {children}
      <Field label={label} help={help} error={tried && !reason.trim() ? "Write the reason. The history keeps it." : undefined}>
        <Textarea voice="human" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} data-autofocus />
      </Field>
    </Dialog>
  );
}

function AmendDialog({ intent, open, onClose }: { intent: Intent; open: boolean; onClose: () => void }) {
  const [goal, setGoal] = useState(intent.goal);
  const [constraint, setConstraint] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setGoal(intent.goal);
      setConstraint("");
      setReason("");
      setTried(false);
    }
  }, [open, intent.goal]);
  const submit = async () => {
    setTried(true);
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await harbor().amendIntent(intent.id, {
        goal: goal.trim() !== intent.goal ? goal.trim() : undefined,
        constraints: constraint.trim() ? [constraint.trim()] : undefined,
        reason: reason.trim(),
      });
      toast({ tone: "info", title: `Goal changed (version ${intent.version + 1})`, text: "Active work copies get a change request with the new text." });
      onClose();
    } catch (e) {
      toast({ tone: "danger", title: "The change did not save", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Change the goal"
      description={`Version ${intent.version} → ${intent.version + 1}. gitring keeps every version. Active work copies get the change as a change request.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="amend" busy={busy} onClick={submit}>
            Change the goal
          </Button>
        </>
      }
    >
      <Field label="Goal">
        <Textarea voice="human" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </Field>
      <Field label="Add a constraint" optional help="Agents must follow every constraint.">
        <Input value={constraint} onChange={(e) => setConstraint(e.target.value)} placeholder="Show at most 20 results." className="voice-human" />
      </Field>
      <Field label="Reason" error={tried && !reason.trim() ? "Write the reason. The list of versions shows it." : undefined}>
        <Textarea voice="human" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Long result lists are slow on phones." />
      </Field>
    </Dialog>
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
        Spec <span className="voice-agent ink-3">v{intent.version}</span>
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
          </span>
          <button type="button" className="lane__fpath voice-agent" onClick={() => openFile(path)} title={`Read ${path} on main`}>
            {path}
          </button>
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

interface LaneProps {
  attempt: Attempt;
  agent?: AgentInfo;
  intent: Intent;
  corrections: Correction[];
  checks: Map<string, CourseCheck>;
  names: (id: string) => string;
  landing?: Landing;
  rederivedFromName?: string;
  onLand: (a: Attempt) => void;
  onRederive: (a: Attempt) => void;
  canAct: boolean;
  /** Main is a Cloudflare Workers app (src/index.js): the work copy has a live preview. */
  preview: boolean;
  now: number;
}

function Lane({ attempt: a, agent, intent, corrections, checks, names, landing, rederivedFromName, onLand, onRederive, canAct, preview, now }: LaneProps) {
  const callsign = agent?.callsign ?? a.agentId;
  const alternate = a.status === "alternate" || a.status === "abandoned" || (a.status === "stale" && intent.status === "landed");
  const landed = a.status === "landed";
  const canLand = a.status === "ready";
  const closed = intent.status === "landed" || intent.status === "parked";
  const [doc, setDoc] = useState<{ src: string | null }>({ src: null });

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
          {a.lineage.generation > 1 && (
            <span className="lane__gen">
              <Icon name="rederive" size={12} /> generation {a.lineage.generation}
              {rederivedFromName ? ` · redo of ${rederivedFromName}` : ""}
            </span>
          )}
          <span className="ink-3">base {shortSha(a.baseSha)}</span>
        </div>
        {alternate && <p className="lane__note">Alternative. gitring keeps it with its diff.</p>}
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
          {doc.src ? (
            <PreviewFrame title={callsign} src={doc.src} height={300} />
          ) : (
            <div className="lane__nopreview">The preview starts when the work copy exists.</div>
          )}
        </section>
      )}

      <section className="lane__sec" aria-label="Files changed">
        <h3 className="lane__h">
          Files <span className="ink-3 voice-agent">+{a.stats.additions} −{a.stats.deletions}</span>
        </h3>
        <FileList attempt={a} />
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
              <CorrectionNotice
                key={c.id}
                correction={c}
                to={callsign}
                from={c.standOnAttemptId ? names(c.standOnAttemptId) : undefined}
                check={checks.get(c.checkId)}
                nameOf={names}
                now={now}
              />
            ))}
          </div>
        )}
      </section>

      <footer className="lane__actions">
        {canAct && (
          <Button
            variant="primary"
            icon="anchor"
            disabled={!canLand || closed}
            onClick={() => onLand(a)}
            title={canLand ? undefined : "Only a ready work copy can merge."}
          >
            Merge
          </Button>
        )}
        <Button icon="diff" onClick={() => openDiff(a.id, callsign)}>
          Open diff
        </Button>
        {canAct && (
          <Button variant="ghost" icon="rederive" disabled={closed || landed} onClick={() => onRederive(a)}>
            Redo
          </Button>
        )}
      </footer>
    </article>
  );
}

/* ───────────── intent detail ───────────── */

function IntentDetail({ intent }: { intent: Intent }) {
  const now = useNow(15_000);
  const st = useStore((s) => s.state);
  const idx = st ? indexes(st) : null;
  const [amend, setAmend] = useState(false);
  const [park, setPark] = useState(false);
  const [landing, setLanding] = useState<Attempt | null>(null);
  const [rederive, setRederive] = useState<Attempt | null>(null);
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
  // Live previews run Cloudflare Workers apps: main must have src/index.js.
  const preview = useStore((s) => Boolean(s.state?.files.some((f) => f.path === "src/index.js")));

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
        <p className="intent__goal voice-human">{intent.goal.replace(/`/g, "")}</p>
        {canAct && (
          <div className="intent__actions">
            <LaunchButton intent={intent} size="md" variant={n === 0 ? "primary" : "secondary"} />
            <Button icon="amend" onClick={() => setAmend(true)} disabled={intent.status === "landed" || intent.status === "parked"}>
              Change the goal
            </Button>
            <Button variant="ghost" icon="park" onClick={() => setPark(true)} disabled={intent.status === "landed" || intent.status === "parked"}>
              Pause the task
            </Button>
          </div>
        )}
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
                  ? "No work copies yet. Start 1 to 4 agents. Each agent works in its own work copy."
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
            action={canAct ? <LaunchButton intent={intent} size="md" variant="primary" /> : undefined}
          />
        ) : (
          <div className="lanes-scroll">
            <div className={["lanes", !preview && "lanes--nopreview"].filter(Boolean).join(" ")} style={{ "--n": n } as CSSProperties}>
              {attempts.map((a) => (
                <Lane
                  key={a.id}
                  attempt={a}
                  agent={agents.get(a.agentId)}
                  intent={intent}
                  corrections={idx?.correctionsByAttempt.get(a.id) ?? []}
                  checks={idx?.checkById ?? new Map()}
                  names={names}
                  landing={idx?.landingByAttempt.get(a.id)}
                  rederivedFromName={a.lineage.rederivedFrom ? names(a.lineage.rederivedFrom) : undefined}
                  onLand={setLanding}
                  onRederive={setRederive}
                  canAct={canAct}
                  preview={preview}
                  now={now}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      <AmendDialog intent={intent} open={amend} onClose={() => setAmend(false)} />
      <ReasonDialog
        open={park}
        onClose={() => setPark(false)}
        title="Pause the task"
        description="Pausing stops all work copies of this task. gitring keeps them. You can open a new task later."
        label="Reason"
        placeholder="The shop does not sell enough books for a search yet."
        action="Pause the task"
        danger
        onSubmit={async (reason) => {
          await harbor().park(intent.id, reason);
          toast({ tone: "info", title: "Task paused", text: `“${intent.title}” stops. Its work copies stay visible.` });
        }}
      />
      <ReasonDialog
        open={Boolean(landing)}
        onClose={() => setLanding(null)}
        title={`Merge the work of ${landing ? names(landing.id) : ""}`}
        description={`gitring combines the work copy with main ${shortSha(mainSha)}, runs the tests of all merged tasks, then merges it. ${
          n > 1 ? "The other work copies stay as alternatives." : ""
        }`}
        label="Why this work copy?"
        help="Your reason goes into the merge record."
        placeholder="Smaller diff. The search form stays out of the header."
        action="Merge"
        onSubmit={async (reason) => {
          if (!landing) return;
          const res = await harbor().land(landing.id, reason);
          if (res.landing) {
            toast({
              tone: "clear",
              title: `Merged into main ${shortSha(res.landing.mainAfter)}`,
              text: `“${intent.title}” · ${METHOD_TEXT[res.landing.method] ?? res.landing.method}.`,
              action: { label: "Read the merge record", onClick: () => navigate(`/history/${res.landing!.id}`) },
            });
          } else {
            toast({ tone: "info", title: "Redo scheduled", text: res.message ?? "The work copy does not merge cleanly with main." });
          }
        }}
      >
        {landing?.checks && <EvidenceBar run={landing.checks} label="Alone" showFailures={false} />}
      </ReasonDialog>
      <ReasonDialog
        open={Boolean(rederive)}
        onClose={() => setRederive(null)}
        title={`Redo the work of ${rederive ? names(rederive.id) : ""}`}
        description="A new work copy starts from the task on the current main. The old work copy stays as an alternative. Give a reason, so that the agent knows what to change."
        label="What is wrong with this work copy?"
        placeholder="The toggle hides the search field on small screens."
        action="Redo on the new main"
        onSubmit={async (reason) => {
          if (!rederive) return;
          const res = await harbor().rederive(rederive.id, reason);
          toast({ tone: "info", title: "Redo started", text: `${names(res.attempt.id)} sends a new plan.` });
        }}
      />
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
            <p className="page__lede">A task is the source of the work: a goal and the tests that prove it. Select a task to compare its work copies.</p>
          </div>
        )}
      </div>
    </div>
  );
}
