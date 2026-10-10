/**
 * GitHub and onboarding data for the web app: the person's repositories, the guesses for a new project,
 * project creation with settings, the GitHub sync of a project, and the apps (MCP clients) that the
 * person allowed through OAuth.
 *
 * Requests:
 *   - identical GET requests in flight share one fetch;
 *   - answers that rarely change stay in a small cache for a short time (TTL per call);
 *   - each caller can abort its own wait; the fetch stops when no caller waits any more.
 * The browser never holds GitHub tokens: the Worker keeps and refreshes them.
 */
import { useEffect, useRef, useState } from "react";
import type { GithubRepo, GithubRepoList, OAuthGrantInfo, ProjectGuess, ProjectInfo, Visibility } from "../../../src/core/accounts";
import type { GithubSyncStatus, ProjectSettings, ProjectSource } from "../../../src/core/types";
import { loadProjects, type UploadFile } from "./account";

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The JSON body of the error answer (for example `installUrl`). */
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export const OFFLINE_TEXT = "gitring did not answer. Check the connection and try again.";

function statusText(status: number): string {
  if (status === 401) return "Sign in first.";
  if (status === 403) return "You do not have access to this.";
  if (status === 404) return "gitring did not find it.";
  if (status === 429) return "Too many requests. Wait one minute, then try again.";
  if (status >= 500) return "gitring had a problem. Try again.";
  return `The request failed with status ${status}. Try again.`;
}

function abortError(): DOMException {
  return new DOMException("The request stopped.", "AbortError");
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "AbortError";
}

async function send<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    if (signal?.aborted) throw abortError();
    throw new RequestError(0, OFFLINE_TEXT);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text().catch(() => "");
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const msg = typeof d.error === "string" && d.error ? d.error : typeof d.message === "string" && d.message ? d.message : statusText(res.status);
    throw new RequestError(res.status, msg, d);
  }
  return data as T;
}

/* ───────────── shared GET: dedupe, cache, abort ───────────── */

interface Entry {
  at: number;
  value: unknown;
}
interface Flight {
  promise: Promise<unknown>;
  ctl: AbortController;
  waiters: number;
}

const cache = new Map<string, Entry>();
const flights = new Map<string, Flight>();

/** Join a shared fetch. Aborting `signal` stops this wait only; the fetch stops when nobody waits. */
function join<T>(key: string, f: Flight, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  f.waiters++;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const leave = () => {
      done = true;
      f.waiters--;
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (done) return;
      leave();
      if (f.waiters <= 0 && flights.get(key) === f) {
        flights.delete(key);
        f.ctl.abort();
      }
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    f.promise.then(
      (v) => {
        if (done) return;
        leave();
        resolve(v as T);
      },
      (e) => {
        if (done) return;
        leave();
        reject(e);
      },
    );
  });
}

/**
 * GET a JSON answer. `ttl` (ms) keeps the answer for later calls; `fresh` skips the cache.
 * Calls for the same URL while a fetch runs share that fetch.
 */
export function getJson<T>(url: string, opts: { ttl?: number; signal?: AbortSignal; fresh?: boolean } = {}): Promise<T> {
  const ttl = opts.ttl ?? 0;
  const hit = cache.get(url);
  if (!opts.fresh && hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value as T);
  let f = flights.get(url);
  if (!f) {
    const ctl = new AbortController();
    const flight: Flight = { promise: Promise.resolve(), ctl, waiters: 0 };
    flight.promise = send<T>("GET", url, undefined, ctl.signal)
      .then((v) => {
        if (ttl > 0) cache.set(url, { at: Date.now(), value: v });
        return v;
      })
      .finally(() => {
        if (flights.get(url) === flight) flights.delete(url);
      });
    // Every waiter can leave before the answer: the rejection then has no other handler.
    flight.promise.catch(() => undefined);
    flights.set(url, flight);
    f = flight;
  }
  return join<T>(url, f, opts.signal);
}

/** The cached answer for a URL, if it is younger than `ttl`. */
export function peekJson<T>(url: string, ttl: number): T | null {
  const hit = cache.get(url);
  return hit && Date.now() - hit.at < ttl ? (hit.value as T) : null;
}

