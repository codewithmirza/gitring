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
