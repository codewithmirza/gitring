/**
 * "/settings": the settings of the open project. The page shows the settings of the live project state at
 * once, then the full settings from the server (members only). Each section saves on its own.
 * Destructive actions confirm in place (no modal dialogs).
 */
import { useEffect, useId, useRef, useState } from "react";
import { Badge, Button, Checkbox, CodeBlock, EmptyState, Field, Input, Segmented, Select, toast, type BadgeTone } from "../design/components";
import { Icon, type IconName } from "../design/icons";
import type { GithubRepo, MemberInfo, Role, Visibility } from "../../../src/core/accounts";
import type { CheckSettings, GithubSyncMode, GithubSyncState, GithubSyncStatus, GitringEventType, ProjectSettings, RedoPolicy, WebhookTarget } from "../../../src/core/types";
import { githubRepoName } from "../../../src/core/repo-rules";
import { addMember, archiveProject, getSettings, listMembers, loadProjects, putSettings, removeMember, updateProject, useAccess, useMe, type MeWithInstall } from "../state/account";
import { isAbort, pullFromGithub, sendToGithub, syncStatus } from "../state/github";
import { useStore } from "../state/store";
import { ago, shortSha } from "../state/format";
import { Link } from "../app/router";
import { InlineConfirm } from "./newproject/InlineConfirm";
import { RepoSelect } from "./newproject/RepoSelect";
import "./projects.css";

/** Save a part of the settings. The server merges it and answers the full settings (or an error to show inline). */
function useSave(projectId: string, onSaved: (s: ProjectSettings) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<ProjectSettings>, done: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await putSettings(projectId, patch));
      toast({ tone: "info", title: done });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, save };
}

function SaveError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="st-error" role="alert">
      <Icon name="cross" size={12} /> {error}
    </p>
  );
}

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
                    variant="ghost"
                    icon="close"
                    question={`Remove ${m.name}? ${m.pending ? "The invitation ends." : "They lose access at once."}`}
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
            <Field label="Add a person" help="A GitHub login or an email. They get the role when they sign in.">
              <Input value={who} onChange={(e) => setWho(e.target.value)} placeholder="octocat or ada@example.com" autoComplete="off" spellCheck={false} />
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
          <MergingSection projectId={projectId} owner={owner} settings={settings} onSaved={setSettings} />
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
              question={`Archive ${title}? It leaves every list at once.`}
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

interface SectionProps {
  projectId: string;
  owner: boolean;
  settings: ProjectSettings;
  onSaved: (s: ProjectSettings) => void;
}

/* ───────────── merging ───────────── */

const REDO_OPTIONS: { value: RedoPolicy; label: string }[] = [
  { value: "agent-first", label: "Give it back to the same agent first, then to a built-in agent" },
  { value: "agent-only", label: "Give it back to the same agent only" },
  { value: "builtin", label: "A built-in agent does it again" },
];

const REDO_HELP: Record<RedoPolicy, string> = {
  "agent-first": "The same agent gets the work back. If it does not answer in the wait time, a built-in agent does the task again.",
  "agent-only": "The same agent gets the work back. If it does not answer, a person decides.",
  builtin: "A built-in agent does the task again at once. The work of built-in agents always goes back to a built-in agent.",
};

