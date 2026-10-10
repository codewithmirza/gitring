import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Attempt } from "../../../src/core/types";
import { Mark, Icon, type IconName } from "../design/icons";
import { Button, IconButton, Popover, Segmented, Stat, rovingKeys, toast, usePopover } from "../design/components";
import { harbor } from "../state/api";
import { THEMES, setTheme, useTheme, type Theme } from "../design/theme";
import { useStore } from "../state/store";
import { indexes, selectJudgmentQueue, type JudgmentItem } from "../state/selectors";
import { int, shortSha } from "../state/format";
import { isProjectRoute, Link, navigate, type Route } from "./router";
import { ProjectSwitcher, UserMenu } from "./Account";
import { useCanAct } from "../state/account";
import { launchAllNow } from "./actions";
import { closePalette, openPalette, openShortcuts, useUi } from "./ui";
import { PALETTE_KEY } from "./keys";

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  match: Route["name"];
  keys: string;
}

const NAV: NavItem[] = [
  { to: "/overview", label: "Overview", icon: "compass", match: "chart", keys: "g o" },
  { to: "/tasks", label: "Tasks", icon: "amend", match: "intents", keys: "g t" },
  { to: "/history", label: "History", icon: "logbook", match: "logbook", keys: "g h" },
  { to: "/code", label: "Code", icon: "code", match: "code", keys: "g c" },
  { to: "/connect", label: "Connect", icon: "plug", match: "connect", keys: "g k" },
  // The design page is a development aid: production builds have no route and no tab for it.
  ...(import.meta.env.DEV ? [{ to: "/design", label: "Design", icon: "grid", match: "design", keys: "g d" } satisfies NavItem] : []),
];

const EMPTY_Q: JudgmentItem[] = [];

/** The view tabs. In the top bar on wide screens; as a bottom bar on phones (one hand). */
export function ViewNav({ route, className, label = "Views" }: { route: Route; className: string; label?: string }) {
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    refs.current[(i + d + NAV.length) % NAV.length]?.focus();
  };
  return (
    <nav aria-label={label} className={className}>
      {NAV.map((n, i) => (
        <Link
          key={n.to}
          ref={(el) => {
            refs.current[i] = el;
          }}
          to={n.to}
          className="viewnav__opt"
          aria-current={route.name === n.match ? "page" : undefined}
          title={`${n.label} (${n.keys})`}
          onKeyDown={(e) => onKey(e, i)}
        >
          <Icon name={n.icon} />
          <span className="viewnav__label">{n.label}</span>
        </Link>
      ))}
    </nav>
  );
}

function SearchButton() {
  const { palette } = useUi();
  return (
    <button
      type="button"
      className="topbar__search"
      data-palette-anchor=""
      aria-haspopup="dialog"
      aria-expanded={palette}
      aria-keyshortcuts="Control+K Meta+K /"
      aria-label="Search and commands"
      onClick={() => (palette ? closePalette() : openPalette())}
    >
      <Icon name="search" />
      <span className="topbar__searchtext">Search</span>
      <kbd className="b-kbd topbar__searchkey">{PALETTE_KEY}</kbd>
    </button>
  );
}

