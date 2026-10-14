/**
 * Requests to the gitring Worker: one place for fetch, errors, shared requests, caches and aborts.
 *   - GET requests for the same URL that run at the same time share one fetch. Each caller can pass an AbortSignal:
 *     it stops the wait of that caller only (a view that closes does not cancel the request of a view that stays).
 *   - An answer can stay in a memory cache for `maxAge` ms. A write through this module removes the answers it can change
 *     (see WRITE_RULES). `invalidate()` does the same for other writers.
 *   - With `etag: true` the next GET sends If-None-Match, and a 304 answer reuses the cached value (no body on the wire).
 * Cached values are shared between callers: never change them in place.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The JSON body of an error answer, when it had one. */
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const OFFLINE_TEXT = "gitring did not answer. Check the connection and try again.";
const TIMEOUT_TEXT = "gitring did not answer in time. Try again.";

/** Plain sentences for answers without an error text of their own. */
export function statusText(status: number): string {
  if (status === 0) return OFFLINE_TEXT;
  if (status === 401) return "Sign in first.";
  if (status === 403) return "You do not have access to this.";
  if (status === 404) return "gitring did not find it.";
  if (status === 409) return "Something changed at the same time. Load the page again and try again.";
  if (status === 429) return "Too many requests. Wait one minute, then try again.";
  if (status >= 500) return "gitring had a problem. Try again.";
  return `The request failed with status ${status}. Try again.`;
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "AbortError";
}

export function abortError(): Error {
  try {
    return new DOMException("The request stopped.", "AbortError");
  } catch {
    const e = new Error("The request stopped.");
    e.name = "AbortError";
    return e;
  }
}

/* ───────────── LRU ───────────── */

/** A small LRU map with a limit on entries and on total weight (for example characters of text). */
export class Lru<K, V> {
  private map = new Map<K, { value: V; weight: number }>();
  private total = 0;
  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight = Infinity,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get weight(): number {
    return this.total;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    // Most recently used goes to the end.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Read without changing the order. */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: K, value: V, weight = 1): void {
    const old = this.map.get(key);
    if (old) {
      this.total -= old.weight;
      this.map.delete(key);
    }
    // One value larger than the whole budget is not kept.
    if (weight > this.maxWeight) return;
    this.map.set(key, { value, weight });
    this.total += weight;
    while (this.map.size > this.maxEntries || this.total > this.maxWeight) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.delete(first.value);
    }
  }

  delete(key: K): void {
    const e = this.map.get(key);
    if (!e) return;
    this.total -= e.weight;
    this.map.delete(key);
  }

  keys(): K[] {
    return [...this.map.keys()];
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

/* ───────────── fetch ───────────── */

type Kind = "json" | "text";

interface Entry {
  at: number;
  value: unknown;
  etag?: string;
  weight: number;
}

interface Flight {
  promise: Promise<unknown>;
  ctl: AbortController;
  waiters: number;
}

/** Cached answers, by URL. About 24 MB of text at most (JSON counts its text length). */
const cache = new Lru<string, Entry>(400, 24_000_000);
const flights = new Map<string, Flight>();
let requestCount = 0;

/** How many fetches this module started (for tests and the development console). */
export function fetchCount(): number {
  return requestCount;
}

async function errorOf(res: Response): Promise<HttpError> {
  let data: Record<string, unknown> = {};
  let text = "";
  try {
    text = await res.text();
    const j = text ? (JSON.parse(text) as unknown) : null;
    if (j && typeof j === "object" && !Array.isArray(j)) data = j as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  const msg = typeof data.error === "string" && data.error ? data.error : typeof data.message === "string" && data.message ? data.message : "";
  return new HttpError(res.status, msg || statusText(res.status), data);
}

interface FetchOptions {
  method: string;
  body?: unknown;
  accept: string;
  signal: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs: number;
  priority?: "high" | "low" | "auto";
}

/** One fetch with a time limit. Throws HttpError for network errors and non-2xx answers (304 passes). */
async function raw(url: string, o: FetchOptions): Promise<Response> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, o.timeoutMs);
  const onAbort = () => ctl.abort();
  if (o.signal.aborted) ctl.abort();
  else o.signal.addEventListener("abort", onAbort, { once: true });
  requestCount++;
  try {
    const headers: Record<string, string> = { accept: o.accept, ...(o.headers ?? {}) };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit & { priority?: string } = {
      method: o.method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      credentials: "same-origin",
      signal: ctl.signal,
    };
    if (o.priority) init.priority = o.priority;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (o.signal.aborted) throw abortError();
      if (timedOut) throw new HttpError(0, TIMEOUT_TEXT);
      if (isAbort(e)) throw abortError();
      throw new HttpError(0, OFFLINE_TEXT);
    }
    if (!res.ok && res.status !== 304) throw await errorOf(res);
    return res;
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", onAbort);
  }
}

async function readBody(res: Response, kind: Kind): Promise<{ value: unknown; weight: number }> {
  if (res.status === 204) return { value: undefined, weight: 1 };
  const text = await res.text();
  if (kind === "text") return { value: text, weight: text.length + 64 };
  const type = res.headers.get("content-type") ?? "";
  if (!text) return { value: undefined, weight: 1 };
  if (type.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      return { value: JSON.parse(text), weight: text.length + 64 };
    } catch {
      throw new HttpError(res.status, "The server sent an answer that gitring cannot read. Try again.");
    }
  }
  return { value: text, weight: text.length + 64 };
}

