/**
 * Account UI: the project switcher, the person menu, the sign-in dialog and the "watching" banner.
 */
import { useRef, useState } from "react";
import { Button, Dialog, Popover } from "../design/components";
import { Icon } from "../design/icons";
import { useStore } from "../state/store";
import { openProject, signIn, signOut, useCanAct, useMe } from "../state/account";
import { Link, navigate } from "./router";
import { setUi, useUi } from "./ui";

const SOURCE_TEXT: Record<string, string> = { sample: "sample", empty: "empty repository", git: "import", upload: "upload", push: "git push" };

export function ProjectSwitcher() {
  const projects = useStore((s) => s.projects);
  const current = useStore((s) => s.projectId);
  const name = useStore((s) => s.state?.project.name ?? projects.find((p) => p.id === s.projectId)?.name ?? "gitring");
  const canAct = useCanAct();
  const signedIn = Boolean(useMe()?.user);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={btn} type="button" className="acct-switch" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`Project: ${name}. Switch project.`}>
        <span className="topbar__projname">{name}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} label="Projects" align="start">
        <div className="acct-list">
          <p className="acct-list__head">Projects</p>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={["acct-list__item", p.id === current && "is-current"].filter(Boolean).join(" ")}
              onClick={() => {
                setOpen(false);
                if (p.id !== current) openProject(p.id);
              }}
            >
              <Icon name={p.source.kind === "git" ? "fork" : p.source.kind === "sample" ? "compass" : "anchor"} />
              <span className="acct-list__text">
                <span className="acct-list__name">{p.name}</span>
                <span className="acct-list__meta">
                  {SOURCE_TEXT[p.source.kind] ?? p.source.kind} · {p.visibility} · {p.role}
                </span>
              </span>
              {p.id === current && <Icon name="check" />}
            </button>
          ))}
          {canAct && (
            <Link to="/settings" className="acct-list__item acct-list__all" onClick={() => setOpen(false)}>
              <Icon name="info" />
              <span className="acct-list__text">
                <span className="acct-list__name">Project settings</span>
                <span className="acct-list__meta">Name, visibility, members</span>
              </span>
            </Link>
          )}
          <Link
            to="/projects"
            className={["acct-list__item", !canAct && "acct-list__all"].filter(Boolean).join(" ")}
            onClick={() => {
              setOpen(false);
            }}
          >
            <Icon name="grid" />
            <span className="acct-list__text">
              <span className="acct-list__name">All projects</span>
            </span>
          </Link>
          {signedIn ? (
            <Link
              to="/projects?new=1"
              className="acct-list__item"
              onClick={() => {
                setOpen(false);
              }}
            >
              <Icon name="plus" />
              <span className="acct-list__text">
                <span className="acct-list__name">New project</span>
              </span>
            </Link>
          ) : (
            <button
              type="button"
              className="acct-list__item"
              onClick={() => {
                setOpen(false);
                setUi({ signIn: true });
              }}
            >
              <Icon name="human" />
              <span className="acct-list__text">
                <span className="acct-list__name">Sign in to make a project</span>
              </span>
            </button>
          )}
        </div>
      </Popover>
    </>
  );
}

export function UserMenu() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  if (!me) return null;
  if (!me.user) {
    return (
      <Button size="sm" variant="primary" icon="human" onClick={() => setUi({ signIn: true })}>
        Sign in
      </Button>
    );
  }
  const u = me.user;
  return (
    <>
      <button ref={btn} type="button" className="acct-me" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`Signed in as ${u.name}. Open the menu.`}>
        {u.avatar ? <img className="acct-me__avatar" src={u.avatar} alt="" width={24} height={24} referrerPolicy="no-referrer" /> : <Icon name="human" />}
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} label="Account" align="end">
        <div className="acct-menu">
          <p className="acct-menu__name">{u.name}</p>
          <p className="acct-menu__meta">
            {u.identities.map((i) => (i.provider === "github" ? `GitHub @${i.login}` : `Google ${i.email}`)).join(" · ")}
            {u.admin ? " · administrator" : ""}
          </p>
          <Link to="/projects" className="acct-menu__item" onClick={() => setOpen(false)}>
            <Icon name="grid" /> Projects
          </Link>
          <Link to="/connect" className="acct-menu__item" onClick={() => setOpen(false)}>
            <Icon name="plug" /> API keys and agents
          </Link>
          <Link to="/?home" className="acct-menu__item" onClick={() => setOpen(false)}>
            <Icon name="info" /> About gitring
          </Link>
          {u.admin && (
            <a className="acct-menu__item" href="/setup">
              <Icon name="info" /> Sign-in setup
            </a>
          )}
          <button type="button" className="acct-menu__item" onClick={() => void signOut()}>
            <Icon name="arrow-left" /> Sign out
          </button>
        </div>
      </Popover>
    </>
  );
}

export function SignInDialog() {
  const ui = useUi();
  const me = useMe();
  const close = () => setUi({ signIn: false });
  const gh = me?.providers.github;
  const gg = me?.providers.google;
  return (
    <Dialog open={ui.signIn} onClose={close} title="Sign in to gitring" description="Sign in to make projects, start agents, choose work copies and create API keys for your agents." dismissOnScrim>
      <div className="acct-signin">
        {gh && (
          <Button variant="primary" icon="fork" onClick={() => signIn("github")}>
            Continue with GitHub
          </Button>
        )}
        {gg && (
          <Button icon="human" onClick={() => signIn("google")}>
            Continue with Google
          </Button>
        )}
        {!gh && !gg && <p className="acct-signin__note">Sign-in is not set up on this server yet. Its owner opens /setup to add GitHub or Google.</p>}
        <p className="acct-signin__note">gitring keeps your name, email and avatar. It does not post anything for you.</p>
      </div>
    </Dialog>
  );
}

/** Shown when the caller can only view the open project. */
export function WatchBanner() {
  const me = useMe();
  const canAct = useCanAct();
  const ready = useStore((s) => s.state !== null);
  const isSample = useStore((s) => s.projectId === "demo");
  if (!ready || canAct || !me) return null;
  return (
    <div className="acct-watch" role="status">
      <Icon name="eye" />
      <span>
        {isSample
          ? me.user
            ? "You view the public sample. Copy it to your projects to start agents."
            : "You view the public sample. Sign in, then copy it to your projects to start agents."
          : me.user
            ? "You can view this project. To change it, ask an owner for the member role, or make your own project."
            : "You can view this project. Sign in to change it."}
      </span>
      {me.user ? (
        <Button size="sm" variant="primary" icon="plus" onClick={() => navigate(isSample ? "/projects?new=sample" : "/projects?new=1")}>
          {isSample ? "Copy the sample" : "New project"}
        </Button>
      ) : (
        <Button size="sm" variant="primary" icon="human" onClick={() => setUi({ signIn: true })}>
          Sign in
        </Button>
      )}
    </div>
  );
}
