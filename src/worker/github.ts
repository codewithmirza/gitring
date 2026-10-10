/**
 * GitHub for people: the repositories they can import, and a guess for a new project from one of them.
 *
 *   GET /api/github/repos[?refresh=1]          repositories of the gitring app's installations that the
 *                                               person can see (cached a minute; refresh after an install)
 *   GET /api/github/guess?repo=owner/name       name, id, branch, install and test commands, sync mode
 *
 * gitring calls GitHub with the person's GitHub App user token: GitHub shows only what the person may see.
 * The Directory keeps the token sealed and refreshes it; this isolate keeps it for a few minutes.
 */
import type { Context, Hono } from "hono";
import type { Env } from "./env";
import type * as A from "../core/accounts";
import { directory, type Principal } from "./auth";
import { GithubClient, GithubError } from "../platform/github/api";
import { guessFromGithub, listUserRepos, type InstallationInfo } from "../platform/github/repos";
import { cleanCommand, projectSlug } from "../core/guess";
import { githubRepoName } from "../core/repo-rules";
import { chat } from "../platform/ai/models";
import { rand } from "../harbor/ids";

type HonoEnv = { Bindings: Env; Variables: { principal: Principal } };
type C = Context<HonoEnv>;

/* ───────────── user tokens (isolate cache) ───────────── */

const tokens = new Map<string, { token: string; until: number }>();

async function userToken(env: Env, userId: string, invalid?: string): Promise<{ ok: true; token: string } | { ok: false; reason: string; state: string }> {
  const hit = tokens.get(userId);
  if (hit && hit.until > Date.now() && hit.token !== invalid) return { ok: true, token: hit.token };
  const res = await directory(env).githubUserToken(userId, invalid);
  if (!res.ok) {
    tokens.delete(userId);
    return { ok: false, reason: res.reason, state: res.state };
  }
  // Keep it until 5 minutes before it expires, at most 10 minutes.
  const until = Math.min(Date.now() + 10 * 60_000, res.expiresAt ? res.expiresAt - 5 * 60_000 : Infinity);
  tokens.set(userId, { token: res.token, until });
  return { ok: true, token: res.token };
}

/** Run `fn` with the person's GitHub client; when GitHub refuses the token, refresh it once and try again. */
async function withGithub<T>(env: Env, userId: string, fn: (gh: GithubClient) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string; state: string }> {
  let t = await userToken(env, userId);
  if (!t.ok) return t;
  try {
    return { ok: true, value: await fn(new GithubClient(t.token, { cacheKey: `u:${userId}` })) };
  } catch (e) {
    if (!(e instanceof GithubError) || e.status !== 401) throw e;
    t = await userToken(env, userId, t.token);
    if (!t.ok) return t;
    return { ok: true, value: await fn(new GithubClient(t.token, { cacheKey: `u:${userId}` })) };
  }
}

export function forgetGithubUser(userId: string): void {
  tokens.delete(userId);
  for (const k of lists.keys()) if (k === userId) lists.delete(k);
}

/* ───────────── repository lists (isolate cache) ───────────── */

type RepoList = A.GithubRepoList & { installations?: InstallationInfo[]; complete?: boolean };
const lists = new Map<string, { at: number; value: RepoList }>();
const LIST_TTL_MS = 60_000;

const guesses = new Map<string, { at: number; value: A.ProjectGuess }>();
const GUESS_TTL_MS = 5 * 60_000;

/** Short browser caching of a person's own data; Vary keeps one person's answer from another. */
const PRIVATE_SHORT = { "cache-control": "private, max-age=30", vary: "Cookie, Authorization" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function githubRoutes(app: Hono<HonoEnv>): void {
  /** Disconnect GitHub: gitring revokes and forgets the GitHub token. Signing in with GitHub still works. */
  app.delete("/api/me/github", async (c) => {
    const p = c.get("principal");
    if (!p.user || p.via !== "session") return json({ error: "Sign in first." }, 401);
    await directory(c.env).githubDisconnect(p.user.id);
    forgetGithubUser(p.user.id);
    return new Response(null, { status: 204 });
  });

  app.get("/api/github/repos", async (c) => {
    const user = c.get("principal").user;
    if (!user) return json({ error: "Sign in first." }, 401);
    const providers = await directory(c.env).providers();
    const installUrl = providers.github?.installUrl;
    if (!providers.github) return json({ connected: false, repos: [], reason: "This gitring has no GitHub App. An owner sets it up on /setup." } satisfies RepoList);
    // ?q= filters the list (name, owner, description); the full list stays cached for the next keystroke.
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const filtered = (v: RepoList): RepoList => (q ? { ...v, repos: v.repos.filter((r) => r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)) } : v);
    const cached = lists.get(user.id);
    const refresh = c.req.query("refresh") === "1";
    if (refresh) await directory(c.env).forgetGithubMisses().catch(() => undefined);
    if (cached && !refresh && Date.now() - cached.at < LIST_TTL_MS) return json(filtered(cached.value), 200, PRIVATE_SHORT);
    let res;
    try {
      res = await withGithub(c.env, user.id, (gh) => listUserRepos(gh));
    } catch (e) {
      return json({ connected: true, repos: [], installUrl, reason: e instanceof GithubError ? e.message : "gitring could not read your repositories from GitHub. Try again." } satisfies RepoList, 502);
    }
    if (!res.ok) return json({ connected: false, repos: [], installUrl, reason: res.reason } satisfies RepoList);
    const value: RepoList = {
      connected: true,
      repos: res.value.repos,
      installUrl,
      installations: res.value.installations,
      complete: res.value.complete,
      ...(res.value.repos.length ? {} : { reason: res.value.installations.length ? "The GitHub app sees no repositories. Add repositories on GitHub." : "Install the gitring GitHub app on your repositories to see them here." }),
    };
    lists.set(user.id, { at: Date.now(), value });
    if (lists.size > 2000) lists.delete(lists.keys().next().value!);
    return json(filtered(value), 200, PRIVATE_SHORT);
  });

  app.get("/api/github/guess", async (c) => {
    const user = c.get("principal").user;
    if (!user) return json({ error: "Sign in first." }, 401);
    const repo = githubRepoName(c.req.query("repo") ?? "");
    if (!repo) return json({ error: "Give the repository as owner/name or as its GitHub URL." }, 400);
    const branch = /^[A-Za-z0-9._/-]{1,100}$/.test(c.req.query("branch") ?? "") ? c.req.query("branch") : undefined;
    const key = `${user.id}|${repo.toLowerCase()}|${branch ?? ""}`;
    const hit = guesses.get(key);
    if (hit && Date.now() - hit.at < GUESS_TTL_MS) return json(hit.value, 200, PRIVATE_SHORT);
    try {
      const value = await guessProject(c.env, user.id, repo, branch);
      guesses.set(key, { at: Date.now(), value });
      if (guesses.size > 2000) guesses.delete(guesses.keys().next().value!);
      return json(value, 200, PRIVATE_SHORT);
    } catch (e) {
      const status = (e as { status?: number }).status === 404 ? 404 : e instanceof GithubError ? 502 : 400;
      return json({ error: String((e as Error).message ?? e) }, status);
    }
  });
}

