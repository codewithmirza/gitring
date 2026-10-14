/**
 * The account parts of the shell: the project switcher, the person menu, the sign-in panel and the view-only banner.
 * Each one is a popover that grows from its button. There are no modal dialogs.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ProjectInfo, Provider, SignInKind } from "../../../src/core/accounts";
import { Button, Input, Menu, MenuItem, MenuSeparator, Popover, SkeletonRows, usePopover } from "../design/components";
import { Icon } from "../design/icons";
import { GitHubMark, GoogleG } from "../design/brand/marks";
import { THEMES, setTheme, useTheme } from "../design/theme";
import { useStore } from "../state/store";
import { openProject, signOut, useCanAct, useMe } from "../state/account";
import { githubSignInUrl, googleSignInUrl, orderedProviders } from "../state/signin";
import { createAccountWithPasskey, passkeyErrorText, passkeysWork, signInWithPasskey } from "../state/passkey";
import { Link, linkProps, navigate } from "./router";
import { openSignIn, rememberAfterSignIn, setUi, useUi } from "./ui";
import { fuzzyScore } from "./palette";

const SOURCE_TEXT: Record<string, string> = { empty: "started empty", git: "imported", github: "GitHub", upload: "uploaded folder", push: "git push" };

function sourceText(p: ProjectInfo): string {
  if (p.source.kind === "github") return p.source.repo;
  return SOURCE_TEXT[p.source.kind] ?? "project";
}

/* ───────────── project switcher ───────────── */

export function ProjectSwitcher() {
  const projects = useStore((s) => s.projects);
  const name = useStore((s) => s.state?.project.name ?? projects.find((p) => p.id === s.projectId)?.name ?? "gitring");
  const pop = usePopover("dialog");
  return (
    <>
      <button {...pop.triggerProps} type="button" className="acct-switch" aria-label={`Project: ${name}. Switch project.`}>
        <span className="topbar__projname">{name}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      <Popover {...pop.popoverProps} label="Switch project" align="start" width={340}>
        <ProjectPicker onDone={pop.close} />
      </Popover>
    </>
  );
}

