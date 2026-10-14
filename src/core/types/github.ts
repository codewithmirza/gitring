/**
 * The types of the optional GitHub link: sync settings, sync status and the status of a pull.
 *
 * GitHub is one import source and one sync target. It is never the center of a project.
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Millis } from "./basics";

/**
 * GitHub sync of main:
 *   off           merged code stays in Cloudflare Artifacts
 *   pull-request  gitring pushes each merge to `branch` and keeps one pull request open to the default branch
 *   main          gitring pushes each merge to the default branch (fast-forward only)
 */
export type GithubSyncMode = "off" | "pull-request" | "main";

export interface GithubSettings {
  /** "owner/name" on github.com. Absent: not linked (a GitHub import links its repository). */
  repo?: string;
  mode: GithubSyncMode;
  /** Branch that gitring pushes in pull-request mode. */
  branch: string;
  /**
   * The GitHub branch that main follows: changes come from it, "Straight to main" moves it, and pull
   * requests go to it. Absent: the repository's default branch (an import sets the imported branch).
   */
  base?: string;
}

export type GithubSyncState =
  | "off" // mode off
  | "not-linked" // no GitHub repository
  | "no-app" // the deployment has no GitHub App
  | "not-installed" // the GitHub App is not on the repository
  | "pending" // a sync runs
  | "ok" // GitHub has main
  | "blocked" // GitHub moved and gitring cannot fast-forward it (main mode)
  | "error";

export interface GithubSyncStatus {
  state: GithubSyncState;
  /** One sentence for people. */
  message: string;
  /** Repository, "owner/name". */
  repo?: string;
  mode?: GithubSyncMode;
  /** Branch on GitHub that gitring updates. */
  branch?: string;
  /** The gitring main commit that GitHub has now. */
  syncedSha?: string;
  /** The GitHub commit for syncedSha. */
  githubSha?: string;
  /** Open pull request (pull-request mode). */
  prUrl?: string;
  prNumber?: number;
  /** Install the GitHub App on the repository (state not-installed). */
  installUrl?: string;
  /** Open the pull request by hand (the app has no pull-request permission). */
  compareUrl?: string;
  at?: Millis;
  /** Changes on GitHub that gitring brings into main (pull). */
  pull?: GithubPullStatus;
}

/**
 * Bringing GitHub changes into main:
 *   up-to-date  main has everything on the GitHub default branch
 *   merged      gitring merged new GitHub commits into main
 *   conflict    GitHub and main changed the same lines; a task asks an agent or a person to merge them
 *   error       gitring could not read GitHub (the message says why)
 */
export interface GithubPullStatus {
  state: "up-to-date" | "merged" | "conflict" | "error" | "pending";
  message: string;
  /** The GitHub commit that main has now (or would have, for a conflict). */
  headSha?: string;
  /** main after the merge. */
  mainSha?: string;
  /** Conflict: the files, and the task that merges them. */
  files?: string[];
  intentId?: string;
  compareUrl?: string;
  at: Millis;
}
