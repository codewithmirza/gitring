/**
 * The command palette: jump to projects, tasks, agents, files and pages, or run an action.
 * Open it with Ctrl+K or ⌘K, or with the "/" key. It is a popover under the Search button (a sheet on phones), not a modal.
 * It searches what the page already has in memory. It sends no request while you type.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Popover, toast } from "../design/components";
import { Icon, type IconName } from "../design/icons";
import { setTheme, THEMES } from "../design/theme";
import { useStore } from "../state/store";
import { selectVessels, type VesselModel } from "../state/selectors";
import type { FileNode, Intent } from "../../../src/core/types";
import { INTENT_STATUS_TEXT, ATTEMPT_STATUS_TEXT } from "../state/format";
import { openProject, signOut } from "../state/account";
import { atLeast } from "../../../src/core/accounts";
import { codeHref, href, navigate } from "./router";
import { closePalette, openNewIntent, openShortcuts, openSignIn, useUi } from "./ui";
import { copyMcpUrl, launchAllNow } from "./actions";
import { pushRecent, rank, readRecent, type PaletteEntry } from "./palette";
import { MOD } from "./keys";

interface Item extends PaletteEntry {
  icon: IconName;
  shortcut?: string;
  /** An app path: Ctrl+Enter opens it in a new tab. */
  to?: string;
  run: () => void;
}

function go(to: string) {
  return () => navigate(to);
}

const NO_INTENTS: Intent[] = [];
const NO_FILES: FileNode[] = [];
const NO_VESSELS: VesselModel[] = [];

/**
 * The entries come from narrow slices of the store (tasks, files, agents), so a live event that changes
 * something else (a log line, a check) does not rebuild them while the palette is open.
 */
