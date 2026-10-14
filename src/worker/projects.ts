/**
 * Project creation, shared by REST (POST /api/projects) and MCP (gitring_create_project).
 *
 * One code path: an agent and a person get the same checks and the same project.
 * People own their projects. The operator key (scripts) makes projects that no person owns.
 * Also here: the git command that clones a project with a read token (the token goes in a header).
 */
import type { Env } from "./env";
import type * as T from "../core/types";
import type * as A from "../core/accounts";
import { actorOf, directory, type Principal } from "./auth";
import { readAsPerson } from "./github";
import type { RepoJson } from "../platform/github/repos";
import { GithubClient, GithubError } from "../platform/github/api";
import { githubRepoName, normalizeGitUrl } from "../core/repo-rules";
import { isTemplateId, TEMPLATES } from "../core/templates";
import { tokenSecret } from "../platform/repo/artifacts";
import { retryAfterReset } from "./mcp-kit";
import type { SeedFile } from "../harbor/harbor";

/*
 * What a new project is made of:
 *
 *   source   template | empty | upload (files) | push | git (any https URL) | github (one import among
 *            others; GitHub sync starts off)
 *   seed     HarborMaster.init: the files in one commit, or an import that runs in the background
 *   settings the tests (when the caller gives them), the GitHub link of a GitHub import
 *   task     optional: the first task, and built-in agents that start on it (also after an import)
 *
 * People own their projects. The operator key (scripts) makes projects that no person owns.
 * Also here: the git command that clones a project with a read token (the token goes in a header).
 */

/** A refusal with the HTTP status for REST (MCP shows the message). `extra` goes into the JSON answer (installUrl). */
export class ProjectError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 502,
    message: string,
    readonly extra: Record<string, string> = {},
  ) {
    super(message);
  }
}

export interface CreateProjectInput {
  name?: string;
  /** A wished id (it must start with the slug of the name). */
  id?: string;
  visibility?: A.Visibility;
  /** Raw: parseSource checks it. */
  source?: unknown;
  /** The files of an upload. */
  files?: SeedFile[];
  settings?: Partial<T.ProjectSettings>;
  /** The first task. A goal without a title gets a title from its first sentence. */
  firstTask?: { title?: string; goal?: string };
  /** Built-in agents that start on the first task (0–4). After an import, they start when the import is done. */
  launch?: number;
}

export interface CreatedProject {
  project: A.ProjectInfo;
  state: T.ProjectState;
  task?: T.Intent;
  /** Work copies of the built-in agents that started. */
  launched: string[];
  /** The agents start when the import is done. */
  launchAfterImport?: boolean;
  /** The first task or the built-in agents did not start. The project exists; this sentence says why. */
  note?: string;
}

function harbor(env: Env, id: string) {
  const objectId = env.HARBOR.idFromName(id);
  return retryAfterReset(() => env.HARBOR.get(objectId));
}

/** The source of a new project, checked. `files`: the files of an upload. */
export function parseSource(raw: unknown, files?: unknown): T.ProjectSource {
  const s = (raw ?? {}) as Record<string, unknown>;
  const branchOf = () => (typeof s.branch === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(s.branch) ? s.branch : undefined);
  switch (s.kind) {
    case "empty":
      return { kind: "empty" };
    case "template": {
      if (!isTemplateId(s.template)) throw new ProjectError(400, `Choose a template: ${TEMPLATES.map((t) => t.id).join(", ")}.`);
      return { kind: "template", template: s.template };
    }
    case "push":
      return { kind: "push" };
    case "upload": {
      if (!Array.isArray(files) || !files.length) throw new ProjectError(400, "Send the files of the folder.");
      return { kind: "upload", files: files.length };
    }
    case "git": {
      let url: string;
      try {
        url = normalizeGitUrl(String(s.url ?? ""));
      } catch (e) {
        throw new ProjectError(400, String((e as Error).message));
      }
      const hostname = new URL(url).hostname;
      const host = /(^|\.)github\.com$/.test(hostname) ? "github" : /(^|\.)gitlab\.com$/.test(hostname) ? "gitlab" : /(^|\.)bitbucket\.org$/.test(hostname) ? "bitbucket" : "other";
      const branch = branchOf();
      return { kind: "git", url, host, ...(branch ? { branch } : {}) };
    }
    case "github": {
      const repo = githubRepoName(String(s.repo ?? ""));
      if (!repo) throw new ProjectError(400, "Give the GitHub repository as owner/name or as its GitHub URL.");
      const branch = branchOf();
      return { kind: "github", repo, ...(branch ? { branch } : {}) };
    }
    default:
      throw new ProjectError(400, "Choose a source: template, empty, upload, push, git (an https URL) or github.");
  }
}

