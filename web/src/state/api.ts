/**
 * Project client: the Worker's REST API under /api/projects/:p and live events over /ws/:p.
 *
 * Boot: the UI asks for the person, the project list and (on a project view) the state of one project.
 * When the address names the project, its state loads at the same time as the account (no waterfall).
 * After that, the WebSocket brings every change: nothing here polls. When the socket drops, it opens
 * again with backoff; the server sends a fresh snapshot on each connect, and the store keeps every
 * object that did not change, so a resync costs no re-render. There is no offline or fake data path.
 *
 * Requests go through ./http: identical GETs share one fetch, views can abort their requests, and
 * answers that do not change (merge records, files of a commit) stay in small LRU caches.
 */
import type { Attempt, ConnectInfo, Intent, Landing, ProjectState, TreeResponse } from "../../../src/core/types";
import type { ProjectInfo, Role } from "../../../src/core/accounts";
import { store } from "./store";
import { loadMe, loadProjects, rememberedProject } from "./account";
import { isProjectRoute, navigate, parseRoute, setSearchParam } from "../app/router";
import { getJson, getText, HttpError, isAbort, Lru, send } from "./http";

export type { ConnectInfo, TreeResponse };
export { HttpError as ApiError, isAbort };

export interface DiffFile {
  path: string;
  status: "A" | "M" | "D";
  additions: number;
  deletions: number;
  /** Unified diff text. */
  diff: string;
}

export interface DiffResult {
  files: DiffFile[];
}

export interface LandingDetail {
  landing: Landing;
  /** The merge record: a git note (JSON text or an object). */
  note: unknown;
  diff: DiffResult;
}

export interface NewIntentInput {
  title: string;
  goal: string;
  checks?: { path: string; content: string; description: string }[];
  priority?: "normal" | "high";
}

export interface AmendInput {
  goal?: string;
  constraints?: string[];
  reason: string;
}

export interface LandResult {
  status: string;
  landing?: Landing;
  message?: string;
}

/** Options for reads: `signal` aborts the wait of the caller (a view that closes). */
export interface ReadOptions {
  signal?: AbortSignal;
  /** "low" for prefetches on hover or focus. */
  priority?: "high" | "low" | "auto";
}

export interface VersionedRead extends ReadOptions {
  /**
   * A version of the content that the caller knows from the live state (a commit id, a work copy's
   * `updatedAt`, the `sha` of its tree). Same version → the answer comes from memory, without a request.
   */
  version?: string | number;
}

export interface HarborClient {
  readonly projectId: string;
  createIntent(input: NewIntentInput): Promise<Intent>;
  amendIntent(id: string, input: AmendInput): Promise<Intent>;
  launch(id: string, fanout: number, models?: string[]): Promise<{ attempts: Attempt[] }>;
  park(id: string, reason: string): Promise<void>;
  land(attemptId: string, rationale: string): Promise<LandResult>;
  rederive(attemptId: string, reason: string): Promise<{ attempt: Attempt }>;
  /** The work copy against its base. With `version` (the work copy's updatedAt) the answer is reused until the work copy changes. */
  attemptDiff(attemptId: string, opts?: VersionedRead): Promise<DiffResult>;
  /** A merge record. Merges do not change, so the answer stays in memory. */
  landing(id: string, opts?: ReadOptions): Promise<LandingDetail>;
  /** Files of main, a work copy id or a commit id. Revalidates with ETag; a commit id stays in memory. */
  tree(ref: string, opts?: ReadOptions): Promise<TreeResponse>;
  /**
   * The text of one file. A commit id (40 hex) never changes: the answer stays in memory. For main and
   * work copies pass `version` (the tree `sha`): same version, no request. Rejects with status 404 for a
   * file that is not on the ref, or that gitring keeps as binary.
   */
  file(ref: string, path: string, opts?: VersionedRead): Promise<string>;
  /** The text of a file when it is in memory now (no request). */
  cachedFile(ref: string, path: string, version?: string | number): string | undefined;
  /** Start built-in AI agents on every open task (Workers AI models). */
  launchAll(): Promise<{ launched: number; queued: number }>;
  /** Endpoints of this deployment for the Connect page (kept for 5 minutes). */
  connect(opts?: ReadOptions): Promise<ConnectInfo>;
  /** Live preview URL of a work copy (iframe src). */
  previewUrl(attemptId: string): string;
}

