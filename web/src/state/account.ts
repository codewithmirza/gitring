/**
 * Accounts in the UI: who is signed in, the projects they can see, API keys, members, and project
 * creation. Every call goes to the Worker; nothing here keeps fake data.
 */
import type { ApiKeyInfo, MemberInfo, MeInfo, ProjectInfo, Role, Visibility } from "../../../src/core/accounts";
import { atLeast } from "../../../src/core/accounts";
import type { GithubSyncStatus, ProjectSettings, ProjectSource, SettingsAnswer } from "../../../src/core/types";
import { store, useStore } from "./store";
import { getJson, HttpError, invalidate, send } from "./http";

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Requests go through ./http: identical GETs in flight share one fetch, and a write drops the cached
 * answers it changes (a project write drops the project list; a sign-in change drops /api/me).
 */
async function call<T>(method: string, path: string, body?: unknown, maxAge = 0): Promise<T> {
  try {
    return method === "GET" ? await getJson<T>(path, { maxAge }) : await send<T>(method, path, body);
  } catch (e) {
    if (e instanceof HttpError) throw new AccountError(e.status, e.message);
    throw e;
  }
}

export interface MeWithInstall extends MeInfo {
  githubInstallUrl?: string | null;
}

/** Who is signed in. Asks the server unless `maxAge` allows an answer of that age (ms) from memory. */
export async function loadMe(opts: { maxAge?: number } = {}): Promise<MeWithInstall> {
  const me = await call<MeWithInstall>("GET", "/api/me", undefined, opts.maxAge);
  store.setMe(me);
  return me;
}

/**
 * The projects the person can see. An answer up to 30 s old comes from memory; every project write
 * through this module (create, rename, archive, members) drops it first, so the next call asks again.
 */
export async function loadProjects(opts: { maxAge?: number } = {}): Promise<ProjectInfo[]> {
  const list = await call<ProjectInfo[]>("GET", "/api/projects", undefined, opts.maxAge ?? 30_000);
  // A cut answer is not a list: keep the list that the store has (every view reads it as an array),
  // and do not keep the bad answer for the next caller.
  if (!Array.isArray(list)) {
    invalidate("/api/projects");
    throw new AccountError(0, "gitring did not send the project list. Try again.");
  }
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

/** End every browser session of the person (API keys and connected apps keep working). */
export async function signOutEverywhere() {
  await call("POST", "/auth/logout-all").catch(() => undefined);
  location.href = "/";
}

/** Open another project (a full load: the live socket and the store start clean). */
export function openProject(id: string, path = "/overview") {
  try {
    localStorage.setItem("gitring.project", id);
  } catch {
    /* storage off */
  }
  location.href = `${path}?project=${encodeURIComponent(id)}`;
}

export function rememberedProject(): string | null {
  try {
    return localStorage.getItem("gitring.project");
  } catch {
    return null;
  }
}

export async function createProject(input: { name: string; visibility: Visibility; source: ProjectSource; files?: UploadFile[] }): Promise<ProjectInfo> {
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

export const pushToken = (project: string) =>
  call<{ remote: string; token: string; expiresAt: string }>("POST", `/api/projects/${encodeURIComponent(project)}/push-token`, {});
export const checkImport = (project: string) =>
  call<{ importing: { url: string; error?: string } | null; mainSha: string }>("POST", `/api/projects/${encodeURIComponent(project)}/import/check`, {});

/** A file of a folder the person picked, ready for an upload project. */
export interface UploadFile {
  path: string;
  text?: string;
  base64?: string;
  executable?: boolean;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output", "coverage", ".turbo", ".cache", ".parcel-cache", ".vercel", ".wrangler", "__pycache__", ".venv", "venv", ".idea", ".DS_Store"]);
const MAX_FILE_BYTES = 5_000_000;

/** Which picked files go into the upload: no dependencies, build output, VCS data or files over 5 MB. */
export function uploadable(files: File[]): { keep: { file: File; path: string }[]; skipped: number; bytes: number } {
  const keep: { file: File; path: string }[] = [];
  let skipped = 0;
  let bytes = 0;
  for (const file of files) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = rel.split("/");
    const path = (parts.length > 1 ? parts.slice(1) : parts).join("/");
    if (!path || parts.some((p) => SKIP_DIRS.has(p)) || file.size > MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    keep.push({ file, path });
    bytes += file.size;
  }
  return { keep, skipped, bytes };
}

/** Read picked files: UTF-8 text when it decodes cleanly, else base64 bytes. */
export async function readUpload(list: { file: File; path: string }[]): Promise<UploadFile[]> {
  const dec = new TextDecoder("utf-8", { fatal: true });
  const out: UploadFile[] = [];
  for (const { file, path } of list) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let text: string | undefined;
    if (!buf.includes(0)) {
      try {
        text = dec.decode(buf);
      } catch {
        text = undefined;
      }
    }
    if (text !== undefined) out.push({ path, text, ...(/\.(sh|bash)$|(^|\/)bin\//.test(path) ? { executable: true } : {}) });
    else {
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      out.push({ path, base64: btoa(bin) });
    }
  }
  return out;
}

export const getSettings = (project: string) => call<ProjectSettings>("GET", `/api/projects/${encodeURIComponent(project)}/settings`);
/** Save part of the settings. The server merges the patch and answers the full settings (and the secrets of new webhooks, once). */
export const putSettings = (project: string, patch: Partial<ProjectSettings>) =>
  call<SettingsAnswer>("PUT", `/api/projects/${encodeURIComponent(project)}/settings`, patch);

/** GitHub sync of main: the status (members) and Sync now (owners). */
export const getGithubStatus = (project: string) => call<GithubSyncStatus>("GET", `/api/projects/${encodeURIComponent(project)}/github`);
export const syncGithub = (project: string) => call<GithubSyncStatus>("POST", `/api/projects/${encodeURIComponent(project)}/github/sync`, {});

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