/** A task title from a description: its first sentence, at most 80 characters. */
export function titleOf(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s+|\n/)[0]?.trim().replace(/[.!?]+$/, "") ?? "";
  if (first.length <= 80) return first;
  const cut = first.slice(0, 80);
  return `${cut.slice(0, Math.max(40, cut.lastIndexOf(" ")))}…`;
}

/**
 * The facts of a GitHub import: GitHub must show the repository to the person (or to nobody, for a
 * public one). A private repository needs the gitring GitHub app and goes only into a private project.
 */
async function githubFacts(env: Env, user: A.UserInfo | null, repo: string, branch?: string): Promise<{ source: T.ProjectSource; visibility?: A.Visibility; canPush: boolean; verified: boolean }> {
  const anon = () => new GithubClient(null, { cacheKey: "anon" }).json<RepoJson>(`/repos/${repo}`);
  const notFound = () => new ProjectError(404, `gitring cannot read ${repo}. It is private, or the name is wrong. Connect GitHub, or use Push with git.`);
  // The operator key (scripts) reads as nobody: public repositories only.
  let meta: (Omit<RepoJson, "private"> & { private?: boolean }) | null;
  let verified = false;
  try {
    meta = await (user ? readAsPerson(env, user.id, (gh) => gh.json<RepoJson>(`/repos/${repo}`)) : anon());
    verified = true;
  } catch (e) {
    if (!(e instanceof GithubError) || (e.status !== 403 && e.status !== 429)) throw new ProjectError(502, `gitring could not ask GitHub about ${repo}. Try again.`);
    // GitHub limits anonymous calls per address, and Workers share addresses. One cheap read without a
    // token (an answer with a known ETag costs no quota) says whether the repository is public. Without
    // an answer, the facts stay unknown: Artifacts imports public repositories only, so a private one
    // fails there, and gitring records no read right for the person.
    const probe = await anon().catch(() => undefined);
    if (probe === null) throw notFound();
    verified = Boolean(probe);
    meta = probe ?? { full_name: repo, html_url: `https://github.com/${repo}` };
  }
  if (!meta) throw notFound();
  if (meta.archived) throw new ProjectError(400, `${meta.full_name} is archived on GitHub.`);
  const access = await directory(env)
    .githubRepoAccess(meta.full_name)
    .catch(() => ({ ok: false as const, message: "gitring could not ask GitHub.", installUrl: undefined }));
  if (meta.private && !access.ok) {
    throw new ProjectError(403, `Install the gitring GitHub app on ${meta.full_name} to import it.`, access.installUrl ? { installUrl: access.installUrl } : {});
  }
  const canPush = verified && access.ok && Boolean(meta.permissions?.push || meta.permissions?.admin || meta.permissions?.maintain);
  const b = branch || meta.default_branch;
  return {
    source: { kind: "github", repo: meta.full_name, ...(b ? { branch: b } : {}), ...(meta.private !== undefined ? { private: meta.private } : {}) },
    // Code of a private repository only goes into a private project.
    visibility: meta.private ? "private" : undefined,
    canPush,
    verified,
  };
}

/**
 * Create a project for the caller (contract C5). REST and the MCP tool gitring_create_project call it.
 * Throws ProjectError for a refusal. A project whose repository could not be made is removed again.
 */
export async function createProjectFor(env: Env, principal: Principal, input: CreateProjectInput): Promise<CreatedProject> {
  // People own their projects. The operator key (scripts) makes projects that no person owns.
  const user = principal.via === "operator" ? null : principal.user;
  if (!user && principal.via !== "operator") throw new ProjectError(401, "Sign in first.");
  let source = parseSource(input.source, input.files);
  let visibility = input.visibility;
  let gh: { canPush: boolean; verified: boolean } | undefined;
  if (source.kind === "github") {
    const facts = await githubFacts(env, user, source.repo, source.branch);
    source = facts.source;
    visibility = facts.visibility ?? visibility ?? "public";
    gh = facts;
  }
  const dir = directory(env);
  let info: A.ProjectInfo;
  try {
    const name = input.name ?? (source.kind === "github" ? source.repo.split("/")[1] : "");
    info = await dir.createProject({ name, id: input.id, visibility, source, ownerId: user?.id ?? null });
  } catch (e) {
    throw new ProjectError(400, String((e as Error)?.message ?? e).replace(/^Error: /, ""));
  }
  const h = harbor(env, info.id);
  const state = await seedProject(dir, h, info, source, user, input, gh);
  // The project exists from here on: a first task or agents that fail do not undo it (the note says why).
  const out: CreatedProject = { project: info, state, launched: [] };
  return openFirstTask(principal, h, input, out);
}