const SHA = /^[0-9a-f]{40}$/;

/** True for a full commit id: its files never change. */
export function isCommitId(ref: string): boolean {
  return SHA.test(ref);
}

function looksLikeState(x: unknown): x is ProjectState {
  const s = x as ProjectState;
  return Boolean(s && typeof s === "object" && s.project && Array.isArray(s.intents) && Array.isArray(s.attempts));
}

class LiveHarbor implements HarborClient {
  /** Merge records (they never change). */
  private landings = new Lru<string, LandingDetail>(60);
  /** Diffs of work copies by id and version. */
  private diffs = new Lru<string, DiffResult>(24, 8_000_000);
  /** Trees of commits (they never change). */
  private commitTrees = new Lru<string, TreeResponse>(12);
  /** File texts by version (commit id, or the tree `sha` of main or a work copy) and path: about 12 MB. */
  private files = new Lru<string, string>(400, 12_000_000);

  constructor(readonly projectId: string) {}

  private p(path: string) {
    return `/api/projects/${encodeURIComponent(this.projectId)}${path}`;
  }

  createIntent(input: NewIntentInput) {
    return send<Intent>("POST", this.p("/intents"), input);
  }
  amendIntent(id: string, input: AmendInput) {
    return send<Intent>("PATCH", this.p(`/intents/${encodeURIComponent(id)}`), input);
  }
  launch(id: string, fanout: number, models?: string[]) {
    return send<{ attempts: Attempt[] }>("POST", this.p(`/intents/${encodeURIComponent(id)}/launch`), { fanout, models });
  }
  async park(id: string, reason: string) {
    await send("POST", this.p(`/intents/${encodeURIComponent(id)}/park`), { reason });
  }
  land(attemptId: string, rationale: string) {
    return send<LandResult>("POST", this.p(`/attempts/${encodeURIComponent(attemptId)}/land`), { rationale });
  }
  rederive(attemptId: string, reason: string) {
    return send<{ attempt: Attempt }>("POST", this.p(`/attempts/${encodeURIComponent(attemptId)}/rederive`), { reason });
  }

  async attemptDiff(attemptId: string, opts: VersionedRead = {}) {
    const key = `${attemptId}@${opts.version ?? ""}`;
    const hit = opts.version !== undefined ? this.diffs.get(key) : undefined;
    if (hit) return hit;
    const res = await getJson<DiffResult>(this.p(`/attempts/${encodeURIComponent(attemptId)}/diff`), { signal: opts.signal, priority: opts.priority });
    if (opts.version !== undefined) this.diffs.set(key, res, res.files.reduce((n, f) => n + f.diff.length, 0) + 256);
    return res;
  }

  async landing(id: string, opts: ReadOptions = {}) {
    const hit = this.landings.get(id);
    if (hit) return hit;
    const res = await getJson<LandingDetail>(this.p(`/landings/${encodeURIComponent(id)}`), { signal: opts.signal, priority: opts.priority, timeoutMs: 20_000 });
    this.landings.set(id, res);
    return res;
  }

  async tree(ref: string, opts: ReadOptions = {}) {
    const commit = isCommitId(ref);
    if (commit) {
      const hit = this.commitTrees.get(ref);
      if (hit) return hit;
    }
    const res = await getJson<TreeResponse>(this.p(`/tree?ref=${encodeURIComponent(ref)}`), {
      signal: opts.signal,
      priority: opts.priority,
      // main and work copies change: keep the answer and its ETag, and ask again with If-None-Match.
      etag: !commit,
      timeoutMs: 20_000,
    });
    if (commit) this.commitTrees.set(ref, res);
    return res;
  }

  private fileKey(ref: string, path: string, version?: string | number): string | null {
    if (isCommitId(ref)) return `${ref}\u0000${path}`;
    return version === undefined || version === "" ? null : `${version}\u0000${path}`;
  }

  cachedFile(ref: string, path: string, version?: string | number) {
    const key = this.fileKey(ref, path, version);
    return key ? this.files.get(key) : undefined;
  }