function useEntries(): Item[] {
  const me = useStore((s) => s.me);
  const projects = useStore((s) => s.projects);
  const hasState = useStore((s) => s.state !== null);
  const intents = useStore((s) => s.state?.intents ?? NO_INTENTS);
  const files = useStore((s) => s.state?.files ?? NO_FILES);
  const vessels = useStore((s) => (s.state ? selectVessels(s.state) : NO_VESSELS));
  const access = useStore((s) => s.access);
  const projectId = useStore((s) => s.projectId);

  const base = useMemo(() => {
    const signedIn = Boolean(me?.user);
    const canAct = atLeast(access, "member");
    const owner = atLeast(access, "owner");
    const st = hasState;
    const out: Item[] = [];
    const cmd = (key: string, title: string, icon: IconName, run: () => void, extra: Partial<Item> = {}) =>
      out.push({ key: `cmd:${key}`, group: "Commands", title, icon, run, ...extra });

    if (st && canAct) cmd("new-task", "New task", "plus", () => openNewIntent(), { shortcut: "n", keywords: "write add create intent" });
    if (signedIn) cmd("new-project", "New project", "folder", go("/projects?new=1"), { keywords: "import repository github upload create", to: "/projects?new=1" });
    else cmd("new-project", "New project", "folder", () => openSignIn({ reason: "Sign in to make a project.", then: { kind: "newProject" } }), { keywords: "import repository github" });
    // The Connect page belongs to a project; without one, the start page shows the connector steps.
    const connectTo = st || projectId ? "/connect" : "/?home#home-connect";
    cmd("connect", "Connect an agent", "plug", go(connectTo), { keywords: "mcp claude cursor codex connector oauth", to: connectTo });
    cmd("copy-mcp", "Copy the MCP URL", "copy", () => void copyMcpUrl(), { keywords: "mcp connector url claude", hint: `${location.origin}/mcp` });
    if (signedIn) cmd("new-key", "Create an API key", "key", go("/account#keys"), { keywords: "token bearer script hook", to: "/account#keys" });
    if (st && canAct) cmd("launch-all", "Start agents on all open tasks", "play", () => void launchAllNow(), { keywords: "run launch built-in" });
    if (st && owner) cmd("invite", "Invite a member", "human", go("/settings"), { keywords: "member role people share", to: "/settings" });
    cmd("shortcuts", "Show the keyboard shortcuts", "keyboard", () => openShortcuts(document.querySelector<HTMLElement>("[data-palette-anchor]")), { shortcut: "?" });
    for (const t of THEMES) cmd(`theme-${t.id}`, `Theme: ${t.label}`, t.id, () => setTheme(t.id), { hint: t.help, keywords: "color dark light mode" });
    if (signedIn) cmd("sign-out", "Sign out", "sign-out", () => void signOut(), { keywords: "log out leave" });
    else cmd("sign-in", "Sign in", "human", () => openSignIn(), { keywords: "log in github google account" });

    const page = (to: string, title: string, icon: IconName, shortcut?: string, hint?: string) =>
      out.push({ key: `page:${to}`, group: "Pages", title, icon, shortcut, hint, to, run: go(to) });
    if (st || projectId) {
      page("/overview", "Overview", "compass", "g o", "the map of active work");
      page("/tasks", "Tasks", "amend", "g t");
      page("/history", "History", "logbook", "g h", "merges and why");
      page("/code", "Code", "code", "g c", "files of main and of each work copy");
      page("/replay", "Replay", "play", undefined, "the history on the map, step by step");
      page("/connect", "Connect", "plug", "g k");
      if (canAct) page("/settings", "Project settings", "gear", undefined, "name, members, tests, GitHub");
    }
    page("/projects", "Projects", "grid", "g p");
    if (signedIn) page("/account", "Account", "human", "g a", "sign-ins, API keys, connected apps");
    page("/?home", "About gitring", "info");

    for (const p of projects) {
      out.push({
        key: `project:${p.id}`,
        group: "Projects",
        title: p.name,
        hint: [p.role, p.visibility].filter(Boolean).join(" · "),
        keywords: p.id,
        icon: "anchor",
        run: () => openProject(p.id),
      });
    }
    return out;
  }, [me, projects, hasState, access, projectId]);

  const tasks = useMemo(
    () =>
      intents.map(
        (i): Item => ({ key: `task:${i.id}`, group: "Tasks", title: i.title, hint: INTENT_STATUS_TEXT[i.status], keywords: i.goal.slice(0, 160), icon: "amend", to: `/tasks/${i.id}`, run: go(`/tasks/${i.id}`) }),
      ),
    [intents],
  );
  const agents = useMemo(
    () =>
      vessels.map(
        (v): Item => ({
          key: `agent:${v.attemptId}`,
          group: "Agents",
          title: v.callsign,
          hint: `${ATTEMPT_STATUS_TEXT[v.status]} · ${v.intentTitle}`,
          keywords: `${v.model} ${v.client ?? ""}`,
          icon: "compass",
          to: `/overview?v=${v.attemptId}`,
          run: go(`/overview?v=${encodeURIComponent(v.attemptId)}`),
        }),
      ),
    [vessels],
  );
  const fileItems = useMemo(
    () =>
      files.map((f): Item => {
        const to = codeHref("main", f.path);
        return { key: `file:${f.path}`, group: "Files", title: f.path, icon: "file", to, run: go(to) };
      }),
    [files],
  );
  return useMemo(() => [...base, ...tasks, ...agents, ...fileItems], [base, tasks, agents, fileItems]);
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>;
  const set = new Set(hits);
  const parts: ReactNode[] = [];
  let run = "";
  let on = false;
  const flush = (k: number) => {
    if (!run) return;
    parts.push(on ? <mark key={k}>{run}</mark> : <span key={k}>{run}</span>);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

/** The Search button in the top bar (the visible one). Read at open time, so that the panel opens in the same frame. */
function paletteAnchor(): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>("[data-palette-anchor]")];
  return all.find((el) => el.getClientRects().length > 0) ?? all[0] ?? null;
}

export function CommandPalette() {
  const { palette, paletteQuery } = useUi();
  // Found in render (not in an effect): keys typed right after Ctrl+K must reach the input.
  const anchor = useMemo(() => (palette ? paletteAnchor() : null), [palette]);
  if (!palette || !anchor) return null;
  return <PalettePanel anchor={anchor} initial={paletteQuery} />;
}