/** Put the files and settings into the new project. A project that cannot start is removed again. */
async function seedProject(
  dir: ReturnType<typeof directory>,
  h: ReturnType<typeof harbor>,
  info: A.ProjectInfo,
  source: T.ProjectSource,
  user: A.UserInfo | null,
  input: CreateProjectInput,
  gh: { canPush: boolean; verified: boolean } | undefined,
): Promise<T.ProjectState> {
  let state: T.ProjectState;
  try {
    const files = source.kind === "upload" && Array.isArray(input.files) ? input.files : undefined;
    state = (await h.init({ projectId: info.id, name: info.name, source, ownerId: user?.id, files })) as unknown as T.ProjectState;
    const wanted: Partial<T.ProjectSettings> = {};
    if (input.settings?.checks) wanted.checks = input.settings.checks;
    if (input.settings?.redo) wanted.redo = input.settings.redo;
    if (source.kind === "github") {
      // GitHub is optional: sync starts off. A person who can push may turn it on here, or later in Settings → GitHub.
      const mode = gh?.canPush ? (input.settings?.github?.mode ?? "off") : "off";
      wanted.github = { repo: source.repo, mode, branch: input.settings?.github?.branch ?? "gitring", ...(source.branch ? { base: source.branch } : {}) };
    }
    if (Object.keys(wanted).length) {
      await h.updateSettings(wanted);
      // The importer is the person whose GitHub rights gitring re-checks for sync and pulls. A read that
      // GitHub did not confirm is not recorded: the first pull asks GitHub.
      if (source.kind === "github" && user) await h.setGithubActor(user.id, { read: Boolean(gh?.verified), push: Boolean(gh?.canPush), ...(source.private !== undefined ? { private: source.private } : {}) });
      state = (await h.state()) as unknown as T.ProjectState;
    }
  } catch (e) {
    await dir.dropProject(info.id).catch(() => undefined);
    throw e instanceof ProjectError ? e : new ProjectError(400, String((e as Error)?.message ?? e).replace(/^Error: /, ""));
  }
  return state;
}

/** The first task of a new project, and the built-in agents that start on it. A failure here does not undo the project. */
async function openFirstTask(principal: Principal, h: ReturnType<typeof harbor>, input: CreateProjectInput, out: CreatedProject): Promise<CreatedProject> {
  const goal = String(input.firstTask?.goal ?? "").trim();
  const title = String(input.firstTask?.title ?? "").trim() || titleOf(goal);
  if (!title) return out;
  const by = actorOf(principal);
  const why = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error: /, "").slice(0, 300);
  try {
    out.task = (await h.createIntent({ title, goal: goal || title, source: { kind: principal.via === "session" ? "ui" : "mcp" } }, by)) as unknown as T.Intent;
  } catch (e) {
    out.note = `The project is ready. gitring did not open the first task: ${why(e)}`;
    return out;
  }
  const fanout = Math.max(0, Math.min(4, Math.round(Number(input.launch) || 0)));
  if (fanout) {
    try {
      const started = await h.launchWhenReady(out.task.id, fanout, by);
      out.launched = started.attempts;
      if (started.afterImport) out.launchAfterImport = true;
    } catch (e) {
      out.note = `The first task is open. The built-in agents did not start: ${why(e)}`;
    }
  }
  return out;
}

/** A clone of a project with plain git: the read token goes in a header, never in the URL or in .git/config. */
export interface CloneHelp {
  remote: string;
  branch: string;
  /** The read token (6 hours). Keep it private. */
  token: string;
  expiresAt: string;
  /** The header that git sends: "Authorization: Basic …". */
  header: string;
  /** git clone with the header. */
  clone: string;
  /** git pull later, in the clone (while the token is valid). */
  pull: string;
}

export function cloneHelp(access: { remote: string; token: string; expiresAt: string; branch: string }, dir: string): CloneHelp {
  const header = `Authorization: Basic ${btoa(`x:${tokenSecret(access.token)}`)}`;
  const folder = dir.replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
  return {
    remote: access.remote,
    branch: access.branch,
    token: access.token,
    expiresAt: access.expiresAt,
    header,
    clone: `git -c http.extraHeader="${header}" clone --branch ${access.branch} ${access.remote} ${folder}`,
    pull: `git -c http.extraHeader="${header}" pull`,
  };
}
