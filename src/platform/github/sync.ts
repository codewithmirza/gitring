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
   * gitring commits that brought GitHub changes into main → the GitHub commit they brought in (and the
   * submodule pointers of it, which gitring itself does not store). On GitHub such a commit becomes a
   * merge commit with that second parent, so GitHub's history stays whole and the branch can fast-forward.
   */
  upstreamOf?: Record<string, UpstreamMark>;
  /** The GitHub branch that main follows (default: the repository's default branch). */
  base?: string;
  pr: { title: string; body: string };
  /** At most this many commits in one run; the rest go in the next run. */
  maxCommits?: number;
}

export type UpstreamMark = string | { head: string; gitlinks?: Record<string, string | null> };

export interface SyncOutput {
  status: T.GithubSyncStatus;
  /** Pairs to remember (the input pairs plus the new ones). */
  known: Record<string, string>;
  /** More commits wait: run the sync again. */
  more?: boolean;
  /** GitHub refused the token (401): ask for a new one and run again. */
  unauthorized?: boolean;
}

/** The newest main commits that one run walks back through to find a commit that GitHub has. */
const MAX_WALK = 5000;

/** Blobs larger than this do not go through the REST API. */
export const MAX_BLOB_BYTES = 15_000_000;

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

/**
 * A branch name as git resolves it: without "refs/heads/", without "." segments and doubled slashes.
 * Two names that resolve to the same ref are the same branch ("./main" is "main").
 */
export function normalizeBranch(name: string): string {
  return String(name ?? "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/");
}