function PalettePanel({ anchor, initial }: { anchor: HTMLElement; initial: string }) {
  const entries = useEntries();
  const [query, setQuery] = useState(initial);
  const [active, setActive] = useState(0);
  const recent = useMemo(() => readRecent(), []);
  const sections = useMemo(() => rank(query, entries, recent), [query, entries, recent]);
  const flat = useMemo(() => sections.flatMap((s) => s.items.map((r) => r.item)), [sections]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uid = useId();
  const optId = (i: number) => `${uid}-opt-${i}`;

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`#${CSS.escape(optId(active))}`)?.scrollIntoView({ block: "nearest" });
    // optId only depends on uid
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const run = (item: Item | undefined, newTab = false) => {
    if (!item) return;
    pushRecent(item.key);
    if (newTab && item.to) {
      window.open(href(item.to), "_blank", "noopener");
      return;
    }
    closePalette();
    // Run after the panel closes, so that focus and navigation do not fight.
    requestAnimationFrame(() => {
      try {
        item.run();
      } catch (e) {
        toast({ tone: "danger", title: "The command did not run", text: (e as Error).message });
      }
    });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 8));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 8));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(flat[active], e.metaKey || e.ctrlKey);
    }
  };

  let index = -1;
  const empty = query.trim() && !flat.length;
  return (
    <Popover anchor={anchor} open onClose={closePalette} label="Search and commands" width={620} align="end" className="palette-pop" initialFocus={inputRef}>
      <div className="palette">
        <div className="palette__field">
          <Icon name="search" />
          <input
            ref={inputRef}
            className="palette__input"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${uid}-list`}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? optId(active) : undefined}
            aria-label="Search projects, tasks, agents, files and commands"
            placeholder="Search, or type > for commands"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="b-kbd palette__esc">Esc</kbd>
        </div>
        <div className="palette__list" id={`${uid}-list`} role="listbox" aria-label="Results" ref={listRef}>
          {empty ? (
            <p className="palette__empty" role="status">
              No match for “{query.trim()}”. Type <kbd className="b-kbd">&gt;</kbd> for commands.
            </p>
          ) : (
            sections.map((s) => (
              <div key={s.group} role="group" aria-labelledby={`${uid}-g-${s.group}`} className="palette__group">
                <div id={`${uid}-g-${s.group}`} className="palette__grouplabel" role="presentation">
                  {s.group}
                </div>
                {s.items.map(({ item, hits }) => {
                  index++;
                  const i = index;
                  const it = item as Item;
                  return (
                    <div
                      key={it.key}
                      id={optId(i)}
                      role="option"
                      aria-selected={i === active}
                      className={["palette__opt", i === active && "is-active"].filter(Boolean).join(" ")}
                      onMouseMove={() => i !== active && setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => run(it, e.metaKey || e.ctrlKey)}
                    >
                      <Icon name={it.icon} />
                      <span className="palette__text">
                        <span className={it.group === "Files" || it.group === "Agents" ? "palette__title voice-agent" : it.group === "Tasks" ? "palette__title voice-human" : "palette__title"}>
                          <Highlight text={it.title} hits={hits} />
                        </span>
                        {it.hint && <span className="palette__hint">{it.hint}</span>}
                      </span>
                      {it.shortcut && (
                        <span className="palette__keys" aria-hidden="true">
                          {it.shortcut.split(" ").map((k) => (
                            <kbd key={k} className="b-kbd">
                              {k}
                            </kbd>
                          ))}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <p className="palette__foot" aria-hidden="true">
          <span>
            <kbd className="b-kbd">↑</kbd>
            <kbd className="b-kbd">↓</kbd> move
          </span>
          <span>
            <kbd className="b-kbd">Enter</kbd> open
          </span>
          <span className="palette__wide">
            <kbd className="b-kbd">{MOD}</kbd>
            <kbd className="b-kbd">Enter</kbd> new tab
          </span>
          <span className="palette__wide">
            <kbd className="b-kbd">&gt;</kbd> commands <kbd className="b-kbd">#</kbd> tasks <kbd className="b-kbd">@</kbd> agents <kbd className="b-kbd">/</kbd> files
          </span>
        </p>
      </div>
    </Popover>
  );
}
