/**
 * A project object that stops at chosen points, for the tests of the merge queue (durability.test.ts).
 *
 * "Eviction" here means: the running object stops in the middle of a step (the promise that it awaits
 * never finishes) and a NEW HarborMaster starts from the SAME storage and the SAME repository.
 * Nothing in memory carries over. The alarm lives in the world, as it lives in the storage of a real object.
 *
 *   const world = new CrashWorld();
 *   await world.start();
 *   const task = await world.submitTask("alpha", { stop: "before-commit" });
 *   await world.reached();          // the object stopped at the point
 *   world.restart();                // a new object, same storage
 */
import type { Attempt } from "../../src/core/types";
import { HarborMaster } from "../../src/harbor/harbor";
import type { CommitInput, CommitMeta, CommitResult, RepoBackend } from "../../src/platform/repo/backend";
import { backendOf } from "../github/fake";
import { sqliteCtx } from "../support/sqlite-storage";

/**
 * Where the object stops in a merge:
 *   queued         the work copy is in the queue; the merge has not started
 *   before-tests   the merge started (the queue marker is written); the tests of main plus the work do not run
 *   before-commit  the tests ran; the commit to main is not made
 *   after-commit   main has the commit; gitring has not written its record
 */
export type StopPoint = "queued" | "before-tests" | "before-commit" | "after-commit";

const NEVER = (): Promise<never> => new Promise<never>(() => undefined);

/** A project with one source file and one test file. */
const SEED = [
  { path: "src/a.js", text: "export const a = 1;\n" },
  { path: "tests/a.test.js", text: 'import { test, expect } from "../harness/test.js";\ntest("a", () => expect(1).toBe(1));\n' },
];

/** The Dynamic Worker loader: every test file of the module map passes. */
const LOADER = {
  get: (_id: string, getCode: () => unknown) => ({
    getEntrypoint: () => ({
      fetch: async () => {
        const code = (await getCode()) as { modules: Record<string, unknown> };
        const files = Object.keys(code.modules).filter((m) => /^tests\/.+\.test\.m?js$/.test(m));
        return Response.json(files.map((file) => ({ file, name: "works", ok: true, ms: 1 })));
      },
    }),
  }),
};

type Internals = {
  attempts: Map<string, Attempt>;
  intents: Map<string, { status: string }>;
  landings: { attemptId: string; mainAfter: string }[];
  logs: { message: string }[];
  stats: { landings: number; escalations: number };
  db: { queue(): string[]; getMeta<T>(key: string): T | undefined; setMeta(key: string, value: unknown): void; dequeue(id: string): void; putAttempt(a: unknown): void };
  landingChain: Promise<unknown>;
  runTreeChecks: (files: Map<string, string>, scope: string, attemptId: string, ...rest: unknown[]) => Promise<unknown>;
};

export class CrashWorld {
  readonly storage = sqliteCtx();
  readonly repo: RepoBackend = backendOf();
  /** The one alarm of the object. */
  alarm: number | null = null;
  /** The point where the running object stops, once. */
  armed?: StopPoint;
  /** The object reached the armed point and stopped. */
  stopped = false;
  /** Commits that gitring made to main, in order (not the seed). */
  mainCommits: CommitInput[] = [];
  /** The scope of every test run that started ("attempt" or "composed"). */
  testRuns: string[] = [];
  boots = 0;
  harbor!: HarborMaster;
  mainRepo = "";
  readonly env: Record<string, unknown>;
  private readonly waits = new Map<number, Promise<unknown>[]>();
  /**
   * The hourly test budget of the Directory (container runner): the next `grants` runs get a slot, then
   * the budget is used and the Directory says to try again at `retryAt`.
   */
  budget = { grants: Number.POSITIVE_INFINITY, retryAt: 0 };
  /** Container runs that started. */
  containerRuns = 0;
  /** What the container prints: a passing run, or the test results of the next runs. */
  containerResult: { ok: boolean; stage: "done" | "test" | "no-test" } = { ok: true, stage: "done" };

  constructor(extraEnv: Record<string, unknown> = {}) {
    const directory = {
      idFromName: (n: string) => n,
      get: () => ({
        budgetTake: async () => {
          if (this.budget.grants > 0) {
            this.budget.grants -= 1;
            return { granted: 1, retryAt: 0 };
          }
          return { granted: 0, retryAt: this.budget.retryAt };
        },
      }),
    };
    const drydock = {
      idFromName: (n: string) => n,
      get: () => ({
        run: async () => {
          this.containerRuns += 1;
          const r = this.containerResult;
          return { ok: r.ok, stage: r.stage, exitCode: r.ok ? 0 : 1, installMs: 1, testMs: 1, reused: false, log: r.ok ? "all tests pass" : "1 test failed" };
        },
      }),
    };
    // A secret, as production has one: a webhook needs it for its signing secret.
    this.env = { ARTIFACTS_NAMESPACE: "gitring", GITRING_SECRET: "crash-world-secret-0123456789abcdef", LOADER, DIRECTORY: directory, DRYDOCK: drydock, ...extraEnv };
  }

