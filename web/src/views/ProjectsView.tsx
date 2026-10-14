/**
 * "/projects": the person's projects and the public ones. "New project" grows a panel from the button
 * (a description, then the sources); a person without projects sees that picker right on the page.
 * The project list comes from the boot request; this page asks again only when the tab comes back
 * after a minute or more.
 */
import { useEffect, useId, useMemo, useState, type MouseEvent } from "react";
import { Button, EmptyState } from "../design/components";
import { Icon } from "../design/icons";
import type { ProjectInfo } from "../../../src/core/accounts";
import { TEMPLATES } from "../../../src/core/templates";
import { loadProjects, openProject, useMe } from "../state/account";
import { ago } from "../state/format";
import { useStore } from "../state/store";
import { setSearchParam, useLocationKey } from "../app/router";
import { AnchoredPanel } from "./newproject/AnchoredPanel";
import { NEW_PROJECT_LEDE, NewProject } from "./newproject/NewProject";
import { draftFromLink, EMPTY_DRAFT, LINK_PARAMS, type NewProjectDraft } from "./newproject/draft";
import { GithubMark, LockIcon, RepoIcon } from "./newproject/marks";
import "./projects.css";

const RETURN_TO = "/projects?new=1";

function sourceLine(p: ProjectInfo): string {
  const s = p.source;
  switch (s.kind) {
    case "github":
      return `${s.repo}${s.branch ? ` · ${s.branch}` : ""}`;
    case "git":
      return `Imported from ${s.url.replace(/^https:\/\//, "")}${s.branch ? ` · ${s.branch}` : ""}`;
    case "empty":
      return "Started empty";
    case "upload":
      return `Uploaded folder · ${s.files} ${s.files === 1 ? "file" : "files"}`;
    case "push":
      return "Pushed with git";
    case "template":
      return `From the ${TEMPLATES.find((t) => t.id === s.template)?.title ?? s.template} template`;
    default:
      return "Project";
  }
}

function SourceIcon({ p }: { p: ProjectInfo }) {
  if (p.source.kind === "github") return <GithubMark className="pj-card__icon" />;
  if (p.source.kind === "git") return <Icon name="fork" className="pj-card__icon" />;
  if (p.source.kind === "upload") return <Icon name="launch" className="pj-card__icon" />;
  if (p.source.kind === "template") return <Icon name="grid" className="pj-card__icon" />;
  return <RepoIcon className="pj-card__icon" />;
}

function clearLinkParams() {
  const params = new URLSearchParams(location.search);
  for (const k of LINK_PARAMS) if (params.has(k)) setSearchParam(k, null);
}