function MergingSection({ projectId, owner, settings, onSaved }: SectionProps) {
  const [autoLand, setAutoLand] = useState(settings.autoLand);
  const [intentsInRepo, setIntentsInRepo] = useState(settings.intentsInRepo);
  const [redo, setRedo] = useState<RedoPolicy>(settings.redo ?? "agent-first");
  const [wait, setWait] = useState(String(settings.redoWaitMinutes ?? 15));
  const { busy, error, setError, save } = useSave(projectId, onSaved);

  // Reset the form only when these values change on the server (a save in another section keeps this draft).
  useEffect(() => {
    setAutoLand(settings.autoLand);
    setIntentsInRepo(settings.intentsInRepo);
    setRedo(settings.redo ?? "agent-first");
    setWait(String(settings.redoWaitMinutes ?? 15));
  }, [settings.autoLand, settings.intentsInRepo, settings.redo, settings.redoWaitMinutes]);

  const dirty = autoLand !== settings.autoLand || intentsInRepo !== settings.intentsInRepo || redo !== (settings.redo ?? "agent-first") || (redo === "agent-first" && wait !== String(settings.redoWaitMinutes ?? 15));
  const submit = () => {
    const minutes = Number(wait);
    if (redo === "agent-first" && (!Number.isInteger(minutes) || minutes < 5 || minutes > 120)) {
      setError("Give a wait time from 5 to 120 minutes.");
      return;
    }
    void save({ autoLand, intentsInRepo, redo, ...(redo === "agent-first" ? { redoWaitMinutes: minutes } : {}) }, "Merge settings saved");
  };

  return (
    <section className="st-sec" aria-labelledby="st-merging">
      <h2 className="page__h2" id="st-merging">
        Merging
      </h2>
      <div className="st-checks">
        <Checkbox label="Merge by itself when the tests pass" checked={autoLand} disabled={!owner} onChange={(e) => setAutoLand(e.target.checked)} />
        <p className="np__help">{autoLand ? "A person chooses only when two or more work copies compete for one task." : "A person chooses each work copy to merge."}</p>
        <Checkbox
          label={
            <>
              Write a task file into the repository on each merge (<span className="voice-agent">.gitring/intents/…</span>)
            </>
          }
          checked={intentsInRepo}
          disabled={!owner}
          onChange={(e) => setIntentsInRepo(e.target.checked)}
        />
      </div>
      <div className="st-row">
        <Field label="When the work of an outside agent cannot merge" help={REDO_HELP[redo]}>
          <Select value={redo} disabled={!owner} onChange={(e) => setRedo(e.target.value as RedoPolicy)}>
            {REDO_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {redo === "agent-first" && (
          <Field label="Wait time (minutes)" help="5 to 120.">
            <Input type="number" min={5} max={120} step={1} inputMode="numeric" value={wait} disabled={!owner} onChange={(e) => setWait(e.target.value)} />
          </Field>
        )}
      </div>
      {owner && (
        <div>
          <Button busy={busy} disabled={!dirty} onClick={submit}>
            Save merge settings
          </Button>
        </div>
      )}
      <SaveError error={error} />
    </section>
  );
}

/* ───────────── tests ───────────── */

/** How tests run: the gitring test runner (Dynamic Worker) or the project's own commands in a container. */
function ChecksSection({ projectId, owner, settings, onSaved }: SectionProps) {
  const cs: CheckSettings = settings.checks ?? { runner: "worker" };
  const [install, setInstall] = useState(cs.install ?? "");
  const [test, setTest] = useState(cs.test ?? "");
  const [timeout, setTimeoutSec] = useState(String(cs.timeoutSec ?? 600));
  const { busy, error, save } = useSave(projectId, onSaved);
  const saved = JSON.stringify(cs);

  useEffect(() => {
    setInstall(cs.install ?? "");
    setTest(cs.test ?? "");
    setTimeoutSec(String(cs.timeoutSec ?? 600));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const container = cs.runner === "container";
  const dirty = install !== (cs.install ?? "") || test !== (cs.test ?? "") || timeout !== String(cs.timeoutSec ?? 600);
  return (
    <section className="st-sec" aria-labelledby="st-checks">
      <h2 className="page__h2" id="st-checks">
        Tests
      </h2>
      <p className="np__help">gitring runs the tests before a work copy is ready, and again on main plus the work copy before it merges. Work merges only when they pass.</p>
      <Segmented<CheckSettings["runner"]>
        label="Where tests run"
        value={cs.runner}
        disabled={!owner}
        onChange={(runner) => owner && runner !== cs.runner && void save({ checks: { ...cs, runner } }, "Test settings saved")}
        options={[
          { value: "container", label: "Container", icon: "anchor" },
          { value: "worker", label: "gitring test runner", icon: "compass" },
        ]}
      />
      <p className="np__help">
        {container
          ? "A Linux container with Node.js 24 runs the install command, then the test command. The container can reach package registries only."
          : "A Dynamic Worker runs tests/*.test.js with the gitring test runner. No dependencies and no network."}
      </p>
      {container && (
        <>
          <div className="st-row">
            <Field label="Install command" optional help="Empty: npm ci with a package-lock.json, else npm install.">
              <Input className="voice-agent" value={install} onChange={(e) => setInstall(e.target.value)} placeholder="npm ci" disabled={!owner} spellCheck={false} />
            </Field>
            <Field label="Test command" optional help="Empty: npm test. Exit code 0 means the tests pass.">
              <Input className="voice-agent" value={test} onChange={(e) => setTest(e.target.value)} placeholder="npm test" disabled={!owner} spellCheck={false} />
            </Field>
            <Field label="Time limit (s)" help="60 to 1800.">
              <Input value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} inputMode="numeric" disabled={!owner} />
            </Field>
          </div>
          {owner && (
            <div>
              <Button
                busy={busy}
                disabled={!dirty}
                onClick={() =>
                  void save({ checks: { runner: "container", install: install.trim() || undefined, test: test.trim() || undefined, timeoutSec: Number(timeout) || 600 } }, "Test settings saved")
                }
              >
                Save test commands
              </Button>
            </div>
          )}
        </>
      )}
      <SaveError error={error} />
    </section>
  );
}

/* ───────────── GitHub ───────────── */

const SYNC_STATE: Record<GithubSyncState, { tone: BadgeTone; icon: IconName; text: string }> = {
  off: { tone: "neutral", icon: "ring", text: "Off" },
  "not-linked": { tone: "neutral", icon: "ring", text: "No repository" },
  "no-app": { tone: "caution", icon: "info", text: "No GitHub App" },
  "not-installed": { tone: "caution", icon: "info", text: "App not installed" },
  pending: { tone: "accent", icon: "clock", text: "Sending" },
  ok: { tone: "clear", icon: "check", text: "In sync" },
  blocked: { tone: "danger", icon: "cross", text: "Stopped" },
  error: { tone: "danger", icon: "cross", text: "Error" },
};

const MODE_HELP: Record<GithubSyncMode, string> = {
  off: "Merged code stays in Cloudflare Artifacts.",
  "pull-request": "gitring pushes each merge to a branch and keeps one pull request open to your main branch. You merge on GitHub.",
  main: "gitring pushes each merge to your main branch. A person's push to main stops the sync.",
};

/** Bringing GitHub changes into main (newer servers send it with the sync status). */
interface PullStatus {
  state: "up-to-date" | "merged" | "conflict" | "error" | "pending";
  message: string;
  files?: string[];
  intentId?: string;
  compareUrl?: string;
  at?: number;
}

const PULL_STATE: Record<PullStatus["state"], { tone: BadgeTone; icon: IconName; text: string }> = {
  "up-to-date": { tone: "clear", icon: "check", text: "Up to date" },
  merged: { tone: "clear", icon: "merge", text: "Brought in" },
  conflict: { tone: "caution", icon: "info", text: "Needs a task" },
  error: { tone: "danger", icon: "cross", text: "Error" },
  pending: { tone: "accent", icon: "clock", text: "Reading" },
};

function pullOf(status: GithubSyncStatus | null): PullStatus | undefined {
  return (status as (GithubSyncStatus & { pull?: PullStatus }) | null)?.pull;
}

function SyncStatus({ status }: { status: GithubSyncStatus }) {
  const st = SYNC_STATE[status.state] ?? SYNC_STATE.error;
  const pull = pullOf(status);
  const ps = pull ? (PULL_STATE[pull.state] ?? PULL_STATE.error) : null;
  return (
    <>
      <div className="st-sync__head">
        <Badge tone={st.tone} icon={st.icon}>
          {st.text}
        </Badge>
        <span className="st-sync__msg">{status.message}</span>
      </div>
      {pull && ps && (
        <div className="st-sync__head">
          <Badge tone={ps.tone} icon={ps.icon}>
            {ps.text}
          </Badge>
          <span className="st-sync__msg">
            {pull.message}
            {pull.at ? <span className="ink-3"> · {ago(pull.at)}</span> : null}
          </span>
          {pull.intentId && <Link to={`/tasks/${encodeURIComponent(pull.intentId)}`}>Open the task</Link>}
          {pull.compareUrl && (
            <a href={pull.compareUrl} target="_blank" rel="noopener noreferrer">
              See the changes on GitHub
            </a>
          )}
        </div>
      )}
      {(status.syncedSha || status.at) && (
        <p className="np__help">
          {status.syncedSha ? (
            <>
              GitHub has main <span className="voice-agent">{shortSha(status.syncedSha)}</span>
              {status.branch ? (
                <>
                  {" "}
                  on the branch <span className="voice-agent">{status.branch}</span>
                </>
              ) : null}
            </>
          ) : null}
          {status.syncedSha && status.at ? " · " : ""}
          {status.at ? ago(status.at) : ""}
        </p>
      )}
      {(status.prUrl || status.compareUrl || status.installUrl) && (
        <p className="st-sync__links">
          {status.prUrl && (
            <a href={status.prUrl} target="_blank" rel="noopener noreferrer">
              Open the pull request{status.prNumber ? ` #${status.prNumber}` : ""}
            </a>
          )}
          {status.compareUrl && (
            <a href={status.compareUrl} target="_blank" rel="noopener noreferrer">
              Open a pull request on GitHub
            </a>
          )}
          {status.installUrl && (
            <a href={status.installUrl} target="_blank" rel="noopener noreferrer">
              Install the GitHub App
            </a>
          )}
        </p>
      )}
    </>
  );
}

function GithubSection({ projectId, owner, settings, onSaved, imported, me }: SectionProps & { imported: string | null; me: MeWithInstall | null }) {
  const uid = useId().replace(/:/g, "");
  const g = settings.github ?? { mode: "off", branch: "gitring" };
  const [repo, setRepo] = useState(g.repo ?? imported ?? "");
  const [mode, setMode] = useState<GithubSyncMode>(g.mode);
  const [branch, setBranch] = useState(g.branch || "gitring");
  const [info, setInfo] = useState<GithubRepo | null>(null);
  const live = useStore((s) => s.state?.project.github);
  const [status, setStatus] = useState<GithubSyncStatus | null>(live ?? null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // The project state carries the sync status and the socket keeps it fresh. Ask the server only when the
  // state has none, and after a save (the repository or the mode changed).
  const [ask, setAsk] = useState(() => !live);
  const [act, setAct] = useState<"send" | "pull" | null>(null);
  const { busy, error, setError, save } = useSave(projectId, onSaved);
  const saved = JSON.stringify(g);

  useEffect(() => {
    setRepo(g.repo ?? imported ?? "");
    setMode(g.mode);
    setBranch(g.branch || "gitring");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  useEffect(() => {
    if (live) setStatus(live);
  }, [live]);

  useEffect(() => {
    if (!ask) return;
    const ctl = new AbortController();
    syncStatus(projectId, ctl.signal)
      .then((s) => {
        setStatus(s);
        setStatusError(null);
      })
      .catch((e) => {
        if (!isAbort(e)) setStatusError((e as Error).message);
      })
      .finally(() => {
        if (!ctl.signal.aborted) setAsk(false);
      });
    return () => ctl.abort();
  }, [ask, projectId]);

  const name = repo.trim();
  const dirty = name !== (g.repo ?? "") || mode !== g.mode || (mode === "pull-request" && (branch.trim() || "gitring") !== (g.branch || "gitring"));
  const submit = async () => {
    if (mode !== "off" && !name) {
      setError("Choose a GitHub repository first, or turn the sync off.");
      return;
    }
    if (name && !githubRepoName(name)) {
      setError("Give the GitHub repository as owner/name, or as its https://github.com URL.");
      return;
    }
    if (await save({ github: { repo: name || undefined, mode, branch: branch.trim() || "gitring" } }, "GitHub settings saved")) setAsk(true);
  };
  const go = async (kind: "send" | "pull") => {
    setAct(kind);
    try {
      const s = kind === "send" ? await sendToGithub(projectId) : await pullFromGithub(projectId);
      setStatus(s);
      setStatusError(null);
      const pull = pullOf(s);
      const bad = kind === "send" ? s.state === "error" || s.state === "blocked" : pull?.state === "error";
      toast({ tone: bad ? "danger" : "info", title: kind === "send" ? "Send to GitHub" : "Bring GitHub changes in", text: kind === "pull" && pull ? pull.message : s.message });
    } catch (e) {
      setStatusError((e as Error).message);
    } finally {
      setAct(null);
    }
  };

  const linked = Boolean(g.repo);
  const sendWhy = !linked ? "Link a repository and save first." : g.mode === "off" ? "Turn the sync on and save first." : undefined;
  const pullWhy = !linked ? "Link a repository and save first." : undefined;
  const suggested = Boolean(imported && !g.repo && repo === imported);
  const pushWarn = info && !info.canPush && mode !== "off";
  const installUrl = me?.githubInstallUrl ?? undefined;
  const back = `/settings?project=${encodeURIComponent(projectId)}&section=github`;

  return (
    <section className="st-sec" aria-labelledby="st-github">
      <h2 className="page__h2" id="st-github">
        GitHub
      </h2>
      <p className="np__help">Send the merged code of this project to a GitHub repository, and bring changes from GitHub into gitring.</p>
      <div className="st-sync" role="status" aria-live="polite">
        {status ? <SyncStatus status={status} /> : !statusError && <span className="np-skel" style={{ width: "50%", height: 12 }} aria-hidden="true" />}
        <SaveError error={statusError} />
        <div className="st-sync__acts">
          {owner && (
            <Button size="sm" icon="send" busy={act === "send"} disabled={Boolean(sendWhy)} title={sendWhy} onClick={() => void go("send")}>
              Send to GitHub now
            </Button>
          )}
          <Button size="sm" icon="arrow-left" busy={act === "pull"} disabled={Boolean(pullWhy)} title={pullWhy} onClick={() => void go("pull")}>
            Bring GitHub changes in now
          </Button>
          {(sendWhy || pullWhy) && <span className="st-sync__result">{owner ? sendWhy : pullWhy}</span>}
        </div>
      </div>
      <div className="st-repo">
        <label className="b-field__label" htmlFor={`${uid}-repo`}>
          Repository
        </label>
        <RepoSelect id={`${uid}-repo`} value={repo} onChange={setRepo} me={me} returnTo={back} disabled={!owner} describedBy={`${uid}-repo-help`} onRepoInfo={setInfo} />
        <div className="st-repo__info" id={`${uid}-repo-help`}>
          {info ? (
            <>
              <span>{info.private ? "Private" : "Public"}</span>
              <span>default branch {info.defaultBranch}</span>
              <span className={info.canPush ? undefined : "st-repo__warn"}>{info.canPush ? "you can push" : "you cannot push"}</span>
            </>
          ) : suggested ? (
            <span>gitring suggests the repository of your import. Save to link it.</span>
          ) : (
            <span>Search your repositories, or type owner/name.</span>
          )}
        </div>
      </div>
      <Segmented<GithubSyncMode>
        label="Where merged code goes"
        value={mode}
        disabled={!owner}
        onChange={setMode}
        options={[
          { value: "off", label: "Off" },
          { value: "pull-request", label: "Pull request" },
          { value: "main", label: "Straight to main" },
        ]}
      />
      <p className="np__help">{MODE_HELP[mode]}</p>
      {pushWarn && (
        <p className="st-error st-warn" role="note">
          <Icon name="info" size={12} /> You cannot push to {info?.fullName}. A person who can push links it, or ask its owner for write access.
        </p>
      )}
      {mode === "pull-request" && (
        <div className="st-row">
          <Field label="Branch name" help="gitring pushes each merge to this branch.">
            <Input className="voice-agent" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="gitring" disabled={!owner} spellCheck={false} />
          </Field>
        </div>
      )}
      {owner && (
        <div className="st-actions">
          <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => void submit()}>
            Save GitHub settings
          </Button>
        </div>
      )}
      <SaveError error={error} />
      <p className="np__help">
        The gitring GitHub App must be on the repository
        {installUrl ? (
          <>
            {" "}
            (
            <a href={installUrl} target="_blank" rel="noopener noreferrer">
              add it on GitHub
            </a>
            )
          </>
        ) : null}
        . Only a person who can push to the repository can link it.
      </p>
    </section>
  );
}

/* ───────────── webhooks ───────────── */

const EVENTS: { value: GitringEventType; label: string }[] = [
  { value: "landing", label: "A merge" },
  { value: "correction", label: "A change request" },
  { value: "decision", label: "A person decided" },
  { value: "intent", label: "A new task" },
];

const MAX_WEBHOOKS = 5;
/** The server keeps only https URLs with a host name (others are dropped without a word). */
const URL_OK = /^https:\/\/[^\s/]+\.[^\s]+$/;

function newWebhook(): WebhookTarget {
  const id = `wh_${Math.random().toString(36).slice(2, 10)}`;
  return { id, url: "", events: ["landing"], format: "json", enabled: true };
}

function WebhooksSection({ projectId, owner, settings, onSaved }: SectionProps) {
  const [list, setList] = useState<WebhookTarget[]>(settings.webhooks ?? []);
  const [tried, setTried] = useState(false);
  const { busy, error, setError, save } = useSave(projectId, onSaved);
  const saved = JSON.stringify(settings.webhooks ?? []);

  useEffect(() => {
    setList(settings.webhooks ?? []);
    setTried(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const change = (id: string, patch: Partial<WebhookTarget>) => setList((l) => l.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const bad = (w: WebhookTarget) => !URL_OK.test(w.url.trim());
  const dirty = JSON.stringify(list) !== saved;

  const submit = () => {
    setTried(true);
    if (list.some(bad)) {
      setError("Each webhook needs an https:// URL.");
      return;
    }
    void save({ webhooks: list.map((w) => ({ ...w, url: w.url.trim() })) }, "Webhooks saved");
  };

  return (
    <section className="st-sec" aria-labelledby="st-webhooks">
      <h2 className="page__h2" id="st-webhooks">
        Webhooks
      </h2>
      <p className="np__help">gitring sends a POST request to each webhook when an event happens: JSON, or a Slack message. At most {MAX_WEBHOOKS} webhooks.</p>
      {list.length === 0 && <p className="np__help">No webhooks yet.</p>}
      <ul className="st-hooks">
        {list.map((w, i) => (
          <li key={w.id} className="st-hook">
            <div className="st-row">
              <Field label={`Webhook ${i + 1}: URL`} error={tried && bad(w) ? "Use an https:// URL, for example https://hooks.slack.com/services/…" : undefined}>
                <Input
                  className="voice-agent"
                  value={w.url}
                  onChange={(e) => change(w.id, { url: e.target.value })}
                  placeholder="https://example.com/gitring"
                  inputMode="url"
                  disabled={!owner}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label="Format">
                <Select value={w.format} disabled={!owner} onChange={(e) => change(w.id, { format: e.target.value === "slack" ? "slack" : "json" })}>
                  <option value="json">JSON</option>
                  <option value="slack">Slack message</option>
                </Select>
              </Field>
            </div>
            <fieldset className="st-hook__events" disabled={!owner}>
              <legend className="b-field__label">Events</legend>
              {EVENTS.map((ev) => (
                <Checkbox
                  key={ev.value}
                  label={ev.label}
                  checked={w.events.includes(ev.value)}
                  onChange={(e) => change(w.id, { events: e.target.checked ? [...w.events, ev.value] : w.events.filter((x) => x !== ev.value) })}
                />
              ))}
            </fieldset>
            <div className="st-actions">
              <Checkbox label="On" checked={w.enabled} disabled={!owner} onChange={(e) => change(w.id, { enabled: e.target.checked })} />
              {owner && (
                <Button size="sm" variant="ghost" icon="close" onClick={() => setList((l) => l.filter((x) => x.id !== w.id))}>
                  Remove
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {owner && (
        <div className="st-actions">
          <Button icon="plus" disabled={list.length >= MAX_WEBHOOKS} onClick={() => setList((l) => [...l, newWebhook()])} title={list.length >= MAX_WEBHOOKS ? `At most ${MAX_WEBHOOKS} webhooks.` : undefined}>
            Add a webhook
          </Button>
          <Button variant="primary" busy={busy} disabled={!dirty} onClick={submit}>
            Save webhooks
          </Button>
        </div>
      )}
      {owner && dirty && <p className="np__help">The changes save when you click Save webhooks. A removed webhook stops after the save.</p>}
      <SaveError error={error} />
    </section>
  );
}
