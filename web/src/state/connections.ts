/**
 * The connections of the person: GitHub, the apps allowed through OAuth, and personal API keys.
 * The apps are MCP clients such as Claude, Claude Code, Cursor and Codex.
 *
 * Requests: a GET answer stays in a short cache, and identical GETs in flight share one request. A view that closes
 * aborts its requests (the shared request stops when no view waits for it any more).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiKeyInfo, OAuthGrantInfo } from "../../../src/core/accounts";
import { loadMe } from "./account";

export class ConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: string })?.name === "AbortError";
}

async function send<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      signal,
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ConnectionError(0, "gitring did not answer. Check the connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) {
    // The session ended (signed out elsewhere, or expired): ask who is signed in, so the page shows the sign-in.
    void loadMe().catch(() => undefined);
    throw new ConnectionError(401, json.error ?? "Your session ended. Sign in again.");
  }
  if (!res.ok) throw new ConnectionError(res.status, json.error ?? `The request failed with status ${res.status}. Try again.`);
  return json as T;
}

/* ───────────── cache ───────────── */

interface Entry<T> {
  at: number;
  value?: T;
  inflight?: { promise: Promise<T>; ctl: AbortController; waiters: number };
}

const cache = new Map<string, Entry<unknown>>();

function abortError(): Error {
  try {
    return new DOMException("The view closed.", "AbortError");
  } catch {
    const e = new Error("The view closed.");
    e.name = "AbortError";
    return e;
  }
}

/** GET with a cache of `maxAge` ms and one request in flight per path. */
export function cachedGet<T>(path: string, opts: { maxAge?: number; signal?: AbortSignal } = {}): Promise<T> {
  const maxAge = opts.maxAge ?? 30_000;
  const hit = cache.get(path) as Entry<T> | undefined;
  if (hit && hit.value !== undefined && Date.now() - hit.at < maxAge) return Promise.resolve(hit.value);
  let entry = hit;
  if (!entry?.inflight || entry.inflight.ctl.signal.aborted) {
    const ctl = new AbortController();
    const promise = send<T>("GET", path, undefined, ctl.signal).then(
      (value) => {
        cache.set(path, { at: Date.now(), value });
        return value;
      },
      (e) => {
        const cur = cache.get(path);
        if (cur) cache.set(path, { at: cur.at, value: cur.value });
        throw e;
      },
    );
    entry = { at: hit?.at ?? 0, value: hit?.value, inflight: { promise, ctl, waiters: 0 } };
    cache.set(path, entry as Entry<unknown>);
  }
  const flight = entry.inflight!;
  flight.waiters++;
  const signal = opts.signal;
  if (!signal) return flight.promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      flight.waiters--;
      if (flight.waiters <= 0) flight.ctl.abort();
      reject(abortError());
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Forget cached answers whose path starts with `prefix`. */
export function invalidate(prefix: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

/** Change a cached answer in place (optimistic update). */
export function patchCache<T>(path: string, fn: (v: T) => T) {
  const e = cache.get(path) as Entry<T> | undefined;
  if (e?.value !== undefined) cache.set(path, { ...e, value: fn(e.value) });
}

/* ───────────── GitHub ───────────── */

/**
 * Connect GitHub to the signed-in account (link=1): gitring gets a GitHub token and lists the
 * repositories. A GitHub account of another gitring account is refused, never merged.
 */
export function connectGithub(returnTo = location.pathname + location.search) {
  location.href = `/auth/github/start?link=1&return=${encodeURIComponent(returnTo)}`;
}

/** gitring forgets the GitHub token of the person. Sign-in with GitHub still works. */
export async function disconnectGithub(): Promise<void> {
  await send<void>("DELETE", "/api/me/github");
  invalidate("/api/github/");
  await loadMe().catch(() => undefined);
}

/* ───────────── apps (OAuth grants) ───────────── */

const GRANTS = "/api/oauth/grants";

export function listGrants(opts: { maxAge?: number; signal?: AbortSignal } = {}): Promise<OAuthGrantInfo[]> {
  return cachedGet<OAuthGrantInfo[]>(GRANTS, opts);
}

/** The app loses access at once: its tokens stop working. Its work copies stay. */
export async function revokeGrant(id: string): Promise<void> {
  await send<void>("DELETE", `${GRANTS}/${encodeURIComponent(id)}`);
  patchCache<OAuthGrantInfo[]>(GRANTS, (list) => list.filter((g) => g.id !== id));
}

/* ───────────── API keys ───────────── */

const KEYS = "/api/keys";

export function listKeys(opts: { maxAge?: number; signal?: AbortSignal } = {}): Promise<ApiKeyInfo[]> {
  return cachedGet<ApiKeyInfo[]>(KEYS, opts);
}

/** A new key. The answer has the full key one time only. */
export async function createKey(name: string): Promise<{ key: string; info: ApiKeyInfo }> {
  const res = await send<{ key: string; info: ApiKeyInfo }>("POST", KEYS, { name });
  patchCache<ApiKeyInfo[]>(KEYS, (list) => [...list.filter((k) => k.id !== res.info.id), res.info]);
  return res;
}

export async function revokeKey(id: string): Promise<void> {
  await send<void>("DELETE", `${KEYS}/${encodeURIComponent(id)}`);
  patchCache<ApiKeyInfo[]>(KEYS, (list) => list.filter((k) => k.id !== id));
}

/* ───────────── a small hook for views ───────────── */

export interface Resource<T> {
  data: T | null;
  error: ConnectionError | Error | null;
  loading: boolean;
  /** Load again (skips the cache). */
  reload: () => void;
  /** Change the data here (optimistic update). */
  set: (fn: (v: T | null) => T | null) => void;
}

/**
 * Load data for a view. The request aborts when the view closes or `key` changes.
 * `enabled: false` loads nothing (for example: nobody is signed in).
 */
export function useResource<T>(key: string, load: (opts: { signal: AbortSignal; maxAge?: number }) => Promise<T>, enabled = true): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    loadRef
      .current({ signal: ctl.signal, maxAge: nonce ? 0 : undefined })
      .then((v) => {
        setData(v);
        setLoading(false);
      })
      .catch((e) => {
        if (isAbort(e)) return;
        setError(e as Error);
        setLoading(false);
      });
    return () => ctl.abort();
  }, [key, enabled, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const set = useCallback((fn: (v: T | null) => T | null) => setData((v) => fn(v)), []);
  return { data, error, loading, reload, set };
}