  async file(ref: string, path: string, opts: VersionedRead = {}) {
    const key = this.fileKey(ref, path, opts.version);
    const hit = key ? this.files.get(key) : undefined;
    if (hit !== undefined) return hit;
    const text = await getText(this.p(`/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`), {
      signal: opts.signal,
      priority: opts.priority,
      // A commit id is immutable: the browser cache answers it. Other refs revalidate with their ETag.
      etag: !isCommitId(ref),
      timeoutMs: 20_000,
    });
    if (key) this.files.set(key, text, text.length + 64);
    return text;
  }

  launchAll() {
    return send<{ launched: number; queued: number }>("POST", this.p("/launch-all"), {});
  }

  connect(opts: ReadOptions = {}): Promise<ConnectInfo> {
    return getJson<ConnectInfo>(this.p("/connect"), { signal: opts.signal, maxAge: 5 * 60_000 });
  }

  previewUrl(attemptId: string) {
    return `/preview/${encodeURIComponent(this.projectId)}/${encodeURIComponent(attemptId)}/`;
  }
}

/** Connect info before the Worker answers: the endpoints of this origin. Inputs count as off until the answer. */
export function defaultConnectInfo(projectId: string): ConnectInfo {
  const origin = typeof location !== "undefined" ? location.origin : "";
  return {
    projectId,
    mcpUrl: `${origin}/mcp`,
    hookUrl: `${origin}/hooks/claude/${encodeURIComponent(projectId)}`,
    intentsUrl: `${origin}/hooks/intents`,
    artifacts: { namespace: "", repo: "", backend: "artifacts" },
    inputs: { slack: false, githubIssues: false },
    githubApp: null,
  };
}

/* ───────────── state ───────────── */

/** The state of a project, without the caller's role (the store keeps that apart). */
async function fetchState(projectId: string, timeoutMs = 10_000): Promise<{ state: ProjectState; access: Role | null }> {
  const st = await getJson<unknown>(`/api/projects/${encodeURIComponent(projectId)}/state`, { timeoutMs });
  if (!looksLikeState(st)) throw new HttpError(0, "The server sent a reply that is not a project state.");
  const { access, ...state } = st as ProjectState & { access?: Role };
  return { state: state as ProjectState, access: access ?? null };
}

/* ───────────── WebSocket ───────────── */

/** After this long in a hidden tab the socket closes; it opens again (with a fresh snapshot) when the tab shows. */
const HIDDEN_CLOSE_MS = 5 * 60_000;
/** A visible tab that heard nothing for this long sends a ping; no answer in PONG_WAIT_MS → reconnect. */
const IDLE_PING_MS = 60_000;
const PONG_WAIT_MS = 10_000;
/** After a reconnect the server sends a snapshot. Without one in this time, one state request resyncs. */
const SNAPSHOT_WAIT_MS = 5_000;

/**
 * The live connection of one project. It reconnects with backoff (and at once when the network or the
 * tab comes back), checks an idle connection with a ping, and closes while the tab stays hidden.
 */
class LiveSocket {
  private ws: WebSocket | null = null;
  private tries = 0;
  private opened = false;
  private stopped = false;
  private paused = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private idle: ReturnType<typeof setInterval> | null = null;
  private pong: ReturnType<typeof setTimeout> | null = null;
  private snapWait: ReturnType<typeof setTimeout> | null = null;
  private hide: ReturnType<typeof setTimeout> | null = null;
  private lastHeard = 0;
  private hiddenAt = 0;

  constructor(readonly projectId: string) {}

  start() {
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    this.open();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    this.close();
  }

  private clearTimers() {
    for (const t of [this.retry, this.pong, this.snapWait, this.hide]) if (t) clearTimeout(t);
    if (this.idle) clearInterval(this.idle);
    this.retry = this.pong = this.snapWait = this.hide = null;
    this.idle = null;
  }

