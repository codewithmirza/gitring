/**
 * Roles, people, projects and access: the types and small helpers that the Worker, the registry and the web app share.
 *
 * No runtime dependencies. Never import Worker or storage code here.
 */

import type { ProjectSource } from "./types";
import type { WaitlistState } from "./waitlist";

export type Role = "owner" | "member" | "viewer";
export type Provider = "github" | "google";
/** A way to sign in: a passkey (built in, no outside account) or an outside provider. */
export type SignInKind = "passkey" | Provider;
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
  /** How many passkeys the person has. A person may have passkeys only (no identities). */
  passkeys?: number;
  /** A deployment owner (GITRING_OWNERS): may set up sign-in and act on every project. */
  admin: boolean;
  /**
   * The waitlist gate lets this person in (an owner, or on the allowlist). Always true when the deployment
   * has no gate. A person with `false` can use only the waitlist pages.
   */
  allowed?: boolean;
}

/** A passkey of a person (a WebAuthn credential). gitring keeps its public key only. */
export interface PasskeyInfo {
  /** The credential id (base64url). */
  id: string;
  /** A name that the person chose, for example "Passkey (Windows)". */
  name: string;
  createdAt: number;
  lastUsed?: number;
}

/** A credential in a passkey request: the id is base64url. */
export interface PasskeyDescriptor {
  type: "public-key";
  id: string;
  transports?: string[];
}

/** Options for navigator.credentials.create() (PublicKeyCredentialCreationOptionsJSON: bytes are base64url). */
export interface PasskeyCreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout: number;
  attestation: "none";
  authenticatorSelection: { residentKey: "required"; requireResidentKey: true; userVerification: "preferred" };
  excludeCredentials: PasskeyDescriptor[];
}

/** Options for navigator.credentials.get() (PublicKeyCredentialRequestOptionsJSON). */
export interface PasskeyRequestOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: "preferred";
  /** Empty: the browser offers the passkeys that it has for this site (discoverable credentials). */
  allowCredentials: PasskeyDescriptor[];
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
  /** Outside sign-in providers that are set up on this deployment. Passkeys need no setup. */
  providers: { github: boolean; google: boolean };
  /** No outside sign-in provider is set up. People can still sign in with a passkey. */
  setupNeeded: boolean;
  /** The GitHub connection of the signed-in person (repository list, imports, sync). */
  github?: GithubConnection;
  /** Install the gitring GitHub App on more repositories. */
  githubInstallUrl?: string | null;
  /** The waitlist gate (src/core/waitlist.ts). Absent when this deployment has no gate. */
  waitlist?: WaitlistState;
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
  /** Account id, email or GitHub login that identifies the member (pending invites have only this). */
  handle: string;
  role: Role;
  /** True until the person signs in for the first time. */
  pending: boolean;
}

/** Project ids: lowercase letters, digits and dashes (1–40). */
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Where a person answers the merge questions of the agents that they send (contract C3):
 *   agent  in the chat of the agent, when its client can show a form (else the link to the gitring app)
 *   app    only in the gitring app: gitring never asks in the chat, and it refuses an answer from the chat
 *   both   in the chat when the client can show a form, and in the gitring app
 */
export type ApprovalsIn = "agent" | "app" | "both";

export const APPROVALS_IN: readonly ApprovalsIn[] = ["agent", "app", "both"];

/** The preferences of one person. */
export interface PersonPrefs {
  approvalsIn: ApprovalsIn;
}

export const DEFAULT_PREFS: PersonPrefs = { approvalsIn: "both" };

/** Preferences from stored or sent data: a value that is not known keeps the default. */
export function cleanPrefs(raw: unknown): PersonPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<PersonPrefs>;
  return { approvalsIn: APPROVALS_IN.includes(r.approvalsIn as ApprovalsIn) ? (r.approvalsIn as ApprovalsIn) : DEFAULT_PREFS.approvalsIn };
}