function Connection() {
  const mode = useStore((s) => s.mode);
  const conn = useStore((s) => s.conn);
  const error = useStore((s) => s.error);
  const canAct = useCanAct();
  const pop = usePopover();
  const [busy, setBusy] = useState(false);
  let text = "Connecting";
  let tone = "neutral";
  let help = "gitring loads the project.";
  if (mode === "live" && conn === "open") {
    text = "Live";
    tone = "clear";
    help = "Changes arrive at once over a live connection. The page does not ask the server again.";
  } else if (conn === "reconnecting" || conn === "offline") {
    text = conn === "offline" ? "Offline" : "Reconnecting";
    tone = "caution";
    help = error ?? "The live connection dropped. gitring connects again by itself.";
  }
  const run = async () => {
    setBusy(true);
    try {
      if (await launchAllNow()) pop.close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button {...pop.triggerProps} type="button" className={`topbar__conn topbar__conn--${tone}`} aria-label={`${text}. Show the connection.`}>
        <span className="topbar__dot" aria-hidden="true" />
        <span className="topbar__conntext">{text}</span>
      </button>
      <Popover {...pop.popoverProps} label="Connection" align="end" width={320}>
        <div className="harborpop">
          <p className="harborpop__state">
            <span className={`topbar__dot topbar__conn--${tone}`} aria-hidden="true" /> {text}
          </p>
          <p className="harborpop__help">{help}</p>
          {canAct ? (
            <>
              <Button size="sm" variant="primary" icon="play" busy={busy} onClick={() => void run()}>
                Start agents on all open tasks
              </Button>
              <p className="harborpop__note">
                Built-in agents use Workers AI models. They need 5 to 8 minutes for a task. Over the hourly AI budget, new agents wait in a queue and start by
                themselves.
              </p>
            </>
          ) : (
            <p className="harborpop__note">You can view this project. Members start agents here.</p>
          )}
        </div>
      </Popover>
    </>
  );
}

/** The work copy that gitring suggests for a "choose one" decision: tests first, then the smaller diff. */
export function bestReady(attempts: Attempt[]): Attempt | null {
  const ready = attempts.filter((a) => a.status === "ready");
  if (!ready.length) return null;
  const rate = (a: Attempt) => {
    const run = a.composedChecks ?? a.checks;
    return run ? run.passed / Math.max(1, run.passed + run.failed) : 0;
  };
  return [...ready].sort(
    (a, b) =>
      Number(Boolean(b.checks?.ok)) - Number(Boolean(a.checks?.ok)) ||
      rate(b) - rate(a) ||
      a.stats.additions + a.stats.deletions - (b.stats.additions + b.stats.deletions) ||
      a.createdAt - b.createdAt,
  )[0];
}

function DecisionRow({ item, onDone }: { item: JudgmentItem; onDone: () => void }) {
  const st = useStore((s) => s.state);
  const canAct = useCanAct();
  const [busy, setBusy] = useState(false);
  const idx = st ? indexes(st) : null;
  const sync = st?.project.settings.github?.mode ?? "off";
  const callsign = (a: Attempt) => idx?.agentById.get(a.agentId)?.callsign ?? a.agentId;

  const attempts = item.attemptIds.map((id) => idx?.attemptById.get(id)).filter((a): a is Attempt => Boolean(a));
  const pick = item.kind === "pick" ? bestReady(attempts) : null;
  const redo = item.kind === "escalation" && item.key.startsWith("stuck:") ? attempts[0] : undefined;
  const run = pick?.composedChecks ?? pick?.checks;

  const act = async () => {
    setBusy(true);
    try {
      if (pick) {
        const why = `Chosen from the decisions list: ${run ? `${run.passed} of ${run.passed + run.failed} tests pass` : "the tests pass"}, +${pick.stats.additions} −${pick.stats.deletions}.`;
        const res = await harbor().land(pick.id, why);
        toast(
          res.landing
            ? { tone: "clear", title: `Merged into main ${shortSha(res.landing.mainAfter)}`, text: `“${item.title}”.`, action: { label: "Read the merge record", onClick: () => navigate(`/history/${res.landing!.id}`) } }
            : { tone: "info", title: "Redo scheduled", text: res.message ?? "The work copy does not merge cleanly with main. gitring does it again on the new main." },
        );
      } else if (redo) {
        await harbor().rederive(redo.id, "Redo on the new main (from the decisions list).");
        toast({ tone: "info", title: "Redo started", text: `${callsign(redo)} does “${item.title}” again on the new main.` });
      }
    } catch (e) {
      toast({ tone: "danger", title: pick ? "The merge did not start" : "The redo did not start", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const open = () => {
    onDone();
    navigate(`/tasks/${item.intentId}`);
  };
  const label = pick ? `Merge ${callsign(pick)}` : redo ? "Redo on the new main" : "Open the task";
  const result = pick
    ? sync === "pull-request"
      ? "Into main, then into the pull request on GitHub."
      : sync === "main"
        ? "Into main, then to main on GitHub."
        : "Into main."
    : redo
      ? `${callsign(redo)} gets the task again on the current main.`
      : "A person decides on this work.";
  return (
    <li className="queue__item">
      <div className="queue__text">
        <span className="voice-human queue__title">{item.title}</span>
        <span className="queue__detail">
          {item.detail}.
          {pick && run ? ` Suggested: ${callsign(pick)}, ${run.passed} of ${run.passed + run.failed} tests pass, +${pick.stats.additions} −${pick.stats.deletions}.` : ""}
        </span>
      </div>
      <div className="queue__acts">
        {canAct && (pick || redo) ? (
          <Button size="sm" variant="primary" className="queue__primary" busy={busy} onClick={() => void act()} icon={pick ? "anchor" : "rederive"} aria-describedby={`${item.key}-result`}>
            {label}
          </Button>
        ) : (
          <Button size="sm" variant="primary" className="queue__primary" onClick={open} icon="arrow-right">
            Open the task
          </Button>
        )}
        {(pick || redo) && (
          <Link to={`/tasks/${item.intentId}`} className="queue__link" onClick={onDone}>
            Compare
          </Link>
        )}
      </div>
      <span className="queue__result" id={`${item.key}-result`}>
        {result}
      </span>
    </li>
  );
}

function Decisions() {
  const queue = useStore((s) => (s.state ? selectJudgmentQueue(s.state) : EMPTY_Q));
  const pop = usePopover();
  const n = queue.length;
  return (
    <>
      <button
        {...pop.triggerProps}
        type="button"
        className={["topbar__queue", n > 0 && "has-items"].filter(Boolean).join(" ")}
        aria-label={n ? `${n} ${n === 1 ? "decision needs" : "decisions need"} you. Show the decisions.` : "No decisions need you."}
      >
        <Icon name={n ? "lighthouse" : "check"} />
        <span className="topbar__queuetext">{n ? `${n} ${n === 1 ? "decision" : "decisions"}` : "No decisions"}</span>
        {n > 0 && (
          <span className="topbar__queuecount" aria-hidden="true">
            {n}
          </span>
        )}
      </button>
      <Popover {...pop.popoverProps} label="Decisions" align="end" width={400}>
        <div className="queue" onKeyDown={(e) => rovingKeys(e, ".queue__primary", { down: ["ArrowDown", "j"], up: ["ArrowUp", "k"] })}>
          <h2 className="pop-title">Decisions</h2>
          <p className="pop-help">
            {n
              ? "Each decision has one suggested action. Enter runs it; J and K move. gitring merges all other work by itself."
              : "No decisions need you now. gitring merges work when its tests pass."}
          </p>
          {n > 0 && (
            <ol className="queue__list">
              {queue.map((q) => (
                <DecisionRow key={q.key} item={q} onDone={pop.close} />
              ))}
            </ol>
          )}
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
      <Stat variant="inline" value={int(stats.replots ?? 0)} label="rebases" source="Times gitring moved active work onto a new main, so the agent works on current code." />
    </div>
  );
}

function ThemeControl() {
  const theme = useTheme();
  const i = THEMES.findIndex((t) => t.id === theme);
  const next = THEMES[(i + 1) % THEMES.length];
  const options = useMemo(
    () =>
      THEMES.map((t) => ({
        value: t.id,
        label: <span className="topbar__themelabel">{t.label}</span>,
        icon: t.id,
        ariaLabel: `${t.label}: ${t.help.toLowerCase()}`,
        title: `${t.label} · ${t.help}`,
      })),
    [],
  );
  return (
    <>
      <IconButton className="topbar__themecycle" icon={theme} label={`Theme: ${THEMES[i]?.label}. Switch to ${next.label}.`} onClick={() => setTheme(next.id)} tooltip={false} />
      <Segmented<Theme> label="Display theme" value={theme} onChange={setTheme} className="topbar__theme" options={options} />
    </>
  );
}

export function TopBar({ route }: { route: Route }) {
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
            <span className="topbar__sha voice-agent" title="The commit of main">
              main {shortSha(sha)}
            </span>
          </div>
        )}
        {project && <ViewNav route={route} className="viewnav topbar__nav" />}
        <div className="topbar__right">
          <SearchButton />
          {project && <Connection />}
          {project && <Decisions />}
          <UserMenu />
          <ThemeControl />
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
            <button type="button" className="substrip__keys" data-shortcuts-anchor="" aria-haspopup="dialog" onClick={(e) => openShortcuts(e.currentTarget)}>
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
