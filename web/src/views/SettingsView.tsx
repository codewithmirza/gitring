/**
 * The "/settings" page: General and Members here, and one file for each other section.
 *
 * The page shows the settings of the live project state at once, then the full settings from the server (members only).
 * Each section saves on its own. Destructive actions confirm in place (no modal dialogs).
 * Read next: settings/ (Merging, Tests, GitHub, Webhooks).
 */
import { useEffect, useRef, useState } from "react";
import { Button, CodeBlock, EmptyState, Field, InlineConfirm, Input, Segmented, toast } from "../design/components";
import { Icon } from "../design/icons";
import type { MemberInfo, Role, Visibility } from "../../../src/core/accounts";
import type { ProjectSettings } from "../../../src/core/types";
import { githubRepoName } from "../../../src/core/repo-rules";
import { addMember, archiveProject, getSettings, listMembers, loadProjects, removeMember, updateProject, useAccess, useMe } from "../state/account";
import { useStore } from "../state/store";
import { ChecksSection } from "./settings/ChecksSection";
import { GithubSection } from "./settings/GithubSection";
import { MergingSection } from "./settings/MergingSection";
import { WebhooksSection } from "./settings/WebhooksSection";
import { SaveError } from "./settings/shared";
import "./projects.css";

const SECTIONS: { id: string; label: string; owner?: boolean }[] = [
  { id: "st-general", label: "General" },
  { id: "st-members", label: "Members" },
  { id: "st-merging", label: "Merging" },
  { id: "st-checks", label: "Tests" },
  { id: "st-github", label: "GitHub" },
  { id: "st-webhooks", label: "Webhooks" },
  { id: "st-danger", label: "Archive", owner: true },
];

function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

