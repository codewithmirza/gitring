import { useRef, useState, type KeyboardEvent } from "react";
import { Mark, Icon, type IconName } from "../design/icons";
import { Button, IconButton, Popover, Segmented, Stat, toast } from "../design/components";
import { harbor } from "../state/api";
import { THEMES, setTheme, useTheme, type Theme } from "../design/theme";
import { useStore } from "../state/store";
import { selectJudgmentQueue, type JudgmentItem } from "../state/selectors";
import { int, shortSha } from "../state/format";
import { isProjectRoute, Link, type Route } from "./router";
import { ProjectSwitcher, UserMenu } from "./Account";
import { useCanAct, useIsOwner } from "../state/account";
import { launchAllNow } from "./actions";

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  match: Route["name"];
}

const NAV: NavItem[] = [
  { to: "/overview", label: "Overview", icon: "compass", match: "chart" },
  { to: "/tasks", label: "Tasks", icon: "amend", match: "intents" },
  { to: "/history", label: "History", icon: "logbook", match: "logbook" },
  { to: "/connect", label: "Connect", icon: "plug", match: "connect" },
  // The design page is a development aid: production builds have no route and no tab for it.
  ...(import.meta.env.DEV ? [{ to: "/design", label: "Design", icon: "grid", match: "design" } satisfies NavItem] : []),
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
  const sample = useStore((s) => (s.state?.project.source?.kind ?? "sample") === "sample");
  const canAct = useCanAct();
  const owner = useIsOwner();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"run" | "reset" | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  let text = "Connecting";
  let tone = "neutral";
  let help = "gitring loads the project.";
  if (mode === "live" && conn === "open") {
    text = "Live";
    tone = "clear";
    help = "Live updates arrive over a WebSocket.";
  } else if (conn === "reconnecting" || conn === "offline") {
    text = conn === "offline" ? "Offline" : "Reconnecting";
    tone = "caution";
    help = error ?? "The live connection dropped. gitring reconnects.";
  }
  const act = async (kind: "run" | "reset") => {
    setBusy(kind);
    try {
      if (kind === "run") {
        if (await launchAllNow()) setOpen(false);
        return;
      }
      await harbor().resetSample();
      toast({ tone: "info", title: "Sample project reset", text: "Main is back at the first commit." });
      setOpen(false);
    } catch (e) {
      toast({ tone: "danger", title: "The reset did not finish", text: (e as Error).message });
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
        aria-label={`${text}. Show the connection.`}
        onClick={() => setOpen(!open)}
      >
        <span className="topbar__dot" aria-hidden="true" />
        <span className="topbar__conntext">{text}</span>
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} label="Connection" align="end">
        <div className="harborpop">
          <p className="harborpop__state">
            <span className={`topbar__dot topbar__conn--${tone}`} aria-hidden="true" /> {text}
          </p>
          <p className="harborpop__help">{help}</p>
          {canAct ? (
            <>
              <div className="harborpop__actions">
                <Button size="sm" variant="primary" icon="play" busy={busy === "run"} onClick={() => act("run")}>
                  Start agents on all open tasks
                </Button>
                {sample && owner && (
                  <Button size="sm" icon="reload" busy={busy === "reset"} onClick={() => act("reset")}>
                    Reset the sample
                  </Button>
                )}
              </div>
              <p className="harborpop__note">
                Built-in agents use Workers AI models. They need 5 to 8 minutes for a task. Over the hourly AI budget, new agents wait in a queue and start by
                themselves.
              </p>
            </>
          ) : (
            <p className="harborpop__note">You can view this project. Members can start agents here.</p>
          )}
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
        aria-label={n ? `${n} ${n === 1 ? "decision needs" : "decisions need"} a person. Show the decisions.` : "No decisions need a person."}
      >
        <Icon name={n ? "lighthouse" : "check"} />
        <span className="topbar__queuetext">{n ? `${n} ${n === 1 ? "decision" : "decisions"}` : "No decisions"}</span>
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} label="Decisions" align="end">
        <div className="queue">
          <p className="queue__head">
            {n ? "These decisions need a person. gitring merges all other work by itself." : "No decisions need a person now. gitring merges work when its tests pass."}
          </p>
          {queue.map((q) => (
            <Link key={q.key} to={`/tasks/${q.intentId}`} className="queue__item" onClick={() => setOpen(false)}>
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
    <div className="substrip__stats" role="group" aria-label="Project numbers">
      <Stat variant="inline" value={int(stats.courseChecks)} label="conflict checks" source="Each plan, log, write and push starts a conflict check." />
      <Stat variant="inline" value={int(stats.clear)} label="no conflict" source="Conflict checks that found no conflict." />
      <Stat variant="inline" value={int(stats.corrections)} label="change requests" source={`Change requests sent to agents. ${stats.correctionsAcknowledged} acknowledged.`} />
      <Stat
        variant="inline"
        value={int(stats.landings)}
        label="merges"
        source={`Fast-forward ${stats.landedByMethod["fast-forward"]} · 3-way merge ${stats.landedByMethod.merge} · redo ${stats.landedByMethod.rederive}`}
      />
      <Stat
        variant="inline"
        value={int(stats.replots ?? 0)}
        label="rebases"
        source="Times gitring moved active work onto a new main, so the agent works on current code."
      />
    </div>
  );
}

export function TopBar({ route }: { route: Route }) {
  const theme = useTheme();
  const sha = useStore((s) => s.state?.project.mainSha);
  const ready = useStore((s) => s.state !== null);
  const signedIn = useStore((s) => Boolean(s.me?.user));
  const p50 = useStore((s) => s.state?.stats.medianCheckLatencyMs ?? 0);
  // The start page shows no project; the other pages show one when it is loaded (or loads now).
  const project = route.name !== "home" && (ready || isProjectRoute(route));
  return (
    <header className="topbar">
      <div className="topbar__row">
        <Link className="topbar__brand" to={signedIn ? "/overview" : "/"} aria-label={signedIn ? "gitring, go to the overview" : "gitring, go to the start page"}>
          <Mark size={22} />
          <span className="topbar__wordmark">gitring</span>
        </Link>
        {project && (
          <div className="topbar__project">
            <ProjectSwitcher />
            <span className="topbar__sha voice-agent" title="main">
              main {shortSha(sha)}
            </span>
          </div>
        )}
        {project && <ViewNav route={route} />}
        <div className="topbar__right">
          {project && <Connection />}
          {project && <JudgmentQueue />}
          <UserMenu />
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
      {project && (
        <div className="substrip">
          <StatsStrip />
          <div className="substrip__right">
            {p50 > 0 && (
              <span className="substrip__note">
                median conflict check <span className="voice-agent ink-1">{p50} ms</span>
              </span>
            )}
            <button type="button" className="substrip__keys" onClick={() => window.dispatchEvent(new Event("gitring:shortcuts"))}>
              <Icon name="keyboard" size={14} />
              <span>Shortcuts</span>
              <kbd className="b-kbd">?</kbd>
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
