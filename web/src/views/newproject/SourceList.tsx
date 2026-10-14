/**
 * The person's GitHub repositories, the last group of the new-project picker.
 * GitHub is one import among others. The list is a WAI-ARIA combobox that is always shown: focus stays in the text field,
 * ↑/↓ move through the rows, Enter picks, Escape closes the panel.
 *
 * Rows: an import row for pasted text (on top: a GitHub repository, or any https git URL), then the repositories
 * (filtered in memory; a server search only when GitHub had more than the list).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { GithubRepo } from "../../../../src/core/accounts";
import { Icon } from "../../design/icons";
import { githubConnectUrl, mergeRepos, useDelayedFlag, useRepoSearch } from "../../state/github";
import type { MeWithInstall } from "../../state/account";
import { GithubMark, SearchIcon } from "./marks";
import { rankRepos, readPasted } from "./match";
import { RepoRow } from "./RepoRow";

/* ───────────── types and constants ───────────── */

export type SourceOption =
  | { key: string; kind: "import-github"; repo: string; known?: GithubRepo }
  | { key: string; kind: "import-git"; url: string }
  | { key: string; kind: "repo"; repo: GithubRepo }
  | { key: string; kind: "connect" }
  | { key: string; kind: "install"; url: string };

/** At most this many repositories show at once (type to find others). */
const SHOW = 40;

interface SourceListProps {
  me: MeWithInstall | null;
  query: string;
  onQuery: (q: string) => void;
  onPick: (o: SourceOption) => void;
  /** Where GitHub sends the person back after "Connect GitHub" (the query is added). */
  returnTo: string;
  autoFocus?: boolean;
}

/* ───────────── the list ───────────── */

