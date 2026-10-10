/**
 * Send main to GitHub with the GitHub Git Data API (REST, no git protocol).
 *
 * For each gitring commit on main that GitHub does not have, gitring makes one GitHub commit with the
 * same tree, message, author and dates: it uploads the changed blobs, makes a tree on top of the parent
 * tree, then the commit. Commits that came from GitHub (an import) keep their ids, so the walk stops at
 * the first commit that GitHub already has. Then:
 *   main          fast-forward the default branch (GitHub refuses when a person pushed to it)
 *   pull-request  point `branch` at the new tip and keep one pull request open to the default branch
 *
 * Pure module: the repository backend and fetch come in as arguments (tests use the git emulator).
 */
import type { CommitMeta, RepoBackend, TreeEntry } from "../repo/backend";
import type * as T from "../../core/types";

export interface GithubApi {
  /** "owner/name". */
  repo: string;
  /** Installation access token (contents: write). */
  token: string;
  fetch?: typeof fetch;
  /** Base URL of the REST API. */
  base?: string;
}

export interface SyncInput {
  backend: RepoBackend;
  /** Artifacts repository that holds main. */
  source: string;
  /** Tip of main in gitring. */
  mainSha: string;
  mode: "pull-request" | "main";
  /** Branch for pull-request mode. */
  branch: string;
  /** Pairs from earlier runs: gitring commit → GitHub commit. */
  known: Record<string, string>;
  /**
   * gitring commits that brought GitHub changes into main → the GitHub commit they brought in. On GitHub
   * such a commit becomes a merge commit with that second parent, so GitHub's history stays whole and
   * the default branch can fast-forward.
   */
  upstreamOf?: Record<string, string>;
  pr: { title: string; body: string };
  /** At most this many commits in one run. */
  maxCommits?: number;
}

export interface SyncOutput {
  status: T.GithubSyncStatus;
  /** Pairs to remember (the input pairs plus the new ones). */
  known: Record<string, string>;
}

/** Blobs larger than this do not go through the REST API. */
export const MAX_BLOB_BYTES = 40_000_000;

interface Reply<J> {
  status: number;
  json: J;
}

