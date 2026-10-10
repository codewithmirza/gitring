/**
 * A GitHub repository field with a list of the person's repositories (WAI-ARIA combobox with a popup
 * listbox). Typing filters the list; ↓ opens it; Enter picks; Escape closes it, then puts the saved
 * value back. The person can also type "owner/name" or a github.com URL.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { GithubRepo } from "../../../../src/core/accounts";
import { githubRepoName } from "../../../../src/core/repo-rules";
import { Icon } from "../../design/icons";
import type { MeWithInstall } from "../../state/account";
import { githubConnectUrl, mergeRepos, useDelayedFlag, useRepoSearch } from "../../state/github";
import { GithubMark } from "./marks";
import { rankRepos } from "./match";
import { RepoRow } from "./SourceList";
import "./newproject.css";

type Opt = { key: string; kind: "repo"; repo: GithubRepo } | { key: string; kind: "typed"; repo: string } | { key: string; kind: "connect" } | { key: string; kind: "install"; url: string };

interface RepoSelectProps {
  id: string;
  value: string;
  onChange: (repo: string) => void;
  me: MeWithInstall | null;
  /** The page that "Connect GitHub" comes back to. */
  returnTo: string;
  disabled?: boolean;
  describedBy?: string;
  invalid?: boolean;
  /** The repository from the list, when the person picks one (for push rights and privacy). */
  onRepoInfo?: (repo: GithubRepo | null) => void;
}

export function RepoSelect({ id, value, onChange, me, returnTo, disabled, describedBy, invalid, onRepoInfo }: RepoSelectProps) {
  const uid = useId().replace(/:/g, "");
  const listId = `${uid}-list`;
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => setText(value), [value]);

  const known = me?.github;
  const skip = known?.connected === false || !me?.user;
  const typing = text.trim() !== value.trim();
  const query = typing ? text : "";
  const search = useRepoSearch(query, used && !skip);
  const connected = skip ? false : search.base ? search.base.connected : (known?.connected ?? null);
  const installUrl = search.base?.installUrl ?? me?.githubInstallUrl ?? undefined;

  const typed = githubRepoName(text);
  const repos = useMemo(() => {
    if (!search.base) return [];
    const q = typed ?? query;
    return mergeRepos(rankRepos(search.base.repos, q), q.trim() ? search.found?.repos : undefined).slice(0, 30);
  }, [search.base, search.found, typed, query]);

  // Tell the page about the chosen repository (push rights, privacy) when the list knows it.
  const current = search.base?.repos.find((r) => r.fullName.toLowerCase() === value.toLowerCase()) ?? null;
  useEffect(() => {
    onRepoInfo?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const options = useMemo(() => {
    const out: Opt[] = [];
    if (me?.user && connected === false) out.push({ key: "connect", kind: "connect" });
    if (typed && !repos.some((r) => r.fullName.toLowerCase() === typed.toLowerCase())) out.push({ key: `typed:${typed}`, kind: "typed", repo: typed });
    for (const r of repos) out.push({ key: `repo:${r.fullName}`, kind: "repo", repo: r });
    if (connected && installUrl) out.push({ key: "install", kind: "install", url: installUrl });
    return out;
  }, [me?.user, connected, typed, repos, installUrl]);

  useEffect(() => setActive(0), [text, open]);
  const idx = Math.max(0, Math.min(active, options.length - 1));
  const optId = (key: string) => `${uid}-o-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const activeKey = open ? options[idx]?.key : undefined;
  useEffect(() => {
    if (activeKey) document.getElementById(optId(activeKey))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const loading = used && !skip && !search.base && !search.error;
  const skeleton = useDelayedFlag(loading && open);

  const commit = (repo: string) => {
    setText(repo);
    setOpen(false);
    if (repo !== value) onChange(repo);
  };
  const pick = (o: Opt) => {
    if (o.kind === "connect") {
      location.href = githubConnectUrl(returnTo);
      return;
    }
    if (o.kind === "install") {
      window.open(o.url, "_blank", "noopener");
      return;
    }
    commit(o.kind === "repo" ? o.repo.fullName : o.repo);
  };
  const settle = () => {
    // Leaving the field keeps a valid name, clears the link for empty text, and puts the value back otherwise.
    const t = text.trim();
    if (!t) commit("");
    else if (typed) commit(typed);
    else setText(value);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = options.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setUsed(true);
      if (!open) {
        setOpen(true);
        return;
      }
      if (n) setActive(e.key === "ArrowDown" ? (idx + 1) % n : (idx - 1 + n) % n);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      if (open && n && options[idx]) {
        e.preventDefault();
        pick(options[idx]);
      } else if (typing) {
        e.preventDefault();
        settle();
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      } else if (typing) {
        e.preventDefault();
        e.stopPropagation();
        setText(value);
      }
    }
  };

  return (
    <div className="np-select">
      <div className="np-select__field">
        <GithubMark size={14} className="np-select__mark" />
        <input
          ref={input}
          id={id}
          className="b-input voice-agent np-select__input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeKey ? optId(activeKey) : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          placeholder="owner/name"
          value={text}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => setUsed(true)}
          onClick={() => {
            setUsed(true);
            setOpen(true);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setUsed(true);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={settle}
        />
        <button
          type="button"
          className="np-select__toggle"
          tabIndex={-1}
          aria-label={open ? "Hide the repositories" : "Show the repositories"}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setUsed(true);
            setOpen(!open);
            input.current?.focus();
          }}
        >
          <Icon name={open ? "chevron-up" : "chevron-down"} size={14} />
        </button>
      </div>
      <div id={listId} role="listbox" aria-label="Your GitHub repositories" className="np-select__pop" hidden={!open}>
        {open && skeleton && (
          <div className="np-opt np-opt--skeleton" aria-hidden="true">
            <span className="np-skel np-skel--icon" />
            <span className="np-opt__main">
              <span className="np-skel" style={{ width: "50%" }} />
            </span>
          </div>
        )}
        {open &&
          options.map((o, i) => (
            <div
              key={o.key}
              id={optId(o.key)}
              role="option"
              aria-selected={i === idx}
              className={["np-opt", i === idx && "is-active", o.kind === "install" && "np-opt--quiet"].filter(Boolean).join(" ")}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== idx && setActive(i)}
              onClick={() => pick(o)}
            >
              {o.kind === "repo" ? (
                <RepoRow repo={o.repo} />
              ) : o.kind === "typed" ? (
                <>
                  <GithubMark className="np-opt__icon" />
                  <span className="np-opt__main">
                    <span className="np-opt__title">
                      Use <span className="voice-agent">{o.repo}</span>
                    </span>
                    <span className="np-opt__text">The gitring GitHub App must be on this repository.</span>
                  </span>
                </>
              ) : o.kind === "connect" ? (
                <>
                  <GithubMark className="np-opt__icon" />
                  <span className="np-opt__main">
                    <span className="np-opt__title">Connect GitHub</span>
                    <span className="np-opt__text">{known?.reason ?? "See your repositories here. GitHub sends you back to this page."}</span>
                  </span>
                </>
              ) : (
                <>
                  <Icon name="plus" className="np-opt__icon" />
                  <span className="np-opt__main">
                    <span className="np-opt__title">
                      Add repositories on GitHub <Icon name="external" size={12} className="np-opt__ext" />
                    </span>
                  </span>
                </>
              )}
            </div>
          ))}
        {open && search.error && !search.base && <div className="np-note">gitring could not load your repositories. {search.error.message}</div>}
        {open && connected && search.base && !repos.length && !typed && <div className="np-note">No repository matches. Type owner/name.</div>}
      </div>
    </div>
  );
}