  private close() {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(1000, "closed by the page");
      } catch {
        /* already closing */
      }
    }
  }

  private open() {
    if (this.stopped || this.paused) return;
    this.clearTimers();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      store.setConn("offline", "This device is offline. gitring reconnects when the network is back.");
      return;
    }
    store.setConn(this.opened ? "reconnecting" : "connecting", store.get().error);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(this.projectId)}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    const reconnect = this.opened;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.tries = 0;
      this.opened = true;
      this.lastHeard = Date.now();
      store.setConn("open", null);
      this.idle = setInterval(() => this.checkIdle(), IDLE_PING_MS / 2);
      // The server sends a snapshot on each connect. If none comes after a reconnect, load the state once.
      if (reconnect) this.snapWait = setTimeout(() => void this.resync(), SNAPSHOT_WAIT_MS);
    });
    ws.addEventListener("message", (m: MessageEvent) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      if (this.pong) {
        clearTimeout(this.pong);
        this.pong = null;
      }
      const raw = String(m.data);
      if (raw === "pong") return;
      try {
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : [data];
        for (const ev of list) {
          if (!ev || typeof ev.type !== "string") continue;
          if (ev.type === "snapshot" && this.snapWait) {
            clearTimeout(this.snapWait);
            this.snapWait = null;
          }
          store.dispatch(ev);
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener("close", (e: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.stopped || this.paused) return;
      // The server closed it on purpose: the access changed (4403) or the sign-in ended (4401). A new
      // connection would get the same answer; a full load shows the right page instead.
      if (e.code === 4401 || e.code === 4403) {
        this.stopped = true;
        store.setConn("offline", e.code === 4401 ? "Your sign-in ended. The page loads again." : "Your access to this project changed. The page loads again.");
        setTimeout(() => location.reload(), 1200);
        return;
      }
      this.scheduleRetry();
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* closed */
      }
    });
  }

  private scheduleRetry(now = false) {
    if (this.stopped || this.paused) return;
    this.tries++;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      store.setConn("offline", "This device is offline. gitring reconnects when the network is back.");
      return;
    }
    const delay = now ? 0 : Math.min(15_000, 500 * 2 ** Math.min(this.tries, 5)) * (0.8 + Math.random() * 0.4);
    store.setConn("reconnecting", `The live connection dropped. gitring reconnects in ${Math.max(1, Math.round(delay / 1000))} s.`);
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.open(), delay);
  }

  /** One state request after a gap without a snapshot (an older server, or a lost first frame). */
  private async resync() {
    this.snapWait = null;
    try {
      const { state, access } = await fetchState(this.projectId);
      store.setAccess(access);
      store.dispatch({ type: "snapshot", state });
    } catch {
      /* the socket brings the next change; the connection badge shows problems */
    }
  }

  /** A quiet connection may be dead (sleep, network change): ask the server, and reconnect without an answer. */
  private ping() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.pong) return;
    try {
      ws.send("ping");
    } catch {
      return;
    }
    this.pong = setTimeout(() => {
      this.pong = null;
      if (this.ws !== ws) return;
      this.ws = null;
      try {
        ws.close(4000, "no answer to ping");
      } catch {
        /* closed */
      }
      this.scheduleRetry(true);
    }, PONG_WAIT_MS);
  }

  private checkIdle() {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - this.lastHeard >= IDLE_PING_MS) this.ping();
  }

  private onOnline = () => {
    if (this.ws?.readyState === WebSocket.OPEN) this.ping();
    else {
      this.tries = 0;
      this.scheduleRetry(true);
    }
  };

  private onOffline = () => {
    store.setConn("offline", "This device is offline. gitring reconnects when the network is back.");
  };

  private onVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.hiddenAt = Date.now();
      if (this.hide) clearTimeout(this.hide);
      this.hide = setTimeout(() => {
        this.hide = null;
        if (document.visibilityState !== "hidden") return;
        // A hidden tab does not need live events: close, and catch up with one snapshot when it shows again.
        this.paused = true;
        this.close();
      }, HIDDEN_CLOSE_MS);
      return;
    }
    if (this.hide) {
      clearTimeout(this.hide);
      this.hide = null;
    }
    if (this.paused) {
      this.paused = false;
      this.tries = 0;
      this.open();
      return;
    }
    if (!this.ws) {
      this.tries = 0;
      this.scheduleRetry(true);
    } else if (Date.now() - this.hiddenAt > 30_000) this.ping();
  };

  /** Leaving the page: close, so the browser can keep the page in its back/forward cache. */
  private onPageHide = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    this.paused = true;
    this.close();
  };

  private onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted || !this.paused) return;
    this.paused = false;
    this.tries = 0;
    this.open();
  };
}

