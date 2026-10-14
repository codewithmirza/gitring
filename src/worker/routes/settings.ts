/**
 * The routes of project setup: tokens, import check, launch all, GitHub link, connect info, usage and settings.
 *
 * Mounted by app.ts. Settings that decide when a person says yes to a merge change only in the app, never by a key.
 * Read next: src/worker/github.ts (GitHub App routes) and src/harbor/harbor.ts (settings, GitHub link).
 */
import type { Hono } from "hono";
import type * as T from "../../core/types";
import { atLeast } from "../../core/accounts";
import { githubRepoName } from "../../core/repo-rules";
import { actorOf, directory } from "../auth";
import { access, err, HTTPError, needUser, projectId, ready, type C, type HonoEnv } from "../http";
import { cloneHelp } from "../projects";

/** The settings that decide when a person must say yes before a merge. */
const APPROVAL_SETTINGS = ["landing", "approver", "autoLand", "allowUntested"] as const;

type ReadyProject = Awaited<ReturnType<typeof ready>>;

/**
 * A change of the GitHub settings. It checks what the person may do on GitHub, then saves the settings.
 * It answers when it has answered (an error, or the saved settings). It answers null when the change needs no check.
 */
async function changeGithubLink(c: C, h: ReadyProject, body: Partial<T.ProjectSettings>, raw: Record<string, unknown>): Promise<Response | null> {
  // The GitHub settings after this change (a field that the patch leaves out keeps its value).
  const current = (await h.settings()).github;
  let repo = current.repo;
  if ("repo" in raw) {
    const text = typeof raw.repo === "string" ? raw.repo.trim() : "";
    repo = text ? (githubRepoName(text) ?? undefined) : undefined;
    if (text && !repo) return c.json({ error: "Give the GitHub repository as owner/name, or as its https://github.com URL." }, 400);
    body.github = { ...(body.github as T.GithubSettings), repo: repo ?? "" };
  }
  const mode = typeof raw.mode === "string" ? raw.mode : current.mode;
  const branch = typeof raw.branch === "string" ? raw.branch.trim() : current.branch;
  const base = "base" in raw ? (typeof raw.base === "string" ? raw.base.trim() : "") : (current.base ?? "");
  const relinked = Boolean(repo) && repo!.toLowerCase() !== current.repo?.toLowerCase();
  // Pushing needs a person who can push on GitHub now: turning sync on, or changing where or how it
  // goes (the mode, the pull request branch, the base branch).
  const pushes = Boolean(repo) && mode !== "off" && (relinked || current.mode === "off" || mode !== current.mode || branch !== current.branch || base !== (current.base ?? ""));
  const principal = c.get("principal");
  if (repo && principal.via !== "operator") {
    // The person behind the link left the project: the owner who saves the settings takes their place.
    const facts = await h.githubFacts().catch(() => ({}) as Awaited<ReturnType<typeof h.githubFacts>>);
    const actorGone = Boolean(facts.actor?.gone) && facts.repo?.toLowerCase() === repo.toLowerCase();
    if (relinked || pushes || actorGone) {
      const user = needUser(c);
      const perm = await directory(c.env).githubPermission(user.id, repo);
      const needPush = pushes || (actorGone && mode !== "off");
      if (needPush && !perm.installed) return c.json({ error: `Install the gitring GitHub App on ${repo} first.`, ...(perm.installUrl ? { installUrl: perm.installUrl } : {}) }, 403);
      if (needPush && !perm.push) return c.json({ error: perm.message }, 403);
      if (!perm.read) return c.json({ error: perm.message, ...(perm.installUrl ? { installUrl: perm.installUrl } : {}) }, 403);
      // A public project links a repository only when GitHub says that it is public.
      if (perm.private !== false && (await directory(c.env).visibilityOf(projectId(c.req.param("p")))) === "public") {
        const why = perm.private ? `${repo} is private on GitHub, and this project is public.` : `gitring could not find out whether ${repo} is private on GitHub.`;
        return c.json({ error: `${why} Make the project private first.` }, 400);
      }
      const out = await h.updateSettings(body);
      await h.setGithubActor(user.id, { read: perm.read, push: perm.push, ...(perm.private !== undefined ? { private: perm.private } : {}) });
      return c.json(out);
    }
  }
  return null;
}

export function settingsRoutes(app: Hono<HonoEnv>): void {
  projectToolRoutes(app);
  githubLinkRoutes(app);
  connectAndSettingsRoutes(app);
}

