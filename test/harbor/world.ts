/**
 * A whole gitring for concurrency tests: the real Worker routes (including POST /mcp), the real
 * Directory and the real HarborMaster, on the git test double. Agents call the MCP tools with a personal
 * API key, as outside agents do. Three small stand-ins sit at the edge:
 *
 *   - the GitHub sign-in (two HTTP answers), so that a person can get an API key;
 *   - the Artifacts store, a git emulator that also counts commits and refused commits on main;
 *   - the check runner, an in-process stand-in for the Dynamic Worker loader. It runs the real harness
 *     and the real test files of the project, so tests pass or fail on the code that gitring merges.
 *
 * This file builds on test/github/harness.ts (copied, not changed).
 */
import { posix } from "node:path";
import { Directory } from "../../src/directory/directory";
import { HarborMaster } from "../../src/harbor/harbor";
import worker from "../../src/worker/index";
import { RepoConflictError, type CommitInput, type RepoBackend } from "../../src/platform/repo/backend";
import { EmulatorBackend, EmulatorService } from "../support/git-emulator/service";
import { GitStore, MemoryObjectStore } from "../support/git-emulator/store";
import { sqliteCtx } from "../support/sqlite-storage";
import type * as T from "../../src/core/types";

export const ORIGIN = "https://gitring.test";

