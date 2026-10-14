/**
 * The base layer of the project coordinator: its state, its constructor and the load at start-up.
 * Layer 1 of the chain in master/README.md. Extends DurableObject.
 * Tests read fields of this class by name (attempts, corrections, stats, questions, landings, db): keep them.
 * It must never call a method of a higher layer. The one exception, wakeQueue, is declared abstract here.
 * Read next: records.ts.
 */
import { DurableObject } from "cloudflare:workers";
import type * as T from "../../core/types";
import { withDefaults } from "../../core/types";
import type { Env } from "../../worker/env";
import type { RepoBackend } from "../../platform/repo/backend";
import { ArtifactsBackend } from "../../platform/repo/artifacts";
import { MemoryTreeCache } from "../../core/git/snapshot";
import { Db } from "../store";
import { newId, rand } from "../ids";
import { ACTIVE, type AttemptView, type MainView, type TreeText } from "../views";
import { GITRING_AUTHOR, MAX_CHECKS, MAX_LOGS } from "../support/constants";
import { emptyStats, pairKey } from "../support/helpers";
import type { CallInfo, GithubRepoState } from "../support/types";

export abstract class HarborState extends DurableObject<Env> {
  // ───── State of the project (every layer reads and writes it) ─────

  protected db: Db;
  protected project?: T.Project;
  protected intents = new Map<string, T.Intent>();
  protected attempts = new Map<string, T.Attempt>();
  protected agents = new Map<string, T.AgentInfo>();
  protected corrections = new Map<string, T.Correction>();
  protected checks: T.CourseCheck[] = [];
  protected logs: T.LogEntry[] = [];
  protected landings: T.Landing[] = [];
  protected decisions: T.Decision[] = [];
  protected questions = new Map<string, T.Question>();
  protected radar = new Map<string, T.RadarPair>();
  /** Every commit that was main → its place in main's history (the table main_seq). */
  protected mainIndex = new Map<string, number>();
  protected stats: T.HarborStats = emptyStats();
  protected checkLatencies: number[] = [];
  protected backendCache?: RepoBackend;
  protected treeCache = new MemoryTreeCache(5000);
  protected treeTexts = new Map<string, Promise<TreeText>>();
  protected mainView?: MainView;
  protected mainLoading?: Promise<MainView>;
  protected attemptViews = new Map<string, { key: string; view: AttemptView }>();
  /** Views of work copies that gitring makes now (see attemptView). */
  protected attemptViewLoads = new Map<string, { key: string; view: Promise<AttemptView> }>();
  /** Text → blob id, for the files that agents wrote (see textBlobId). */
  protected textIds = new Map<string, string>();
  protected textIdChars = 0;
  protected attemptVersion = new Map<string, number>();
  protected forks = new Map<string, Promise<void>>();
  protected landingChain: Promise<unknown> = Promise.resolve();
  /** The tests of main after merges (post-merge test mode) run one after the other on this chain. */
  protected mainTestChain: Promise<unknown> = Promise.resolve();
  protected outbox: T.GitringEvent[] = [];
  protected flushScheduled = false;
  protected seq = 0;
  /** Changes on every start of this object: versions of work copies are counted in memory. */
  protected readonly bootId = rand(6);
  /** The agents that wait, per work copy. Memory only: a restart loses them, and the next call of the agent sees the state. */
  protected waiters = new Map<string, Set<(ev: T.WaitEvent) => void>>();
  /** The state of a work copy that agents wait on: a change of the status or of the approval wakes them. */
  protected waitSeen = new Map<string, { status: T.AttemptStatus; approval?: T.Approval["status"] }>();

  // ───── Start-up ─────