/** Tokens for git, the import check and launch all. */
function projectToolRoutes(app: Hono<HonoEnv>): void {
  /** A push project: a 24-hour write token for the owner's first `git push`. */
  app.post("/api/projects/:p/push-token", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "owner");
      return c.json(await h.pushAccess());
    } catch (e) {
      return err(c, e);
    }
  });

  /** A member clones the project with plain git: a 6-hour read token, sent in a header (never in the URL). */
  app.post("/api/projects/:p/clone-token", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "member");
      const project = projectId(c.req.param("p"));
      return c.json(cloneHelp(await h.cloneAccess(), project));
    } catch (e) {
      return err(c, e);
    }
  });

  /** Look for the push (or the end of an import) now. */
  app.post("/api/projects/:p/import/check", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "member");
      const st = (await h.checkImport()) as unknown as T.ProjectState;
      return c.json({ importing: st.project.importing ?? null, mainSha: st.project.mainSha });
    } catch (e) {
      return err(c, e);
    }
  });

  app.post("/api/projects/:p/launch-all", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "member");
      return c.json(await h.launchAll(actorOf(c.get("principal"))));
    } catch (e) {
      return err(c, e);
    }
  });
}

/** The status of the GitHub link, sync now and pull now. */
function githubLinkRoutes(app: Hono<HonoEnv>): void {
  /** GitHub sync status (members) and Sync now (owners). */
  app.get("/api/projects/:p/github", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "member");
      return c.json(await h.githubStatus());
    } catch (e) {
      return err(c, e);
    }
  });

  app.post("/api/projects/:p/github/sync", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "owner");
      return c.json(await h.githubSync());
    } catch (e) {
      return err(c, e);
    }
  });

  /** Bring GitHub changes into main now (members). */
  app.post("/api/projects/:p/github/pull", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "member");
      return c.json(await h.githubPull({ reason: "manual" }));
    } catch (e) {
      return err(c, e);
    }
  });
}

/** Connect info, settings, usage and the operator diagnostics. */
function connectAndSettingsRoutes(app: Hono<HonoEnv>): void {
  app.get("/api/projects/:p/connect", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "viewer");
      const info = await h.connectInfo(new URL(c.req.url).origin);
      if (atLeast(h.role, "member")) return c.json(info);
      // Viewers get the public addresses only: no repository names, and no hook URLs with keys.
      const { artifacts: _artifacts, slackUrl: _slack, githubHookUrl: _github, ...pub } = info;
      return c.json({ ...pub, artifacts: { namespace: "", repo: "", backend: info.artifacts.backend } });
    } catch (e) {
      return err(c, e);
    }
  });

  app.get("/api/projects/:p/settings", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "member");
      return c.json(await h.settings());
    } catch (e) {
      return err(c, e);
    }
  });

  /** Use of a project in a month (counters only: merges, container test runs, built-in agent tokens). */
  app.get("/api/projects/:p/usage", async (c) => {
    try {
      const { id } = await access(c, c.req.param("p"), "member");
      const month = c.req.query("month");
      return c.json(await directory(c.env).usageOf(id, month && /^d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : undefined));
    } catch (e) {
      return err(c, e);
    }
  });

  app.put("/api/projects/:p/settings", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "owner");
      const body = await c.req.json<Partial<T.ProjectSettings>>().catch(() => ({}) as Partial<T.ProjectSettings>);
      // These settings decide when a person must say yes before a merge. A person changes them in the gitring app:
      // an agent with a key must not switch the question off.
      const caller = c.get("principal");
      if (caller.via !== "session" && caller.via !== "operator" && APPROVAL_SETTINGS.some((k) => body && typeof body === "object" && k in body)) {
        throw new HTTPError(403, "A person must change this setting in the gitring app. A key or an agent token cannot change when a person says yes to a merge.");
      }
      const raw = body?.github && typeof body.github === "object" ? (body.github as unknown as Record<string, unknown>) : undefined;
      if (raw) {
        const answer = await changeGithubLink(c, h, body, raw);
        if (answer) return answer;
      }
      return c.json(await h.updateSettings(body));
    } catch (e) {
      return err(c, e);
    }
  });

  /** Operator only: diagnostics of a check container (name = "<project>:<attempt>"). */
  app.get("/api/ops/drydock", async (c) => {
    if (c.get("principal").via !== "operator") return c.json({ error: "Operator key only." }, 403);
    const name = c.req.query("name") ?? "diag";
    return c.json(await c.env.DRYDOCK.get(c.env.DRYDOCK.idFromName(name)).diag({ instance: c.req.query("instance"), internet: c.req.query("internet") === "1" }));
  });
}