export function SourceList({ me, query, onQuery, onPick, returnTo, autoFocus }: SourceListProps) {
  const base = useId().replace(/:/g, "");
  const listId = `${base}-list`;
  const statusId = `${base}-status`;
  const input = useRef<HTMLInputElement | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const signedIn = Boolean(me?.user);
  const known = me?.github;
  // A person whose GitHub connection is off needs no repository request: the list shows "Connect GitHub".
  const skip = known?.connected === false;
  const search = useRepoSearch(query, signedIn && !skip);
  const connected: boolean | null = skip ? false : search.base ? search.base.connected : (known?.connected ?? null);
  const login = known?.login;
  const installUrl = search.base?.installUrl ?? me?.githubInstallUrl ?? undefined;
  const reason = (skip ? known?.reason : search.base?.reason) ?? undefined;

  const pasted = readPasted(query);
  const filter = pasted?.kind === "github" ? pasted.repo : pasted ? "" : query;
  // Accounts (the GitHub App installations): chips filter the list when there is more than one.
  const [owner, setOwner] = useState<string | null>(null);
  const accounts = useMemo(() => {
    const fromServer = (search.base?.installations ?? []).map((i) => ({ name: i.account, count: i.repos }));
    if (fromServer.length) return fromServer;
    const counts = new Map<string, number>();
    for (const r of search.base?.repos ?? []) {
      const o = r.fullName.split("/")[0];
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  }, [search.base]);

  const repos = useMemo(() => {
    if (!search.base || pasted?.kind === "git" || pasted?.kind === "bad") return [];
    const own = owner && !pasted ? (r: GithubRepo) => r.fullName.toLowerCase().startsWith(`${owner.toLowerCase()}/`) : () => true;
    const local = rankRepos(search.base.repos.filter(own), filter);
    return mergeRepos(local, filter.trim() ? search.found?.repos.filter(own) : undefined);
  }, [search.base, search.found, filter, pasted?.kind, owner]);

  const exact = pasted?.kind === "github" ? repos.find((r) => r.fullName.toLowerCase() === pasted.repo.toLowerCase()) : undefined;
  const shown = repos.slice(0, SHOW);

  const pastedKey = pasted ? JSON.stringify(pasted) : "";
  const options = useMemo(() => {
    const out: SourceOption[] = [];
    if (pasted?.kind === "github" && !exact) out.push({ key: `import:${pasted.repo}`, kind: "import-github", repo: pasted.repo });
    if (pasted?.kind === "git") out.push({ key: `git:${pasted.url}`, kind: "import-git", url: pasted.url });
    if (signedIn && connected === false) out.push({ key: "connect", kind: "connect" });
    for (const r of shown) out.push({ key: `repo:${r.fullName}`, kind: "repo", repo: r });
    // "Add repositories on GitHub" ends the list once it has loaded.
    if (search.base?.connected && installUrl && pasted?.kind !== "git" && pasted?.kind !== "bad") out.push({ key: "install", kind: "install", url: installUrl });
    return out;
    // `pasted` is rebuilt on each render; its JSON stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedKey, exact, signedIn, connected, shown, installUrl, search.base?.connected]);

  const loadingRepos = signedIn && connected !== false && !search.base && !search.error;
  // The active row: null follows the list (the first repository or import row); keys and the mouse pick one.
  // While the repositories load, no row is active, so an early Enter waits for them.
  const lead = options.findIndex((o) => o.kind === "repo" || o.kind === "import-github" || o.kind === "import-git" || o.kind === "connect");
  const auto = lead >= 0 ? lead : loadingRepos ? -1 : 0;
  const idx = active === null ? auto : Math.max(0, Math.min(active, options.length - 1));
  const activeKey = idx >= 0 ? options[idx]?.key : undefined;
  const optId = (key: string) => `${base}-o-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  // Only keys scroll the list (a mouse already points at the row; the first render must not move the page).
  const byKey = useRef(false);
  const [queued, setQueued] = useState(false);

  // A new query or account starts at the first row again.
  useEffect(() => setActive(null), [query, owner]);

  useEffect(() => {
    if (!activeKey || !byKey.current) return;
    byKey.current = false;
    document.getElementById(optId(activeKey))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const move = (to: number) => {
    byKey.current = true;
    setActive(to);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = options.length;
    // No rows yet: Enter still waits for the repositories (the list has no other rows now).
    if (!n && !(e.key === "Enter" && loadingRepos)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(idx < 0 ? 0 : (idx + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(idx < 0 ? n - 1 : (idx - 1 + n) % n);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      move(Math.min(n - 1, Math.max(0, idx) + 6));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      move(Math.max(0, idx - 6));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const o = idx >= 0 ? options[idx] : undefined;
      if (o) pick(o);
      else if (loadingRepos) setQueued(true);
    }
  };

  // Enter while the repositories loaded: pick the first match when they arrive.
  useEffect(() => {
    if (!queued || loadingRepos) return;
    setQueued(false);
    if (lead >= 0) pick(options[lead]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, loadingRepos]);

  const pick = (o: SourceOption) => {
    if (o.kind === "connect") {
      const back = query.trim() ? `${returnTo}${returnTo.includes("?") ? "&" : "?"}q=${encodeURIComponent(query.trim())}` : returnTo;
      location.href = githubConnectUrl(back);
      return;
    }
    if (o.kind === "install") {
      // A new tab keeps this panel; the list loads again when the person comes back.
      window.open(o.url, "_blank", "noopener");
      return;
    }
    if (o.kind === "repo") {
      onPick({ ...o });
      return;
    }
    onPick(exact && o.kind === "import-github" ? { key: o.key, kind: "repo", repo: exact } : o);
  };

  const skeleton = useDelayedFlag(loadingRepos);
  const q = query.trim();

  let ghNote: ReactNode = null;
  if (signedIn && search.error && !search.base && search.error.status === 401) {
    ghNote = (
      <span>
        Your sign-in ended.{" "}
        <a className="np-linkbtn" href={githubConnectUrl(returnTo)}>
          Sign in again
        </a>
      </span>
    );
  } else if (signedIn && search.error && !search.base) {
    ghNote = (
      <span>
        gitring could not load your repositories. {search.error.message}{" "}
        <button type="button" className="np-linkbtn" onClick={search.reload}>
          Try again
        </button>
      </span>
    );
  } else if (connected && search.base && !search.base.repos.length) {
    ghNote = <span>{search.base.reason ?? "The GitHub app sees no repositories yet. Add repositories on GitHub."}</span>;
  } else if (connected && search.base && q && !repos.length && !pasted && !search.searching) {
    ghNote = (
      <span>
        No repository matches “{q}”. Paste a git URL, or add the repository on GitHub.
      </span>
    );
  }

  // The live region says what changed for the person: the import row, a reason, or the number of repositories.
  const statusText = loadingRepos
    ? "gitring loads your repositories."
    : pasted?.kind === "bad"
      ? pasted.reason
      : pasted?.kind === "git"
        ? `Import ${pasted.url.replace(/^https:\/\//, "")}. Press Enter.`
        : pasted?.kind === "github" && !exact
          ? `Import github.com/${pasted.repo}. Press Enter.`
          : connected
            ? `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}${repos.length > SHOW ? `, ${SHOW} shown` : ""}.`
            : "";

  const row = (o: SourceOption, body: ReactNode, extra?: string, hint = true) => {
    const i = options.indexOf(o);
    const on = i === idx;
    return (
      <div
        key={o.key}
        id={optId(o.key)}
        role="option"
        aria-selected={on}
        className={["np-opt", extra, on && "is-active"].filter(Boolean).join(" ")}
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={() => {
          if (!on) setActive(i);
        }}
        onClick={() => pick(o)}
      >
        {body}
        {on && hint && (
          <kbd className="b-kbd np-opt__enter" aria-hidden="true">
            Enter
          </kbd>
        )}
      </div>
    );
  };

  const importRows = options.filter((o) => o.kind === "import-github" || o.kind === "import-git");
  const repoRows = options.filter((o) => o.kind === "repo" || o.kind === "connect" || o.kind === "install");
  const showGithubGroup = signedIn && pasted?.kind !== "git" && pasted?.kind !== "bad";

  return (
    <div className="np-src">
      <div className="np-search">
        <SearchIcon size={15} className="np-search__icon" />
        <input
          ref={input}
          data-autofocus
          className="np-search__input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeKey ? optId(activeKey) : undefined}
          aria-describedby={statusId}
          aria-label="Search your repositories or paste a git URL"
          placeholder={signedIn && connected !== false ? "Search your repositories or paste a git URL" : "Paste a git URL"}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        {search.searching || search.loading ? (
          <span className="np-search__busy" aria-hidden="true" />
        ) : (
          connected && (
            <button type="button" className="np-search__act" onMouseDown={(e) => e.preventDefault()} onClick={search.reload} aria-label="Read the repositories from GitHub again" title="Read the repositories from GitHub again">
              <Icon name="reload" size={14} />
            </button>
          )
        )}
      </div>
      <p id={statusId} className="vh" role="status" aria-live="polite">
        {statusText}
      </p>
      {pasted?.kind === "bad" && (
        <p className="np-hint" role="note">
          <Icon name="info" size={12} /> {pasted.reason}
        </p>
      )}
      {connected && !pasted && accounts.length > 1 && (
        <div className="np-chips" role="group" aria-label="Show the repositories of one account">
          <button type="button" className="np-chip" aria-pressed={owner === null} onMouseDown={(e) => e.preventDefault()} onClick={() => setOwner(null)}>
            All accounts
          </button>
          {accounts.map((a) => (
            <button
              key={a.name}
              type="button"
              className="np-chip"
              aria-pressed={owner === a.name}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOwner(owner === a.name ? null : a.name)}
            >
              {a.name} <span className="np-chip__n">{a.count}</span>
            </button>
          ))}
        </div>
      )}
      {/* Notes stay outside the listbox: a listbox holds options and groups only. */}
      {ghNote && <div className="np-note np-note--top">{ghNote}</div>}
      <div id={listId} role="listbox" aria-label="Sources" className="np-list">
        {importRows.length > 0 && (
          <div role="group" aria-labelledby={`${base}-g-text`} className="np-group">
            <div id={`${base}-g-text`} role="presentation" className="np-group__head">
              From your text
            </div>
            {importRows.map((o) =>
              row(
                o,
                o.kind === "import-github" ? (
                  <>
                    <GithubMark className="np-opt__icon" />
                    <span className="np-opt__main">
                      <span className="np-opt__title">
                        Import <span className="voice-agent">github.com/{o.repo}</span>
                      </span>
                      <span className="np-opt__text">gitring reads the repository and guesses the test commands.</span>
                    </span>
                  </>
                ) : o.kind === "import-git" ? (
                  <>
                    <Icon name="launch" className="np-opt__icon" />
                    <span className="np-opt__main">
                      <span className="np-opt__title">
                        Import <span className="voice-agent">{o.url.replace(/^https:\/\//, "")}</span>
                      </span>
                      <span className="np-opt__text">A public repository. The history comes with it.</span>
                    </span>
                  </>
                ) : null,
              ),
            )}
          </div>
        )}

        {showGithubGroup && (
          <div role="group" aria-labelledby={`${base}-g-gh`} className="np-group">
            <div id={`${base}-g-gh`} role="presentation" className="np-group__head">
              <GithubMark size={12} />
              <span>GitHub</span>
              {login && <span>@{login}</span>}
            </div>
            {skeleton &&
              [0, 1, 2].map((i) => (
                <div key={i} className="np-opt np-opt--skeleton" aria-hidden="true">
                  <span className="np-skel np-skel--icon" />
                  <span className="np-opt__main">
                    <span className="np-skel" style={{ width: `${46 - i * 8}%` }} />
                    <span className="np-skel np-skel--thin" style={{ width: `${70 - i * 10}%` }} />
                  </span>
                </div>
              ))}
            {repoRows.map((o) =>
              o.kind === "connect"
                ? row(
                    o,
                    <>
                      <GithubMark className="np-opt__icon" />
                      <span className="np-opt__main">
                        <span className="np-opt__title">{known?.login ? "Connect GitHub again" : "Connect GitHub"}</span>
                        <span className="np-opt__text">{reason ?? "See your repositories here, private ones too. GitHub sends you back to this list."}</span>
                      </span>
                    </>,
                    "np-opt--lead",
                  )
                : o.kind === "install"
                  ? row(
                      o,
                      <>
                        <Icon name="plus" className="np-opt__icon" />
                        <span className="np-opt__main">
                          <span className="np-opt__title">
                            Add repositories on GitHub <Icon name="external" size={12} className="np-opt__ext" />
                          </span>
                          <span className="np-opt__text">Opens GitHub in a new tab. This list loads again when you come back.</span>
                        </span>
                      </>,
                      "np-opt--quiet",
                    )
                  : o.kind === "repo"
                    ? row(o, <RepoRow repo={o.repo} />)
                    : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}
