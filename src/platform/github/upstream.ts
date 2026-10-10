/**
 * Bring GitHub changes into gitring: what changed on the GitHub default branch since a commit that
 * gitring already has, merged with main file by file.
 *
 *   since   a GitHub commit that gitring has (the import, the last pull, or the last sync)
 *   head    the GitHub default branch now
 *   base    the merge base of since and head (GitHub's compare API)
 *
 * Per path (git blob ids compare content exactly, on both sides):
 *   main = head        nothing to do
 *   main = base        take GitHub's version
 *   head = base        only gitring changed it: keep main
 *   both changed       3-way merge of the text; overlapping changes are conflicts
 *
 * Pure module: fetch and the repository backend come in as arguments.
 */
import type { FileChange, RepoBackend } from "../repo/backend";
import type { Snapshot } from "../../core/git/snapshot";
import { merge3 } from "../../core/text/merge3";
import { isProbablyText, unifiedDiff } from "../../core/text/diff";
import { githubMessage, GITHUB_API } from "./api";

export interface UpstreamInput {
  repo: string;
  token: string | null;
  fetch?: typeof fetch;
  base?: string;
  backend: Pick<RepoBackend, "readBlob">;
  /** Artifacts repository of the project. */
  source: string;
  /** Main of the project: path → blob id and mode. */
  main: Snapshot;
  since: string;
  /** Paths that a person or agent merged by hand, with GitHub's blob id they merged (null: deleted). */
  resolved?: Record<string, string | null>;
  /** At most this many changed paths (default 3000). */
  maxPaths?: number;
  /** The GitHub branch that main follows (default: the repository's default branch). */
  branch?: string;
}

export interface UpstreamConflict {
  path: string;
  /** GitHub's blob id at head (null: GitHub deleted the file). */
  theirs: string | null;
  /** GitHub's change as a unified diff (base → head), for the person or agent who merges it. */
  diff: string;
}

export type UpstreamResult =
  | { state: "up-to-date"; head: string; branch: string; private: boolean; message: string }
  | {
      state: "changes";
      head: string;
      base: string;
      branch: string;
      private: boolean;
      commits: number;
      authors: string[];
      changes: FileChange[];
      /** Submodule pointers that GitHub changed (path → commit, null: removed). gitring does not keep them. */
      gitlinks: Record<string, string | null>;
      compareUrl: string;
      message: string;
    }
  | { state: "conflict"; head: string; base: string; branch: string; private: boolean; commits: number; conflicts: UpstreamConflict[]; compareUrl: string; message: string }
  | { state: "error"; message: string; private?: boolean };

interface TreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

const MAX_TEXT = 1_000_000;
/** Larger files do not come in through the API (memory of the project's object): push them with git. */
export const MAX_PULL_BLOB = 10_000_000;

