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
import { ago, modelShort, plural, shortSha } from "../state/format";
import { useStore } from "../state/store";
import { useCanAct } from "../state/account";
import { byId, indexes, selectIntentGroups } from "../state/selectors";
import "./intents.css";

const SOURCE_TEXT: Record<Intent["source"]["kind"], string> = {
  ui: "the chart",
  mcp: "MCP",
  webhook: "a webhook",
  seed: "the seed",
  sim: "the simulation",
};

function sourceText(i: Intent): string {
  const ref = i.source.ref ?? "";
  if (ref.startsWith("github")) return `GitHub issue ${ref.split("#")[1] ? "#" + ref.split("#")[1] : ""}`.trim();
  if (ref.startsWith("linear")) return `Linear ${ref.split(":")[1] ?? ""}`.trim();
  if (ref.startsWith("slack")) return "Slack /bearing";
  return SOURCE_TEXT[i.source.kind];
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
      <Field label={label} help={help} error={tried && !reason.trim() ? "Write the reason. The logbook keeps it." : undefined}>
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
      toast({ tone: "info", title: `Intent amended to v${intent.version + 1}`, text: "Active attempts get a correction with the new text." });
      onClose();
    } catch (e) {
      toast({ tone: "danger", title: "The amendment failed", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Amend intent"
      description={`v${intent.version} → v${intent.version + 1}. Bearing keeps every version. Active attempts get the change as a correction.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="amend" busy={busy} onClick={submit}>
            Amend intent
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
      <Field label="Reason" error={tried && !reason.trim() ? "Write the reason. The amendments timeline shows it." : undefined}>
        <Textarea voice="human" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Long result lists are slow on phones." />
      </Field>
    </Dialog>
  );
}

/* ───────────── living spec ───────────── */

function LivingSpec({ intent, now }: { intent: Intent; now: number }) {
  const versions = [
    { version: 1, at: intent.createdAt, by: intent.createdBy, reason: `Opened from ${sourceText(intent)}.`, text: "" },
    ...intent.amendments,
  ].reverse();
  return (
    <section className="spec" aria-labelledby="spec-title">
      <h2 className="spec__title" id="spec-title">
        Living spec <span className="voice-agent ink-3">v{intent.version}</span>
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
  now: number;
}

function Lane({ attempt: a, agent, intent, corrections, checks, names, landing, rederivedFromName, onLand, onRederive, canAct, now }: LaneProps) {
  const callsign = agent?.callsign ?? a.agentId;
  const alternate = a.status === "alternate" || a.status === "abandoned" || (a.status === "stale" && intent.status === "landed");
  const landed = a.status === "landed";
  const canLand = a.status === "ready";
  const closed = intent.status === "landed" || intent.status === "parked";
  const [doc, setDoc] = useState<{ src: string | null }>({ src: null });

  useEffect(() => {
    const load = () => {
      const h = harborOrNull();
      if (!h) return;
      setDoc({ src: h.previewUrl(a.id) });
    };
    load();
    return onHarbor(load);
    // Rebuild the preview when the attempt writes files.
  }, [a.id, a.stats.steps, a.status]);

  const style = { "--vc": `var(--v${(agent?.color ?? 0) % 12})` } as CSSProperties;
  return (
    <article
      className={["lane", alternate && "is-alternate", landed && "is-landed", canLand && "is-ready"].filter(Boolean).join(" ")}
      style={style}
      aria-label={`Attempt ${callsign}: ${a.status}`}
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
              {rederivedFromName ? ` · re-derived from ${rederivedFromName}` : ""}
            </span>
          )}
          <span className="ink-3">base {shortSha(a.baseSha)}</span>
        </div>
        {alternate && <p className="lane__note">Alternate. Bearing keeps it with its preview and its diff.</p>}
        {a.drift && !landed && !alternate && (
          <p className="lane__note lane__note--drift">
            <Icon name="rederive" size={14} />
            Main moved to <span className="voice-agent">{shortSha(a.drift.mainSha)}</span>. {a.drift.overlaps.join(", ")} overlap{a.drift.overlaps.length > 1 ? "" : "s"} the
            landed change. If you pick this attempt, Bearing re-derives it on the new main.
          </p>
        )}
        {landed && landing && (
          <p className="lane__note lane__note--landed">
            <Icon name="anchor" size={14} />
            Landed on main <span className="voice-agent">{shortSha(landing.mainAfter)}</span> with <MethodBadge method={landing.method} />{" "}
            <Link to={`/logbook/${landing.id}`}>Read the why</Link>
          </p>
        )}
      </header>

      <section className="lane__sec lane__evidence" aria-label="Checks">
        <h3 className="lane__h">Checks</h3>
        <EvidenceBar run={a.checks} checking={a.status === "checking" || a.status === "submitted"} pending={intent.checks.length * 4} label="Alone" />
        {a.composedChecks && <EvidenceBar run={a.composedChecks} label="Composed with main" showFailures />}
        {(a.composedChecks?.log ?? a.checks?.log) && (
          <details className="lane__log">
            <summary>Output of the check container</summary>
            <pre className="voice-agent">{(a.composedChecks?.log ?? a.checks?.log ?? "").slice(-4000)}</pre>
          </details>
        )}
      </section>

      <section className="lane__sec lane__preview" aria-label="Live preview">
        <h3 className="lane__h">
          Live preview <span className="ink-3">· the attempt's real code</span>
        </h3>
        {doc.src ? (
          <PreviewFrame title={callsign} src={doc.src} height={300} />
        ) : (
          <div className="lane__nopreview">The preview starts when the attempt has a fork.</div>
        )}
      </section>

      <section className="lane__sec" aria-label="Files changed">
        <h3 className="lane__h">
          Files <span className="ink-3 voice-agent">+{a.stats.additions} −{a.stats.deletions}</span>
        </h3>
        <FileList attempt={a} />
      </section>

      <section className="lane__sec" aria-label="Course">
        <h3 className="lane__h">Course</h3>
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

      <section className="lane__sec" aria-label="Corrections received">
        <h3 className="lane__h">
          Corrections <span className="ink-3 voice-agent">{corrections.length}</span>
        </h3>
        {corrections.length === 0 ? (
          <p className="ink-3 lane__empty">No corrections. The course stayed clear.</p>
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
            title={canLand ? undefined : "Only a ready attempt can land."}
          >
            Land attempt
          </Button>
        )}
        <Button icon="diff" onClick={() => openDiff(a.id, callsign)}>
          Open diff
        </Button>
        {canAct && (
          <Button variant="ghost" icon="rederive" disabled={closed || landed} onClick={() => onRederive(a)}>
            Re-derive
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

  return (
    <article className="intent" aria-labelledby="intent-title">
      <header className="intent__head">
        <div className="intent__crumbs">
          <Link to="/intents" className="backlink">
            <Icon name="arrow-left" size={14} />
            Intents
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
              Amend intent
            </Button>
            <Button variant="ghost" icon="park" onClick={() => setPark(true)} disabled={intent.status === "landed" || intent.status === "parked"}>
              Park intent
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
              <p className="ink-3">No constraints yet. Humans and corrections add them.</p>
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
              Checks <span className="voice-agent ink-3">{intent.checks.length}</span>
            </h2>
            <ul className="checklist">
              {intent.checks.map((c) => {
                const cases = [...c.content.matchAll(/\btest\(\s*"((?:[^"\\]|\\.)+)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
                return (
                  <li key={c.id}>
                    <div className="checklist__head">
                      <Icon name="check" size={14} />
                      <span className="voice-agent">{c.path}</span>
                      <span className="ink-3">{plural(cases.length, "case")}</span>
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
            {n === 0 ? "Attempts" : n === 1 ? "1 attempt" : `Compare ${n} attempts`}
          </h2>
          <p className="compare__help">
            {intent.status === "judging"
              ? `${ready.length} attempts are ready. Compare the evidence and the previews. Land one. The others stay as alternates.`
              : intent.status === "landed"
                ? pick
                  ? `${pick.by.name} picked ${names(pick.attemptIds[0])}: “${pick.rationale}”`
                  : "Bearing landed the attempt that passed its checks. Alternates stay below."
                : n === 0
                  ? "No attempts yet. Launch 1 to 4 attempts. Each runs in its own fork."
                  : "Attempts run in their own forks. Bearing checks every course against all traffic."}
          </p>
        </div>
        {n === 0 ? (
          <EmptyState
            text={canAct ? "Launch attempts to fill the lanes. Each attempt shows its checks, its live preview and its diff." : "No attempts yet. Members launch attempts for this intent."}
            action={canAct ? <LaunchButton intent={intent} size="md" variant="primary" /> : undefined}
          />
        ) : (
          <div className="lanes-scroll">
            <div className="lanes" style={{ "--n": n } as CSSProperties}>
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
        title="Park intent"
        description="Parking stops all attempts of this intent. Bearing keeps them as alternates. You can open a new intent later."
        label="Reason"
        placeholder="The shop does not sell enough books for a search yet."
        action="Park intent"
        danger
        onSubmit={async (reason) => {
          await harbor().park(intent.id, reason);
          toast({ tone: "info", title: "Intent parked", text: `“${intent.title}” stops. Its attempts stay visible.` });
        }}
      />
      <ReasonDialog
        open={Boolean(landing)}
        onClose={() => setLanding(null)}
        title={`Land ${landing ? names(landing.id) : ""}`}
        description={`Bearing composes the attempt with main ${shortSha(mainSha)}, runs every landed check, then lands it. ${
          n > 1 ? "The other attempts stay as alternates." : ""
        }`}
        label="Why this attempt?"
        help="Your reason goes into the logbook with the landing."
        placeholder="Smaller diff. The search form stays out of the header."
        action="Land attempt"
        onSubmit={async (reason) => {
          if (!landing) return;
          const res = await harbor().land(landing.id, reason);
          if (res.landing) {
            toast({
              tone: "clear",
              title: `Landed on main ${shortSha(res.landing.mainAfter)}`,
              text: `“${intent.title}” · ${res.landing.method}. Human merge fixes: 0.`,
              action: { label: "Read the why", onClick: () => navigate(`/logbook/${res.landing!.id}`) },
            });
          } else {
            toast({ tone: "info", title: "Re-derive scheduled", text: res.message ?? "The attempt does not compose with main." });
          }
        }}
      >
        {landing?.checks && <EvidenceBar run={landing.checks} label="Alone" showFailures={false} />}
      </ReasonDialog>
      <ReasonDialog
        open={Boolean(rederive)}
        onClose={() => setRederive(null)}
        title={`Re-derive ${rederive ? names(rederive.id) : ""}`}
        description="A new attempt starts from the intent on the current main. The old attempt stays as an alternate. A re-derive needs a reason: no blind re-rolls."
        label="What is wrong with this attempt?"
        placeholder="The toggle hides the search field on small screens."
        action="Re-derive attempt"
        onSubmit={async (reason) => {
          if (!rederive) return;
          const res = await harbor().rederive(rederive.id, reason);
          toast({ tone: "info", title: "Re-derive started", text: `${names(res.attempt.id)} declares a new course.` });
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
    if (first) navigate(`/intents/${first.id}`, { replace: true });
  }, [id, groups]);

  return (
    <div className={["intents-view", id ? "has-detail" : "no-detail"].join(" ")}>
      <aside className="intents-view__rail" aria-label="Intents">
        <IntentsRail selectedId={id} />
      </aside>
      <div className="intents-view__main">
        {intent ? (
          <IntentDetail key={intent.id} intent={intent} />
        ) : id && exists ? (
          <div className="page">
            <h1 className="page__title" tabIndex={-1}>
              Intent not found
            </h1>
            <EmptyState text="This intent is not in the harbor. The demo harbor may have restarted." action={<Link to="/intents">Show all intents</Link>} />
          </div>
        ) : (
          <div className="page">
            <h1 className="page__title" tabIndex={-1}>
              Intents
            </h1>
            <p className="page__lede">An intent is the source of the work: a goal and the checks that prove it. Select an intent to compare its attempts.</p>
          </div>
        )}
      </div>
    </div>
  );
}