function ProjectPicker({ onDone }: { onDone: () => void }) {
  const projects = useStore((s) => s.projects);
  const current = useStore((s) => s.projectId);
  const canAct = useCanAct();
  const signedIn = Boolean(useMe()?.user);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const uid = useId();
  const list = useMemo(() => {
    const mine = [...projects].sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : 0));
    if (!q.trim()) return mine;
    return mine
      .map((p) => ({ p, m: fuzzyScore(q, `${p.name} ${p.id}`) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .map((x) => x.p);
  }, [projects, current, q]);
  useEffect(() => setActive(0), [q]);

  const open = (p: ProjectInfo | undefined) => {
    if (!p) return;
    onDone();
    if (p.id !== current) openProject(p.id);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (list.length ? (a + 1) % list.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (list.length ? (a - 1 + list.length) % list.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(list[active]);
    }
  };
  return (
    <div className="pick">
      <div className="pick__field">
        <Icon name="search" size={14} />
        <input
          className="pick__input"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${uid}-list`}
          aria-activedescendant={list.length ? `${uid}-${active}` : undefined}
          aria-label="Find a project"
          placeholder="Find a project"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          data-autofocus
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="pick__list" role="listbox" id={`${uid}-list`} aria-label="Projects">
        {list.length === 0 && (
          <p className="pick__empty" role="status">
            {projects.length ? `No project matches “${q.trim()}”.` : "No projects yet."}
          </p>
        )}
        {list.map((p, i) => (
          <div
            key={p.id}
            id={`${uid}-${i}`}
            role="option"
            aria-selected={i === active}
            className={["pick__opt", i === active && "is-active", p.id === current && "is-current"].filter(Boolean).join(" ")}
            onMouseMove={() => i !== active && setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open(p)}
          >
            <Icon name={p.source.kind === "github" || p.source.kind === "git" ? "fork" : "anchor"} />
            <span className="pick__text">
              <span className="pick__name">{p.name}</span>
              <span className="pick__meta">
                {sourceText(p)} · {p.visibility}
                {p.role ? ` · ${p.role}` : ""}
              </span>
            </span>
            {p.id === current && <Icon name="check" className="pick__check" title="Open now" />}
          </div>
        ))}
      </div>
      <div className="pick__actions">
        {canAct && (
          <Link to="/settings" className="pick__action" onClick={onDone}>
            <Icon name="gear" /> Project settings
          </Link>
        )}
        <Link to="/projects" className="pick__action" onClick={onDone}>
          <Icon name="grid" /> All projects
        </Link>
        {signedIn ? (
          <Link to="/projects?new=1" className="pick__action" onClick={onDone}>
            <Icon name="plus" /> New project
          </Link>
        ) : (
          <button
            type="button"
            className="pick__action"
            onClick={(e) => {
              onDone();
              openSignIn({ anchor: document.querySelector<HTMLElement>("[data-signin-anchor]") ?? e.currentTarget, reason: "Sign in to make a project.", then: { kind: "newProject" } });
            }}
          >
            <Icon name="human" /> Sign in to make a project
          </button>
        )}
      </div>
    </div>
  );
}

/* ───────────── person menu ───────────── */

export function UserMenu() {
  const me = useMe();
  const ui = useUi();
  const pop = usePopover("menu");
  const signInBtn = useRef<HTMLButtonElement | null>(null);
  if (!me) return <span className="acct-me acct-me--wait" aria-hidden="true" />;
  if (!me.user) {
    return (
      <Button
        ref={signInBtn}
        size="sm"
        variant="primary"
        data-signin-anchor=""
        aria-haspopup="dialog"
        aria-expanded={ui.signIn}
        onClick={(e) => (ui.signIn ? setUi({ signIn: false }) : openSignIn({ anchor: e.currentTarget }))}
      >
        Sign in
      </Button>
    );
  }
  const u = me.user;
  const passkeys = u.passkeys ? (u.passkeys === 1 ? "1 passkey" : `${u.passkeys} passkeys`) : null;
  const ids = [...u.identities.map((i) => (i.provider === "github" ? `GitHub @${i.login}` : `Google ${i.email}`)), passkeys].filter(Boolean).join(" · ");
  return (
    <>
      <button {...pop.triggerProps} type="button" className="acct-me" aria-label={`Signed in as ${u.name}. Open the account menu.`}>
        {u.avatar ? <img className="acct-me__avatar" src={u.avatar} alt="" width={24} height={24} referrerPolicy="no-referrer" /> : <Icon name="human" />}
      </button>
      <Menu anchor={pop.anchor} open={pop.open} onClose={pop.close} id={pop.id} label="Account" align="end" width={280}>
        <div className="acct-menu__who" role="presentation">
          <span className="acct-menu__name">{u.name}</span>
          <span className="acct-menu__meta">
            {ids}
            {u.admin ? " · administrator" : ""}
          </span>
        </div>
        <MenuSeparator />
        <MenuItem icon="human" shortcut="g a" {...linkProps("/account")}>
          Account
        </MenuItem>
        <MenuItem icon="grid" shortcut="g p" {...linkProps("/projects")}>
          Projects
        </MenuItem>
        <MenuItem icon="plug" {...linkProps("/connect")}>
          Connect an agent
        </MenuItem>
        <MenuItem icon="info" {...linkProps("/?home")}>
          About gitring
        </MenuItem>
        {u.admin && (
          <MenuItem icon="gear" href="/setup">
            Sign-in setup
          </MenuItem>
        )}
        <ThemeChoices />
        <MenuSeparator />
        <MenuItem icon="sign-out" onSelect={() => void signOut()}>
          Sign out
        </MenuItem>
      </Menu>
    </>
  );
}

/** Day, Dusk and Night in the account menu. A phone has no theme control in the bar, so it shows only there (see accounts.css). */
function ThemeChoices() {
  const theme = useTheme();
  return (
    <div className="acct-menu__themes" role="presentation">
      <MenuSeparator />
      <div role="group" aria-label="Theme">
        <div className="acct-menu__label" aria-hidden="true">
          Theme
        </div>
        {THEMES.map((t) => (
          <MenuItem key={t.id} icon={t.id} checked={theme === t.id} keepOpen onSelect={() => setTheme(t.id)}>
            {t.label}
          </MenuItem>
        ))}
      </div>
    </div>
  );
}

/* ───────────── sign-in ───────────── */

const LAST_KEY = "gitring.lastProvider";
const PROVIDER_NAME: Record<Provider, string> = { github: "GitHub", google: "Google" };

/**
 * The way of the last sign-in in this browser: the server's cookie "gitring_last" (set when a sign-in
 * finishes), else the way that the person chose last here.
 */
export function lastProvider(): SignInKind | null {
  try {
    const m = /(?:^|;\s*)gitring_last=(github|google|passkey)\b/.exec(document.cookie);
    if (m) return m[1] as SignInKind;
    const v = localStorage.getItem(LAST_KEY);
    return v === "github" || v === "google" || v === "passkey" ? v : null;
  } catch {
    return null;
  }
}

function rememberLast(kind: SignInKind) {
  try {
    localStorage.setItem(LAST_KEY, kind);
  } catch {
    /* storage off */
  }
}

/**
 * The sign-in choices. Passkeys come first: they need no outside account. Then the providers that this
 * gitring has (real provider marks, the last used first). A provider choice is a link (it leaves for the
 * provider) and shows "Please wait…" until the page changes. A passkey sign-in loads `returnTo` again
 * (default: this page), so the app starts signed in, like after a provider.
 */
export function SignInChoices({ reason, error, returnTo }: { reason?: string | null; error?: string | null; returnTo?: string }) {
  const me = useMe();
  const ui = useUi();
  const [busy, setBusy] = useState<SignInKind | "create" | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const nameId = useId();
  useEffect(() => {
    // Back from the provider (the page comes from the back-forward cache): the choices work again.
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(null);
    };
    addEventListener("pageshow", reset);
    return () => removeEventListener("pageshow", reset);
  }, []);
  const last = lastProvider();
  if (!me) return <SkeletonRows rows={2} label="Please wait for the sign-in choices" />;
  const ordered = orderedProviders(me.providers, last);
  const back = returnTo ?? location.pathname + location.search;
  const canPasskey = passkeysWork();
  const chose = (p: Provider) => {
    setBusy(p);
    rememberLast(p);
    rememberAfterSignIn(ui.signInThen);
  };
  const signedIn = () => {
    rememberLast("passkey");
    rememberAfterSignIn(ui.signInThen);
    location.assign(back);
  };
  const withPasskey = async (kind: "passkey" | "create", run: () => Promise<unknown>) => {
    setBusy(kind);
    setProblem(null);
    try {
      await run();
      signedIn();
    } catch (e) {
      setProblem(passkeyErrorText(e));
      setBusy(null);
    }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setProblem("Give your name. Other people in your projects see it.");
    void withPasskey("create", () => createAccountWithPasskey(name.trim()));
  };
  return (
    <div className="signin">
      {reason && <p className="pop-help">{reason}</p>}
      {error && (
        <p className="signin__error" role="alert">
          <Icon name="cross" size={14} />
          <span>{error}</span>
        </p>
      )}
      <div className="signin__buttons">
        <button
          type="button"
          className="b-provider"
          onClick={() => void withPasskey("passkey", signInWithPasskey)}
          aria-busy={busy === "passkey" || undefined}
          disabled={!canPasskey || busy !== null}
          data-autofocus=""
        >
          <Icon name="key" size={18} />
          <span className="b-provider__text">{busy === "passkey" ? "Confirm on your device…" : "Sign in with a passkey"}</span>
          {last === "passkey" && ordered.length > 0 && <span className="b-provider__tag">Last used</span>}
        </button>
        {creating ? (
          <form className="signin__create" onSubmit={create}>
            <label className="b-field__label" htmlFor={nameId}>
              Your name
            </label>
            <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" autoFocus aria-describedby={`${nameId}-help`} />
            <span className="b-field__help" id={`${nameId}-help`}>
              Other people in your projects see this name. Your device keeps the passkey.
            </span>
            <span className="signin__row">
              <Button type="submit" size="sm" variant="primary" busy={busy === "create"}>
                Create the account
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </span>
          </form>
        ) : (
          <button type="button" className="b-provider" onClick={() => setCreating(true)} disabled={!canPasskey || busy !== null}>
            <Icon name="plus" size={18} />
            <span className="b-provider__text">Create an account with a passkey</span>
          </button>
        )}
      </div>
      {problem && (
        <p className="signin__error" role="alert">
          <Icon name="cross" size={14} />
          <span>{problem}</span>
        </p>
      )}
      {!canPasskey && <p className="signin__none">This browser cannot use passkeys. Use another browser{ordered.length ? " or another sign-in" : ""}.</p>}
      {ordered.length > 0 && (
        <>
          <p className="signin__or">or</p>
          <div className="signin__buttons">
            {ordered.map((p) => (
              <a
                key={p}
                className="b-provider"
                href={p === "github" ? githubSignInUrl(back) : googleSignInUrl(back)}
                aria-busy={busy === p || undefined}
                onClick={(e) => {
                  // A new tab or window keeps this page as it is.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  chose(p);
                }}
              >
                {p === "github" ? <GitHubMark size={18} /> : <GoogleG size={18} />}
                <span className="b-provider__text">{busy === p ? "Please wait…" : `Continue with ${PROVIDER_NAME[p]}`}</span>
                {p === last && <span className="b-provider__tag">Last used</span>}
              </a>
            ))}
          </div>
        </>
      )}
      <p className="signin__note">
        gitring keeps your name, and your email and avatar when a provider sends them. gitring never posts for you. <a href="/privacy">Privacy</a> ·{" "}
        <a href="/terms">Terms</a>
      </p>
    </div>
  );
}

/** The sign-in panel: a popover from the button that asked for it (or from "Sign in" in the top bar). */
/** A visible element to anchor a shell popover: the asked one, else the first visible match of `selector`. */
export function visibleAnchor(asked: HTMLElement | null | undefined, selector: string): HTMLElement | null {
  if (asked && asked.isConnected && asked.getClientRects().length > 0) return asked;
  return [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.getClientRects().length > 0) ?? null;
}

export function SignInPopover() {
  const ui = useUi();
  const me = useMe();
  const signedIn = Boolean(me?.user);
  const anchor = useMemo(() => (ui.signIn ? visibleAnchor(ui.signInAnchor, "[data-signin-anchor], [data-palette-anchor]") : null), [ui.signIn, ui.signInAnchor]);
  useEffect(() => {
    if (ui.signIn && signedIn) setUi({ signIn: false });
  }, [ui.signIn, signedIn]);
  if (!ui.signIn || !anchor || signedIn) return null;
  return (
    <Popover anchor={anchor} open onClose={() => setUi({ signIn: false })} labelledBy="signin-title" align="end" width={340}>
      <h2 className="pop-title" id="signin-title">
        Sign in to gitring
      </h2>
      <SignInChoices reason={ui.signInReason ?? "Sign in to make projects, write tasks and connect your agents."} error={ui.signInError} />
    </Popover>
  );
}

/* ───────────── "you can only view" banner ───────────── */

/** Shown when the caller can only view the open project. */
export function WatchBanner() {
  const me = useMe();
  const canAct = useCanAct();
  const ready = useStore((s) => s.state !== null);
  if (!ready || canAct || !me) return null;
  return (
    <div className="acct-watch" role="status">
      <Icon name="eye" />
      <span>{me.user ? "You can view this project. To change it, ask an owner for the member role, or make your own project." : "You can view this project. Sign in to change it."}</span>
      {me.user ? (
        <Button size="sm" variant="primary" icon="plus" onClick={() => navigate("/projects?new=1")}>
          New project
        </Button>
      ) : (
        <Button size="sm" variant="primary" onClick={(e) => openSignIn({ anchor: e.currentTarget, reason: "Sign in to change this project or make your own." })}>
          Sign in
        </Button>
      )}
    </div>
  );
}
