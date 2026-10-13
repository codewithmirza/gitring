/**
 * Repositories that a person can import: the repositories of the gitring GitHub App's installations
 * that the person can see (GET /user/installations, /user/installations/{id}/repositories, with the
 * person's GitHub App user token). And the guess for a new project from one repository: the file list
 * and a reader of GitHub's tree go to the same guess as every other source (core/guess.ts guessTree).
 */
import type * as A from "../../core/accounts";
import { guessTree, projectNameOf, type AskModel, type ChecksGuess } from "../../core/guess";
import { GithubClient } from "./api";

interface InstallationJson {
  id: number;
  account?: { login?: string; type?: string; avatar_url?: string } | null;
  repository_selection?: "all" | "selected";
  suspended_at?: string | null;
}

export interface RepoJson {
  full_name: string;
  private: boolean;
  default_branch?: string;
  description?: string | null;
  language?: string | null;
  pushed_at?: string | null;
  html_url: string;
  size?: number;
  archived?: boolean;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean };
}

export type InstallationInfo = A.GithubInstallationInfo;

const MAX_INSTALLATIONS = 30;
const MAX_REPO_PAGES = 5;

export function toRepo(r: RepoJson): A.GithubRepo {
  return {
    fullName: r.full_name,
    private: Boolean(r.private),
    defaultBranch: r.default_branch || "main",
    ...(r.description ? { description: r.description.slice(0, 200) } : {}),
    ...(r.language ? { language: r.language } : {}),
    ...(r.pushed_at ? { pushedAt: r.pushed_at } : {}),
    htmlUrl: r.html_url,
    canPush: Boolean(r.permissions?.push || r.permissions?.admin || r.permissions?.maintain),
    ...(typeof r.size === "number" ? { sizeKb: r.size } : {}),
  };
}

/** The repositories a person can import, newest push first, and the installations they come from. */
export async function listUserRepos(gh: GithubClient): Promise<{ repos: A.GithubRepo[]; installations: InstallationInfo[]; complete: boolean }> {
  const inst = await gh.pages<InstallationJson>("/user/installations", (p) => ((p as { installations?: InstallationJson[] }).installations ?? []), 2);
  const active = inst.items.filter((i) => !i.suspended_at).slice(0, MAX_INSTALLATIONS);
  let complete = inst.complete && inst.items.length <= MAX_INSTALLATIONS;
  const installations: InstallationInfo[] = [];
  const seen = new Map<string, A.GithubRepo>();
  // A few installations at a time: most people have one or two.
  for (let i = 0; i < active.length; i += 4) {
    const batch = active.slice(i, i + 4);
    const lists = await Promise.all(
      batch.map((x) => gh.pages<RepoJson>(`/user/installations/${x.id}/repositories`, (p) => ((p as { repositories?: RepoJson[] }).repositories ?? []), MAX_REPO_PAGES)),
    );
    batch.forEach((x, k) => {
      const list = lists[k];
      if (!list.complete) complete = false;
      const repos = list.items.filter((r) => !r.archived);
      for (const r of repos) seen.set(r.full_name.toLowerCase(), toRepo(r));
      installations.push({
        id: x.id,
        account: x.account?.login ?? "unknown",
        type: x.account?.type === "Organization" ? "Organization" : "User",
        ...(x.account?.avatar_url ? { avatar: x.account.avatar_url } : {}),
        selection: x.repository_selection === "all" ? "all" : "selected",
        repos: repos.length,
      });
    });
  }
  const repos = [...seen.values()].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "") || a.fullName.localeCompare(b.fullName));
  return { repos, installations, complete };
}

interface TreeJson {
  sha: string;
  truncated?: boolean;
  tree: { path: string; type: "blob" | "tree" | "commit"; size?: number }[];
}

/** Everything gitring needs to guess a new project from one repository. `ask`: the model for the cases that the rules do not know. */
export async function guessFromGithub(gh: GithubClient, repo: string, branch?: string, ask?: AskModel): Promise<{ meta: A.GithubRepo; sha: string; guess: ChecksGuess; name: string; truncated: boolean }> {
  const meta = await gh.json<RepoJson>(`/repos/${repo}`);
  if (!meta) throw Object.assign(new Error(`gitring cannot read ${repo}. It is private and the GitHub app is not on it, or the name is wrong.`), { status: 404 });
  const ref = branch || meta.default_branch || "main";
  const tree = await gh.json<TreeJson>(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const paths = (tree?.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);
  const sizes = new Map((tree?.tree ?? []).map((e) => [e.path, e.size ?? 0]));
  const guess = await guessTree({
    label: meta.full_name,
    paths,
    read: async (path) => ((sizes.get(path) ?? 0) > 200_000 ? null : gh.text(repo, path, ref)),
    ask,
  });
  return { meta: { ...toRepo(meta), defaultBranch: ref }, sha: tree?.sha ?? "", guess, name: projectNameOf(meta.full_name), truncated: Boolean(tree?.truncated) };
}
