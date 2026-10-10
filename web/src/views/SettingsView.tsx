import { useEffect, useRef, useState } from "react";
import { Badge, Button, Checkbox, CodeBlock, EmptyState, Field, Input, Segmented, Select, toast, type BadgeTone } from "../design/components";
import { Icon, type IconName } from "../design/icons";
import type { MemberInfo, Role, Visibility } from "../../../src/core/accounts";
import type { CheckSettings, GithubSyncMode, GithubSyncState, GithubSyncStatus, GitringEventType, ProjectSettings, RedoPolicy, WebhookTarget } from "../../../src/core/types";
import { githubRepoName } from "../../../src/core/repo-rules";
import {
  addMember,
  archiveProject,
  getGithubStatus,
  getSettings,
  listMembers,
  loadProjects,
  putSettings,
  removeMember,
  syncGithub,
  updateProject,
  useAccess,
} from "../state/account";
import { useStore } from "../state/store";
import { harborOrNull } from "../state/api";
import { ago, shortSha } from "../state/format";
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

export function SettingsView() {
  const access = useAccess();
  const projectId = useStore((s) => s.projectId);
  const project = useStore((s) => s.state?.project);
  const info = useStore((s) => s.projects.find((p) => p.id === s.projectId));
  const owner = access === "owner";
  const [members, setMembers] = useState<MemberInfo[] | null>(null);
  const [who, setWho] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [name, setName] = useState(info?.name ?? project?.name ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (access === "owner" || access === "member") listMembers(projectId).then(setMembers, () => setMembers([]));
  }, [projectId, access]);
  useEffect(() => {
    if (access !== "owner" && access !== "member") return;
    setLoadError(null);
    getSettings(projectId).then(setSettings, (e: Error) => setLoadError(e.message));
  }, [projectId, access]);
  useEffect(() => setName(info?.name ?? project?.name ?? ""), [info?.name, project?.name]);

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

  const visibility: Visibility = info?.visibility ?? "private";
  const isSample = projectId === "demo";
  const source = project?.source ?? info?.source;
  const imported = source?.kind === "git" ? githubRepoName(source.url) : null;

  return (
    <div className="page settings">
      <p className="page__eyebrow">
        <Icon name="info" size={14} /> Settings
      </p>
      <h1 className="page__title" tabIndex={-1}>
        {info?.name ?? project?.name ?? projectId}
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

      <section className="st-sec" aria-labelledby="st-general">
        <h2 className="page__h2" id="st-general">
          General
        </h2>
        <div className="st-row">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!owner} maxLength={80} />
          </Field>
          {owner && (
            <Button busy={busy === "name"} onClick={() => void run("name", () => updateProject(projectId, { name }).then(() => loadProjects()), "Name saved")}>
              Save name
            </Button>
          )}
        </div>
        <Segmented<Visibility>
          label="Who can see it"
          value={visibility}
          disabled={!owner}
          onChange={(v) => owner && void run("vis", () => updateProject(projectId, { visibility: v }).then(() => loadProjects()), v === "public" ? "The project is public" : "The project is private")}
          options={[
            { value: "private", label: "Private", icon: "eye" },
            { value: "public", label: "Public", icon: "waves" },
          ]}
        />
        <p className="np__help">{visibility === "private" ? "Only members see this project." : "Anyone with the link can view it. Only members can change it."}</p>
      </section>

      <section className="st-sec" aria-labelledby="st-members">
        <h2 className="page__h2" id="st-members">
          Members
        </h2>
        <p className="np__help">Owners change settings and members. Members open tasks, start agents and choose work copies. Viewers can only look.</p>
        <ul className="st-members">
          {(members ?? []).map((m) => (
            <li key={m.handle}>
              <span className="st-members__name">{m.name}</span>
              <span className="st-members__handle voice-agent">{m.handle}</span>
              <span className="st-members__role">{m.pending ? `${m.role} · invited` : m.role}</span>
              {owner && (
                <Button size="sm" variant="ghost" icon="close" onClick={() => void run(`rm:${m.handle}`, () => removeMember(projectId, m.userId ?? m.handle).then(setMembers), "Member removed")}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
        {owner && (
          <div className="st-row">
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
            <Button
              variant="primary"
              icon="plus"
              busy={busy === "add"}
              disabled={!who.trim()}
              onClick={() =>
                void run(
                  "add",
                  () =>
                    addMember(projectId, who.trim(), role).then((list) => {
                      setMembers(list);
                      setWho("");
                    }),
                  "Person added",
                )
              }
            >
              Add
            </Button>
          </div>
        )}
      </section>

      {loadError && (
        <section className="st-sec">
          <SaveError error={`The settings did not load. ${loadError}`} />
        </section>
      )}
      {settings && (
        <>
          <MergingSection projectId={projectId} owner={owner} settings={settings} onSaved={setSettings} />
          <ChecksSection projectId={projectId} owner={owner} settings={settings} onSaved={setSettings} />
          <GithubSection projectId={projectId} owner={owner} settings={settings} onSaved={setSettings} imported={imported} />
          <WebhooksSection projectId={projectId} owner={owner} settings={settings} onSaved={setSettings} />
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

      {owner && !isSample && (
        <section className="st-sec st-danger" aria-labelledby="st-danger">
          <h2 className="page__h2" id="st-danger">
            Archive
          </h2>
          <p className="np__help">The project leaves every list. Its repository stays in Artifacts.</p>
          <div>
            <Button
              variant="danger"
              busy={busy === "archive"}
              onClick={() => {
                if (!confirm(`Archive ${info?.name ?? projectId}?`)) return;
                void run(
                  "archive",
                  () =>
                    archiveProject(projectId).then(() => {
                      // A full load: the archived project's socket and state go away.
                      location.href = "/projects";
                    }),
                  "Project archived",
                );
              }}
            >
              Archive project
            </Button>
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
          <Button busy={busy} onClick={submit}>
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
          : "A Dynamic Worker runs tests/*.test.js with the gitring test runner. No dependencies and no network. The sample uses it."}
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
  pending: { tone: "accent", icon: "clock", text: "Waiting" },
  ok: { tone: "clear", icon: "check", text: "In sync" },
  blocked: { tone: "danger", icon: "cross", text: "Stopped" },
  error: { tone: "danger", icon: "cross", text: "Error" },
};

const MODE_HELP: Record<GithubSyncMode, string> = {
  off: "Merged code stays in Cloudflare Artifacts.",
  "pull-request": "gitring pushes each merge to a branch and keeps one pull request open to your main branch. You merge on GitHub.",
  main: "gitring pushes each merge to your main branch. A person's push to main stops the sync.",
};

function SyncStatus({ status }: { status: GithubSyncStatus }) {
  const st = SYNC_STATE[status.state] ?? SYNC_STATE.error;
  return (
    <div className="st-sync" role="status">
      <div className="st-sync__head">
        <Badge tone={st.tone} icon={st.icon}>
          {st.text}
        </Badge>
        <span className="st-sync__msg">{status.message}</span>
      </div>
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
    </div>
  );
}

function GithubSection({ projectId, owner, settings, onSaved, imported }: SectionProps & { imported: string | null }) {
  const g = settings.github ?? { mode: "off", branch: "gitring" };
  const [repo, setRepo] = useState(g.repo ?? imported ?? "");
  const [mode, setMode] = useState<GithubSyncMode>(g.mode);
  const [branch, setBranch] = useState(g.branch || "gitring");
  const [status, setStatus] = useState<GithubSyncStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { busy, error, setError, save } = useSave(projectId, onSaved);
  const live = useStore((s) => s.state?.project.github);
  const firstLive = useRef(live);
  const saved = JSON.stringify(g);
  const [app, setApp] = useState<{ installUrl: string } | null>(null);
  useEffect(() => {
    harborOrNull()
      ?.connect()
      .then((i) => setApp(i.githubApp))
      .catch(() => setApp(null));
  }, [projectId]);

  useEffect(() => {
    setRepo(g.repo ?? imported ?? "");
    setMode(g.mode);
    setBranch(g.branch || "gitring");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const loadStatus = () => {
    getGithubStatus(projectId).then(
      (s) => {
        setStatus(s);
        setStatusError(null);
      },
      (e: Error) => setStatusError(e.message),
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadStatus, [projectId, saved]);
  // A sync that runs now reports over the live connection (event "github").
  useEffect(() => {
    if (!live || live === firstLive.current) return;
    if (g.mode !== "off" && (!live.repo || live.repo === g.repo)) setStatus(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const submit = () => {
    const name = repo.trim();
    if (mode !== "off" && !name) {
      setError("Give the GitHub repository as owner/name, or as its https://github.com URL.");
      return;
    }
    if (name && !githubRepoName(name)) {
      setError("Give the GitHub repository as owner/name, or as its https://github.com URL.");
      return;
    }
    void save({ github: { repo: name || undefined, mode, branch: branch.trim() || "gitring" } }, "GitHub settings saved");
  };
  const syncNow = async () => {
    setSyncing(true);
    try {
      setStatus(await syncGithub(projectId));
      setStatusError(null);
    } catch (e) {
      setStatusError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const suggested = Boolean(imported && !g.repo && repo === imported);
  return (
    <section className="st-sec" aria-labelledby="st-github">
      <h2 className="page__h2" id="st-github">
        GitHub
      </h2>
      <p className="np__help">Send the merged code of this project to a GitHub repository.</p>
      {status ? <SyncStatus status={status} /> : !statusError && <p className="np__help">gitring loads the sync status…</p>}
      <SaveError error={statusError} />
      <div className="st-row">
        <Field
          label="Repository"
          help={suggested ? "gitring suggests the repository of your import. Save to link it." : "owner/name, or a github.com URL."}
        >
          <Input
            className="voice-agent"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/name"
            disabled={!owner}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
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
      {mode === "pull-request" && (
        <div className="st-row">
          <Field label="Branch name" help="gitring pushes each merge to this branch.">
            <Input className="voice-agent" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="gitring" disabled={!owner} spellCheck={false} />
          </Field>
        </div>
      )}
      {owner && (
        <div className="st-actions">
          <Button busy={busy} onClick={submit}>
            Save
          </Button>
          <Button icon="reload" busy={syncing} disabled={g.mode === "off"} onClick={() => void syncNow()} title={g.mode === "off" ? "Turn the sync on first." : undefined}>
            Sync now
          </Button>
        </div>
      )}
      <SaveError error={error} />
      <p className="np__help">
        The gitring GitHub App must be installed on the repository
        {app ? (
          <>
            {" "}
            (
            <a href={app.installUrl} target="_blank" rel="noopener noreferrer">
              install the app
            </a>
            )
          </>
        ) : null}
        . To link a repository, sign in with GitHub as a person who can push to it.
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
          <Button variant="primary" busy={busy} onClick={submit}>
            Save webhooks
          </Button>
        </div>
      )}
      <SaveError error={error} />
    </section>
  );
}