/** Join a shared fetch. Aborting `signal` stops this wait only; the fetch stops when nobody waits. */
function join<T>(key: string, f: Flight, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  f.waiters++;
  if (!signal) return f.promise as Promise<T>;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      f.waiters--;
      if (f.waiters <= 0 && flights.get(key) === f) {
        flights.delete(key);
        f.ctl.abort();
      }
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    f.promise.then(
      (v) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve(v as T);
      },
      (e) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export interface GetOptions {
  signal?: AbortSignal;
  /** Serve a cached answer younger than this many ms. 0 (default): ask the server; requests in flight are still shared. */
  maxAge?: number;
  /** Keep the answer with its ETag and revalidate with If-None-Match. */
  etag?: boolean;
  /** Keep the answer in the cache (also without an ETag), so peek() and maxAge can use it. */
  keep?: boolean;
  timeoutMs?: number;
  accept?: string;
  /** Fetch priority hint: "low" for prefetches. */
  priority?: "high" | "low" | "auto";
}

function get<T>(url: string, kind: Kind, o: GetOptions): Promise<T> {
  const maxAge = o.maxAge ?? 0;
  const hit = cache.peek(url);
  if (hit && maxAge > 0 && Date.now() - hit.at < maxAge) {
    cache.get(url); // mark as used
    return Promise.resolve(hit.value as T);
  }
  if (o.signal?.aborted) return Promise.reject(abortError());
  const key = `${kind} ${url}`;
  let f = flights.get(key);
  if (!f || f.ctl.signal.aborted) {
    const ctl = new AbortController();
    const prev = o.etag ? cache.peek(url) : undefined;
    const promise = (async () => {
      const res = await raw(url, {
        method: "GET",
        accept: o.accept ?? (kind === "json" ? "application/json" : "text/plain, */*"),
        signal: ctl.signal,
        headers: prev?.etag ? { "if-none-match": prev.etag } : undefined,
        timeoutMs: o.timeoutMs ?? 15_000,
        priority: o.priority,
      });
      if (res.status === 304 && prev) {
        cache.set(url, { ...prev, at: Date.now() }, prev.weight);
        return prev.value;
      }
      if (res.status === 304) throw new HttpError(304, "The server sent no content. Try again.");
      const { value, weight } = await readBody(res, kind);
      const etag = res.headers.get("etag") ?? undefined;
      if (o.etag || o.keep || maxAge > 0) cache.set(url, { at: Date.now(), value, etag: o.etag ? etag : undefined, weight }, weight);
      return value;
    })();
    f = { promise, ctl, waiters: 0 };
    const mine = f;
    flights.set(key, mine);
    promise.then(
      () => {
        if (flights.get(key) === mine) flights.delete(key);
      },
      () => {
        if (flights.get(key) === mine) flights.delete(key);
      },
    );
  }
  return join<T>(key, f, o.signal);
}

/** GET a JSON answer (shared in flight; cached by maxAge, keep or etag). */
export function getJson<T>(url: string, o: GetOptions = {}): Promise<T> {
  return get<T>(url, "json", o);
}

/** GET a text answer (shared in flight; cached by maxAge, keep or etag). */
export function getText(url: string, o: GetOptions = {}): Promise<string> {
  return get<string>(url, "text", o);
}

/** The cached answer for a URL, if there is one (no request). */
export function peek<T>(url: string): T | undefined {
  return cache.peek(url)?.value as T | undefined;
}

/** Forget cached answers: an exact URL, every URL with a prefix ("/api/projects/p1/"), or a test. */
export function invalidate(match: string | RegExp | ((url: string) => boolean), opts: { prefix?: boolean } = {}): void {
  for (const k of cache.keys()) {
    const hit = typeof match === "function" ? match(k) : match instanceof RegExp ? match.test(k) : opts.prefix ? k.startsWith(match) : k === match || k.startsWith(`${match}?`);
    if (hit) cache.delete(k);
  }
}

/**
 * Writes that change cached answers. A write to a project changes the project list (name, visibility,
 * a new or archived project); a sign-in change or a change to the person changes /api/me and the list.
 */
const WRITE_RULES: { test: RegExp; drop: (url: string) => void }[] = [
  { test: /^\/api\/projects(\/|\?|$)/, drop: () => invalidate("/api/projects") },
  {
    test: /^\/(auth|api\/me)(\/|\?|$)/,
    drop: () => {
      invalidate("/api/me");
      invalidate("/api/projects");
    },
  },
];

function pathOf(url: string): string {
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return url;
  }
}

/** Tell the caches about a write that went out another way (for example another module's fetch). */
export function noteWrite(url: string): void {
  const path = pathOf(url);
  for (const r of WRITE_RULES) if (r.test.test(path)) r.drop(url);
}

export interface SendOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** A write (POST, PUT, PATCH, DELETE). The answer is JSON, text or undefined (204). */
export async function send<T>(method: string, url: string, body?: unknown, o: SendOptions = {}): Promise<T> {
  try {
    const res = await raw(url, {
      method,
      body,
      accept: "application/json",
      signal: o.signal ?? new AbortController().signal,
      timeoutMs: o.timeoutMs ?? 20_000,
    });
    return (await readBody(res, "json")).value as T;
  } finally {
    // Also after a failure: the write may have reached the server.
    noteWrite(url);
  }
}

/** Forget every cached answer (sign-out, tests). */
export function resetHttpCache(): void {
  cache.clear();
  for (const f of flights.values()) f.ctl.abort();
  flights.clear();
}