export async function upstreamChanges(input: UpstreamInput): Promise<UpstreamResult> {
  const f = input.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const api = input.base ?? GITHUB_API;
  const headers = (accept = "application/vnd.github+json"): Record<string, string> => ({
    "User-Agent": "gitring",
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
  });
  const get = async <T>(path: string): Promise<{ status: number; json: T | null; text: string }> => {
    const res = await f(`${api}${path}`, { headers: headers() });
    const text = await res.text();
    let json: T | null = null;
    try {
      json = JSON.parse(text) as T;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text };
  };
  const fail = (message: string): UpstreamResult => ({ state: "error", message });

  try {
    const info = await get<{ default_branch?: string; html_url?: string; private?: boolean }>(`/repos/${input.repo}`);
    if (info.status !== 200 || !info.json) return fail(`gitring cannot read ${input.repo}: ${githubMessage(info.status, info.text)}`);
    const isPrivate = Boolean(info.json.private);
    const branch = input.branch || info.json.default_branch || "main";
    const html = info.json.html_url || `https://github.com/${input.repo}`;
    const headRes = await f(`${api}/repos/${input.repo}/commits/${encodeURIComponent(branch)}`, { headers: headers("application/vnd.github.sha") });
    const head = (await headRes.text()).trim();
    if (headRes.status !== 200 || !/^[0-9a-f]{40}$/.test(head)) return fail(`gitring cannot read ${branch} of ${input.repo}: ${githubMessage(headRes.status, head)}`);
    if (head === input.since) return { state: "up-to-date", head, branch, private: isPrivate, message: `main has everything on GitHub ${branch}.` };

    const cmp = await get<{ status?: string; total_commits?: number; merge_base_commit?: { sha?: string; commit?: { tree?: { sha?: string } } }; commits?: { commit?: { author?: { name?: string } } }[] }>(
      `/repos/${input.repo}/compare/${input.since}...${head}?per_page=100`,
    );
    if (cmp.status === 404) return fail(`GitHub no longer has commit ${input.since.slice(0, 7)} (a force push?). Link the repository again in Settings → GitHub.`);
    if (cmp.status !== 200 || !cmp.json) return fail(`GitHub did not compare the commits: ${githubMessage(cmp.status, cmp.text)}`);
    if (cmp.json.status === "identical" || cmp.json.status === "behind") return { state: "up-to-date", head, branch, private: isPrivate, message: `main has everything on GitHub ${branch}.` };
    const base = cmp.json.merge_base_commit?.sha ?? "";
    const baseTree = cmp.json.merge_base_commit?.commit?.tree?.sha ?? "";
    if (!base || !baseTree) return fail("GitHub did not give the common commit of gitring and GitHub.");
    const commits = cmp.json.total_commits ?? 0;
    const authors = [...new Set((cmp.json.commits ?? []).map((c) => c.commit?.author?.name).filter((n): n is string => Boolean(n)))].slice(0, 10);
    const compareUrl = `${html}/compare/${base.slice(0, 12)}...${head.slice(0, 12)}`;

    const headCommit = await get<{ tree?: { sha?: string } }>(`/repos/${input.repo}/git/commits/${head}`);
    const headTree = headCommit.json?.tree?.sha;
    if (!headTree) return fail(`gitring cannot read commit ${head.slice(0, 7)} on GitHub.`);
    const [baseMap, headMap] = await Promise.all([baseTree, headTree].map(async (t) => {
      const r = await get<{ truncated?: boolean; tree?: TreeItem[] }>(`/repos/${input.repo}/git/trees/${t}?recursive=1`);
      if (r.status !== 200 || !r.json?.tree) throw new Error(`gitring cannot read tree ${t.slice(0, 7)} on GitHub (${r.status}).`);
      if (r.json.truncated) throw new Error("The repository is too large to compare through the GitHub API. Push the changes to gitring with git.");
      return new Map(r.json.tree.filter((e) => e.type !== "tree").map((e) => [e.path, e]));
    }));

    const changed = new Set<string>();
    for (const [p, e] of headMap) if (baseMap.get(p)?.sha !== e.sha || baseMap.get(p)?.mode !== e.mode) changed.add(p);
    for (const p of baseMap.keys()) if (!headMap.has(p)) changed.add(p);
    if (changed.size > (input.maxPaths ?? 3000)) return fail(`GitHub changed ${changed.size} files. That is too many to merge through the API; push the changes to gitring with git.`);

    const blobCache = new Map<string, Uint8Array>();
    // Raw bytes (no base64 copy in memory).
    const githubBlob = async (sha: string): Promise<Uint8Array> => {
      const hit = blobCache.get(sha);
      if (hit) return hit;
      const res = await f(`${api}/repos/${input.repo}/git/blobs/${sha}`, { headers: headers("application/vnd.github.raw") });
      if (res.status !== 200) throw new Error(`gitring cannot read blob ${sha.slice(0, 7)} on GitHub (${res.status}).`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      blobCache.set(sha, bytes);
      return bytes;
    };
    const tooLarge = (e: TreeItem | undefined) => (e?.size ?? 0) > MAX_PULL_BLOB;
    const asText = (b: Uint8Array | null): string | null => (b && b.length <= MAX_TEXT && isProbablyText(b) ? new TextDecoder().decode(b) : null);

    const changes: FileChange[] = [];
    const conflicts: UpstreamConflict[] = [];
    const gitlinks: Record<string, string | null> = {};
    const key = (e: { sha: string; mode: string } | undefined) => (e ? `${e.sha} ${normMode(e.mode)}` : "-");
    for (const path of [...changed].sort()) {
      const b = baseMap.get(path);
      const t = headMap.get(path);
      const o = input.main.get(path);
      if (b?.type === "commit" || t?.type === "commit") {
        // Submodules: gitring keeps no pointers, but the merge commit on GitHub must carry GitHub's.
        if (t?.type === "commit") gitlinks[path] = t.sha;
        else if (!t) gitlinks[path] = null;
        else {
          gitlinks[path] = null; // a submodule became a file: the file comes in below
          if (key(o) !== key(t)) changes.push({ path, content: await githubBlob(t.sha), mode: normMode(t.mode) });
        }
        continue;
      }
      if (key(o) === key(t)) continue;
      if (key(o) === key(b)) {
        if (t && tooLarge(t)) {
          conflicts.push({ path, theirs: t.sha, diff: `${path}: GitHub's version is larger than ${MAX_PULL_BLOB / 1e6} MB. Push it to gitring with git.` });
          continue;
        }
        changes.push(t ? { path, content: await githubBlob(t.sha), mode: normMode(t.mode) } : { path, content: null });
        continue;
      }
      if (key(t) === key(b)) continue;
      if (input.resolved && path in input.resolved && input.resolved[path] === (t?.sha ?? null)) continue;
      // Both sides changed the path.
      if (tooLarge(t) || tooLarge(b)) {
        conflicts.push({ path, theirs: t?.sha ?? null, diff: `${path}: too large to merge through the API.` });
        continue;
      }
      const baseText = b ? asText(await githubBlob(b.sha)) : "";
      const theirsText = t ? asText(await githubBlob(t.sha)) : null;
      const oursText = o ? asText(await input.backend.readBlob(input.source, o.sha)) : null;
      if (o && t && baseText !== null && theirsText !== null && oursText !== null) {
        const m = merge3(baseText, oursText, theirsText);
        // Modes: GitHub's change wins when main kept the old mode; two different changes conflict.
        const om = normMode(o.mode);
        const tm = normMode(t.mode);
        const bm = b ? normMode(b.mode) : om;
        const mode = om === bm ? tm : tm === bm || tm === om ? om : null;
        if (m.clean && mode) {
          changes.push({ path, content: m.content, mode });
          continue;
        }
      }
      conflicts.push({ path, theirs: t?.sha ?? null, diff: baseText !== null && (t ? theirsText !== null : true) ? unifiedDiff(path, b ? baseText : null, t ? theirsText : null) : `${path}: binary file or too large to show.` });
    }
    const n = `${commits} commit${commits === 1 ? "" : "s"}`;
    if (conflicts.length) {
      return {
        state: "conflict",
        head,
        base,
        branch,
        private: isPrivate,
        commits,
        conflicts,
        compareUrl,
        message: `GitHub ${branch} has ${n} that change the same lines as main in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}: ${conflicts.slice(0, 3).map((c) => c.path).join(", ")}${conflicts.length > 3 ? ", …" : ""}.`,
      };
    }
    return {
      state: "changes",
      head,
      base,
      branch,
      private: isPrivate,
      commits,
      authors,
      changes,
      gitlinks,
      compareUrl,
      message: changes.length ? `GitHub ${branch} has ${n} with changes to ${changes.length} file${changes.length === 1 ? "" : "s"}.` : `main already has the changes of ${n} on GitHub ${branch}.`,
    };
  } catch (e) {
    return fail(String((e as Error)?.message ?? e).slice(0, 300));
  }
}

function normMode(mode: string): string {
  return mode === "040000" ? "40000" : mode;
}