/** The ref path of a branch for the Git Data API (one encoded segment per path part). */
function refPathOf(repo: string, branch: string): string {
  return `/repos/${repo}/git/refs/heads/${normalizeBranch(branch).split("/").map(encodeURIComponent).join("/")}`;
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

/** The pieces that every step of one sync shares: the request, the failure answer and the pairs found so far. */
interface SyncRun {
  gh: GithubApi;
  input: SyncInput;
  known: Record<string, string>;
  api: <J = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<Reply<J>>;
  fail: (state: T.GithubSyncState, message: string, extra?: Partial<T.GithubSyncStatus>) => SyncOutput;
  base: Pick<T.GithubSyncStatus, "repo" | "mode" | "branch">;
}

/** Where the sync stands when the missing commits are on GitHub. */
interface Landed {
  defaultBranch: string;
  html: string;
  tip: string;
  done: { syncedSha: string; githubSha: string };
  partial: (st: SyncOutput) => SyncOutput;
}

/** Send main to GitHub. Never throws: problems come back as a status for people. */
export async function syncToGithub(gh: GithubApi, input: SyncInput): Promise<SyncOutput> {
  const known = { ...input.known };
  let unauthorized = false;
  const raw = client(gh);
  const api = async <J = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Reply<J>> => {
    const r = await raw<J>(method, path, body);
    if (r.status === 401) unauthorized = true;
    return r;
  };
  const base: Pick<T.GithubSyncStatus, "repo" | "mode" | "branch"> = { repo: gh.repo, mode: input.mode, ...(input.mode === "pull-request" ? { branch: input.branch } : {}) };
  const fail = (state: T.GithubSyncState, message: string, extra: Partial<T.GithubSyncStatus> = {}): SyncOutput => ({
    status: { state, message: unauthorized ? "GitHub refused the app's token. gitring asks for a new one and tries again." : message, ...base, ...extra, at: Date.now() },
    known,
    ...(unauthorized ? { unauthorized } : {}),
  });
  const run: SyncRun = { gh, input, known, api, fail, base };
  try {
    const info = await api<{ default_branch?: string; html_url?: string }>("GET", `/repos/${gh.repo}`);
    if (info.status === 404) return fail("error", `GitHub does not show ${gh.repo} to the gitring app. Check the name, and install the app on the repository.`);
    if (info.status >= 400) return fail("error", `GitHub answered ${info.status} for ${gh.repo}.`);
    const defaultBranch = normalizeBranch(input.base || info.json.default_branch || "main");
    if (input.mode === "pull-request" && normalizeBranch(input.branch) === defaultBranch) {
      return fail("error", `The pull request branch must not be ${defaultBranch}, the branch that it merges into. Choose another branch in Settings → GitHub.`);
    }
    const html = info.json.html_url || `https://github.com/${gh.repo}`;

    const walked = await walkToAnchor(run);
    if ("status" in walked) return walked;
    const made = await makeCommits(run, walked);
    if ("status" in made) return made;
    const { chain, more, tip } = made;
    const synced = chain.length ? chain[chain.length - 1].hash : input.mainSha;
    const done = { syncedSha: synced, githubSha: tip };
    const partial = (st: SyncOutput): SyncOutput =>
      more && st.status.state === "ok"
        ? { ...st, more: true, status: { ...st.status, state: "pending", message: `gitring sent ${chain.length} commits to GitHub; it sends the rest now.` } }
        : st;
    const landed: Landed = { defaultBranch, html, tip, done, partial };

    if (input.mode === "main") return await fastForwardMain(run, landed);
    const stopped = await moveBranch(run, landed);
    if (stopped) return stopped;
    return await openPullRequest(run, landed);
  } catch (e) {
    return fail("error", `GitHub sync stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

// ───── The steps of one sync ─────

/** Step 1: walk main back to the first commit that GitHub has. */
async function walkToAnchor(run: SyncRun): Promise<{ chain: CommitMeta[]; anchor: { gitring: string; github: string } } | SyncOutput> {
  const { gh, input, known, api, fail } = run;
  let chain: CommitMeta[] = [];
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
    if (chain.length >= MAX_WALK) {
      return fail("error", `Main has more than ${MAX_WALK} commits that GitHub does not have. Push main to GitHub with git once; then gitring continues.`);
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
  return { chain, anchor };
}

/** Step 2: make the missing commits on GitHub, oldest first; at most `max` in one run. */
async function makeCommits(run: SyncRun, walked: { chain: CommitMeta[]; anchor: { gitring: string; github: string } }): Promise<{ chain: CommitMeta[]; more: boolean; tip: string } | SyncOutput> {
  const { gh, input, api, fail } = run;
  const { anchor } = walked;
  let chain = walked.chain;
  const max = input.maxCommits ?? 200;
  chain = chain.reverse();
  const more = chain.length > max;
  if (more) chain = chain.slice(0, max);
  let parentGh = anchor.github;
  let parentTreeGitring: string | null = null;
  let parentTreeGh = "";
  if (chain.length) {
    parentTreeGitring = (await input.backend.readCommit(input.source, anchor.gitring))?.treeHash ?? null;
    const parentCommit = await api<{ tree?: { sha?: string } }>("GET", `/repos/${gh.repo}/git/commits/${parentGh}`);
    parentTreeGh = parentCommit.json?.tree?.sha ?? "";
    if (!parentTreeGh || !parentTreeGitring) return fail("error", `gitring cannot read the tree of ${parentGh.slice(0, 7)}.`);
  }
  for (const meta of chain) {
    const sent = await sendCommit(run, meta, { gh: parentGh, treeGh: parentTreeGh, treeGitring: parentTreeGitring });
    if ("status" in sent) return sent;
    parentGh = sent.gh;
    parentTreeGh = sent.treeGh;
    parentTreeGitring = meta.treeHash;
  }
  return { chain, more, tip: parentGh };
}

/** One commit of main on GitHub: its blobs, its tree, then the commit on top of `parent`. Answers the new parent. */
async function sendCommit(run: SyncRun, meta: CommitMeta, parent: { gh: string; treeGh: string; treeGitring: string | null }): Promise<{ gh: string; treeGh: string } | SyncOutput> {
  const { gh, input, known, api, fail } = run;
  const parentGh = parent.gh;
  const parentTreeGh = parent.treeGh;
  const parentTreeGitring = parent.treeGitring;
  const changes = await treeChanges(input.backend, input.source, parentTreeGitring, meta.treeHash);
  const mark = input.upstreamOf?.[meta.hash];
  const upstreamHead = typeof mark === "string" ? mark : mark?.head;
  // Submodule pointers that came from GitHub in this merge: gitring does not keep them, so they go
  // into the merge commit here (otherwise the merge would set them back).
  const gitlinks = typeof mark === "object" && mark.gitlinks ? Object.entries(mark.gitlinks) : [];
  for (const [path, sha] of gitlinks) changes.push({ path, mode: "160000", type: "commit", sha });
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
    parents: upstreamHead && upstreamHead !== parentGh ? [parentGh, upstreamHead] : [parentGh],
    author: { name: meta.author.name, email: meta.author.email, date: iso(meta.authoredAt) },
    committer: { name: meta.committer.name, email: meta.committer.email, date: iso(meta.committedAt) },
  });
  if (commit.status !== 201 || !commit.json?.sha) return fail("error", `GitHub did not make the commit for ${meta.hash.slice(0, 7)} (${commit.status}${commit.json?.message ? `: ${commit.json.message}` : ""}).`);
  known[meta.hash] = commit.json.sha;
  return { gh: commit.json.sha, treeGh: treeSha };
}

/** Step 3 in mode main: the default branch of GitHub moves to the new tip, by fast-forward only. */
async function fastForwardMain(run: SyncRun, landed: Landed): Promise<SyncOutput> {
  const { gh, known, api, fail, base } = run;
  const { defaultBranch, tip, done, partial } = landed;
  const ref = await api<{ message?: string }>("PATCH", refPathOf(gh.repo, defaultBranch), { sha: tip, force: false });
  if (ref.status === 200) return partial({ status: { state: "ok", message: `GitHub ${defaultBranch} has main at ${tip.slice(0, 7)}.`, ...base, branch: defaultBranch, ...done, at: Date.now() }, known });
  if (/protected/i.test(ref.json?.message ?? "")) {
    return fail("blocked", `GitHub protects ${defaultBranch}: the gitring app may not push to it. Use pull request mode, or allow the app in the branch rules.`, { branch: defaultBranch });
  }
  if (ref.status === 422 || ref.status === 409) {
    return fail("blocked", `GitHub ${defaultBranch} has commits that gitring does not have, so gitring cannot fast-forward it. gitring brings them in first.`, { branch: defaultBranch, ...done, syncedSha: undefined });
  }
  return fail("error", `GitHub did not move ${defaultBranch} (${ref.status}${ref.json?.message ? `: ${ref.json.message}` : ""}).`, { branch: defaultBranch });
}

/** Step 3 in mode pull-request, part one: move the branch to the new tip. Answers null when the branch moved. */
async function moveBranch(run: SyncRun, landed: Landed): Promise<SyncOutput | null> {
  const { gh, input, known, api, fail } = run;
  const { tip } = landed;
  const branch = normalizeBranch(input.branch);
  const refPath = refPathOf(gh.repo, branch);
  const ours = new Set(Object.values(known));
  const tipOf = async (): Promise<string | undefined> => {
    const r = await api<{ object?: { sha?: string } }>("GET", refPath);
    return r.status === 200 ? r.json?.object?.sha : undefined;
  };
  const missingRef = (r: Reply<{ message?: string }>) => r.status === 404 || (r.status === 422 && /reference does not exist|not found/i.test(r.json?.message ?? ""));
  // The branch moves without force: a commit that a person pushed to it since the last run stays, and
  // GitHub refuses the move. Force is used only when the tip is gitring's own commit and it did not
  // move between the read and the refused move; otherwise the tip is read again.
  let moved: Reply<{ message?: string }> = { status: 200, json: {} };
  let currentTip: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    currentTip = await tipOf();
    if (currentTip === tip) break;
    moved = await api<{ message?: string }>("PATCH", refPath, { sha: tip, force: false });
    if (moved.status !== 422 || missingRef(moved)) break;
    if (!currentTip || !ours.has(currentTip)) break;
    if ((await tipOf()) !== currentTip) continue;
    moved = await api<{ message?: string }>("PATCH", refPath, { sha: tip, force: true });
    break;
  }
  if (moved.status === 422 && !missingRef(moved) && currentTip && !ours.has(currentTip)) {
    return fail("blocked", `Someone pushed commits to ${branch} on GitHub. gitring does not overwrite them: merge or delete the branch, or choose another branch in Settings → GitHub.`, { branch });
  }
  if (missingRef(moved)) {
    const made = await api<{ message?: string }>("POST", `/repos/${gh.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip });
    if (made.status !== 201) {
      return fail("error", `GitHub did not make the branch ${branch} (${made.status}${made.json?.message ? `: ${made.json.message}` : ""}).`);
    }
  } else if (moved.status !== 200) {
    return fail("error", `GitHub did not move the branch ${branch} (${moved.status}${moved.json?.message ? `: ${moved.json.message}` : ""}).`);
  }
  return null;
}

/** Step 3 in mode pull-request, part two: keep one pull request open from the branch to the default branch. */
async function openPullRequest(run: SyncRun, landed: Landed): Promise<SyncOutput> {
  const { gh, input, known, api, fail, base } = run;
  const { defaultBranch, html, tip, done, partial } = landed;
  const [owner] = gh.repo.split("/");
  const branch = normalizeBranch(input.branch);
  const compareUrl = `${html}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branch)}?expand=1`;
  const open = await api<{ html_url?: string; number?: number }[]>(
    "GET",
    `/repos/${gh.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(defaultBranch)}`,
  );
  if (open.status === 200 && Array.isArray(open.json) && open.json[0]?.html_url) {
    const pr = open.json[0];
    return partial({ status: { state: "ok", message: `Pull request #${pr.number} has main at ${tip.slice(0, 7)}.`, ...base, ...done, prUrl: pr.html_url, prNumber: pr.number, at: Date.now() }, known });
  }
  // A pull request whose files are the files of the base branch changes nothing (the last pull request
  // was merged with a merge commit): gitring opens none. The next merged task opens the next one.
  const nothingNew = `GitHub ${defaultBranch} has all merged work. No pull request is necessary.`;
  const baseTip = (await api<{ object?: { sha?: string } }>("GET", refPathOf(gh.repo, defaultBranch))).json?.object?.sha;
  if (baseTip === tip) return partial({ status: { state: "ok", message: nothingNew, ...base, ...done, at: Date.now() }, known });
  if (baseTip) {
    const treeOf = async (sha: string) => (await api<{ tree?: { sha?: string } }>("GET", `/repos/${gh.repo}/git/commits/${sha}`)).json?.tree?.sha;
    const [baseTree, tipTree] = await Promise.all([treeOf(baseTip), treeOf(tip)]);
    if (baseTree && baseTree === tipTree) return partial({ status: { state: "ok", message: nothingNew, ...base, ...done, at: Date.now() }, known });
  }
  const pr = await api<{ html_url?: string; number?: number; message?: string; errors?: { message?: string }[] }>("POST", `/repos/${gh.repo}/pulls`, {
    title: input.pr.title,
    head: branch,
    base: defaultBranch,
    body: input.pr.body,
  });
  if (pr.status === 201 && pr.json?.html_url) {
    return partial({ status: { state: "ok", message: `gitring opened pull request #${pr.json.number}.`, ...base, ...done, prUrl: pr.json.html_url, prNumber: pr.json.number, at: Date.now() }, known });
  }
  const why = [pr.json?.message, ...(pr.json?.errors ?? []).map((e) => e.message)].filter(Boolean).join(" ");
  if (pr.status === 422 && /no commits between/i.test(why)) {
    return partial({ status: { state: "ok", message: nothingNew, ...base, ...done, at: Date.now() }, known });
  }
  if (pr.status === 403 || pr.status === 404) {
    return partial({
      status: {
        state: "ok",
        message: `Branch ${branch} has main at ${tip.slice(0, 7)}. The gitring app cannot open pull requests: open it on GitHub, or give the app the pull request permission.`,
        ...base,
        ...done,
        compareUrl,
        at: Date.now(),
      },
      known,
    });
  }
  return fail("error", `GitHub did not open the pull request (${pr.status}${why ? `: ${why}` : ""}).`, { ...done, compareUrl });
}