export function ProjectsView() {
  const me = useMe();
  const ready = useStore((s) => s.accountReady);
  const projects = useStore((s) => s.projects);
  const current = useStore((s) => s.projectId);
  const loc = useLocationKey();
  const uid = useId().replace(/:/g, "");
  const panelId = `${uid}-new`;
  const headingId = `${uid}-new-title`;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<NewProjectDraft>(EMPTY_DRAFT);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [focusInline, setFocusInline] = useState(false);
  const signedIn = Boolean(me?.user);

  const [mine, others] = useMemo(() => {
    const a = projects.filter((p) => p.role === "owner" || p.role === "member");
    const b = projects.filter((p) => p.role !== "owner" && p.role !== "member");
    return [a, b];
  }, [projects]);
  // A person without projects gets the picker on the page: no extra click.
  const inline = ready && signedIn && mine.length === 0;

  // Links open the picker: "New project" in the project menu, the watch banner, GitHub sending the person back.
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(location.search);
    if (!params.has("new") && !params.has("repo")) return;
    setDraft((d) => draftFromLink(params, d));
    if (inline) setFocusInline(true);
    else setOpen(true);
  }, [loc, ready, inline]);

  // Shift+N opens the picker from anywhere on this page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "N" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || !ready) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      if (inline) document.querySelector<HTMLInputElement>(".pj-start .np-describe__input")?.focus();
      else setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, inline]);

  // Someone may add this person to a project meanwhile: look again when the tab comes back after a minute.
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 60_000) void loadProjects().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const close = () => {
    setOpen(false);
    clearLinkParams();
  };

  return (
    <div className="page projects">
      <p className="page__eyebrow">
        <Icon name="grid" size={14} /> Projects
      </p>
      <div className="projects__head">
        <div className="projects__intro">
          <h1 className="page__title" tabIndex={-1}>
            Projects
          </h1>
          <p className="page__lede">
            A project is one git repository. gitring holds it in Cloudflare Artifacts. Many agents change it at the same time: gitring checks their plans and merges
            their work when the tests pass. You say yes to risky work. Agents can also create projects through MCP. GitHub sync is optional.
          </p>
        </div>
        {ready && !inline && (
          <div className="projects__new">
            <Button
              ref={setTrigger}
              variant="primary"
              icon="plus"
              iconRight={open ? "chevron-up" : "chevron-down"}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              aria-keyshortcuts="Shift+N"
              title="New project (Shift+N)"
              onClick={() => (open ? close() : setOpen(true))}
            >
              New project
            </Button>
            <AnchoredPanel id={panelId} open={open} anchor={trigger} onClose={close} labelledBy={headingId} align="end" width={500}>
              <NewProject me={me} draft={draft} onDraft={setDraft} headingId={headingId} returnTo={RETURN_TO} />
            </AnchoredPanel>
          </div>
        )}
      </div>

      {inline && (
        <section className="pj-start" aria-labelledby={headingId}>
          <NewProject
            me={me}
            draft={draft}
            onDraft={setDraft}
            headingId={headingId}
            returnTo={RETURN_TO}
            autoFocus={focusInline}
            title="Start your first project"
            lede={NEW_PROJECT_LEDE}
          />
        </section>
      )}

      {!ready && <GridSkeleton />}

      {ready && signedIn && mine.length > 0 && (
        <section className="projects__sec" aria-labelledby="pj-mine">
          <h2 className="page__h2" id="pj-mine">
            Your projects <span className="projects__count">{mine.length}</span>
          </h2>
          <ProjectGrid list={mine} current={current} />
        </section>
      )}
      {ready && (others.length > 0 || !signedIn) && (
        <section className="projects__sec" aria-labelledby="pj-public">
          <h2 className="page__h2" id="pj-public">
            Public projects <span className="projects__count">{others.length}</span>
          </h2>
          {others.length ? <ProjectGrid list={others} current={current} /> : <EmptyState art={false} text="No public projects yet." />}
        </section>
      )}
    </div>
  );
}

function GridSkeleton() {
  return (
    <ul className="pj-grid pj-grid--skeleton" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="pj-card">
          <span className="np-skel" style={{ width: "55%", height: 14 }} />
          <span className="np-skel" style={{ width: "80%" }} />
          <span className="np-skel" style={{ width: "40%" }} />
        </li>
      ))}
    </ul>
  );
}

function ProjectGrid({ list, current }: { list: ProjectInfo[]; current: string }) {
  const open = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    // A plain click opens the project here; a modified click opens a new tab as usual.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openProject(id);
  };
  return (
    <ul className="pj-grid">
      {list.map((p) => (
        <li key={p.id}>
          <a
            href={`/overview?project=${encodeURIComponent(p.id)}`}
            className={["pj-card", p.id === current && "is-current"].filter(Boolean).join(" ")}
            aria-current={p.id === current ? "true" : undefined}
            onClick={(e) => open(e, p.id)}
          >
            <span className="pj-card__top">
              <SourceIcon p={p} />
              <span className="pj-card__name">{p.name}</span>
              {p.visibility === "private" && (
                <span className="pj-card__lock" title="Private">
                  <LockIcon size={12} />
                  <span className="vh">Private</span>
                </span>
              )}
            </span>
            <span className="pj-card__source voice-agent">{sourceLine(p)}</span>
            <span className="pj-card__meta">
              {[p.visibility === "public" ? "Public" : "Private", p.role === "owner" ? "Owner" : p.role === "member" ? "Member" : "Viewer", p.ownerName && p.role !== "owner" ? p.ownerName : null, p.createdAt ? `created ${ago(p.createdAt)}` : null]
                .filter(Boolean)
                .join(" · ")}
              {p.id === current ? " · open now" : ""}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
