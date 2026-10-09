/**
 * Harbor client: the Worker's REST API under /api/projects/:p and live events over /ws/:p.
 *
 * Boot: the UI asks the Worker for the project state. When the Worker does not answer,
 * the UI says so and tries again. There is no offline or fake data path.
 */
import type { Attempt, Intent, Landing, ProjectState } from "../../../src/core/types";
import type { Role } from "../../../src/core/accounts";
import { store } from "./store";
import { loadMe, loadProjects, rememberedProject } from "./account";

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
  /** The logbook git note (JSON text or an object). */
  note: unknown;
  diff: DiffResult;
}

export interface ConnectInfo {
  mcpUrl: string;
  gitRemoteExample?: string;
  hookUrl: string;
  projectKeyHint: string;
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
  /** Launch built-in AI agents on every open intent (Workers AI models). */
  launchAll(): Promise<{ launched: number; queued: number }>;
  simStart(agents: number, sectors: number): Promise<void>;
  simStop(): Promise<void>;
  connect(): Promise<ConnectInfo>;
  /** Live preview URL of an attempt (iframe src). */
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
    throw new ApiError(0, "The harbor did not answer. Check the connection and try again.");
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
  async simStart(agents: number, sectors: number) {
    await request("POST", this.p("/sim/start"), { agents, sectors });
  }
  async simStop() {
    await request("POST", this.p("/sim/stop"), {});
  }
  async connect(): Promise<ConnectInfo> {
    try {
      return await request<ConnectInfo>("GET", this.p("/connect"));
    } catch {
      return defaultConnectInfo(this.projectId);
    }
  }
  previewUrl(attemptId: string) {
    return `/preview/${encodeURIComponent(this.projectId)}/${encodeURIComponent(attemptId)}/`;
  }
}

export function defaultConnectInfo(projectId: string): ConnectInfo {
  const origin = typeof location !== "undefined" ? location.origin : "https://gitring.example.workers.dev";
  return {
    mcpUrl: `${origin}/mcp`,
    hookUrl: `${origin}/hooks/claude-code?project=${encodeURIComponent(projectId)}`,
    gitRemoteExample: `https://<account-id>.artifacts.cloudflare.net/git/gitring/${projectId}--kestrel-7.git`,
    projectKeyHint: "Set GITRING_KEY to a personal API key (above).",
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
  if (!client) throw new ApiError(0, "The harbor is not ready. Try again in 2 seconds.");
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

let bootTries = 0;

/** Pick the project: ?project=, else the last one used (if the caller still sees it), else the public sample. */
function chooseProject(params: URLSearchParams): string {
  const asked = params.get("project");
  if (asked) return asked;
  const remembered = rememberedProject();
  if (remembered && store.get().projects.some((p) => p.id === remembered)) return remembered;
  const mine = store.get().projects.find((p) => p.role === "owner" && p.id !== "demo");
  return mine?.id ?? "demo";
}

export async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (!store.get().me) {
    await Promise.all([loadMe(), loadProjects()]).catch(() => undefined);
  }
  const projectId = chooseProject(params);
  store.setProject(projectId);
  try {
    const st = await request<unknown>("GET", `/api/projects/${encodeURIComponent(projectId)}/state`, undefined, 8000);
    if (!looksLikeState(st)) throw new ApiError(0, "The harbor sent a reply that is not a project state.");
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
    store.setConn("offline", `The harbor is not reachable. gitring tries again in ${Math.round(delay / 1000)} s.`);
    setTimeout(() => void boot(), delay);
  }
}
