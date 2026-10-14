/**
 * The client of one project: one method for each request to /api/projects/:p, with caches for answers that never change.
 * The app gets it from harbor() in boot.ts. It is exported so that tests can build one.
 */
import type { ApprovalResult, Attempt, ConnectInfo, Intent, TreeResponse } from "../../../../src/core/types";
import { getJson, getText, HttpError, Lru, send } from "../http";
import type {
  AmendInput,
  DecideInput,
  DiffResult,
  HarborClient,
  LandingDetail,
  LandResult,
  NewIntentInput,
  ReadOptions,
  VersionedRead,
} from "./types";

const SHA = /^[0-9a-f]{40}$/;

/** True for a full commit id: its files never change. */
export function isCommitId(ref: string): boolean {
  return SHA.test(ref);
}

/** The client of one project. The app gets it from harbor(); it is exported so that tests can build one. */
export class LiveHarbor implements HarborClient {
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
  async decide(attemptId: string, input: DecideInput) {
    try {
      return await send<ApprovalResult>("POST", this.p(`/attempts/${encodeURIComponent(attemptId)}/decide`), input);
    } catch (e) {
      // gitring refuses a person with status 403 and the whole result. That is an answer, not a failure.
      if (e instanceof HttpError && e.status === 403 && e.data.outcome === "refused" && typeof e.data.message === "string") return e.data as unknown as ApprovalResult;
      throw e;
    }
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
