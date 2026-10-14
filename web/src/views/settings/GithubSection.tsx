/**
 * The GitHub section of the settings: the linked repository, the sync mode and the sync status.
 * GitHub is optional. Sync is off by default.
 */
import { useEffect, useId, useState } from "react";
import { Badge, Button, Field, Input, Segmented, toast, type BadgeTone } from "../../design/components";
import { Icon, type IconName } from "../../design/icons";
import type { GithubRepo } from "../../../../src/core/accounts";
import type { GithubSyncMode, GithubSyncState, GithubSyncStatus } from "../../../../src/core/types";
import { githubRepoName } from "../../../../src/core/repo-rules";
import { type MeWithInstall } from "../../state/account";
import { isAbort, pullFromGithub, sendToGithub, syncStatus } from "../../state/github";
import { useStore } from "../../state/store";
import { ago, shortSha } from "../../state/format";
import { Link } from "../../app/router";
import { RepoSelect } from "../newproject/RepoSelect";
import { SaveError, type SectionProps, useSave } from "./shared";

/* ───────────── words and types ───────────── */

const SYNC_STATE: Record<GithubSyncState, { tone: BadgeTone; icon: IconName; text: string }> = {
  off: { tone: "neutral", icon: "ring", text: "Off" },
  "not-linked": { tone: "neutral", icon: "ring", text: "No repository" },
  "no-app": { tone: "caution", icon: "info", text: "No GitHub App" },
  "not-installed": { tone: "caution", icon: "info", text: "App not installed" },
  pending: { tone: "accent", icon: "clock", text: "On its way" },
  ok: { tone: "clear", icon: "check", text: "In sync" },
  blocked: { tone: "danger", icon: "cross", text: "Stopped" },
  error: { tone: "danger", icon: "cross", text: "Error" },
};

const MODE_HELP: Record<GithubSyncMode, string> = {
  // GitHub sync is optional: with it off, gitring follows GitHub only when a person asks.
  off: 'Merged code stays in gitring. A push on GitHub does not change main. Use "Bring GitHub changes in now" for that.',
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
  pending: { tone: "accent", icon: "clock", text: "Not read yet" },
};

function pullOf(status: GithubSyncStatus | null): PullStatus | undefined {
  return (status as (GithubSyncStatus & { pull?: PullStatus }) | null)?.pull;
}

/* ───────────── the sync status ───────────── */

/** The server names its storage host in the message "GitHub sync is off". A person reads "gitring" there. */
function plainSyncMessage(message: string): string {
  return message.replace("Cloudflare Artifacts", "gitring");
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
        <span className="st-sync__msg">{plainSyncMessage(status.message)}</span>
      </div>
      {pull && ps && (
        <div className="st-sync__head">
          <Badge tone={ps.tone} icon={ps.icon}>
            {ps.text}
          </Badge>
          <span className="st-sync__msg">
            {pull.message}
            {pull.at ? <span className="st-sync__when">{ago(pull.at)}</span> : null}
          </span>
          {pull.intentId && <Link to={`/tasks/${encodeURIComponent(pull.intentId)}`}>Open the task</Link>}
          {pull.compareUrl && (
            <a href={pull.compareUrl} target="_blank" rel="noopener noreferrer">
              See the changes on GitHub
            </a>
          )}
        </div>
      )}
      {status.syncedSha && (
        <p className="np__help">
          GitHub has main <span className="voice-agent">{shortSha(status.syncedSha)}</span>
          {status.branch ? (
            <>
              {" "}
              on the branch <span className="voice-agent">{status.branch}</span>
            </>
          ) : null}
          .
        </p>
      )}
      {status.at && <p className="np__help">Updated {ago(status.at)}.</p>}
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

/* ───────────── the section ───────────── */

export function GithubSection({ projectId, owner, settings, onSaved, imported, me }: SectionProps & { imported: string | null; me: MeWithInstall | null }) {
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