/** Forget cached answers whose URL starts with `prefix`. */
export function forget(prefix: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

/** Test aid: forget every cached answer and every shared fetch. */
export function resetRequestCache(): void {
  cache.clear();
  flights.clear();
}

/* ───────────── repositories and guesses ───────────── */

export const REPOS_TTL = 60_000;
const GUESS_TTL = 5 * 60_000;

export function reposUrl(q = ""): string {
  const t = q.trim();
  return t ? `/api/github/repos?q=${encodeURIComponent(t)}` : "/api/github/repos";
}

/** The person's GitHub repositories (from the gitring GitHub App installations). 401 when signed out. */
export function listRepos(q = "", signal?: AbortSignal, fresh = false): Promise<GithubRepoList> {
  return getJson<GithubRepoList>(reposUrl(q), { ttl: REPOS_TTL, signal, fresh });
}

export function cachedRepos(q = ""): GithubRepoList | null {
  return peekJson<GithubRepoList>(reposUrl(q), REPOS_TTL);
}

/** Load the repository list again (after the person installs the GitHub App on more repositories). */
export function refreshRepos(): void {
  forget("/api/github/repos");
}

export function guessUrl(repo: string, branch?: string): string {
  return `/api/github/guess?repo=${encodeURIComponent(repo)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`;
}

/** What gitring guesses for a new project from a GitHub repository: name, branch, test commands, sync mode. */
export function guessProject(repo: string, branch?: string, signal?: AbortSignal): Promise<ProjectGuess> {
  return getJson<ProjectGuess>(guessUrl(repo, branch), { ttl: GUESS_TTL, signal });
}

export function cachedGuess(repo: string, branch?: string): ProjectGuess | null {
  return peekJson<ProjectGuess>(guessUrl(repo, branch), GUESS_TTL);
}

/** The address that signs in with GitHub (or connects GitHub to the account), then comes back to `returnTo`. */
export function githubConnectUrl(returnTo: string): string {
  return `/auth/github/start?return=${encodeURIComponent(returnTo)}`;
}

export function googleSignInUrl(returnTo: string): string {
  return `/auth/google/start?return=${encodeURIComponent(returnTo)}`;
}

/* ───────────── projects ───────────── */

export interface NewProjectInput {
  name: string;
  visibility: Visibility;
  source: ProjectSource;
  settings?: Partial<ProjectSettings>;
  files?: UploadFile[];
}

/** Create a project. The project list loads again; the answer is the new project. */
export async function createProjectFrom(input: NewProjectInput): Promise<ProjectInfo> {
  const res = await send<{ project: ProjectInfo }>("POST", "/api/projects", input);
  await loadProjects().catch(() => undefined);
  return res.project;
}

const p = (project: string) => `/api/projects/${encodeURIComponent(project)}`;

/** GitHub sync status of a project (members). */
export function syncStatus(project: string, signal?: AbortSignal): Promise<GithubSyncStatus> {
  return getJson<GithubSyncStatus>(`${p(project)}/github`, { signal });
}

/** Send main to GitHub now (owners). */
export function sendToGithub(project: string): Promise<GithubSyncStatus> {
  return send<GithubSyncStatus>("POST", `${p(project)}/github/sync`, {});
}

/** Bring the changes on GitHub into gitring now (owners). */
export function pullFromGithub(project: string): Promise<GithubSyncStatus> {
  return send<GithubSyncStatus>("POST", `${p(project)}/github/pull`, {});
}

/* ───────────── OAuth apps (MCP clients) ───────────── */

/** Apps that the person allowed to use gitring as them. 401 when signed out. */
export function listGrants(signal?: AbortSignal): Promise<OAuthGrantInfo[]> {
  return getJson<OAuthGrantInfo[]>("/api/oauth/grants", { signal });
}

/* ───────────── hooks ───────────── */

/**
 * A flag for a loading indicator: it turns on only after `delay` ms of loading, and then stays on for at
 * least `min` ms, so fast answers show no flash and slow answers show a steady skeleton.
 */
export function useDelayedFlag(loading: boolean, delay = 150, min = 400): boolean {
  const [shown, setShown] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (loading) {
      if (shown) return;
      const t = setTimeout(() => {
        since.current = Date.now();
        setShown(true);
      }, delay);
      return () => clearTimeout(t);
    }
    if (!shown) return;
    const left = Math.max(0, min - (Date.now() - since.current));
    const t = setTimeout(() => setShown(false), left);
    return () => clearTimeout(t);
  }, [loading, shown, delay, min]);
  return shown;
}

export interface RepoSearch {
  /** The full list (no query), or null until it loads. */
  base: GithubRepoList | null;
  /** Server results for the query (null until they load, or without a query). */
  found: GithubRepoList | null;
  loading: boolean;
  /** A server search for the query runs now. */
  searching: boolean;
  error: RequestError | null;
  /** Load the list again (skips the cache). */
  reload: () => void;
}

/**
 * The person's repositories for a combobox. The full list loads once (cached 60 s); a query filters it at
 * once in memory, and after 250 ms a server search adds repositories that the full list does not have.
 * Requests of a closed combobox stop.
 */
export function useRepoSearch(query: string, enabled: boolean): RepoSearch {
  const [base, setBase] = useState<GithubRepoList | null>(() => (enabled ? cachedRepos() : null));
  const [found, setFound] = useState<GithubRepoList | null>(null);
  const [error, setError] = useState<RequestError | null>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [nonce, setNonce] = useState(0);
  const q = query.trim();

  useEffect(() => {
    if (!enabled) return;
    const fresh = nonce > 0;
    const cached = fresh ? null : cachedRepos();
    if (cached) {
      setBase(cached);
      setError(null);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    listRepos("", ctl.signal, fresh)
      .then((list) => {
        setBase(list);
        setError(null);
      })
      .catch((e) => {
        if (!isAbort(e)) setError(e instanceof RequestError ? e : new RequestError(0, OFFLINE_TEXT));
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => {
      ctl.abort();
      setLoading(false);
    };
  }, [enabled, nonce]);

  // The person may install the GitHub App in another tab: look again when this tab comes back.
  useEffect(() => {
    if (!enabled) return;
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 2000) {
        refreshRepos();
        setNonce((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled]);

  useEffect(() => {
    setFound(null);
    if (!enabled || !q || base?.connected === false) {
      setSearching(false);
      return;
    }
    const cached = cachedRepos(q);
    if (cached) {
      setFound(cached);
      return;
    }
    const ctl = new AbortController();
    setSearching(true);
    const t = setTimeout(() => {
      listRepos(q, ctl.signal)
        .then(setFound)
        .catch(() => undefined)
        .finally(() => {
          if (!ctl.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, enabled, base?.connected, nonce]);

  return {
    base,
    found,
    loading,
    searching,
    error,
    reload: () => {
      refreshRepos();
      setNonce((n) => n + 1);
    },
  };
}

/** Merge the in-memory matches with the server results (no duplicates; in-memory order first). */
export function mergeRepos(local: GithubRepo[], server: GithubRepo[] | undefined): GithubRepo[] {
  if (!server?.length) return local;
  const seen = new Set(local.map((r) => r.fullName.toLowerCase()));
  return [...local, ...server.filter((r) => !seen.has(r.fullName.toLowerCase()))];
}