/* ───────────────────────────── seeded random numbers and a scheduler ───────────────────────────── */

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a seeded generator. */
export function shuffled<X>(items: readonly X[], rng: () => number): X[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A seeded scheduler. Each agent has its own stream, so the pauses of one agent do not depend on the
 * order of the others. A pause is a few microtask turns, a macrotask turn, or a short timer: calls of
 * different agents then meet in many different orders.
 */
export class Scheduler {
  private streams = new Map<string, () => number>();
  constructor(readonly seed: number) {}
  private rng(who: string): () => number {
    let r = this.streams.get(who);
    if (!r) {
      let h = this.seed >>> 0;
      for (const c of who) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
      r = mulberry32(h);
      this.streams.set(who, r);
    }
    return r;
  }
  async pause(who: string): Promise<void> {
    const x = this.rng(who)();
    if (x < 0.35) {
      for (let i = 0; i < 1 + Math.floor(x * 20); i++) await Promise.resolve();
    } else if (x < 0.6) {
      await new Promise<void>((r) => setImmediate(r));
    } else {
      await sleep(Math.floor((x - 0.6) * 12));
    }
  }
  /** The wait between two polls: grows with the number of polls, with a seeded spread. */
  async backoff(who: string, polls: number): Promise<void> {
    await sleep(Math.min(400, 40 + polls * 30) + Math.floor(this.rng(who)() * 25));
  }
}

/* ───────────────────────────── check runner stand-in ───────────────────────────── */

/**
 * A WorkerLoader for Node tests that runs the module map in this process. It reads the small subset of
 * ES module syntax that the gitring harness, the generated runner and the test files of this project
 * use (import { a } from "x"; import "x"; export function / const / default). Module state lives as
 * long as the id, like an isolate.
 */
export function inProcessLoader() {
  const isolates = new Map<string, Promise<{ fetch(): Promise<Response> }>>();
  const loads = { runs: 0, starts: 0 };

  function transform(source: string): string {
    const exported: string[] = [];
    const code = source
      .replace(/^import\s+\{([^}]*)\}\s+from\s+(["'])(.+?)\2;?[ \t]*$/gm, (_m, names: string, _q, spec: string) => `const { ${names.replace(/\s+as\s+/g, ": ")} } = __require(${JSON.stringify(spec)});`)
      .replace(/^import\s+(["'])(.+?)\1;?[ \t]*$/gm, (_m, _q, spec: string) => `__require(${JSON.stringify(spec)});`)
      .replace(/^export\s+default\s+/gm, "__exports.default = ")
      .replace(/^export\s+(async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/gm, (_m, kw: string, name: string) => {
        exported.push(name);
        return `${kw} ${name}`;
      })
      .replace(/^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_m, kw: string, name: string) => {
        exported.push(name);
        return `${kw} ${name}`;
      });
    return `${code}\n${exported.map((n) => `__exports.${n} = ${n};`).join("\n")}\n`;
  }

  function start(code: WorkerLoaderWorkerCode): { fetch(): Promise<Response> } {
    const sources = new Map<string, string>();
    for (const [name, mod] of Object.entries(code.modules)) sources.set(name, typeof mod === "string" ? mod : String((mod as WorkerLoaderModule).js));
    const cache = new Map<string, Record<string, unknown>>();
    const load = (name: string): Record<string, unknown> => {
      const hit = cache.get(name);
      if (hit) return hit;
      const src = sources.get(name);
      if (src === undefined) throw new Error(`No such module: ${name}`);
      const exports: Record<string, unknown> = {};
      cache.set(name, exports);
      const body = transform(src);
      const requireFrom = (spec: string) => load(posix.normalize(posix.join(posix.dirname(name), spec)));
      new Function("__exports", "__require", body)(exports, requireFrom);
      return exports;
    };
    const main = load(code.mainModule) as { default: { fetch(r: Request): Promise<Response> } };
    return { fetch: () => main.default.fetch(new Request("http://checks.gitring.internal/run")) };
  }

  return {
    stats: loads,
    get(id: string | null, getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) {
      const key = id ?? `anonymous:${loads.starts}`;
      const entry = {
        fetch: async (): Promise<Response> => {
          let isolate = isolates.get(key);
          if (!isolate) {
            loads.starts += 1;
            isolate = (async () => start(await getCode()))();
            isolates.set(key, isolate);
            if (isolates.size > 48) isolates.delete(isolates.keys().next().value!);
          }
          loads.runs += 1;
          return (await isolate).fetch();
        },
      };
      return { getEntrypoint: () => entry as unknown as Fetcher } as unknown as WorkerStub;
    },
    load() {
      throw new Error("inProcessLoader supports get() only");
    },
  } as unknown as WorkerLoader & { stats: { runs: number; starts: number } };
}

/* ───────────────────────────── the Artifacts test double, with counters ───────────────────────────── */

export interface MainCommitRecord {
  repo: string;
  parent: string;
  sha?: string;
  refused?: boolean;
}

function gitDouble(): RepoBackend {
  let svc: EmulatorService | undefined;
  const ns = {
    idFromName: (name: string) => ({ name, toString: () => name, equals: () => false }),
    get: () => {
      svc ??= new EmulatorService(new GitStore(new MemoryObjectStore()));
      const target = svc;
      return new Proxy(
        {},
        {
          get:
            (_t, method: string) =>
            async (...args: unknown[]) =>
              structuredClone(await (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method].apply(target, structuredClone(args))),
        },
      );
    },
  };
  return new EmulatorBackend(ns as never, "test");
}

/** The git double. It records each commit to a watched repository (main), and each refused one. */
export function countingBackend(watched: Set<string>): { backend: RepoBackend; commits: MainCommitRecord[] } {
  const base = gitDouble();
  const commits: MainCommitRecord[] = [];
  const backend = new Proxy(base, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop !== "commit") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return async (input: CommitInput) => {
        if (!watched.has(input.repo)) return base.commit(input);
        const rec: MainCommitRecord = { repo: input.repo, parent: input.parent };
        commits.push(rec);
        try {
          const res = await base.commit(input);
          rec.sha = res.sha;
          return res;
        } catch (e) {
          if (e instanceof RepoConflictError) rec.refused = true;
          throw e;
        }
      };
    },
  }) as RepoBackend;
  return { backend, commits };
}

/* ───────────────────────────── MCP answers ───────────────────────────── */

export interface Notice {
  id: string;
  kind: string;
  message: string;
  from?: string;
}

export interface ToolResult {
  tool: string;
  ok: boolean;
  /** The whole text of the answer. */
  text: string;
  /** The JSON block at the end of the answer (absent for tools that answer with plain text). */
  json: any;
  /** Change requests in this answer (the notices that gitring sends first). */
  notices: Notice[];
  ms: number;
}

function lastJson(text: string): unknown {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === "{" || lines[i] === "[") {
      try {
        return JSON.parse(lines.slice(i).join("\n"));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/* ───────────────────────────── the world ───────────────────────────── */

export interface WorldOptions {
  /** Extra environment values. */
  env?: Record<string, unknown>;
  /** Default true: Date.now() never repeats a value (see init). */
  strictClock?: boolean;
}

export class World {
  dir!: Directory;
  harbors = new Map<string, HarborMaster>();
  env: Record<string, unknown> = {};
  loader = inProcessLoader();
  pending: Promise<unknown>[] = [];
  /** Names of the repositories that hold main (the counting backend watches them). */
  readonly mainRepos = new Set<string>();
  private counting = countingBackend(this.mainRepos);
  readonly backend: RepoBackend = this.counting.backend;
  /** Every commit to a main repository, refused ones included. */
  readonly mainCommits: MainCommitRecord[] = this.counting.commits;
  /** Every MCP call. */
  readonly calls: { tool: string; ok: boolean; ms: number }[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private rpcId = 0;
  private realFetch = globalThis.fetch;
  private realNow = Date.now;
  private signingIn = { id: 0, login: "" };

  async init(opts: WorldOptions = {}) {
    if (opts.strictClock !== false) {
      // Date.now() answers in milliseconds, and many calls happen in one millisecond. Rule R4 ("the
      // earlier plan continues") needs two different times. This clock never gives the same value twice,
      // so that R4 always decides. A test that needs the plain clock passes strictClock: false.
      const real = this.realNow.bind(Date);
      let last = 0;
      Date.now = () => (last = Math.max(real(), last + 1));
    }
    const dirNs = { idFromName: (n: string) => n, get: () => this.dir };
    const harborNs = {
      idFromName: (n: string) => n,
      get: (id: string) => {
        let h = this.harbors.get(id);
        if (!h) {
          h = new HarborMaster(this.harborCtx(() => this.harbors.get(id)) as never, this.env as never);
          Object.defineProperty(h, "backend", { get: () => this.backend, configurable: true });
          this.harbors.set(id, h);
        }
        return h;
      },
    };
    this.env = {
      DIRECTORY: dirNs,
      HARBOR: harborNs,
      LOADER: this.loader,
      ARTIFACTS: { import: async () => ({ remote: "", defaultBranch: "main" }) },
      GITRING_SECRET: "concurrency-secret-0123456789abcdef",
      ARTIFACTS_NAMESPACE: "gitring",
      ...(opts.env ?? {}),
    };
    this.dir = new Directory(sqliteCtx() as never, this.env as never);
    globalThis.fetch = this.signInFetch as typeof fetch;
    const m = await this.dir.githubManifest(ORIGIN);
    await this.dir.githubManifestDone("code", new URL(m.postUrl).searchParams.get("state")!);
  }

  /** The object context of one project object: SQLite storage, and alarms that fire after their delay. */
  private harborCtx(self: () => HarborMaster | undefined) {
    const base = sqliteCtx();
    let alarm: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (at: number) => {
      if (timer) clearTimeout(timer);
      const delay = at - Date.now();
      if (delay > 120_000) return; // far alarms (redo waits) do not fire in a test
      timer = setTimeout(
        () => {
          this.timers.delete(timer!);
          alarm = null;
          const h = self();
          if (h) this.pending.push(h.alarm().catch((e: unknown) => console.warn("alarm", e)));
        },
        Math.max(0, delay),
      );
      this.timers.add(timer);
    };
    return {
      storage: {
        sql: base.storage.sql,
        setAlarm: async (t: number) => {
          alarm = t;
          arm(t);
        },
        getAlarm: async () => alarm,
        deleteAlarm: async () => {
          alarm = null;
          if (timer) clearTimeout(timer);
        },
      },
      blockConcurrencyWhile: async (fn: () => unknown) => fn(),
      waitUntil: (p: Promise<unknown>) => void this.pending.push(p.catch((e) => console.warn("waitUntil", e))),
      getWebSockets: () => [],
      getTags: () => [],
      acceptWebSocket: () => undefined,
    };
  }

  /** The only network calls in a world: the GitHub sign-in of a person. */
  private signInFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.github.com/app-manifests/")) {
      return Response.json({ id: 42, slug: "git-ring", client_id: "Iv1.x", client_secret: "cs", webhook_secret: "whsec", pem: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", html_url: "https://github.com/apps/git-ring" });
    }
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: `gho_${this.signingIn.login}`, expires_in: 28800, refresh_token: `ghr_${this.signingIn.login}`, refresh_token_expires_in: 15552000 });
    if (url === "https://api.github.com/user") return Response.json({ id: this.signingIn.id, login: this.signingIn.login, name: this.signingIn.login, email: null, avatar_url: "" });
    return Response.json({ message: `not stubbed ${url}` }, { status: 599 });
  };

  async close() {
    globalThis.fetch = this.realFetch;
    Date.now = this.realNow;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await this.settle();
  }

  /** Wait until background work (waitUntil, alarms) settles. */
  async settle() {
    for (let i = 0; i < 60; i++) {
      const p = this.pending.splice(0);
      if (!p.length) {
        await sleep(5);
        if (!this.pending.length) return;
        continue;
      }
      await Promise.all(p);
    }
  }

  /** A person with an API key (one personal key for all agents of a test). */
  async signIn(login: string, id: number): Promise<{ userId: string; key: string }> {
    this.signingIn = { id, login };
    const url = await this.dir.signInUrl("github", ORIGIN, "/");
    const res = await this.dir.finishSignIn("github", "code", new URL(url).searchParams.get("state")!);
    const { key } = await this.dir.createKey(res.user.id, "agents");
    return { userId: res.user.id, key };
  }

  /** A request to the real Worker. */
  async call(method: string, path: string, opts: { key?: string; body?: unknown } = {}): Promise<{ status: number; json: any; text: string }> {
    const headers: Record<string, string> = { ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) };
    const req = new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const ctx = { waitUntil: (p: Promise<unknown>) => void this.pending.push(p.catch((e) => console.warn("ctx.waitUntil", e))), passThroughOnException() {}, props: {} };
    const res = await worker.fetch(req, this.env as never, ctx as never);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { status: res.status, json, text };
  }

  /** One MCP tool call: POST /mcp, JSON-RPC tools/call, with the personal key. */
  async tool(key: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const t0 = performance.now();
    const id = ++this.rpcId;
    const req = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    });
    const ctx = { waitUntil: (p: Promise<unknown>) => void this.pending.push(p.catch((e) => console.warn("ctx.waitUntil", e))), passThroughOnException() {}, props: {} };
    const res = await worker.fetch(req, this.env as never, ctx as never);
    const raw = await res.text();
    const ms = performance.now() - t0;
    // The answer is a JSON body, or a server-sent event with one "data:" line.
    const body = raw.trimStart().startsWith("{") ? raw : (raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).at(-1) ?? "");
    let rpc: any;
    try {
      rpc = JSON.parse(body);
    } catch {
      throw new Error(`MCP ${name}: HTTP ${res.status}, no JSON-RPC answer: ${raw.slice(0, 300)}`);
    }
    if (rpc.error) throw new Error(`MCP ${name}: protocol error ${JSON.stringify(rpc.error)}`);
    const text = String(rpc.result?.content?.[0]?.text ?? "");
    const ok = !rpc.result?.isError;
    const json = lastJson(text);
    const clr = (json as any)?.clearance ?? json;
    const notices: Notice[] = Array.isArray(clr?.corrections) ? clr.corrections.map((c: any) => ({ id: c.id, kind: c.kind, message: c.message, from: c.from })) : [];
    this.calls.push({ tool: name, ok, ms });
    return { tool: name, ok, text, json, notices, ms };
  }

  harbor(id: string): HarborMaster {
    return (this.env.HARBOR as { get: (id: string) => HarborMaster }).get(id);
  }

  /** A project from a folder of files (the Worker route), with the check runner of the Worker. */
  async createProject(key: string, name: string, files: Record<string, string>, settings: Partial<T.ProjectSettings> = {}): Promise<{ id: string; mainRepo: string }> {
    const made = await this.call("POST", "/api/projects", {
      key,
      body: { name, visibility: "private", source: { kind: "upload" }, files: Object.entries(files).map(([path, text]) => ({ path, text })) },
    });
    if (made.status !== 201) throw new Error(`project: ${made.text}`);
    const id = made.json.project.id as string;
    const put = await this.call("PUT", `/api/projects/${id}/settings`, { key, body: { checks: { runner: "worker" }, ...settings } });
    if (put.status !== 200) throw new Error(`settings: ${put.text}`);
    const mainRepo = (await this.harbor(id).state()).project.repo.name;
    this.mainRepos.add(mainRepo);
    return { id, mainRepo };
  }

  /** A person writes a task (with its test files). Returns the task id. */
  async addTask(key: string, project: string, task: { title: string; goal: string; checks: { path: string; content: string; description: string }[]; priority?: "normal" | "high" }): Promise<string> {
    const res = await this.call("POST", `/api/projects/${project}/intents`, { key, body: task });
    if (res.status !== 200) throw new Error(`task: ${res.text}`);
    return res.json.id as string;
  }

  /** The files of a ref of the project repository (text only). */
  async filesAt(repo: string, sha: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (tree: string, prefix: string) => {
      for (const e of (await this.backend.readTree(repo, tree)) ?? []) {
        if (e.type === "tree") await walk(e.hash, `${prefix}${e.name}/`);
        else out[`${prefix}${e.name}`] = new TextDecoder().decode((await this.backend.readBlob(repo, e.hash))!);
      }
    };
    await walk((await this.backend.readCommit(repo, sha))!.treeHash, "");
    return out;
  }
}