function client(gh: GithubApi) {
  const f = gh.fetch ?? fetch;
  const base = gh.base ?? "https://api.github.com";
  return async function call<J = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Reply<J>> {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${gh.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gitring",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text.slice(0, 200) };
    }
    return { status: res.status, json: json as J };
  };
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function b64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** GitHub writes tree modes with six digits. */
function ghMode(mode: string): string {
  return mode === "40000" ? "040000" : mode;
}

function ghType(e: TreeEntry): "blob" | "tree" | "commit" {
  return e.type === "tree" ? "tree" : e.type === "gitlink" ? "commit" : "blob";
}

export interface TreeChange {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  /** null deletes the path. */
  sha: string | null;
}

/** Changes from tree `from` to tree `to` (paths of blobs, links and submodules; deletions with sha null). */
export async function treeChanges(backend: RepoBackend, repo: string, from: string | null, to: string): Promise<TreeChange[]> {
  const out: TreeChange[] = [];
  const read = async (sha: string | null) => (sha ? ((await backend.readTree(repo, sha)) ?? []) : []);
  const walkAll = async (sha: string, prefix: string, del: boolean) => {
    for (const e of await read(sha)) {
      const path = `${prefix}${e.name}`;
      if (e.type === "tree") await walkAll(e.hash, `${path}/`, del);
      else out.push({ path, mode: ghMode(e.mode), type: ghType(e), sha: del ? null : e.hash });
    }
  };
  const walk = async (a: string | null, b: string, prefix: string) => {
    if (a === b) return;
    const left = new Map((await read(a)).map((e) => [e.name, e]));
    const right = new Map((await read(b)).map((e) => [e.name, e]));
    for (const [name, r] of right) {
      const l = left.get(name);
      const path = `${prefix}${name}`;
      if (r.type === "tree") {
        if (l && l.type === "tree") await walk(l.hash, r.hash, `${path}/`);
        else {
          if (l) out.push({ path, mode: ghMode(l.mode), type: ghType(l), sha: null });
          await walkAll(r.hash, `${path}/`, false);
        }
      } else if (!l || l.hash !== r.hash || l.mode !== r.mode || l.type !== r.type) {
        if (l && l.type === "tree") await walkAll(l.hash, `${path}/`, true);
        out.push({ path, mode: ghMode(r.mode), type: ghType(r), sha: r.hash });
      }
    }
    for (const [name, l] of left) {
      if (right.has(name)) continue;
      const path = `${prefix}${name}`;
      if (l.type === "tree") await walkAll(l.hash, `${path}/`, true);
      else out.push({ path, mode: ghMode(l.mode), type: ghType(l), sha: null });
    }
  };
  await walk(from, to, "");
  return out;
}

/** Send main to GitHub. Never throws: problems come back as a status for people. */
export async function syncToGithub(gh: GithubApi, input: SyncInput): Promise<SyncOutput> {
  const known = { ...input.known };
  const api = client(gh);
  const [owner] = gh.repo.split("/");
  const base: Pick<T.GithubSyncStatus, "repo" | "mode" | "branch"> = { repo: gh.repo, mode: input.mode, ...(input.mode === "pull-request" ? { branch: input.branch } : {}) };
  const fail = (state: T.GithubSyncState, message: string, extra: Partial<T.GithubSyncStatus> = {}): SyncOutput => ({
    status: { state, message, ...base, ...extra, at: Date.now() },
    known,
  });
  try {
    const info = await api<{ default_branch?: string; html_url?: string }>("GET", `/repos/${gh.repo}`);
    if (info.status === 404) return fail("error", `GitHub does not show ${gh.repo} to the gitring app. Check the name, and install the app on the repository.`);
    if (info.status >= 400) return fail("error", `GitHub answered ${info.status} for ${gh.repo}.`);
    const defaultBranch = info.json.default_branch || "main";
    const html = info.json.html_url || `https://github.com/${gh.repo}`;

    // 1. Walk main back to the first commit that GitHub has.
    const chain: CommitMeta[] = [];
    const max = input.maxCommits ?? 200;
    let cur = input.mainSha;
    let anchor: { gitring: string; github: string } | null = null;
    for (;;) {
      if (known[cur]) {
        anchor = { gitring: cur, github: known[cur] };
        break;
      }
      const there = await api("GET", `/repos/${gh.repo}/git/commits/${cur}`);
      if (there.status === 200) {
        anchor = { gitring: cur, github: cur };
        known[cur] = cur;
        break;
      }
      if (chain.length >= max) {
        return fail("error", `Main has more than ${max} commits that GitHub does not have. gitring sends at most ${max} in one run.`);
      }
      const meta = await input.backend.readCommit(input.source, cur);
      if (!meta) return fail("error", `gitring cannot read commit ${cur.slice(0, 7)} of main.`);
      chain.push(meta);
      if (!meta.parents.length) break;
      cur = meta.parents[0];
    }
    if (!anchor) {
      return fail(
        "error",
        `${gh.repo} has no commit of this project's history. Sync works for a project that you imported from this GitHub repository.`,
      );
    }

    // 2. Make the missing commits on GitHub, oldest first.
    let parentGh = anchor.github;
    let parentTreeGitring: string | null = null;
    let parentTreeGh = "";
    if (chain.length) {
      parentTreeGitring = (await input.backend.readCommit(input.source, anchor.gitring))?.treeHash ?? null;
      const parentCommit = await api<{ tree?: { sha?: string } }>("GET", `/repos/${gh.repo}/git/commits/${parentGh}`);
      parentTreeGh = parentCommit.json?.tree?.sha ?? "";
      if (!parentTreeGh || !parentTreeGitring) return fail("error", `gitring cannot read the tree of ${parentGh.slice(0, 7)}.`);
    }
    for (const meta of chain.reverse()) {
      const changes = await treeChanges(input.backend, input.source, parentTreeGitring, meta.treeHash);
      for (const ch of changes) {
        if (ch.type !== "blob" || !ch.sha) continue;
        const bytes = await input.backend.readBlob(input.source, ch.sha);
        if (!bytes) return fail("error", `gitring cannot read ${ch.path} of commit ${meta.hash.slice(0, 7)}.`);
        if (bytes.length > MAX_BLOB_BYTES) return fail("error", `${ch.path} is larger than ${Math.round(MAX_BLOB_BYTES / 1e6)} MB. Push it to GitHub with git.`);
        const blob = await api<{ sha?: string; message?: string }>("POST", `/repos/${gh.repo}/git/blobs`, { content: b64(bytes), encoding: "base64" });
        if (blob.status !== 201 || !blob.json?.sha) return fail("error", `GitHub did not take the file ${ch.path} (${blob.status}${blob.json?.message ? `: ${blob.json.message}` : ""}).`);
      }
      let treeSha = parentTreeGh;
      if (changes.length) {
        const tree = await api<{ sha?: string; message?: string }>("POST", `/repos/${gh.repo}/git/trees`, {
          base_tree: parentTreeGh,
          tree: changes.map((c) => ({ path: c.path, mode: c.mode, type: c.type, sha: c.sha })),
        });
        if (tree.status !== 201 || !tree.json?.sha) return fail("error", `GitHub did not make the tree of ${meta.hash.slice(0, 7)} (${tree.status}${tree.json?.message ? `: ${tree.json.message}` : ""}).`);
        treeSha = tree.json.sha;
      }
      const commit = await api<{ sha?: string; message?: string }>("POST", `/repos/${gh.repo}/git/commits`, {
        message: meta.message,
        tree: treeSha,
        parents: input.upstreamOf?.[meta.hash] && input.upstreamOf[meta.hash] !== parentGh ? [parentGh, input.upstreamOf[meta.hash]] : [parentGh],
        author: { name: meta.author.name, email: meta.author.email, date: iso(meta.authoredAt) },
        committer: { name: meta.committer.name, email: meta.committer.email, date: iso(meta.committedAt) },
      });
      if (commit.status !== 201 || !commit.json?.sha) return fail("error", `GitHub did not make the commit for ${meta.hash.slice(0, 7)} (${commit.status}${commit.json?.message ? `: ${commit.json.message}` : ""}).`);
      known[meta.hash] = commit.json.sha;
      parentGh = commit.json.sha;
      parentTreeGh = treeSha;
      parentTreeGitring = meta.treeHash;
    }
    const tip = parentGh;
    const done = { syncedSha: input.mainSha, githubSha: tip };

    // 3a. Straight to main: fast-forward only.
    if (input.mode === "main") {
      const ref = await api<{ message?: string }>("PATCH", `/repos/${gh.repo}/git/refs/heads/${encodeURIComponent(defaultBranch)}`, { sha: tip, force: false });
      if (ref.status === 200) return { status: { state: "ok", message: `GitHub ${defaultBranch} has main at ${tip.slice(0, 7)}.`, ...base, branch: defaultBranch, ...done, at: Date.now() }, known };
      if (ref.status === 422 || ref.status === 409) {
        return fail("blocked", `GitHub ${defaultBranch} has commits that gitring does not have, so gitring cannot fast-forward it. Use pull request mode, or bring those commits into gitring.`, { branch: defaultBranch, ...done, syncedSha: undefined });
      }
      return fail("error", `GitHub did not move ${defaultBranch} (${ref.status}${ref.json?.message ? `: ${ref.json.message}` : ""}).`, { branch: defaultBranch });
    }

    // 3b. Pull request: move the branch, then keep one pull request open.
    const branch = input.branch;
    const refPath = `/repos/${gh.repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
    const moved = await api<{ message?: string }>("PATCH", refPath, { sha: tip, force: true });
    const missing = moved.status === 404 || (moved.status === 422 && /reference does not exist|not found/i.test(moved.json?.message ?? ""));
    if (missing) {
      const made = await api<{ message?: string }>("POST", `/repos/${gh.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip });
      if (made.status !== 201) {
        return fail("error", `GitHub did not make the branch ${branch} (${made.status}${made.json?.message ? `: ${made.json.message}` : ""}).`);
      }
    } else if (moved.status !== 200) {
      return fail("error", `GitHub did not move the branch ${branch} (${moved.status}${moved.json?.message ? `: ${moved.json.message}` : ""}).`);
    }
    const compareUrl = `${html}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branch)}?expand=1`;
    const open = await api<{ html_url?: string; number?: number }[]>(
      "GET",
      `/repos/${gh.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(defaultBranch)}`,
    );
    if (open.status === 200 && Array.isArray(open.json) && open.json[0]?.html_url) {
      const pr = open.json[0];
      return { status: { state: "ok", message: `Pull request #${pr.number} has main at ${tip.slice(0, 7)}.`, ...base, ...done, prUrl: pr.html_url, prNumber: pr.number, at: Date.now() }, known };
    }
    const pr = await api<{ html_url?: string; number?: number; message?: string; errors?: { message?: string }[] }>("POST", `/repos/${gh.repo}/pulls`, {
      title: input.pr.title,
      head: branch,
      base: defaultBranch,
      body: input.pr.body,
    });
    if (pr.status === 201 && pr.json?.html_url) {
      return { status: { state: "ok", message: `gitring opened pull request #${pr.json.number}.`, ...base, ...done, prUrl: pr.json.html_url, prNumber: pr.json.number, at: Date.now() }, known };
    }
    const why = [pr.json?.message, ...(pr.json?.errors ?? []).map((e) => e.message)].filter(Boolean).join(" ");
    if (pr.status === 422 && /no commits between/i.test(why)) {
      return { status: { state: "ok", message: `GitHub ${defaultBranch} has all merged work. No pull request is necessary.`, ...base, ...done, at: Date.now() }, known };
    }
    if (pr.status === 403 || pr.status === 404) {
      return {
        status: {
          state: "ok",
          message: `Branch ${branch} has main at ${tip.slice(0, 7)}. The gitring app cannot open pull requests: open it on GitHub, or give the app the pull request permission.`,
          ...base,
          ...done,
          compareUrl,
          at: Date.now(),
        },
        known,
      };
    }
    return fail("error", `GitHub did not open the pull request (${pr.status}${why ? `: ${why}` : ""}).`, { ...done, compareUrl });
  } catch (e) {
    return fail("error", `GitHub sync stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}
