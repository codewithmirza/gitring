/**
 * The project record: its repository, where its code came from, its import state and the Connect page data.
 *
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Millis } from "./basics";
import type { GithubSyncStatus } from "./github";
import type { ProjectSettings } from "./settings";

export type RepoBackendKind = "artifacts";

export interface ProjectRepo {
  backend: RepoBackendKind;
  /** Artifacts namespace. */
  namespace: string;
  /** Canonical repo name. Only the HarborMaster writes to its `main`. */
  name: string;
  /** Git remote URL of the canonical repo in Artifacts. */
  remote?: string;
  defaultBranch: string;
  /** Main is not the default branch of the Artifacts repo (an import of another branch): forks copy every branch. */
  forkAllBranches?: boolean;
}

/** Files of a ref (GET /api/projects/:p/tree?ref=main | <work copy id> | <commit sha>). */
export interface TreeResponse {
  /** The ref as asked. */
  ref: string;
  /** The commit (main or a commit sha) or "<work copy id>@<version>" for a work copy with unsaved edits. */
  sha: string;
  files: FileNode[];
}

/** What the Connect page needs: endpoints of this deployment and which inputs it has. */
export interface ConnectInfo {
  projectId: string;
  /** MCP endpoint (streamable HTTP). */
  mcpUrl: string;
  /** Claude Code PostToolUse hook for this project. */
  hookUrl: string;
  /** Endpoint that opens a task from any app. */
  intentsUrl: string;
  artifacts: { namespace: string; repo: string; remote?: string; backend: string };
  /** Inputs this deployment has set up. */
  inputs: { slack: boolean; githubIssues: boolean };
  /** The Slack command URL of this project (members only; it carries the project's key). */
  slackUrl?: string;
  /** A plain GitHub repository webhook for this project (members only; it carries the project's key). */
  githubHookUrl?: string;
  /** The GitHub App of this deployment (sign-in, issues, sync). */
  githubApp: { slug: string; installUrl: string } | null;
}

/** Where the code of a project came from. Artifacts holds the canonical repo for every kind. */
export type ProjectSource =
  /** Old projects only: the sample left the product (2026-10-10). */
  | { kind: "sample" }
  | { kind: "empty" }
  /** A GitHub repository (public or private) through the GitHub App: a snapshot of `branch` at `sha`. */
  | { kind: "github"; repo: string; branch?: string; sha?: string; private?: boolean }
  | { kind: "git"; url: string; branch?: string; host?: "github" | "gitlab" | "bitbucket" | "other"; private?: boolean }
  | { kind: "upload"; files: number }
  | { kind: "push" }
  /** A starter template of src/core/templates.ts, in one commit. Its tests run in the gitring test runner. */
  | { kind: "template"; template: string };

export interface Project {
  id: string;
  name: string;
  repo: ProjectRepo;
  mainSha: string;
  mainTree: string;
  createdAt: Millis;
  settings: ProjectSettings;
  /** Absent on projects created before sources existed: those are samples. */
  source?: ProjectSource;
  /** The Directory user who created the project (budget and default owner). */
  ownerId?: string;
  /**
   * Set while main is empty: Artifacts imports the repository (git), or gitring waits for the owner's
   * first `git push` (push). Main fills when it is done.
   */
  importing?: {
    url: string;
    startedAt: Millis;
    error?: string;
    push?: boolean;
    tokenIds?: string[];
    /** A GitHub import: a private repository comes as a snapshot of one commit (public ones keep history). */
    github?: { repo: string; branch: string; snapshot: boolean; tries?: number };
  };
  /** GitHub sync of main (settings.github). */
  github?: GithubSyncStatus;
  /**
   * Code or an issue of a private GitHub repository came into this project (an import, a pull, a task).
   * Set once, never cleared: the project stays private, also after an unlink or a relink.
   */
  privateCode?: { repo: string; at: Millis };
}

export interface FileNode {
  path: string;
  size: number;
  lang: string;
}
