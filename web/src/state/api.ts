/**
 * Project client: the Worker's REST API under /api/projects/:p and live events over /ws/:p.
 *
 * Boot: the UI asks the Worker for the state of one project, only on the views that show a project.
 * When the Worker does not answer, the UI says so and tries again. There is no offline or fake data path.
 */
import type { Attempt, ConnectInfo, Intent, Landing, ProjectState } from "../../../src/core/types";
import type { ProjectInfo, Role } from "../../../src/core/accounts";
import { store } from "./store";
import { loadMe, loadProjects, rememberedProject } from "./account";
import { isProjectRoute, navigate, parseRoute, setSearchParam } from "../app/router";

export type { ConnectInfo };

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

export interface HarborClient {
  readonly projectId: string;
  createIntent(input: NewIntentInput): Promise<Intent>;
  amendIntent(id: string, input: AmendInput): Promise<Intent>;
  launch(id: string, fanout: number, models?: string[]): Promise<{ attempts: Attempt[] }>;
  park(id: string, reason: string): Promise<void>;
  land(attemptId: string, rationale: string): Promise<LandResult>;
  rederive(attemptId: string, reason: string): Promise<{ attempt: Attempt }>;
  attemptDiff(attemptId: string): Promise<DiffResult>;
  landing(id: string): Promise<LandingDetail>;
  file(ref: string, path: string): Promise<string>;
  /** Sample projects only: start again from the sample's first commit. */
  resetSample(): Promise<void>;
  /** Start built-in AI agents on every open task (Workers AI models). */
  launchAll(): Promise<{ launched: number; queued: number }>;
  connect(): Promise<ConnectInfo>;
  /** Live preview URL of a work copy (iframe src). */
  previewUrl(attemptId: string): string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/* ───────────── live ───────────── */

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = 15000, accept = "application/json"): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? { accept } : { accept, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch {
    throw new ApiError(0, "gitring did not answer. Check the connection and try again.");
  } finally {
    clearTimeout(timer);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    let msg = "";
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      msg = j.error ?? j.message ?? "";
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg || `The request failed with status ${res.status}. Try again.`);
  }
  if (type.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

function looksLikeState(x: unknown): x is ProjectState {
  const s = x as ProjectState;
  return Boolean(s && typeof s === "object" && s.project && Array.isArray(s.intents) && Array.isArray(s.attempts));
}

class LiveHarbor implements HarborClient {
  constructor(readonly projectId: string) {}
  private p(path: string) {
    return `/api/projects/${encodeURIComponent(this.projectId)}${path}`;
  }
  createIntent(input: NewIntentInput) {
    return request<Intent>("POST", this.p("/intents"), input);
  }
  amendIntent(id: string, input: AmendInput) {
    return request<Intent>("PATCH", this.p(`/intents/${encodeURIComponent(id)}`), input);
  }
  launch(id: string, fanout: number, models?: string[]) {
    return request<{ attempts: Attempt[] }>("POST", this.p(`/intents/${encodeURIComponent(id)}/launch`), { fanout, models });
  }
  async park(id: string, reason: string) {
    await request("POST", this.p(`/intents/${encodeURIComponent(id)}/park`), { reason });
  }
  land(attemptId: string, rationale: string) {
    return request<LandResult>("POST", this.p(`/attempts/${encodeURIComponent(attemptId)}/land`), { rationale });
  }
  rederive(attemptId: string, reason: string) {
    return request<{ attempt: Attempt }>("POST", this.p(`/attempts/${encodeURIComponent(attemptId)}/rederive`), { reason });
  }
  attemptDiff(attemptId: string) {
    return request<DiffResult>("GET", this.p(`/attempts/${encodeURIComponent(attemptId)}/diff`));
  }
  landing(id: string) {
    return request<LandingDetail>("GET", this.p(`/landings/${encodeURIComponent(id)}`));
  }
  file(ref: string, path: string) {
    return request<string>("GET", this.p(`/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`), undefined, 15000, "text/plain, */*");
  }
  async resetSample() {
    await request("POST", this.p("/reset"), {});
  }
  launchAll() {
    return request<{ launched: number; queued: number }>("POST", this.p("/launch-all"), {});
  }
  connect(): Promise<ConnectInfo> {
    return request<ConnectInfo>("GET", this.p("/connect"));
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

/* ───────────── WebSocket ───────────── */

function connectSocket(projectId: string) {
  let tries = 0;
  const open = () => {
    store.setConn(tries === 0 ? "connecting" : "reconnecting", store.get().error);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(projectId)}`);
    ws.addEventListener("open", () => {
      tries = 0;
      store.setConn("open", null);
    });
    ws.addEventListener("message", (m: Event) => {
      try {
        const data = JSON.parse(String((m as MessageEvent).data));
        const list = Array.isArray(data) ? data : [data];
        for (const ev of list) if (ev && typeof ev.type === "string") store.dispatch(ev);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener("close", () => {
      tries++;
      const delay = Math.min(15000, 500 * 2 ** Math.min(tries, 5)) * (0.8 + Math.random() * 0.4);
      store.setConn("reconnecting", `The live connection dropped. gitring reconnects in ${Math.max(1, Math.round(delay / 1000))} s.`);
      setTimeout(open, delay);
    });
    ws.addEventListener("error", () => ws.close());
  };
  open();
}

/* ───────────── boot ───────────── */

let client: HarborClient | null = null;
const clientListeners = new Set<() => void>();

export function harbor(): HarborClient {
  if (!client) throw new ApiError(0, "The project is not loaded yet. Try again in 2 seconds.");
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
  return projects.find((p) => p.role === "owner" && p.id !== "demo")?.id ?? null;
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
  if (!store.get().accountReady) {
    await Promise.all([loadMe(), loadProjects()]).catch(() => undefined);
    store.setAccountReady();
  }
  if (client || !needsProject()) return;
  const params = new URLSearchParams(location.search);
  const projectId = chooseProject(params);
  if (!projectId) {
    // No project to show: visitors go to the start page, signed-in people to their projects.
    navigate(store.get().me?.user ? "/projects" : "/", { replace: true });
    return;
  }
  // Keep the project in the address, so a copied link opens the same project.
  if (!params.get("project")) setSearchParam("project", projectId);
  store.setProject(projectId);
  try {
    const st = await request<unknown>("GET", `/api/projects/${encodeURIComponent(projectId)}/state`, undefined, 8000);
    if (!looksLikeState(st)) throw new ApiError(0, "The server sent a reply that is not a project state.");
    bootTries = 0;
    setClient(new LiveHarbor(projectId));
    store.setMode("live");
    store.setAccess((st as ProjectState & { access?: Role }).access ?? null);
    store.dispatch({ type: "snapshot", state: st });
    connectSocket(projectId);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0;
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
