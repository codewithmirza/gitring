/**
 * The top bar: view tabs, search, connection state, decisions, the inbox button, stats and theme.
 * The view tabs also make the bottom bar on phones. Some words come from ../views/approval-copy.ts.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Attempt } from "../../../src/core/types";
import { Mark, Icon, type IconName } from "../design/icons";
import { Button, IconButton, Popover, Segmented, Stat, rovingKeys, toast, usePopover } from "../design/components";
import { harbor } from "../state/api";
import { THEMES, setTheme, useTheme, type Theme } from "../design/theme";
import { useStore } from "../state/store";
import { indexes, type JudgmentItem, type OtherJudgmentItem } from "../state/selectors";
import { useJudgmentQueue } from "../state/approvals";
import { badgeText, useInboxCount } from "../state/inbox";
import { taskPath } from "../../../src/core/inbox";
import { int, shortSha } from "../state/format";
import { isProjectRoute, Link, navigate, type Route } from "./router";
import { ProjectSwitcher, UserMenu } from "./Account";
import { useCanAct } from "../state/account";
import { launchAllNow } from "./actions";
import { closePalette, openPalette, openShortcuts, setUi, useUi } from "./ui";
import { PALETTE_KEY } from "./keys";
import { ApprovalCard } from "./ApprovalCard";
import { useMaxChips } from "./ApprovalTray";
import { QuestionCard } from "./QuestionCard";
import { landingOf, quietText } from "../views/approval-copy";

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

/* ───────────── view tabs, search and connection ───────────── */

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
  let text = "Not linked yet";
  let tone = "neutral";
  let help = "gitring loads the project.";
  if (mode === "live" && conn === "open") {
    text = "Live";
    tone = "clear";
    help = "Changes arrive at once over a live connection. The page does not ask the server again.";
  } else if (conn === "reconnecting" || conn === "offline") {
    text = conn === "offline" ? "Offline" : "Link lost";
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

/* ───────────── decisions ───────────── */

/** A decision that is not a question for a yes: work that could not merge, a course check that asks, or old work. */
function OtherRow({ item, first, onDone }: { item: OtherJudgmentItem; first: boolean; onDone: () => void }) {
  const st = useStore((s) => s.state);
  const canAct = useCanAct();
  const [busy, setBusy] = useState(false);
  const idx = st ? indexes(st) : null;
  const callsign = (a: Attempt) => idx?.agentById.get(a.agentId)?.callsign ?? a.agentId;

  const attempts = item.attemptIds.map((id) => idx?.attemptById.get(id)).filter((a): a is Attempt => Boolean(a));
  const redo = item.key.startsWith("stuck:") ? attempts[0] : undefined;

  const act = async () => {
    if (!redo) return;
    setBusy(true);
    try {
      await harbor().rederive(redo.id, "Redo on the new main (from the decisions list).");
      toast({ tone: "info", title: "Redo started", text: `${callsign(redo)} does “${item.title}” again on the new main.` });
    } catch (e) {
      toast({ tone: "danger", title: "The redo did not start", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const open = () => {
    onDone();
    navigate(`/tasks/${item.intentId}`);
  };
  const result = redo
    ? `${callsign(redo)} gets the task again on the current main.`
    : item.kind === "pick"
      ? "You merge a work copy on the task page."
      : "A person decides on this work.";
  return (
    <li className="queue__item">
      <div className="queue__text">
        <span className="voice-human queue__title">{item.title}</span>
        <span className="queue__detail">{item.detail}.</span>
      </div>
      <div className="queue__acts">
        {canAct && redo ? (
          <Button size="sm" variant="primary" className="queue__primary" data-row-first="" data-autofocus={first ? "" : undefined} busy={busy} onClick={() => void act()} icon="rederive" aria-describedby={`${item.key}-result`}>
            Redo on the new main
          </Button>
        ) : (
          <Button size="sm" variant="primary" className="queue__primary" data-row-first="" data-autofocus={first ? "" : undefined} onClick={open} icon="arrow-right">
            Open the task
          </Button>
        )}
        {redo && (
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

/**
 * The button of the decisions list. A merge question has its card in the tray and its count on the Inbox button,
 * so the button shows only when it adds something: work that is not a merge question, more questions than the
 * tray shows, a person who only views, and the pages where the tray gives way (the replay and the approve page).
 */
function Decisions({ route }: { route: Route }) {
  const queue = useJudgmentQueue();
  const maxChips = useMaxChips();
  const canAct = useCanAct();
  const projectId = useStore((s) => s.state?.project.id ?? "");
  const mode = useStore((s) => landingOf(s.state?.project.settings));
  const pop = usePopover();
  const { setOpen } = pop;
  // The "+N more" chip of the tray asks to open this list.
  const request = useUi().decisionsRequest;
  const seen = useRef(request);
  useEffect(() => {
    if (request === seen.current) return;
    seen.current = request;
    setOpen(true);
  }, [request, setOpen]);
  // While the list is open, the tray of chips waits: both show the same questions.
  const listOpen = pop.open;
  useEffect(() => {
    setUi({ decisionsOpen: listOpen });
    return () => setUi({ decisionsOpen: false });
  }, [listOpen]);

  // A member decides on the questions that wait for them and on the other items. A question that waits for
  // somebody else is in the list too, but it is not theirs. People who only view see everything as "waits".
  const theirs = (q: JudgmentItem) => (q.kind === "approval" || q.kind === "question" ? q.mayAnswer : true);
  const mine = useMemo(() => (canAct ? queue.filter(theirs) : EMPTY_Q), [queue, canAct]);
  const rest = useMemo(() => (canAct ? queue.filter((q) => !theirs(q)) : queue), [queue, canAct]);
  const rows = useMemo(() => [...mine, ...rest], [mine, rest]);
  const n = canAct ? mine.length : queue.length;
  const w = canAct ? rest.length : 0;
  // The color says "needs you": only for people who can decide (members and owners).
  const needsYou = mine.length > 0;
  const trayShowsAll = canAct && rows.length <= maxChips && rows.every((q) => q.kind === "approval" && q.mayAnswer);
  const quiet = rows.length === 0 || (trayShowsAll && route.name !== "replay" && route.name !== "approve");
  const merges = mine.every((q) => q.kind === "approval");
  const lead = merges ? `${n} ${n === 1 ? "merge waits" : "merges wait"} for you.` : `${n} ${n === 1 ? "decision needs" : "decisions need"} you.`;
  const others = w > 0 ? ` ${w} ${w === 1 ? "waits" : "wait"} for other people.` : "";
  const label =
    n === 0
      ? `No merge waits for you.${others}${others ? " Show the decisions." : ""}`
      : canAct
        ? `${lead}${others} Show the decisions.`
        : `${n} ${n === 1 ? "decision waits" : "decisions wait"} for a member. Show the decisions.`;
  const help =
    rows.length === 0
      ? `No merge waits for you. ${quietText(mode)}`
      : !canAct
        ? `A member of this project says yes.${mode === "ask" ? "" : " gitring merges the other work when its tests pass."}`
        : n === 0
          ? `No merge waits for you.${others}`
          : `${lead}${merges ? " Yes merges the work into main. Send back tells the agent what to change." : ""}${rows.length > 1 ? " J and K move between the decisions." : ""}`;
  if (quiet) return null;
  return (
    <>
      <button
        {...pop.triggerProps}
        type="button"
        className={["topbar__queue", needsYou && "has-items", !canAct && "topbar__queue--watch"].filter(Boolean).join(" ")}
        aria-label={label}
      >
        <Icon name={n ? "lighthouse" : "check"} />
        <span className="topbar__queuetext">{n ? `${n} ${n === 1 ? "decision" : "decisions"}` : `${rows.length} ${rows.length === 1 ? "decision waits" : "decisions wait"} for others`}</span>
        {n > 0 && (
          <span className="topbar__queuecount" aria-hidden="true">
            {n}
          </span>
        )}
      </button>
      <Popover {...pop.popoverProps} label="Decisions" align="end" width={400}>
        <div
          className="queue"
          onKeyDown={(e) => {
            // Letters and arrows belong to a text field (the note for the agent).
            if ((e.target as HTMLElement).closest("textarea, input")) return;
            rovingKeys(e, "[data-row-first]", { down: ["ArrowDown", "j"], up: ["ArrowUp", "k"] });
          }}
        >
          <h2 className="pop-title">Decisions</h2>
          <p className="pop-help">{help}</p>
          {rows.length > 0 && (
            <ol className="queue__list">
              {rows.map((q: JudgmentItem, i) =>
                q.kind === "approval" ? (
                  <li key={q.key} className="queue__item queue__item--approval">
                    <ApprovalCard item={q} variant="row" onOpen={pop.close} focusReview={i === 0} />
                  </li>
                ) : q.kind === "question" ? (
                  <li key={q.key} className="queue__item queue__item--approval">
                    <QuestionCard
                      projectId={projectId}
                      questionId={q.question.id}
                      title={q.title}
                      headline={q.detail}
                      facts={q.question.facts}
                      options={q.question.options.map((o, n) => ({ ...o, primary: n === 0, note: q.question.kind === "escalation" && o.id !== "both" }))}
                      mayAnswer={canAct && q.mayAnswer}
                      to={taskPath(projectId, q.intentId)}
                      variant="row"
                      first={i === 0}
                      onOpen={pop.close}
                    />
                  </li>
                ) : (
                  <OtherRow key={q.key} item={q} first={i === 0} onDone={pop.close} />
                ),
              )}
            </ol>
          )}
        </div>
      </Popover>
    </>
  );
}

/* ───────────── inbox, stats and theme ───────────── */

/** The inbox: what waits for the signed-in person in all projects. The count shows on every page. */
function InboxButton({ route }: { route: Route }) {
  const n = useInboxCount();
  return (
    <Link
      to="/inbox"
      className={["topbar__queue", "topbar__inbox", n > 0 && "has-items"].filter(Boolean).join(" ")}
      aria-current={route.name === "inbox" ? "page" : undefined}
      aria-label={n ? `Inbox: ${n} ${n === 1 ? "thing waits" : "things wait"} for you` : "Inbox: nothing waits for you"}
      title="Inbox (g i)"
    >
      <Icon name="inbox" />
      <span className="topbar__queuetext">Inbox</span>
      {n > 0 && (
        <span className="topbar__queuecount" aria-hidden="true">
          {badgeText(n)}
        </span>
      )}
    </Link>
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
        source={`Fast-forward ${stats.landedByMethod["fast-forward"]} · 3-way merge ${stats.landedByMethod.merge} · redo ${stats.landedByMethod.rederive}${stats.landedByMethod.revert ? ` · reverted ${stats.landedByMethod.revert}` : ""}${stats.trains ? ` · trains ${stats.trains}` : ""}`}
      />
      <Stat variant="inline" value={int(stats.replots ?? 0)} label="rebases" source="Times gitring moved active work onto a new main, so the agent works on current code." />
    </div>
  );
}

/** The theme control. On a phone the cycle button shows only for a person who has no account menu and no project name on the bar. */
function ThemeControl({ spare }: { spare: boolean }) {
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
      <IconButton className={["topbar__themecycle", spare && "topbar__themecycle--spare"].filter(Boolean).join(" ")} icon={theme} label={`Theme: ${THEMES[i]?.label}. Switch to ${next.label}.`} onClick={() => setTheme(next.id)} tooltip={false} />
      <Segmented<Theme> label="Display theme" value={theme} onChange={setTheme} className="topbar__theme" options={options} />
    </>
  );
}

/* ───────────── the top bar ───────────── */

export function TopBar({ route }: { route: Route }) {
  const sha = useStore((s) => s.state?.project.mainSha);
  const ready = useStore((s) => s.state !== null);
  const signedIn = useStore((s) => Boolean(s.me?.user));
  const blocked = useStore((s) => s.conn === "blocked");
  const offline = useStore((s) => s.conn === "offline");
  const known = useStore((s) => s.projects.some((p) => p.id === s.projectId));
  const p50 = useStore((s) => s.state?.stats.medianCheckLatencyMs ?? 0);
  // The start page shows no project. A project page shows its bar parts only when the project has loaded, and the
  // view tabs while it loads. A page that the server refused (no sign-in, no access, no such project) shows none.
  const onApp = route.name !== "home";
  const loaded = onApp && ready;
  const chrome = loaded || (onApp && isProjectRoute(route) && !blocked);
  const named = loaded || (chrome && known);
  return (
    <header className="topbar">
      <div className="topbar__row">
        <Link className="topbar__brand" to={signedIn ? "/overview" : "/"} aria-label={signedIn ? "gitring, go to the overview" : "gitring, go to the start page"}>
          <Mark size={22} />
          <span className="topbar__wordmark">gitring</span>
        </Link>
        {named && (
          <div className="topbar__project">
            <ProjectSwitcher />
            {loaded && (
              <span className="topbar__sha voice-agent" title="The commit of main">
                main {shortSha(sha)}
              </span>
            )}
          </div>
        )}
        {chrome && <ViewNav route={route} className="viewnav topbar__nav" />}
        <div className="topbar__right">
          <SearchButton />
          {(loaded || (chrome && offline)) && <Connection />}
          {loaded && <Decisions route={route} />}
          {signedIn && <InboxButton route={route} />}
          <UserMenu />
          <ThemeControl spare={signedIn || named} />
        </div>
      </div>
      {chrome && (
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
