import { useRef, useState, type KeyboardEvent } from "react";
import { Mark, Icon, type IconName } from "../design/icons";
import { Button, IconButton, Popover, Segmented, Stat, toast } from "../design/components";
import { harbor } from "../state/api";
import { THEMES, setTheme, useTheme, type Theme } from "../design/theme";
import { useStore } from "../state/store";
import { selectJudgmentQueue, type JudgmentItem } from "../state/selectors";
import { int, shortSha } from "../state/format";
import { Link, navigate, type Route } from "./router";

const NAV: { to: string; label: string; icon: IconName; match: Route["name"]; key: string }[] = [
  { to: "/", label: "Chart", icon: "compass", match: "chart", key: "c" },
  { to: "/intents", label: "Intents", icon: "amend", match: "intents", key: "i" },
  { to: "/logbook", label: "Logbook", icon: "logbook", match: "logbook", key: "l" },
  { to: "/connect", label: "Connect", icon: "plug", match: "connect", key: "k" },
  { to: "/sim", label: "Sim", icon: "waves", match: "sim", key: "s" },
  { to: "/design", label: "Design", icon: "grid", match: "design", key: "d" },
];

const EMPTY_Q: JudgmentItem[] = [];

function ViewNav({ route }: { route: Route }) {
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    refs.current[(i + d + NAV.length) % NAV.length]?.focus();
  };
  return (
    <nav aria-label="Views" className="topbar__nav">
      <div className="b-seg">
        {NAV.map((n, i) => (
          <Link
            key={n.to}
            ref={(el) => {
              refs.current[i] = el;
            }}
            to={n.to}
            className="b-seg__opt"
            aria-current={route.name === n.match ? "page" : undefined}
            onKeyDown={(e) => onKey(e, i)}
          >
            <Icon name={n.icon} />
            <span className="topbar__navlabel">{n.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

function Connection() {
  const mode = useStore((s) => s.mode);
  const conn = useStore((s) => s.conn);
  const error = useStore((s) => s.error);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"run" | "script" | "reset" | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  let text = "Connecting";
  let tone = "neutral";
  let help = "Bearing asks the harbor for the project state.";
  if (mode === "mock") {
    text = "Mock harbor";
    tone = "accent";
    help = "The mock harbor runs in this browser with the Saltmarsh Books demo. Start the Worker for live data.";
  } else if (mode === "live" && conn === "open") {
    text = "Live";
    tone = "clear";
    help = "Live events arrive over the WebSocket.";
  } else if (conn === "reconnecting" || conn === "offline") {
    text = conn === "offline" ? "Offline" : "Reconnecting";
    tone = "caution";
    help = error ?? "The live connection dropped. Bearing reconnects.";
  }
  const act = async (kind: "run" | "script" | "reset") => {
    setBusy(kind);
    try {
      if (kind === "run") await harbor().demoRun("llm");
      else if (kind === "script") await harbor().demoRun("scripted");
      else await harbor().demoReset();
      toast({
        tone: "info",
        title: kind === "reset" ? "Demo harbor reset" : "Demo scenario started",
        text: kind === "run" ? "AI agents take 5 to 8 minutes. Watch the chart." : "Watch the chart.",
      });
      setOpen(false);
    } catch (e) {
      toast({ tone: "danger", title: "The demo did not start", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`topbar__conn topbar__conn--${tone}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${text}. Show the harbor connection.`}
        onClick={() => setOpen(!open)}
      >
        <span className="topbar__dot" aria-hidden="true" />
        <span className="topbar__conntext">{text}</span>
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} label="Harbor connection" align="end">
        <div className="harborpop">
          <p className="harborpop__state">
            <span className={`topbar__dot topbar__conn--${tone}`} aria-hidden="true" /> {text}
          </p>
          <p className="harborpop__help">{help}</p>
          <div className="harborpop__actions">
            <Button size="sm" variant="primary" icon="play" busy={busy === "run"} onClick={() => act("run")}>
              Run with AI agents
            </Button>
            <Button size="sm" icon="play" busy={busy === "script"} onClick={() => act("script")}>
              Run scripted
            </Button>
            <Button size="sm" icon="reload" busy={busy === "reset"} onClick={() => act("reset")}>
              Reset demo
            </Button>
          </div>
          <p className="harborpop__note">AI agents use Workers AI models and take 5 to 8 minutes. Scripted vessels take about 1 minute. Offline, both run scripted.</p>
          <p className="harborpop__note">
            {mode === "mock" ? (
              <>
                The mock loop restarts every 100 s until you act. Add <span className="code-inline">?mock=0</span> to the URL to stay on the live harbor.
              </>
            ) : (
              <>
                Add <span className="code-inline">?mock=1</span> to the URL to use the in-browser mock harbor.
              </>
            )}
          </p>
        </div>
      </Popover>
    </>
  );
}

function JudgmentQueue() {
  const queue = useStore((s) => (s.state ? selectJudgmentQueue(s.state) : EMPTY_Q));
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const n = queue.length;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={["topbar__queue", n > 0 && "has-items"].filter(Boolean).join(" ")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        aria-label={n ? `${n} ${n === 1 ? "decision needs" : "decisions need"} a human. Show the judgment queue.` : "No decisions need a human."}
      >
        <Icon name={n ? "lighthouse" : "check"} />
        <span className="topbar__queuetext">{n ? `${n} ${n === 1 ? "decision" : "decisions"}` : "No decisions"}</span>
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} label="Judgment queue" align="end">
        <div className="queue">
          <p className="queue__head">
            {n ? "These decisions need a human. Everything else lands by itself." : "No decisions need a human now. Bearing lands work that passes its checks."}
          </p>
          {queue.map((q) => (
            <Link key={q.key} to={`/intents/${q.intentId}`} className="queue__item" onClick={() => setOpen(false)}>
              <Icon name={q.kind === "pick" ? "lighthouse" : "info"} />
              <span className="queue__text">
                <span className="voice-human queue__title">{q.title}</span>
                <span className="queue__detail">{q.detail}</span>
              </span>
              <Icon name="chevron-right" />
            </Link>
          ))}
        </div>
      </Popover>
    </>
  );
}

function StatsStrip() {
  const stats = useStore((s) => s.state?.stats);
  if (!stats) return <div className="substrip__stats" />;
  return (
    <div className="substrip__stats" role="group" aria-label="Harbor numbers">
      <Stat variant="inline" value={int(stats.courseChecks)} label="course checks" source="Every declare, log, write and push runs a course check. Source: harbor stats." />
      <Stat variant="inline" value={int(stats.clear)} label="clear" source="Course checks with the verdict clear." />
      <Stat variant="inline" value={int(stats.corrections)} label="corrections" source={`Corrections sent to agents. ${stats.correctionsAcknowledged} acknowledged.`} />
      <Stat
        variant="inline"
        value={int(stats.landings)}
        label="landings"
        source={`Fast-forward ${stats.landedByMethod["fast-forward"]} · merge ${stats.landedByMethod.merge} · re-derive ${stats.landedByMethod.rederive}`}
      />
      <Stat
        variant="inline"
        value={int(stats.replots ?? 0)}
        label="re-plots"
        source="Times Bearing moved work in progress onto a new main, so the agent keeps working on current code."
      />
      <Stat variant="inline" value={int(stats.humanMergeFixes)} label="human merge fixes" good={stats.humanMergeFixes === 0} source="Text conflicts a human fixed by hand. Bearing keeps this number at zero." />
    </div>
  );
}

export function TopBar({ route }: { route: Route }) {
  const theme = useTheme();
  const name = useStore((s) => s.state?.project.name ?? "Bearing");
  const sha = useStore((s) => s.state?.project.mainSha);
  const p50 = useStore((s) => s.state?.stats.medianCheckLatencyMs ?? 0);
  return (
    <header className="topbar">
      <div className="topbar__row">
        <a
          className="topbar__brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
          aria-label="Bearing, go to the chart"
        >
          <Mark size={22} />
          <span className="topbar__wordmark">bearing</span>
        </a>
        <div className="topbar__project">
          <span className="topbar__projname">{name}</span>
          <span className="topbar__sha voice-agent" title="main">
            main {shortSha(sha)}
          </span>
        </div>
        <ViewNav route={route} />
        <div className="topbar__right">
          <Connection />
          <JudgmentQueue />
          <IconButton
            className="topbar__themecycle"
            icon={theme}
            label={`Theme: ${THEMES.find((t) => t.id === theme)?.label}. Switch to ${THEMES[(THEMES.findIndex((t) => t.id === theme) + 1) % 3].label}.`}
            onClick={() => setTheme(THEMES[(THEMES.findIndex((t) => t.id === theme) + 1) % 3].id)}
            tooltip={false}
          />
          <Segmented<Theme>
            label="Display theme"
            value={theme}
            onChange={setTheme}
            className="topbar__theme"
            options={THEMES.map((t) => ({
              value: t.id,
              label: <span className="topbar__themelabel">{t.label}</span>,
              icon: t.id,
              ariaLabel: `${t.label}: ${t.help.toLowerCase()}`,
              title: `${t.label} · ${t.help}`,
            }))}
          />
        </div>
      </div>
      <div className="substrip">
        <StatsStrip />
        <div className="substrip__right">
          {p50 > 0 && (
            <span className="substrip__note">
              median check <span className="voice-agent ink-1">{p50} ms</span>
            </span>
          )}
          <button type="button" className="substrip__keys" onClick={() => window.dispatchEvent(new Event("bearing:shortcuts"))}>
            <Icon name="keyboard" size={14} />
            <span>Shortcuts</span>
            <kbd className="b-kbd">?</kbd>
          </button>
        </div>
      </div>
    </header>
  );
}
