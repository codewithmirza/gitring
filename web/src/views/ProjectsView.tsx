/**
 * The /projects page: the projects of the person, and the public ones.
 * The "New project" button grows a panel from the button (a description, then the sources). A person without projects
 * sees that picker right on the page. The cards are in projects/ProjectCard.tsx.
 * The project list comes from the boot request. This page asks again only when the tab comes back after a minute or more.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Button, EmptyState } from "../design/components";
import { Icon } from "../design/icons";
import { loadProjects, useMe } from "../state/account";
import { refreshInbox } from "../state/inbox";
import { useStore } from "../state/store";
import { setSearchParam, useLocationKey } from "../app/router";
import { AnchoredPanel } from "./newproject/AnchoredPanel";
import { NEW_PROJECT_LEDE, NewProject } from "./newproject/NewProject";
import { draftFromLink, EMPTY_DRAFT, LINK_PARAMS, type NewProjectDraft } from "./newproject/draft";
import { ProjectGrid } from "./projects/ProjectCard";
import "./projects.css";

/* ───────────── helpers ───────────── */

const RETURN_TO = "/projects?new=1";

function clearLinkParams() {
  const params = new URLSearchParams(location.search);
  for (const k of LINK_PARAMS) if (params.has(k)) setSearchParam(k, null);
}

/* ───────────── the page ───────────── */

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

  // The cards lead with the questions that wait: load the inbox now, so that the numbers are fresh.
  useEffect(() => {
    if (ready && signedIn) void refreshInbox();
  }, [ready, signedIn]);

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
          <p className="page__lede">A project is the code that your agents change together.</p>
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

/* ───────────── parts of the page ───────────── */

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
