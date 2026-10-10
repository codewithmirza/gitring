/**
 * One combobox for every source of a new project (WAI-ARIA combobox with a list that is always shown):
 * focus stays in the text field, ↑/↓ move through the rows, Enter picks, Escape closes the panel.
 *
 * Rows: an import row for pasted text (on top), the person's GitHub repositories (filtered at once in
 * memory, then by a server search), and always "Upload a folder", "Push with git", "Empty project".
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { GithubRepo } from "../../../../src/core/accounts";
import { Icon, type IconName } from "../../design/icons";
import { githubConnectUrl, mergeRepos, useDelayedFlag, useRepoSearch } from "../../state/github";
import type { MeWithInstall } from "../../state/account";
import { GithubMark, LockIcon, RepoIcon, SearchIcon } from "./marks";
import { agoIso, rankRepos, readPasted } from "./match";

export type SourceOption =
  | { key: string; kind: "import-github"; repo: string; known?: GithubRepo }
  | { key: string; kind: "import-git"; url: string }
  | { key: string; kind: "repo"; repo: GithubRepo }
  | { key: string; kind: "connect" }
  | { key: string; kind: "install"; url: string }
  | { key: string; kind: "upload" }
  | { key: string; kind: "push" }
  | { key: string; kind: "empty" };

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

const OTHER: { kind: "upload" | "push" | "empty"; icon: IconName; title: string; text: string }[] = [
  { kind: "upload", icon: "launch", title: "Upload a folder", text: "Files from your computer, without the git history. At most 20 MB." },
  { kind: "push", icon: "fork", title: "Push with git", text: "Private repositories from any host. The history comes with it." },
  { kind: "empty", icon: "plus", title: "Empty project", text: "A new repository with a README. Agents write the first files." },
];

export function SourceList({ me, query, onQuery, onPick, returnTo, autoFocus }: SourceListProps) {
  const base = useId().replace(/:/g, "");
  const listId = `${base}-list`;
  const statusId = `${base}-status`;
  const input = useRef<HTMLInputElement | null>(null);
  const [active, setActive] = useState(0);

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

  const repos = useMemo(() => {
    if (!search.base || pasted?.kind === "git" || pasted?.kind === "bad") return [];
    const local = rankRepos(search.base.repos, filter);
    return mergeRepos(local, filter.trim() ? search.found?.repos : undefined);
  }, [search.base, search.found, filter, pasted?.kind]);

  const exact = pasted?.kind === "github" ? repos.find((r) => r.fullName.toLowerCase() === pasted.repo.toLowerCase()) : undefined;
  const shown = repos.slice(0, SHOW);

  const pastedKey = pasted ? JSON.stringify(pasted) : "";
  const options = useMemo(() => {
    const out: SourceOption[] = [];
    if (pasted?.kind === "github" && !exact) out.push({ key: `import:${pasted.repo}`, kind: "import-github", repo: pasted.repo });
    if (pasted?.kind === "git") out.push({ key: `git:${pasted.url}`, kind: "import-git", url: pasted.url });
    if (signedIn && connected === false) out.push({ key: "connect", kind: "connect" });
    for (const r of shown) out.push({ key: `repo:${r.fullName}`, kind: "repo", repo: r });
    if (connected && installUrl && pasted?.kind !== "git" && pasted?.kind !== "bad") out.push({ key: "install", kind: "install", url: installUrl });
    for (const o of OTHER) out.push({ key: o.kind, kind: o.kind });
    return out;
    // `pasted` is rebuilt on each render; its JSON stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedKey, exact, signedIn, connected, shown, installUrl]);

  // A new query starts at the first row.
  useEffect(() => setActive(0), [query]);
  const idx = Math.max(0, Math.min(active, options.length - 1));
  const activeKey = options[idx]?.key;
  const optId = (key: string) => `${base}-o-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  // Only keys scroll the list (a mouse already points at the row; the first render must not move the page).
  const byKey = useRef(false);

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
    if (!n) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move((idx + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move((idx - 1 + n) % n);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      move(Math.min(n - 1, idx + 6));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      move(Math.max(0, idx - 6));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const o = options[idx];
      if (o) pick(o);
    }
  };

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

  const loadingRepos = signedIn && connected !== false && !search.base && !search.error;
  const skeleton = useDelayedFlag(loadingRepos);
  const q = query.trim();

  let ghNote: ReactNode = null;
  if (signedIn && search.error && !search.base) {
    ghNote = (
      <span>
        gitring could not load your repositories. {search.error.message}{" "}
        <button type="button" className="np-linkbtn" onClick={search.reload}>
          Try again
        </button>
      </span>
    );
  } else if (connected && search.base && !search.base.repos.length) {
    ghNote = <span>The GitHub app sees no repositories yet. Add repositories on GitHub.</span>;
  } else if (connected && search.base && q && !repos.length && !pasted && !search.searching) {
    ghNote = (
      <span>
        No repository matches “{q}”. Paste a git URL, or add the repository on GitHub.
      </span>
    );
  }

  const count = connected ? `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}${repos.length > SHOW ? `, ${SHOW} shown` : ""}. ` : "";
  const statusText = loadingRepos ? "gitring loads your repositories." : `${count}${pasted?.kind === "bad" ? pasted.reason : ""}`;

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
  const otherRows = options.filter((o) => o.kind === "upload" || o.kind === "push" || o.kind === "empty");
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
          placeholder={signedIn && connected !== false ? "Search your repositories or paste a git URL" : "Paste a git URL, or choose a source"}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        {search.searching && <span className="np-search__busy" aria-hidden="true" />}
      </div>
      <p id={statusId} className="vh" role="status" aria-live="polite">
        {statusText}
      </p>
      {pasted?.kind === "bad" && (
        <p className="np-hint" role="note">
          <Icon name="info" size={12} /> {pasted.reason}
        </p>
      )}
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
              <span>GitHub{login ? ` · @${login}` : ""}</span>
              {connected && (
                <button type="button" className="np-group__act" onMouseDown={(e) => e.preventDefault()} onClick={search.reload} aria-label="Load the repositories again">
                  <Icon name="reload" size={12} />
                </button>
              )}
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
            {ghNote && <div className="np-note">{ghNote}</div>}
          </div>
        )}

        {/* Always in view at the foot of the list: the sources without GitHub. */}
        <div role="group" aria-labelledby={`${base}-g-other`} className="np-group np-group--dock">
          <div id={`${base}-g-other`} role="presentation" className="np-group__head">
            Other sources
          </div>
          <div className="np-dock" role="presentation">
            {otherRows.map((o) => {
              const d = OTHER.find((x) => x.kind === o.kind)!;
              return row(
                o,
                <>
                  <Icon name={d.icon} className="np-opt__icon" />
                  <span className="np-opt__title">{d.title}</span>
                  <span className="vh">. {d.text}</span>
                </>,
                "np-opt--tile",
                false,
              );
            })}
          </div>
          <p className="np-dock__hint" aria-hidden="true">
            {OTHER.find((x) => x.kind === options[idx]?.kind)?.text ?? "Or start from a folder, a git push, or an empty repository."}
          </p>
        </div>
      </div>
    </div>
  );
}

export function RepoRow({ repo }: { repo: GithubRepo }) {
  const slash = repo.fullName.indexOf("/");
  return (
    <>
      {repo.private ? <LockIcon className="np-opt__icon" /> : <RepoIcon className="np-opt__icon" />}
      <span className="np-opt__main">
        <span className="np-opt__title">
          <span className="voice-agent np-repo">
            <span className="np-repo__owner">{repo.fullName.slice(0, slash + 1)}</span>
            {repo.fullName.slice(slash + 1)}
          </span>
          {repo.private && <span className="np-tag">private</span>}
          {!repo.canPush && <span className="np-tag">read only</span>}
        </span>
        <span className="np-opt__text">
          {[repo.defaultBranch, repo.language, repo.pushedAt && `pushed ${agoIso(repo.pushedAt)}`].filter(Boolean).join(" · ")}
          {repo.description ? <span className="np-opt__desc"> · {repo.description}</span> : null}
        </span>
      </span>
    </>
  );
}
