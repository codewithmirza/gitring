/**
 * Accounts in the UI: who is signed in, the projects they can see, API keys, members, and project
 * creation. Every call goes to the Worker; nothing here keeps fake data.
 */
import type { ApiKeyInfo, MemberInfo, MeInfo, ProjectInfo, Role, Visibility } from "../../../src/core/accounts";
import { atLeast } from "../../../src/core/accounts";
import type { ProjectSource } from "../../../src/core/types";
import { store, useStore } from "./store";

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new AccountError(0, "Bearing did not answer. Check the connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new AccountError(res.status, json.error ?? `The request failed with status ${res.status}.`);
  return json as T;
}

export interface MeWithInstall extends MeInfo {
  githubInstallUrl?: string | null;
}

export async function loadMe(): Promise<MeWithInstall> {
  const me = await call<MeWithInstall>("GET", "/api/me");
  store.setMe(me);
  return me;
}

export async function loadProjects(): Promise<ProjectInfo[]> {
  const list = await call<ProjectInfo[]>("GET", "/api/projects");
  store.setProjects(list);
  return list;
}

/** Leave the page for the provider's sign-in; come back to the same view. */
export function signIn(provider: "github" | "google") {
  const back = location.pathname + location.search;
  location.href = `/auth/${provider}/start?return=${encodeURIComponent(back)}`;
}

export async function signOut() {
  await call("POST", "/auth/logout").catch(() => undefined);
  location.href = "/";
}

/** Open another project (a full load: the live socket and the store start clean). */
export function openProject(id: string, path = "/") {
  try {
    localStorage.setItem("bearing.project", id);
  } catch {
    /* storage off */
  }
  location.href = `${path}?project=${encodeURIComponent(id)}`;
}

export function rememberedProject(): string | null {
  try {
    return localStorage.getItem("bearing.project");
  } catch {
    return null;
  }
}

export async function createProject(input: { name: string; visibility: Visibility; source: ProjectSource }): Promise<ProjectInfo> {
  const res = await call<{ project: ProjectInfo }>("POST", "/api/projects", input);
  await loadProjects().catch(() => undefined);
  return res.project;
}

export const updateProject = (id: string, patch: { name?: string; visibility?: Visibility }) =>
  call<ProjectInfo>("PATCH", `/api/projects/${encodeURIComponent(id)}`, patch);
export const archiveProject = (id: string) => call<void>("DELETE", `/api/projects/${encodeURIComponent(id)}`);

export const listKeys = () => call<ApiKeyInfo[]>("GET", "/api/keys");
export const createKey = (name: string) => call<{ key: string; info: ApiKeyInfo }>("POST", "/api/keys", { name });
export const revokeKey = (id: string) => call<void>("DELETE", `/api/keys/${encodeURIComponent(id)}`);

export const listMembers = (project: string) => call<MemberInfo[]>("GET", `/api/projects/${encodeURIComponent(project)}/members`);
export const addMember = (project: string, who: string, role: Role) =>
  call<MemberInfo[]>("POST", `/api/projects/${encodeURIComponent(project)}/members`, { who, role });
export const removeMember = (project: string, who: string) =>
  call<MemberInfo[]>("DELETE", `/api/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(who)}`);

/** The caller's role on the open project. */
export function useAccess(): Role | null {
  return useStore((s) => s.access);
}

/** True when the caller may act on the open project (member or owner). */
export function useCanAct(): boolean {
  return useStore((s) => atLeast(s.access, "member"));
}

export function useIsOwner(): boolean {
  return useStore((s) => atLeast(s.access, "owner"));
}

export function useMe(): MeWithInstall | null {
  return useStore((s) => s.me as MeWithInstall | null);
}
