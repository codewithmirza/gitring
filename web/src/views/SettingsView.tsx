/**
 * The "/settings" page: tabs, and one section at a time under them.
 *
 * The page shows the settings of the live project state at once, then the full settings from the server (members only).
 * Each section saves on its own. Every panel stays mounted, so a draft survives a change of tab.
 * The address names the tab: `?section=github` or `#st-github` (see settings/sections.ts).
 * Read next: settings/ (one file for each section).
 */
import { useEffect, useState, type ReactNode } from "react";
import { EmptyState, Tabs, toast } from "../design/components";
import { Icon } from "../design/icons";
import type { MemberInfo, Visibility } from "../../../src/core/accounts";
import type { ProjectSettings } from "../../../src/core/types";
import { githubRepoName } from "../../../src/core/repo-rules";
import { getSettings, listMembers, useAccess, useMe } from "../state/account";
import { useStore } from "../state/store";
import { ArchiveSection } from "./settings/ArchiveSection";
import { ChecksSection } from "./settings/ChecksSection";
import { GeneralSection } from "./settings/GeneralSection";
import { GithubSection } from "./settings/GithubSection";
import { MembersSection } from "./settings/MembersSection";
import { MergingSection } from "./settings/MergingSection";
import { WebhooksSection } from "./settings/WebhooksSection";
import { SECTIONS, type SectionId, useSection } from "./settings/sections";
import { SaveError } from "./settings/shared";
import "./projects.css";
import "./settings.css";

/** One tab's content. It stays in the page when hidden, so that nothing the person typed is lost. */
function Panel({ id, active, children }: { id: SectionId; active: boolean; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`st-panel-${id}`} aria-labelledby={`st-tab-${id}`} hidden={!active} className="st-panel">
      {children}
    </div>
  );
}

export function SettingsView() {
  const access = useAccess();
  const me = useMe();
  const projectId = useStore((s) => s.projectId);
  const project = useStore((s) => s.state?.project);
  const info = useStore((s) => s.projects.find((p) => p.id === s.projectId));
  const owner = access === "owner";
  const member = access === "owner" || access === "member";
  const [section, setSection] = useSection(owner);
  const [members, setMembers] = useState<MemberInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The live state carries the settings: the page shows them at once. The server's answer replaces them.
  const [settings, setSettings] = useState<ProjectSettings | null>(() => project?.settings ?? null);
  const [full, setFull] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!member) return;
    const ctl = new AbortController();
    listMembers(projectId).then(
      (m) => !ctl.signal.aborted && setMembers(m),
      () => !ctl.signal.aborted && setMembers([]),
    );
    return () => ctl.abort();
  }, [projectId, member]);
  useEffect(() => {
    if (!member) return;
    let live = true;
    setLoadError(null);
    getSettings(projectId).then(
      (s) => {
        if (!live) return;
        setSettings(s);
        setFull(true);
      },
      (e: Error) => live && setLoadError(e.message),
    );
    return () => {
      live = false;
    };
  }, [projectId, member]);

  if (!access || access === "viewer") {
    return (
      <div className="page">
        <h1 className="page__title" tabIndex={-1}>
          Project settings
        </h1>
        <EmptyState text="Only members of this project see its settings." />
      </div>
    );
  }

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast({ tone: "info", title: done });
    } catch (e) {
      toast({ tone: "danger", title: "The change did not save", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const title = info?.name ?? project?.name ?? projectId;
  const visibility: Visibility = info?.visibility ?? "private";
  const source = project?.source ?? info?.source;
  const imported = source?.kind === "github" ? source.repo : source?.kind === "git" ? githubRepoName(source.url) : null;
  const tabs = SECTIONS.filter((s) => !s.owner || owner);
  const sectionProps = settings ? { projectId, owner, settings, onSaved: setSettings } : null;
  // Shown in a panel that has no settings to show: the server did not answer.
  const failed = loadError ? (
    <section className="st-sec">
      <SaveError error={`The settings did not load. ${loadError}`} />
    </section>
  ) : null;

  return (
    <div className="page settings">
      <p className="page__eyebrow">
        <Icon name="info" size={14} /> Settings
      </p>
      <h1 className="page__title" tabIndex={-1}>
        {title}
      </h1>
      <p className="page__lede">Choose who works in this project, when a person says yes, how tests run, and what goes out.</p>
      {!owner && <p className="st-note">Owners change these settings. You see the values.</p>}
      <Tabs<SectionId> label="Settings sections" idPrefix="st" value={section} onChange={setSection} tabs={tabs} className="st-tabs" />

      <Panel id="general" active={section === "general"}>
        <GeneralSection projectId={projectId} owner={owner} title={title} visibility={visibility} branch={project?.repo.defaultBranch ?? "main"} remote={project?.repo.remote} busy={busy} run={run} />
      </Panel>
      <Panel id="members" active={section === "members"}>
        <MembersSection projectId={projectId} owner={owner} meId={me?.user?.id} members={members} onMembers={setMembers} busy={busy} run={run} />
      </Panel>
      <Panel id="merging" active={section === "merging"}>
        {sectionProps ? <MergingSection {...sectionProps} members={members} /> : failed}
      </Panel>
      <Panel id="checks" active={section === "checks"}>
        {sectionProps ? <ChecksSection {...sectionProps} /> : failed}
      </Panel>
      <Panel id="github" active={section === "github"}>
        {sectionProps ? <GithubSection {...sectionProps} imported={imported} me={me} /> : failed}
      </Panel>
      <Panel id="webhooks" active={section === "webhooks"}>
        {sectionProps && full ? (
          <WebhooksSection {...sectionProps} />
        ) : (
          <section className="st-sec" aria-labelledby="st-webhooks" aria-busy={!loadError || undefined}>
            <h2 className="page__h2" id="st-webhooks">
              Webhooks
            </h2>
            {loadError ? <SaveError error={`The webhooks did not load. ${loadError}`} /> : <span className="np-skel" style={{ width: "40%", height: 12 }} aria-hidden="true" />}
          </section>
        )}
      </Panel>
      {owner && (
        <Panel id="danger" active={section === "danger"}>
          <ArchiveSection projectId={projectId} title={title} />
        </Panel>
      )}
    </div>
  );
}
