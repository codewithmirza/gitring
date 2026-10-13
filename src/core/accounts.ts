/**
 * Accounts, projects and access: types shared by the Worker, the Directory and the web UI.
 * No runtime dependencies.
 */
import type { ProjectSource } from "./types";

export type Role = "owner" | "member" | "viewer";
export type Provider = "github" | "google";
export type Visibility = "public" | "private";

export const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, owner: 3 };

export function atLeast(role: Role | null | undefined, need: Role): boolean {
  return Boolean(role) && ROLE_RANK[role as Role] >= ROLE_RANK[need];
}

export interface Identity {
  provider: Provider;
  /** GitHub login (GitHub only). */
  login?: string;
  email?: string;
}

export interface UserInfo {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  identities: Identity[];
  /** A deployment owner (GITRING_OWNERS): may set up sign-in and act on every project. */
  admin: boolean;
}

export interface ProjectInfo {
  id: string;
  name: string;
  visibility: Visibility;
  source: ProjectSource;
  createdAt: number;
  ownerName?: string;
  /** The caller's role, or null when the caller cannot see the project. */
  role: Role | null;
}

export interface MeInfo {
  user: UserInfo | null;
  /** Sign-in providers that are set up on this deployment. */
  providers: { github: boolean; google: boolean };
  /** No sign-in provider is set up yet: an owner must open /setup. */
  setupNeeded: boolean;
  /** The GitHub connection of the signed-in person (repository list, imports, sync). */
  github?: GithubConnection;
  /** Install the gitring GitHub App on more repositories. */
  githubInstallUrl?: string | null;
}

/** The GitHub connection of a person: gitring holds their GitHub token, sealed, to list and import repositories. */
export interface GithubConnection {
  connected: boolean;
  login?: string;
  /** Why the connection does not work now (one plain sentence). */
  reason?: string;
}

/** A GitHub repository that the person can import (the gitring GitHub App is installed on it). */
export interface GithubRepo {
  /** "owner/name". */
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description?: string;
  language?: string;
  /** ISO time of the last push. */
  pushedAt?: string;
  htmlUrl: string;
  /** The person can push: gitring can send merged code back. */
  canPush: boolean;
  /** Size that GitHub reports, in KB. */
  sizeKb?: number;
}

export interface GithubRepoList {
  connected: boolean;
  repos: GithubRepo[];
  /** Install the GitHub App on more repositories (or on the first one). */
  installUrl?: string;
  /** Why the list is empty or short (one plain sentence). */
  reason?: string;
  /** The accounts (people and organizations) where the app is installed, with their repository counts. */
  installations?: GithubInstallationInfo[];
  /** False when gitring read only part of a very long list (500 repositories per account). */
  complete?: boolean;
}

export interface GithubInstallationInfo {
  id: number;
  account: string;
  type: "User" | "Organization";
  avatar?: string;
  selection: "all" | "selected";
  repos: number;
}

/** What gitring guesses for a new project from a GitHub repository: name, branch and test commands. */
export interface ProjectGuess {
  repo: string;
  name: string;
  /** A free project id. */
  id: string;
  branch: string;
  private: boolean;
  language?: string;
  checks: { runner: "container" | "worker"; install?: string; test?: string };
  /** One plain sentence for each guess. */
  reasons: string[];
  /** The sync mode to start with: "off". GitHub sync is optional; the person turns it on. */
  sync: "off" | "pull-request" | "main";
  /** The person can turn GitHub sync on (the app is on the repository and the person can push). */
  canSync?: boolean;
}

/** An app that a person allowed to use gitring as them (OAuth, for MCP clients such as Claude). */
export interface OAuthGrantInfo {
  id: string;
  clientId: string;
  clientName: string;
  clientUri?: string;
  scope: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  /** The first characters of the key, to recognize it. */
  prefix: string;
  createdAt: number;
  lastUsed?: number;
}

export interface MemberInfo {
  userId?: string;
  name: string;
  /** GitHub login or email that identifies the member (pending invites have only this). */
  handle: string;
  role: Role;
  /** True until the person signs in for the first time. */
  pending: boolean;
}

/** Project ids: lowercase letters, digits and dashes (1–40). */
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