/* ───────────── boot ───────────── */

let client: HarborClient | null = null;
let socket: LiveSocket | null = null;
const clientListeners = new Set<() => void>();

export function harbor(): HarborClient {
  if (!client) throw new HttpError(0, "The project is not loaded yet. Try again in 2 seconds.");
  return client;
}

export function harborOrNull(): HarborClient | null {
  return client;
}

export function onHarbor(cb: () => void): () => void {
  clientListeners.add(cb);
  return () => {
    clientListeners.delete(cb);
  };
}

function setClient(c: HarborClient) {
  client = c;
  clientListeners.forEach((l) => l());
}

/** A signed-in person's project: the remembered one if they still see it, else their first own project. */
export function defaultProjectFor(projects: ProjectInfo[]): string | null {
  const remembered = rememberedProject();
  if (remembered && projects.some((p) => p.id === remembered)) return remembered;
  return projects.find((p) => p.role === "owner")?.id ?? null;
}

/**
 * The project for a project view: ?project=, else (signed in) the remembered or first own project.
 * null: a visitor without ?project=, or a person without a project.
 */
function chooseProject(params: URLSearchParams): string | null {
  const asked = params.get("project");
  if (asked) return asked;
  const s = store.get();
  return s.me?.user ? defaultProjectFor(s.projects) : null;
}

function needsProject(): boolean {
  return isProjectRoute(parseRoute(location.pathname));
}

/** /api/me and the project list stay fresh for this long at boot (the store keeps them after that). */
export const ME_TTL = 60_000;
export const PROJECTS_TTL = 30_000;

let bootTries = 0;
let inflight: Promise<void> | null = null;

/** Load the person, the project list and (on a project view) the project state. One run at a time. */
export function boot(): Promise<void> {
  inflight ??= run().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // The address names the project: ask for its state now, in parallel with the account requests.
  const early = !client && needsProject() && params.get("project") ? params.get("project")! : null;
  const statePromise = early ? fetchState(early) : null;
  statePromise?.catch(() => undefined); // handled below
  if (!store.get().accountReady) {
    await Promise.all([loadMe({ maxAge: ME_TTL }), loadProjects({ maxAge: PROJECTS_TTL })]).catch(() => undefined);
    store.setAccountReady();
  }
  if (client || !needsProject()) return;
  const projectId = early ?? chooseProject(params);
  if (!projectId) {
    // No project to show: visitors go to the start page, signed-in people to their projects.
    navigate(store.get().me?.user ? "/projects" : "/", { replace: true });
    return;
  }
  // Keep the project in the address, so a copied link opens the same project.
  if (!params.get("project")) setSearchParam("project", projectId);
  store.setProject(projectId);
  try {
    const { state, access } = await (statePromise ?? fetchState(projectId));
    bootTries = 0;
    setClient(new LiveHarbor(projectId));
    store.setMode("live");
    store.setAccess(access);
    store.dispatch({ type: "snapshot", state });
    socket?.stop();
    socket = new LiveSocket(projectId);
    socket.start();
  } catch (e) {
    if (isAbort(e)) return;
    const status = e instanceof HttpError ? e.status : 0;
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      store.setAccess(null);
      store.setConn("offline", (e as Error).message);
      return;
    }
    bootTries++;
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(bootTries - 1, 4));
    store.setConn("offline", `The server is not reachable. gitring tries again in ${Math.round(delay / 1000)} s.`);
    setTimeout(() => void boot(), delay);
  }
}

/**
 * After a navigation inside the app: load the project state that the new view needs.
 * A link to another project than the live one loads the page again, so the socket and the store start clean.
 */
export function syncProject(): void {
  if (inflight || !needsProject()) return;
  if (client) {
    const asked = new URLSearchParams(location.search).get("project");
    if (asked && asked !== client.projectId) location.reload();
    return;
  }
  void boot();
}