  /** Make the project (one commit on main). The worker runner runs the tests unless `runner` is "container". */
  async start(opts: { runner?: "worker" | "container"; files?: { path: string; text: string }[]; settings?: Record<string, unknown> } = {}): Promise<void> {
    const files = opts.files ?? SEED;
    this.harbor = this.boot();
    await this.harbor.init({ projectId: "p_crash", name: "Shop", source: { kind: "upload", files: files.length }, files });
    await this.harbor.updateSettings({ checks: { runner: opts.runner ?? "worker" }, ...(opts.settings ?? {}) });
    this.mainRepo = (await this.harbor.state()).project.repo.name;
  }

  get inner(): Internals {
    return this.harbor as unknown as Internals;
  }

  /** The object stops (its work never finishes) and a new object starts from the same storage. */
  restart(): HarborMaster {
    this.stopped = false;
    this.armed = undefined;
    this.harbor = this.boot();
    return this.harbor;
  }

  private boot(): HarborMaster {
    const boot = this.boots++;
    this.waits.set(boot, []);
    const ctx = {
      storage: {
        sql: this.storage.storage.sql,
        setAlarm: async (t: number) => void (this.alarm = t),
        getAlarm: async () => this.alarm,
        deleteAlarm: async () => void (this.alarm = null),
      },
      blockConcurrencyWhile: async (fn: () => unknown) => fn(),
      waitUntil: (p: Promise<unknown>) => void this.waits.get(boot)!.push(p.catch((e) => console.warn("waitUntil", e))),
      getWebSockets: () => [],
      getTags: () => [],
      acceptWebSocket: () => undefined,
    };
    const h = new HarborMaster(ctx as never, this.env as never);
    const wrapped = this.wrap(this.repo);
    Object.defineProperty(h, "backend", { get: () => wrapped, configurable: true });
    const inner = h as unknown as Internals;
    const original = inner.runTreeChecks.bind(h);
    inner.runTreeChecks = async (files, scope, attemptId, ...rest) => {
      if (scope === "composed" && this.armed === "before-tests") return this.stop();
      this.testRuns.push(scope);
      return original(files, scope, attemptId, ...rest);
    };
    return h;
  }

  /** Stop here: the caller's promise never finishes. */
  private stop(): Promise<never> {
    this.armed = undefined;
    this.stopped = true;
    return NEVER();
  }

  private wrap(base: RepoBackend): RepoBackend {
    const world = this;
    return new Proxy(base, {
      get(target, prop) {
        if (prop === "commit") {
          return async (input: CommitInput): Promise<CommitResult> => {
            const main = input.repo === world.mainRepo && input.parent !== "";
            if (main && world.armed === "before-commit") return world.stop();
            const res = await target.commit(input);
            if (main) world.mainCommits.push(input);
            if (main && world.armed === "after-commit") return world.stop();
            return res;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** An agent sends a plan and writes files (default: src/NAME.js). It does not submit. */
  async startTask(name: string, files: Record<string, string> = { [`src/${name}.js`]: `export const ${name} = 1;\n` }): Promise<{ attemptId: string; intentId: string }> {
    const h = this.harbor;
    const d = await h.declare({
      agent: { client: "test" },
      newIntent: { title: `Add ${name}`, goal: `Add the file src/${name}.js.` },
      plan: [`Write src/${name}.js`],
      files: Object.keys(files),
      symbols: [],
      approach: `Write src/${name}.js.`,
    });
    await h.write({ attemptId: d.attemptId, files: Object.entries(files).map(([path, content]) => ({ path, content })) });
    return { attemptId: d.attemptId, intentId: d.intent.id };
  }

  /** An agent sends a plan, writes one file and submits. `stop` arms a stop point first. */
  async submitTask(name: string, opts: { stop?: StopPoint; files?: Record<string, string> } = {}): Promise<{ attemptId: string; intentId: string; next: string; message: string }> {
    const t = await this.startTask(name, opts.files);
    // "queued": the chain that runs the queue never starts, as if the object stopped right after the queue write.
    if (opts.stop === "queued") this.inner.landingChain = NEVER();
    else if (opts.stop) this.armed = opts.stop;
    const res = await this.harbor.submit(t.attemptId, `Add ${name}`);
    return { ...t, next: res.next, message: res.message };
  }

  /** Wait until the running object reaches the armed stop point. */
  async reached(): Promise<void> {
    for (let i = 0; i < 400 && !this.stopped; i++) await new Promise((r) => setTimeout(r, 5));
    if (!this.stopped) throw new Error("The object did not reach the stop point.");
  }

  /** Wait until the background work (waitUntil) of the running object ends. */
  async settle(): Promise<void> {
    const waits = this.waits.get(this.boots - 1)!;
    for (let i = 0; i < 40; i++) {
      const batch = waits.splice(0);
      if (!batch.length) {
        await new Promise((r) => setTimeout(r, 5));
        if (!waits.length) return;
        continue;
      }
      await Promise.all(batch);
    }
  }

  /** Commits on main that name this work copy in their message (a merge by gitring). */
  async mergesOf(attemptId: string): Promise<CommitMeta[]> {
    const log = await this.repo.log(this.mainRepo, "main", 50);
    return log.filter((c) => c.message.includes(`Gitring-Attempt: ${attemptId}`));
  }

  status(attemptId: string): string | undefined {
    return this.inner.attempts.get(attemptId)?.status;
  }
}