/**
 * Read a repository as the person (their token), or anonymously when they did not connect GitHub (public
 * repositories only). gitring never reads a repository with its app token for a person who cannot see it.
 */
export async function readAsPerson<T>(env: Env, userId: string, fn: (gh: GithubClient) => Promise<T>): Promise<T> {
  const res = await withGithub(env, userId, fn);
  if (res.ok) return res.value;
  return fn(new GithubClient(null, { cacheKey: "anon" }));
}

async function guessProject(env: Env, userId: string, repo: string, branch?: string): Promise<A.ProjectGuess> {
  const found = await readAsPerson(env, userId, (gh) => guessFromGithub(gh, repo, branch));
  const access = await directory(env)
    .githubRepoAccess(found.meta.fullName)
    .catch(() => ({ ok: false as const }));
  const installed = access.ok;
  const reasons = [...found.guess.reasons];
  let { install, test } = found.guess;
  let guessed = false;
  if (!found.guess.confident && env.AI) {
    const ai = await askModel(env, found.meta.fullName, found.meta.defaultBranch, userId).catch(() => null);
    if (ai?.test) {
      install = ai.install ?? install;
      test = ai.test;
      guessed = true;
      reasons.push(`Guess: a model read the README and the file list${ai.why ? ` (${ai.why})` : ""}. Check the commands.`);
    }
  }
  if (found.truncated) reasons.push("The repository is very large: gitring looked at part of its files.");
  const canSync = installed && found.meta.canPush;
  if (!installed) reasons.push(`The gitring GitHub app is not on ${found.meta.fullName}: GitHub sync stays off until you install it.`);
  else if (!found.meta.canPush) reasons.push("You cannot push to this repository: GitHub sync stays off.");
  else reasons.push("You can push to this repository: gitring opens one pull request for merged work.");
  return {
    repo: found.meta.fullName,
    name: found.name,
    id: `${projectSlug(found.name)}-${rand(4)}`,
    branch: found.meta.defaultBranch,
    private: found.meta.private,
    ...(found.meta.language || found.guess.stack ? { language: found.guess.stack ?? found.meta.language } : {}),
    checks: { runner: "container", ...(install ? { install } : {}), ...(test ? { test } : {}) },
    reasons,
    sync: canSync ? "pull-request" : "off",
  };
}

/** Ask a small model for the install and test commands when the rules found none. */
async function askModel(env: Env, repo: string, branch: string, userId: string): Promise<{ install?: string; test?: string; why?: string } | null> {
  const files = await readAsPerson(env, userId, async (gh) => {
    const tree = await gh.json<{ tree: { path: string; type: string; size?: number }[] }>(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const blobs = (tree?.tree ?? []).filter((e) => e.type === "blob");
    const paths = blobs.map((e) => e.path);
    // A README of reasonable size only: the API sends a file whole.
    const readme = blobs.find((e) => /^readme(\.md|\.rst|\.txt)?$/i.test(e.path) && (e.size ?? 0) <= 200_000)?.path;
    const text = readme ? await gh.text(repo, readme, branch, 200_000) : null;
    return { paths: paths.slice(0, 300), readme: text?.slice(0, 6000) ?? "" };
  });
  const res = await chat(
    env.AI as never,
    "@cf/zai-org/glm-4.7-flash",
    [
      {
        role: "system",
        content:
          'You read a repository and answer how a CI machine installs its dependencies and runs its tests. The machine runs Debian with Node.js 24; other tools come from apt-get. Answer JSON only: {"install": "<one shell line or empty>", "test": "<one shell line>", "why": "<at most 12 words>"}. If you cannot tell, answer {"test": ""}.',
      },
      { role: "user", content: `Repository ${repo}.\nFiles:\n${files.paths.join("\n")}\n\nREADME:\n${files.readme}` },
    ],
    { maxTokens: 300, timeoutMs: 8000, json: true, temperature: 0 },
  );
  const text = res?.message.content ?? "";
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const test = cleanCommand(o.test);
    if (!test) return null;
    return { test, install: cleanCommand(o.install), why: typeof o.why === "string" ? o.why.slice(0, 80) : undefined };
  } catch {
    return null;
  }
}