  /** The merge queue starts or wakes the work that waits (queue.ts). The constructor calls it. */
  protected abstract wakeQueue(): void;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Db(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      this.load();
      this.wakeQueue();
    });
  }

  protected load(): void {
    this.project = this.db.getMeta<T.Project>("project");
    if (this.project) this.project.settings = withDefaults(this.project.settings);
    for (const i of this.db.all<T.Intent>("intents")) this.intents.set(i.id, i);
    for (const a of this.db.all<T.Attempt>("attempts")) this.attempts.set(a.id, a);
    for (const g of this.db.all<T.AgentInfo>("agents")) this.agents.set(g.id, g);
    for (const c of this.db.all<T.Correction>("corrections")) this.corrections.set(c.id, c);
    this.checks = this.db.recentChecks<T.CourseCheck>(MAX_CHECKS);
    this.logs = this.db.recentLogs<T.LogEntry>(MAX_LOGS);
    this.landings = this.db.all<T.Landing>("landings").sort((a, b) => a.at - b.at);
    this.decisions = this.db.all<T.Decision>("decisions").sort((a, b) => a.at - b.at);
    for (const q of this.db.all<T.Question>("questions")) this.questions.set(q.id, q);
    for (const r of this.db.all<T.RadarPair>("radar")) this.radar.set(pairKey(r.a, r.b), r);
    for (const r of this.db.mainSeq()) this.mainIndex.set(r.sha, r.seq);
    this.stats = this.db.getMeta<T.HarborStats>("stats") ?? emptyStats();
    this.checkLatencies = this.db.getMeta<number[]>("latencies") ?? [];
    this.seq = this.db.getMeta<number>("seq") ?? 0;
    this.migrateGithubState();
    this.migrateApprovals();
  }

  /**
   * Work that waited for a person before approvals existed ("ready" in a task that is "judging") gets an
   * approval with no digest: it has no hash to compare, and any member may answer it.
   */
  protected migrateApprovals(): void {
    for (const a of this.attempts.values()) {
      if (a.status !== "ready" || a.approval) continue;
      const intent = this.intents.get(a.intentId);
      if (intent?.status !== "judging") continue;
      const rivals = [...this.attempts.values()].filter((x) => x.intentId === a.intentId && x.id !== a.id && ACTIVE.has(x.status)).length;
      const reason: T.ApprovalReason = rivals ? "competing" : "project-asks";
      a.approval = {
        id: newId("ap"),
        status: "waiting",
        reason,
        why: [rivals ? `${rivals + 1} work copies compete on this task. A person chooses one.` : "A person must decide to merge this work."],
        digest: "",
        ...(a.sender ? { approver: a.sender } : {}),
        askedAt: a.updatedAt,
      };
      this.db.putAttempt(a);
    }
  }

  // ───── Lookups ─────

  protected get backend(): RepoBackend {
    if (this.backendCache) return this.backendCache;
    this.backendCache = new ArtifactsBackend(this.env.ARTIFACTS, { author: GITRING_AUTHOR, treeCache: this.treeCache });
    return this.backendCache;
  }

  protected requireProject(): T.Project {
    if (!this.project) throw new Error("The project is not ready. Call init first.");
    return this.project;
  }

  /** The branch that holds main in the canonical repo (an import keeps the remote's default branch). */
  protected get branch(): string {
    return this.project?.repo.defaultBranch || "main";
  }

  /** The project. A project exists only after init (POST /api/projects). */
  async ensure(_projectId?: string): Promise<T.Project> {
    if (this.project) return this.project;
    throw new Error("Unknown project. Create it first.");
  }

  protected mustAttempt(id: string): T.Attempt {
    const a = this.attempts.get(id);
    if (!a) throw new Error(`Unknown work copy ${id}. Call gitring_declare first.`);
    return a;
  }

  protected callsign(attemptId?: string): string | undefined {
    if (!attemptId) return undefined;
    const a = this.attempts.get(attemptId);
    return a ? this.agents.get(a.agentId)?.callsign : undefined;
  }

  /**
   * Did the caller send the agent of this work copy? Also true for a call from inside gitring or with the
   * operator key (no viewer), and for work that no person sent.
   */
  protected sentBy(a: T.Attempt, viewer?: CallInfo["viewer"]): boolean {
    return !viewer || !a.sender || a.sender.id === viewer.id;
  }

  /** May the caller change this work copy? The person who sent the agent, an owner, or the operator key may. */
  protected mayAct(a: T.Attempt, viewer?: CallInfo["viewer"]): boolean {
    return this.sentBy(a, viewer) || viewer?.role === "owner";
  }

  protected mayChange(a: T.Attempt, viewer?: CallInfo["viewer"]): void {
    if (this.mayAct(a, viewer)) return;
    throw new Error(`Work copy ${a.id} belongs to the agent of ${a.sender?.name ?? "another person"}. Only that person or an owner of the project can change it.`);
  }

  // ───── Main's place in history ─────

  /** The place of a commit in main's history, or -1 when it never was main. */
  protected mainPlace(sha: string): number {
    return this.mainIndex.get(sha) ?? -1;
  }

  /** A commit becomes main: it gets the next place (a commit that was main already keeps its place). */
  protected appendMainSeq(sha: string): void {
    this.mainIndex.set(sha, this.db.appendMain(sha));
  }

  /** Main starts at one commit (a new repository). */
  protected resetMainSeq(sha: string): void {
    this.mainIndex = new Map([[sha, this.db.resetMain(sha)]]);
  }

  protected bump(attemptId: string): void {
    this.attemptVersion.set(attemptId, (this.attemptVersion.get(attemptId) ?? 0) + 1);
  }

  // ───── GitHub state of the project ─────

  protected directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
  }

  /*
   * GitHub state is kept per repository (meta "gh:<owner/name>"): unlinking and linking again, or a run
   * that finishes after a relink, never mixes the commit pairs, pulls or conflicts of two repositories.
   */
  protected ghKey(repo: string): string {
    return `gh:${repo.toLowerCase()}`;
  }

  protected gh(repo: string): GithubRepoState {
    return this.db.getMeta<GithubRepoState>(this.ghKey(repo)) ?? { known: {}, upstreamOf: {} };
  }

  protected setGh(repo: string, patch: Partial<GithubRepoState>): GithubRepoState {
    const next = { ...this.gh(repo), ...patch };
    next.known = Object.fromEntries(Object.entries(next.known).slice(-1000));
    next.upstreamOf = Object.fromEntries(Object.entries(next.upstreamOf).slice(-200));
    this.db.setMeta(this.ghKey(repo), next);
    return next;
  }

  /** Move state of the first GitHub sync version (separate meta keys) into the per-repository state. */
  protected migrateGithubState(): void {
    const repo = this.project?.settings.github.repo;
    const known = this.db.getMeta<Record<string, string>>("githubKnown");
    const last = this.db.getMeta<string>("githubLast");
    const upstreamOf = this.db.getMeta<Record<string, string>>("githubUpstreamOf");
    if (repo && (known || last || upstreamOf)) {
      const cur = this.gh(repo);
      this.setGh(repo, { known: { ...(known ?? {}), ...cur.known }, last: cur.last ?? last, upstreamOf: { ...(upstreamOf ?? {}), ...cur.upstreamOf } });
    }
    for (const k of ["githubKnown", "githubLast", "githubUpstreamOf", "githubConflict", "githubPull"]) this.db.setMeta(k, undefined);
  }

  /** Private code (or a private issue) came in from `repo`: the project stays private from now on. */
  protected holdPrivate(repo: string): void {
    const p = this.requireProject();
    if (p.privateCode) return;
    p.privateCode = { repo, at: Date.now() };
    this.db.setMeta("project", p);
  }
}