export function SettingsView() {
  const access = useAccess();
  const me = useMe();
  const projectId = useStore((s) => s.projectId);
  const project = useStore((s) => s.state?.project);
  const info = useStore((s) => s.projects.find((p) => p.id === s.projectId));
  const owner = access === "owner";
  const member = access === "owner" || access === "member";
  const [members, setMembers] = useState<MemberInfo[] | null>(null);
  const [who, setWho] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [name, setName] = useState(info?.name ?? project?.name ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  // The live state carries the settings: the page shows them at once. The server's answer replaces them.
  const [settings, setSettings] = useState<ProjectSettings | null>(() => project?.settings ?? null);
  const [full, setFull] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const membersHead = useRef<HTMLHeadingElement | null>(null);

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
  useEffect(() => setName(info?.name ?? project?.name ?? ""), [info?.name, project?.name]);
  // ?section=github (for example after "Connect GitHub") opens the page at that section.
  useEffect(() => {
    const section = new URLSearchParams(location.search).get("section");
    if (section && settings) requestAnimationFrame(() => jumpTo(`st-${section}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(settings)]);

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

  return (
    <div className="page settings">
      <p className="page__eyebrow">
        <Icon name="info" size={14} /> Settings
      </p>
      <h1 className="page__title" tabIndex={-1}>
        {title}
      </h1>
      <p className="page__lede">
        Project id <span className="voice-agent">{projectId}</span>
        {project?.repo.remote ? (
          <>
            {" "}
            · main is in Cloudflare Artifacts (<span className="voice-agent">{project.repo.name}</span>, branch {project.repo.defaultBranch})
          </>
        ) : null}
      </p>
      {!owner && <p className="st-note">Owners change these settings. You see the values.</p>}
      <nav aria-label="Sections">
        <ul className="st-toc">
          {SECTIONS.filter((s) => !s.owner || owner).map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  jumpTo(s.id);
                }}
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section className="st-sec" aria-labelledby="st-general">
        <h2 className="page__h2" id="st-general">
          General
        </h2>
        <div className="st-row">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!owner} maxLength={80} />
          </Field>
          {owner && (
            <Button
              busy={busy === "name"}
              disabled={!name.trim() || name.trim() === title}
              onClick={() => void run("name", () => updateProject(projectId, { name: name.trim() }).then(() => loadProjects()), "Name saved")}
            >
              Save name
            </Button>
          )}
        </div>
        <Segmented<Visibility>
          label="Who can see it"
          value={visibility}
          disabled={!owner}
          onChange={(v) => owner && v !== visibility && void run("vis", () => updateProject(projectId, { visibility: v }).then(() => loadProjects()), v === "public" ? "The project is public" : "The project is private")}
          options={[
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ]}
        />
        <p className="np__help">{visibility === "private" ? "Only members see this project." : "Anyone with the link can view it. Only members can change it."}</p>
      </section>

      <section className="st-sec" aria-labelledby="st-members">
        <h2 className="page__h2" id="st-members" ref={membersHead}>
          Members
        </h2>
        <p className="np__help">Owners change settings and members. Members open tasks, start agents and choose work copies. Viewers can only look.</p>
        <ul className="st-members" aria-busy={members === null || undefined}>
          {(members ?? []).map((m) => (
            <li key={m.handle}>
              <span className="st-members__name">{m.name}</span>
              <span className="st-members__handle voice-agent">{m.handle}</span>
              <span className="st-members__role">
                {m.pending ? `${m.role} · invited` : m.role}
                {m.userId && m.userId === me?.user?.id ? " · you" : ""}
              </span>
              {owner && m.userId !== me?.user?.id && (
                <span className="st-members__act">
                  <InlineConfirm
                    label="Remove"
                    ariaLabel={`Remove ${m.name}`}
                    size="sm"
                    icon="close"
                    consequence={`Remove ${m.name}? ${m.pending ? "The invitation ends." : "They lose access at once."}`}
                    confirmLabel="Remove"
                    onConfirm={async () => {
                      try {
                        setMembers(await removeMember(projectId, m.userId ?? m.handle));
                        toast({ tone: "info", title: "Member removed", text: `${m.name} has no access now.` });
                        membersHead.current?.setAttribute("tabindex", "-1");
                        membersHead.current?.focus();
                      } catch (e) {
                        toast({ tone: "danger", title: "The member was not removed", text: (e as Error).message });
                      }
                    }}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
        {owner && (
          <form
            className="st-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!who.trim()) return;
              void run(
                "add",
                () =>
                  addMember(projectId, who.trim(), role).then((list) => {
                    setMembers(list);
                    setWho("");
                  }),
                "Person added",
              );
            }}
          >
            <Field label="Add a person" help="An account id (from the Account page), an email or a GitHub login. An email or a login gets the role at the next sign-in.">
              <Input value={who} onChange={(e) => setWho(e.target.value)} placeholder="u_0123456789 or ada@example.com" autoComplete="off" spellCheck={false} />
            </Field>
            <Segmented<Role>
              label="Role"
              value={role}
              onChange={setRole}
              options={[
                { value: "viewer", label: "Viewer" },
                { value: "member", label: "Member" },
                { value: "owner", label: "Owner" },
              ]}
            />
            <Button type="submit" variant="primary" icon="plus" busy={busy === "add"} disabled={!who.trim()}>
              Add
            </Button>
          </form>
        )}
      </section>

      {loadError && !settings && (
        <section className="st-sec">
          <SaveError error={`The settings did not load. ${loadError}`} />
        </section>
      )}
      {settings && (
        <>
          <MergingSection projectId={projectId} owner={owner} settings={settings} onSaved={setSettings} members={members} />
          <ChecksSection projectId={projectId} owner={owner} settings={settings} onSaved={setSettings} />
          <GithubSection projectId={projectId} owner={owner} settings={settings} onSaved={setSettings} imported={imported} me={me} />
          {full ? (
            <WebhooksSection projectId={projectId} owner={owner} settings={settings} onSaved={setSettings} />
          ) : (
            <section className="st-sec" aria-labelledby="st-webhooks" aria-busy="true">
              <h2 className="page__h2" id="st-webhooks">
                Webhooks
              </h2>
              {loadError ? <SaveError error={`The webhooks did not load. ${loadError}`} /> : <span className="np-skel" style={{ width: "40%", height: 12 }} aria-hidden="true" />}
            </section>
          )}
        </>
      )}

      {project?.repo.remote && (
        <section className="st-sec" aria-labelledby="st-repo">
          <h2 className="page__h2" id="st-repo">
            Repository
          </h2>
          <p className="np__help">The main repository of the project. Only gitring writes its main branch. Agents and people merge work through tasks.</p>
          <CodeBlock label="Artifacts remote" code={project.repo.remote} copyLabel="Copy remote" />
        </section>
      )}

      {owner && (
        <section className="st-sec st-danger" aria-labelledby="st-danger">
          <h2 className="page__h2" id="st-danger">
            Archive
          </h2>
          <p className="np__help">The project leaves every list, and agents stop. Its repository stays in Cloudflare Artifacts.</p>
          <div>
            <InlineConfirm
              label="Archive project"
              size="md"
              variant="danger"
              box
              timeout={0}
              consequence={`Archive ${title}? It leaves every list at once.`}
              confirmLabel="Archive"
              onConfirm={async () => {
                try {
                  await archiveProject(projectId);
                  // A full load: the archived project's socket and state go away.
                  location.href = "/projects";
                } catch (e) {
                  toast({ tone: "danger", title: "The project was not archived", text: (e as Error).message });
                }
              }}
            />
          </div>
        </section>
      )}
    </div>
  );
}
