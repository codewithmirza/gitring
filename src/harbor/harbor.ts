/**
 * HarborMaster — one Durable Object per project.
 *
 * It is the single writer of `main`, the course-check authority, the landing queue and the
 * live event source for the UI. Agents (MCP clients, git clients, built-in vessels) talk to it
 * through the same protocol: declare → log/write → check → submit → (corrections piggyback on
 * every response).
 */
import { DurableObject } from "cloudflare:workers";
import type * as T from "../core/types";
import { DEFAULT_SETTINGS } from "../core/types";
import { Db } from "./store";
import { callsignFor, colorFor, newId, repoSafe } from "./ids";
import type { Env } from "../worker/env";
import type { RepoBackend } from "../platform/repo/backend";
import { RepoConflictError } from "../platform/repo/backend";
import { ArtifactsBackend } from "../platform/repo/artifacts";
import { MemoryTreeCache, readSnapshot, diffSnapshots, type Snapshot } from "../core/git/snapshot";
import { utf8 } from "../core/git/objects";
import { buildImportGraph, graphFromEdges } from "../core/analysis/graph";
import { isAnalyzable } from "../core/analysis/symbols";
import { unifiedDiff, isProbablyText, lineDiff } from "../core/text/diff";
import {
  selectCandidates,
  buildPairFacts,
  assessWithRules,
  parseClefResponse,
  decide,
  draftCorrection,
  draftUpstreamCorrection,
  draftReplotCorrection,
  draftDuplicateCorrection,
  draftIntentAmendedCorrection,
  type VesselView,
} from "../core/coord";
import { computeRange, shapeFromFootprint } from "../core/analysis/range";
import { buildBriefClefRequest } from "../core/coord/clef-brief";
import { compose } from "../core/land/compose";
import { merge3 } from "../core/text/merge3";
import { landingMessage, landingNote, intentFile } from "../core/logbook";
import { MAX_TEXT_BYTES, MAX_TEXT_FILES, normalizeGitUrl, textEligible } from "../core/repo-rules";
import { runChecks, contentKey } from "../platform/checks/runner";
import { packTree, type DrydockResult } from "../drydock/drydock";
import { callClef, chat } from "../platform/ai/models";
import {
  ACTIVE,
  WAITING,
  PROTOCOL,
  changedVersions,
  clearance,
  failureSummary,
  fileNodes,
  footprintOf,
  latestCheck,
  median,
  notices,
  overlayFiles,
  signaturesOf,
  trafficVessel,
  vesselView,
  type AttemptView,
  type MainView,
  type TreeText,
} from "./views";
import bundle from "../../sample/bundle.json";

const BEARING_AUTHOR = { name: "Bearing", email: "harbor@bearing.dev" };
export const BUILD_ID = "0.4.0+20261009f";
const MAX_LOGS = 500;
const MAX_CHECKS = 300;
const TERMINAL: ReadonlySet<T.AttemptStatus> = new Set(["landed", "abandoned", "alternate", "failed", "stale"]);
/** Default built-in AI agent starts per hour for the whole deployment (AI_AGENTS_PER_HOUR overrides). */
const LLM_STARTS_PER_HOUR = 40;
/** Default built-in AI agent starts per hour and person (AI_AGENTS_PER_USER_HOUR overrides). */
const LLM_STARTS_PER_USER_HOUR = 12;

interface DemoIntent {
  slug: string;
  title: string;
  goal: string;
  fanout?: number;
  checks: { path: string; description: string; content: string }[];
  expect: { files: string[]; symbols: string[] };
}
interface DemoBundle {
  name: string;
  repo: Record<string, string>;
  intents: DemoIntent[];
}
/** The sample project: a real codebase with intents and checks. New sample projects start from it. */
export const SAMPLE = bundle as unknown as DemoBundle;

export interface LaunchInput {
  fanout?: number;
  models?: string[];
}

export interface Brief {
  attemptId?: string;
  intent: T.Intent;
  files: { path: string; size: number }[];
  /** Full text of the small files the agent likely needs. */
  context: Record<string, string>;
  checks: { path: string; description: string; content: string }[];
  constraints: string[];
  traffic: T.TrafficVessel[];
  /** How the checks run: the Bearing harness, or the project's install and test commands in a container. */
  runner: T.CheckSettings;
}

export class HarborMaster extends DurableObject<Env> {
  private db: Db;
  private project?: T.Project;
  private intents = new Map<string, T.Intent>();
  private attempts = new Map<string, T.Attempt>();
  private agents = new Map<string, T.AgentInfo>();
  private corrections = new Map<string, T.Correction>();
  private checks: T.CourseCheck[] = [];
  private logs: T.LogEntry[] = [];
  private landings: T.Landing[] = [];
  private decisions: T.Decision[] = [];
  private radar = new Map<string, T.RadarPair>();
  private stats: T.HarborStats = emptyStats();
  private checkLatencies: number[] = [];
  private sim?: T.SimStats;

  private backendCache?: RepoBackend;
  private treeCache = new MemoryTreeCache(5000);
  private treeTexts = new Map<string, Promise<TreeText>>();
  private mainView?: MainView;
  private mainLoading?: Promise<MainView>;
  private attemptViews = new Map<string, { version: number; view: AttemptView }>();
  private attemptVersion = new Map<string, number>();
  private forks = new Map<string, Promise<void>>();
  private landingChain: Promise<unknown> = Promise.resolve();
  private outbox: T.BearingEvent[] = [];
  private flushScheduled = false;
  private seq = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Db(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => this.load());
  }

  /* ════════════════════════════ load / bootstrap ════════════════════════════ */

  private load(): void {
    this.project = this.db.getMeta<T.Project>("project");
    for (const i of this.db.all<T.Intent>("intents")) this.intents.set(i.id, i);
    for (const a of this.db.all<T.Attempt>("attempts")) this.attempts.set(a.id, a);
    for (const g of this.db.all<T.AgentInfo>("agents")) this.agents.set(g.id, g);
    for (const c of this.db.all<T.Correction>("corrections")) this.corrections.set(c.id, c);
    this.checks = this.db.recentChecks<T.CourseCheck>(MAX_CHECKS);
    this.logs = this.db.recentLogs<T.LogEntry>(MAX_LOGS);
    this.landings = this.db.all<T.Landing>("landings").sort((a, b) => a.at - b.at);
    this.decisions = this.db.all<T.Decision>("decisions").sort((a, b) => a.at - b.at);
    for (const r of this.db.all<T.RadarPair>("radar")) this.radar.set(pairKey(r.a, r.b), r);
    this.stats = this.db.getMeta<T.HarborStats>("stats") ?? emptyStats();
    this.checkLatencies = this.db.getMeta<number[]>("latencies") ?? [];
    this.seq = this.db.getMeta<number>("seq") ?? 0;
    this.sim = this.db.getMeta<T.SimStats>("sim");
    if (this.sim?.running && !this.simRun) this.sim = { ...this.sim, running: false };
  }

  private get backend(): RepoBackend {
    if (this.backendCache) return this.backendCache;
    this.backendCache = new ArtifactsBackend(this.env.ARTIFACTS, { author: BEARING_AUTHOR, treeCache: this.treeCache });
    return this.backendCache;
  }

  private requireProject(): T.Project {
    if (!this.project) throw new Error("The project is not ready. Call init first.");
    return this.project;
  }

  /** The branch that holds main in the canonical repo (an import keeps the remote's default branch). */
  private get branch(): string {
    return this.project?.repo.defaultBranch || "main";
  }

  /** The project, created on first use only for the deployment's public sample ("demo"). */
  async ensure(projectId: string): Promise<T.Project> {
    if (this.project) return this.project;
    if (projectId !== "demo") throw new Error("Unknown project. Create it first.");
    await this.init({ projectId, name: `${SAMPLE.name ?? "Saltmarsh Books"} (sample)`, source: { kind: "sample" } });
    return this.requireProject();
  }

  /**
   * Create the canonical repo in Artifacts from a source:
   *   sample  the sample codebase and its intents (one seed commit)
   *   empty   a README in one commit
   *   git     Artifacts imports a public https remote (history kept); main = the remote's default branch
   *   push    an empty repo; the owner pushes to it with plain git (Bearing adopts the pushed branch)
   *   upload  the files of a folder from the owner's computer, in one commit
   * Imports run in the background: the project shows "importing" until Artifacts is done.
   */
  async init(opts: { projectId: string; name?: string; source?: T.ProjectSource; ownerId?: string; files?: SeedFile[] }): Promise<T.ProjectState> {
    const generation = (this.db.getMeta<number>("generation") ?? 0) + 1;
    const source: T.ProjectSource = opts.source ?? { kind: "sample" };
    const namespace = this.env.ARTIFACTS_NAMESPACE ?? "bearing";
    this.project = undefined;
    this.backendCache = undefined;
    const repoName = repoSafe(`${opts.projectId}-g${generation}-${Date.now().toString(36)}`);
    const draft: T.Project = {
      id: opts.projectId,
      name: opts.name ?? SAMPLE.name ?? "Saltmarsh Books",
      repo: { backend: "artifacts", namespace, name: repoName, defaultBranch: "main" },
      mainSha: "",
      mainTree: "",
      createdAt: Date.now(),
      source,
      ownerId: opts.ownerId,
      settings: {
        ...DEFAULT_SETTINGS,
        decisionModel: "clef-flash",
        agentModels: this.env.AGENT_MODELS?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_SETTINGS.agentModels,
        intentsInRepo: source.kind === "sample",
        // The sample's checks use the Bearing harness; other repositories run their own tests in a container.
        ...(source.kind === "sample" ? {} : { checks: { runner: "container" as const } }),
      },
    };
    this.project = draft;
    this.db.setMeta("generation", generation);

    if (source.kind === "git") {
      const url = normalizeGitUrl(source.url);
      const res = await this.env.ARTIFACTS.import({
        source: { url, ...(source.branch ? { branch: source.branch } : {}), depth: 200 },
        target: { name: repoName, opts: { description: `Bearing project ${opts.projectId} (import of ${url})` } },
      });
      draft.repo.remote = res.remote;
      draft.repo.defaultBranch = source.branch || res.defaultBranch || "main";
      draft.importing = { url, startedAt: Date.now() };
      this.db.setMeta("project", draft);
      this.addLog({ kind: "system", message: `Import starts: ${url} into Cloudflare Artifacts (${repoName}).` });
      await this.ctx.storage.setAlarm(Date.now() + 2000);
      const state = await this.state();
      this.emit({ type: "snapshot", state });
      return state;
    }

    const handle = await this.backend.ensureRepo(repoName, { description: `Bearing project ${opts.projectId}` });
    draft.repo.remote = handle.remote;

    if (source.kind === "push") {
      // An empty repo: the owner pushes an existing repository with plain git. Bearing adopts the push.
      draft.importing = { url: "git push", startedAt: Date.now(), push: true, tokenIds: [] };
      this.db.setMeta("project", draft);
      this.addLog({ kind: "system", message: `Repository ready in Cloudflare Artifacts (${repoName}). Waiting for the first git push.` });
      await this.ctx.storage.setAlarm(Date.now() + 15_000);
      const state = await this.state();
      this.emit({ type: "snapshot", state });
      return state;
    }

    const uploaded = source.kind === "upload" ? seedChanges(opts.files ?? []) : [];
    if (source.kind === "upload" && !uploaded.length) throw new Error("The folder has no files to upload.");
    const changes =
      source.kind === "sample"
        ? Object.entries(SAMPLE.repo).map(([path, content]) => ({ path, content }) as { path: string; content: string | Uint8Array; mode?: string })
        : source.kind === "upload"
          ? uploaded
          : [{ path: "README.md", content: `# ${draft.name}\n\nThis repository lives in Bearing. Agents declare intents before they change it.\n` }];
    const seed = await this.backend.commit({
      repo: repoName,
      branch: "main",
      parent: "",
      changes,
      message:
        source.kind === "sample"
          ? `Seed ${draft.name}\n\nThe starting point of the sample project.\n\nBearing-Seed: sample`
          : source.kind === "upload"
            ? `Upload ${draft.name}\n\n${changes.length} files from a folder.\n\nBearing-Seed: upload`
            : `Start ${draft.name}\n\nBearing-Seed: ${source.kind}`,
      author: BEARING_AUTHOR,
    });
    draft.mainSha = seed.sha;
    draft.mainTree = seed.tree;
    this.db.setMeta("project", draft);
    this.db.setMeta("mainSeq", [seed.sha]);
    if (source.kind === "sample") for (const di of SAMPLE.intents) this.seedIntent(di);
    this.addLog({ kind: "system", message: `Project ready. Main is ${seed.sha.slice(0, 7)} in Cloudflare Artifacts (${repoName}).` });
    await this.loadMain();
    this.persistStats();
    const state = await this.state();
    this.emit({ type: "snapshot", state });
    return state;
  }

  /** Alarm step for an import: wait until Artifacts has the repo (or the owner's push), then read main. */
  private async continueImport(): Promise<void> {
    const p = this.project;
    if (!p?.importing || p.importing.error) return;
    const elapsed = Date.now() - p.importing.startedAt;
    if (p.importing.push) {
      const pushed = await this.pushedBranch();
      if (!pushed) {
        if (elapsed > 3 * 24 * 3600_000) {
          p.importing = { ...p.importing, error: "No git push arrived in 3 days. Make a new project to try again." };
          this.db.setMeta("project", p);
          this.emit({ type: "snapshot", state: await this.state() });
          return;
        }
        // Check often at first, then every 5 minutes. "Check now" in the UI does not wait.
        await this.ctx.storage.setAlarm(Date.now() + Math.min(300_000, 15_000 + elapsed / 20));
        return;
      }
      await this.adoptMain(pushed.branch, pushed.sha);
      return;
    }
    let ready = false;
    let remoteDefault = "";
    try {
      // get() throws IMPORT_IN_PROGRESS until Artifacts has the whole repository.
      using repo = await this.env.ARTIFACTS.get(p.repo.name);
      const info = await repo.info();
      ready = !("status" in info) || (info as { status?: string }).status !== "importing";
      remoteDefault = info.defaultBranch ?? "";
    } catch {
      ready = false;
    }
    if (!ready) {
      if (elapsed > 20 * 60_000) {
        p.importing = { ...p.importing, error: "The import took more than 20 minutes. Try a smaller repository or a shallower branch." };
        this.db.setMeta("project", p);
        this.addLog({ kind: "system", message: `Import failed: ${p.importing.error}` });
        this.emit({ type: "snapshot", state: await this.state() });
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + Math.min(15_000, 2000 + elapsed / 10));
      return;
    }
    // Main is the branch the owner asked for, else the remote's default branch.
    const asked = p.source?.kind === "git" ? p.source.branch : undefined;
    const candidates = asked ? [asked] : [...new Set([remoteDefault, p.repo.defaultBranch, "main", "master", "trunk", "develop"].filter(Boolean))];
    let sha: string | null = null;
    for (const branch of candidates) {
      sha = await this.backend.resolve(p.repo.name, branch);
      if (sha) {
        p.repo.defaultBranch = branch;
        p.repo.forkAllBranches = remoteDefault !== branch;
        break;
      }
    }
    if (!sha) {
      p.importing = { ...p.importing, error: asked ? `The repository has no branch "${asked}".` : "Bearing did not find the default branch of the repository. Import it again and name the branch." };
      this.db.setMeta("project", p);
      this.addLog({ kind: "system", message: `Import failed: ${p.importing.error}` });
      this.emit({ type: "snapshot", state: await this.state() });
      return;
    }
    await this.adoptMain(p.repo.defaultBranch, sha);
  }

  /** Main becomes `branch` at `sha` (after an import or the owner's first push). */
  private async adoptMain(branch: string, sha: string): Promise<void> {
    const p = this.requireProject();
    const commit = await this.backend.readCommit(p.repo.name, sha);
    if (!commit) throw new Error("The imported head commit cannot be read.");
    p.repo.defaultBranch = branch;
    p.mainSha = sha;
    p.mainTree = commit.treeHash;
    const url = p.importing?.url ?? "";
    // Push tokens open the canonical repo; after the adoption only Bearing writes to it.
    for (const id of p.importing?.tokenIds ?? []) await this.backend.revokeToken(p.repo.name, id).catch(() => false);
    p.importing = undefined;
    this.db.setMeta("project", p);
    this.db.setMeta("mainSeq", [sha]);
    this.mainView = undefined;
    const main = await this.loadMain();
    this.addLog({ kind: "system", message: `${url === "git push" ? "Push received" : `Import done: ${url}`} at ${sha.slice(0, 7)} on ${branch} (${main.files.length} files). Open intents for agents.` });
    this.persistStats();
    this.emit({ type: "snapshot", state: await this.state() });
  }

  /** The branch the owner pushed: main, master, or the repo's default branch. */
  private async pushedBranch(): Promise<{ branch: string; sha: string } | null> {
    const p = this.requireProject();
    let fallback = "";
    try {
      using repo = await this.env.ARTIFACTS.get(p.repo.name);
      fallback = (await repo.info()).defaultBranch ?? "";
    } catch {
      return null;
    }
    for (const branch of [...new Set(["main", "master", fallback, "trunk", "develop"].filter(Boolean))]) {
      const sha = await this.backend.resolve(p.repo.name, branch).catch(() => null);
      if (sha) return { branch, sha };
    }
    return null;
  }

  /**
   * A push project: a write token for the owner's first `git push` (24 hours). Bearing revokes it when
   * it adopts the push.
   */
  async pushAccess(): Promise<{ remote: string; token: string; expiresAt: string }> {
    const p = this.requireProject();
    if (!p.importing?.push || p.importing.error) throw new Error("This project does not wait for a push.");
    const t = await this.backend.createToken(p.repo.name, "write", 24 * 3600);
    if (!t) throw new Error("Artifacts did not make a token. Try again.");
    if (t.id) {
      p.importing = { ...p.importing, tokenIds: [...(p.importing.tokenIds ?? []), t.id].slice(-10) };
      this.db.setMeta("project", p);
    }
    const remote = p.repo.remote ?? (await this.backend.remoteUrl(p.repo.name)) ?? "";
    this.addLog({ kind: "system", message: "The owner took a push token (24 hours)." });
    return { remote, token: t.token, expiresAt: t.expiresAt };
  }

  /** "Check now": look for the owner's push without waiting for the alarm. */
  async checkImport(): Promise<T.ProjectState> {
    await this.continueImport();
    return this.state();
  }

  /** Sample projects only: wipe the state and start again from the sample's first commit. */
  async reset(): Promise<T.ProjectState> {
    if (this.project?.source && this.project.source.kind !== "sample") throw new Error("Only a sample project can be reset.");
    const id = this.project?.id ?? "demo";
    // Stop built-in vessels of the old generation.
    for (const a of this.attempts.values()) {
      if (ACTIVE.has(a.status)) this.stopVessel(a.id).catch(() => {});
    }
    const generation = this.db.getMeta<number>("generation") ?? 0;
    this.db.wipe();
    this.db.setMeta("generation", generation);
    this.intents.clear();
    this.attempts.clear();
    this.agents.clear();
    this.corrections.clear();
    this.checks = [];
    this.logs = [];
    this.landings = [];
    this.decisions = [];
    this.radar.clear();
    this.stats = emptyStats();
    this.checkLatencies = [];
    this.mainView = undefined;
    this.attemptViews.clear();
    this.attemptVersion.clear();
    this.forks.clear();
    this.treeTexts.clear();
    this.sim = undefined;
    return this.init({ projectId: id, name: this.project?.name, source: { kind: "sample" }, ownerId: this.project?.ownerId });
  }

  private seedIntent(di: DemoIntent): T.Intent {
    const now = Date.now();
    const intent: T.Intent = {
      id: newId("i"),
      title: di.title,
      goal: di.goal,
      constraints: [],
      checks: di.checks.map((c, i) => ({ id: `chk_${i}`, path: c.path, content: c.content, description: c.description })),
      scope: { paths: di.expect.files },
      priority: "normal",
      status: "open",
      version: 1,
      amendments: [],
      createdBy: SYSTEM,
      createdAt: now,
      updatedAt: now,
      source: { kind: "seed", ref: di.slug },
      suggestedFanout: di.fanout,
    };
    this.putIntent(intent);
    return intent;
  }

  /* ════════════════════════════ tree + main views ════════════════════════════ */

  private async readText(repo: string, sha: string): Promise<string | null> {
    const cached = this.db.getBlobText(sha);
    if (cached) return cached.text;
    const bytes = await this.backend.readBlob(repo, sha);
    if (!bytes) return null;
    // Very large files stay opaque: agents do not edit them through Bearing, and SQLite rows stay small.
    const text = bytes.length <= MAX_TEXT_BYTES && isProbablyText(bytes) ? utf8.decode(bytes) : null;
    this.db.putBlobText(sha, text);
    return text;
  }

  /** Snapshot + text of a tree (cached forever: trees are content-addressed). */
  private treeText(repo: string, tree: string): Promise<TreeText> {
    let p = this.treeTexts.get(tree);
    if (!p) {
      p = (async () => {
        const snapshot = await readSnapshot(this.backend, repo, tree, this.treeCache);
        const text = new Map<string, string>();
        const entries = [...snapshot.entries()].filter(([path]) => textEligible(path)).slice(0, MAX_TEXT_FILES);
        for (let i = 0; i < entries.length; i += 24) {
          await Promise.all(
            entries.slice(i, i + 24).map(async ([path, e]) => {
              const t = await this.readText(repo, e.sha);
              if (t !== null) text.set(path, t);
            }),
          );
        }
        return { tree, snapshot, text };
      })();
      p.catch(() => this.treeTexts.delete(tree));
      this.treeTexts.set(tree, p);
      if (this.treeTexts.size > 64) this.treeTexts.delete(this.treeTexts.keys().next().value!);
    }
    return p;
  }

  private async loadMain(): Promise<MainView> {
    const p = this.requireProject();
    if (p.importing) throw new Error(p.importing.error ? `The import failed: ${p.importing.error}` : "The repository is still importing. Try again in a minute.");
    if (this.mainView && this.mainView.sha === p.mainSha) return this.mainView;
    if (this.mainLoading) return this.mainLoading;
    this.mainLoading = (async () => {
      const tt = await this.treeText(p.repo.name, p.mainTree);
      const analyzable = new Map([...tt.text].filter(([path]) => isAnalyzable(path)));
      const graph = buildImportGraph(analyzable);
      const view: MainView = {
        ...tt,
        sha: p.mainSha,
        files: fileNodes(tt.snapshot, tt.text),
        graph,
        imports: graph.edges.map(([a, b]) => [a, b] as [string, string]),
        signatures: signaturesOf(analyzable),
      };
      this.mainView = view;
      return view;
    })().finally(() => {
      this.mainLoading = undefined;
    });
    return this.mainLoading;
  }

  private bump(attemptId: string): void {
    this.attemptVersion.set(attemptId, (this.attemptVersion.get(attemptId) ?? 0) + 1);
  }

  /** Files, changes and signatures of an attempt (cached per content version). */
  private async attemptView(a: T.Attempt): Promise<AttemptView> {
    const version = this.attemptVersion.get(a.id) ?? 0;
    const cached = this.attemptViews.get(a.id);
    if (cached && cached.version === version) return cached.view;
    const p = this.requireProject();
    const base = await this.treeText(p.repo.name, a.baseTree);
    let files: Map<string, string>;
    let paths: string[];
    if (a.mode === "git") {
      const head = a.headSha ? await this.backend.readCommit(a.fork.repo, a.headSha) : null;
      const tt = head ? await this.treeText(a.fork.repo, head.treeHash) : base;
      // Shadow edits (from the Claude Code hook) sit on top of the last push.
      const shadow = this.db.worktree(a.id);
      files = overlayFiles(tt.text, shadow);
      paths = [...diffSnapshots(base.snapshot, tt.snapshot).map((c) => c.path), ...shadow.keys()];
    } else {
      const overlay = this.db.worktree(a.id);
      files = overlayFiles(base.text, overlay);
      paths = [...overlay.keys()];
    }
    const changed = changedVersions(base.text, files, paths);
    const { signatures } = footprintOf(changed, new Set(files.keys()));
    const view: AttemptView = { version, files, changed, signatures };
    this.attemptViews.set(a.id, { version, view });
    return view;
  }

  /** Check files are written by Bearing, not by agents: they never count as a collision. */
  private checkPaths(): Set<string> {
    return new Set([...this.intents.values()].flatMap((i) => i.checks.map((c) => c.path)));
  }

  private async refreshFootprint(a: T.Attempt): Promise<AttemptView> {
    this.bump(a.id);
    const view = await this.attemptView(a);
    const managed = this.checkPaths();
    const { footprint } = footprintOf(view.changed.filter((c) => !managed.has(c.path)), new Set(view.files.keys()));
    a.footprint = footprint;
    let additions = 0;
    let deletions = 0;
    for (const t of Object.values(footprint.files)) {
      additions += t.additions;
      deletions += t.deletions;
    }
    a.stats = { ...a.stats, filesChanged: Object.keys(footprint.files).length, additions, deletions };
    return view;
  }

  /* ════════════════════════════ events, logs, stats ════════════════════════════ */

  private emit(ev: T.BearingEvent): void {
    this.outbox.push(ev);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => this.flush(), 0);
  }

  private flush(): void {
    this.flushScheduled = false;
    if (!this.outbox.length) return;
    const batch = this.outbox;
    this.outbox = [];
    const data = JSON.stringify(batch.length === 1 ? batch[0] : batch);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* closed socket */
      }
    }
  }

  private addLog(entry: Omit<T.LogEntry, "id" | "at"> & { at?: number }): T.LogEntry {
    const log: T.LogEntry = { id: `lg_${++this.seq}`, at: entry.at ?? Date.now(), ...entry } as T.LogEntry;
    this.logs.push(log);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.db.appendLog(log);
    this.db.setMeta("seq", this.seq);
    this.emit({ type: "log", log });
    return log;
  }

  private persistStats(): void {
    this.stats.medianCheckLatencyMs = median(this.checkLatencies);
    this.db.setMeta("stats", this.stats);
    this.db.setMeta("latencies", this.checkLatencies.slice(-200));
    this.emit({ type: "stats", stats: { ...this.stats } });
  }

  private putIntent(i: T.Intent): void {
    i.updatedAt = Date.now();
    this.intents.set(i.id, i);
    this.db.putIntent(i);
    this.emit({ type: "intent", intent: i });
  }

  private putAttempt(a: T.Attempt): void {
    a.updatedAt = Date.now();
    this.attempts.set(a.id, a);
    this.db.putAttempt(a);
    this.emit({ type: "attempt", attempt: a });
  }

  private putAgent(g: T.AgentInfo): void {
    this.agents.set(g.id, g);
    this.db.putAgent(g);
    this.emit({ type: "agent", agent: g });
  }

  private putCorrection(c: T.Correction): void {
    this.corrections.set(c.id, c);
    this.db.putCorrection(c);
    this.emit({ type: "correction", correction: c });
  }

  private callsign(attemptId?: string): string | undefined {
    if (!attemptId) return undefined;
    const a = this.attempts.get(attemptId);
    return a ? this.agents.get(a.agentId)?.callsign : undefined;
  }

  /* ════════════════════════════ state for the UI ════════════════════════════ */

  async state(): Promise<T.ProjectState> {
    const project = this.requireProject();
    const main = project.mainTree ? await this.loadMain() : { files: [], imports: [] as [string, string][] };
    return {
      project,
      intents: [...this.intents.values()],
      attempts: [...this.attempts.values()],
      agents: [...this.agents.values()],
      corrections: [...this.corrections.values()],
      checks: this.checks.slice(-200),
      landings: this.landings,
      decisions: this.decisions,
      logs: this.logs.slice(-400),
      radar: [...this.radar.values()],
      files: main.files,
      imports: main.imports,
      stats: { ...this.stats, medianCheckLatencyMs: median(this.checkLatencies) },
      sim: this.sim,
    };
  }

  /* ════════════════════════════ WebSocket (hibernation API) ════════════════════════════ */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const projectId = url.searchParams.get("project") ?? "demo";
      await this.ensure(projectId);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "snapshot", state: await this.state() } satisfies T.BearingEvent));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "bye");
    } catch {
      /* already closed */
    }
  }

  /* ════════════════════════════ agents ════════════════════════════ */

  private upsertAgent(id: T.AgentIdentity): T.AgentInfo {
    const existing = id.id ? this.agents.get(id.id) : undefined;
    if (existing) {
      existing.lastSeen = Date.now();
      if (id.model) existing.model = id.model;
      if (id.client) existing.client = id.client;
      this.putAgent(existing);
      return existing;
    }
    const n = this.agents.size;
    const agent: T.AgentInfo = {
      id: id.id ?? newId("ag"),
      callsign: id.name && /^[A-Z]+-\d+$/.test(id.name) ? id.name : callsignFor(n),
      kind: id.kind ?? (id.client ? "mcp" : "builtin"),
      model: id.model,
      client: id.client,
      color: colorFor(n),
      status: "idle",
      lastSeen: Date.now(),
    };
    this.putAgent(agent);
    return agent;
  }

  /* ════════════════════════════ agent protocol ════════════════════════════ */

  async declare(input: T.DeclareInput & { attemptId?: string; projectId?: string; workdir?: string }): Promise<T.DeclareResult> {
    await this.ensure(input.projectId ?? "demo");
    const p = this.requireProject();
    const main = await this.loadMain();
    const agent = this.upsertAgent(input.agent ?? {});

    let intent: T.Intent | undefined = input.intentId ? this.intents.get(input.intentId) : undefined;
    let createdIntent = false;
    if (!intent && input.newIntent) {
      intent = await this.createIntent(
        { title: input.newIntent.title, goal: input.newIntent.goal, source: { kind: "mcp", ref: agent.callsign } },
        { kind: "agent", id: agent.id, name: agent.callsign },
      );
      createdIntent = true;
    }
    if (!intent) throw new Error("Unknown intent. Give intentId from bearing_intents, or give newIntent.");
    if (intent.status === "landed" || intent.status === "parked") {
      throw new Error(`Intent "${intent.title}" is ${intent.status}. Choose an open intent.`);
    }

    const mode = input.mode ?? "api";
    let attempt = input.attemptId ? this.attempts.get(input.attemptId) : undefined;
    const now = Date.now();
    const course: T.Course = {
      plan: (input.plan ?? []).slice(0, 20).map(String),
      files: [...new Set((input.files ?? []).map(normPath))],
      symbols: [...new Set((input.symbols ?? []).map(String))],
      approach: String(input.approach ?? "").slice(0, 400),
      declaredAt: now,
    };
    if (!attempt) {
      const id = newId("a");
      attempt = {
        id,
        intentId: intent.id,
        agentId: agent.id,
        fork: { repo: repoSafe(`${p.repo.name}-${id}`) },
        mode,
        baseSha: main.sha,
        baseTree: main.tree,
        status: "declared",
        course,
        footprint: emptyFootprint(),
        corrections: [],
        lineage: { generation: 1 },
        stats: { filesChanged: 0, additions: 0, deletions: 0, steps: 0 },
        createdAt: now,
        updatedAt: now,
      };
    } else {
      attempt.agentId = agent.id;
      attempt.course = course;
      attempt.mode = mode;
      attempt.intentId = intent.id;
    }
    agent.status = "underway";
    agent.attemptId = attempt.id;
    this.putAgent(agent);
    if (input.workdir) this.db.setHook(`cwd:${normDir(input.workdir)}`, attempt.id);

    // The intent's checks are part of the attempt from the start.
    if (mode === "api") {
      for (const c of intent.checks) this.db.writeWorktree(attempt.id, c.path, c.content);
    }
    this.putAttempt(attempt);
    if (intent.status === "open" || intent.status === "draft") {
      intent.status = "underway";
      this.putIntent(intent);
    }
    this.addLog({
      kind: "declare",
      attemptId: attempt.id,
      agentId: agent.id,
      intentId: intent.id,
      message: `${agent.callsign} declares a course on "${intent.title}": ${course.approach || course.plan[0] || "no approach given"}`,
      files: course.files,
    });

    // Fork: git mode needs the remote now; api mode forks in the background.
    let workspace: T.DeclareResult["workspace"] = { mode, baseSha: attempt.baseSha };
    const forkJob = this.ensureFork(attempt, intent);
    if (mode === "git") {
      await forkJob;
      const tok = await this.backend.createToken(attempt.fork.repo, "write", 6 * 3600);
      workspace = {
        mode,
        baseSha: attempt.baseSha,
        remote: attempt.fork.remote ?? (await this.backend.remoteUrl(attempt.fork.repo)),
        token: tok?.token,
        tokenExpiresAt: tok?.expiresAt,
      };
    } else {
      this.ctx.waitUntil(forkJob.catch((e) => console.warn("fork failed", String(e))));
    }

    await this.refreshFootprint(attempt);
    let check = await this.courseCheck(attempt.id, "declare");
    // A duplicate of a new intent joins the existing intent as another attempt (best-of-N).
    if (check?.verdict === "merge-intents" && createdIntent) {
      check = await this.mergeDuplicate(attempt, intent, check);
      intent = this.intents.get(attempt.intentId)!;
    }
    const clr = this.clearanceFor(attempt.id);
    return {
      attemptId: attempt.id,
      agentId: agent.id,
      callsign: agent.callsign,
      intent: {
        id: intent.id,
        title: intent.title,
        goal: intent.goal,
        constraints: intent.constraints,
        version: intent.version,
        checks: intent.checks.map((c) => ({ path: c.path, description: c.description })),
      },
      workspace,
      clearance: clr,
      protocol: PROTOCOL,
    };
  }

  private ensureFork(a: T.Attempt, intent: T.Intent): Promise<void> {
    let job = this.forks.get(a.id);
    if (job) return job;
    const p = this.requireProject();
    job = (async () => {
      const fork = await this.backend.fork(p.repo.name, a.fork.repo, { description: `${intent.title} · ${a.id}`, allBranches: p.repo.forkAllBranches });
      a.fork.remote = fork.remote ?? (await this.backend.remoteUrl(a.fork.repo));
      if (a.mode === "git" && intent.checks.length) {
        // Put the intent's checks into the fork so a git client sees them after clone.
        const tip = (await this.backend.resolve(a.fork.repo, this.branch)) ?? a.baseSha;
        const res = await this.backend.commit({
          repo: a.fork.repo,
          branch: this.branch,
          parent: tip,
          changes: intent.checks.map((c) => ({ path: c.path, content: c.content })),
          message: `Add checks for "${intent.title}"\n\nBearing-Intent: ${intent.id}\nBearing-Attempt: ${a.id}`,
          author: BEARING_AUTHOR,
        });
        a.headSha = res.sha;
        this.bump(a.id);
      }
      this.putAttempt(a);
    })();
    this.forks.set(a.id, job);
    job.catch(() => this.forks.delete(a.id));
    return job;
  }

  async log(input: T.LogInput): Promise<T.Clearance> {
    const a = this.mustAttempt(input.attemptId);
    const agent = this.agents.get(a.agentId);
    if (agent) {
      agent.lastSeen = Date.now();
      this.putAgent(agent);
    }
    let trigger: T.CourseCheck["trigger"] = "log";
    if (input.files?.length) a.course.files = [...new Set([...a.course.files, ...input.files.map(normPath)])];
    if (input.symbols?.length) a.course.symbols = [...new Set([...a.course.symbols, ...input.symbols])];
    if (input.headSha && input.headSha !== a.headSha) {
      a.headSha = input.headSha;
      a.mode = "git";
      trigger = "push";
      this.db.clearWorktree(a.id); // the push supersedes shadow edits
    }
    if (a.status === "declared") a.status = "underway";
    a.stats.steps += 1;
    await this.refreshFootprint(a);
    this.putAttempt(a);
    this.addLog({
      kind: trigger === "push" ? "push" : "log",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${agent?.callsign ?? a.agentId}: ${String(input.message).slice(0, 300)}`,
      files: input.files?.length ? input.files.map(normPath) : Object.keys(a.footprint.files),
    });
    this.autoAck(a);
    await this.courseCheck(a.id, trigger);
    return this.clearanceFor(a.id);
  }

  async write(input: T.WriteInput): Promise<T.WriteResult> {
    const a = this.mustAttempt(input.attemptId);
    if (TERMINAL.has(a.status)) throw new Error(`Attempt ${a.id} is ${a.status}. Declare a new course to continue.`);
    if (a.mode === "git") throw new Error("This attempt uses git mode. Push to your fork, then call bearing_log with headSha.");
    const intent = this.intents.get(a.intentId);
    const protectedPaths = new Set(
      [...this.intents.values()].filter((i) => i.id !== a.intentId).flatMap((i) => i.checks.map((c) => c.path)),
    );
    const written: string[] = [];
    const merged: string[] = [];
    const refused: { path: string; reason: string }[] = [];
    const before = await this.attemptView(a);
    for (const f of input.files ?? []) {
      const path = normPath(f.path);
      if (!path || path.startsWith("../")) continue;
      if (protectedPaths.has(path)) continue; // checks of other intents are not yours to edit
      if (path.startsWith(".bearing/")) continue;
      const content: string | null = f.delete ? null : String(f.content ?? "");
      const g = this.guardWrite(a, path, content, before.files.get(path) ?? null);
      if (g.refused) {
        refused.push({ path, reason: g.refused });
        continue;
      }
      this.db.writeWorktree(a.id, path, g.content);
      // The agent's own text stays its copy: a later write from the same copy merges again.
      this.db.setSeen(a.id, path, content);
      if (g.merged) merged.push(path);
      written.push(path);
    }
    if (a.status === "declared") a.status = "underway";
    a.stats.steps += 1;
    a.course.files = [...new Set([...a.course.files, ...written])];
    await this.refreshFootprint(a);
    this.putAttempt(a);
    const agent = this.agents.get(a.agentId);
    this.addLog({
      kind: "write",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message:
        `${agent?.callsign ?? a.agentId} writes ${written.join(", ") || "nothing"}${input.message ? `: ${String(input.message).slice(0, 200)}` : ""}` +
        (merged.length ? ` Bearing merged the write with main changes in ${merged.join(", ")}.` : "") +
        (refused.length ? ` Bearing did not write ${refused.map((r) => r.path).join(", ")}: the file changed after the last read.` : ""),
      files: written,
    });
    void intent;
    this.autoAck(a);
    await this.courseCheck(a.id, "write");
    return {
      written,
      ...(merged.length ? { merged } : {}),
      ...(refused.length ? { refused } : {}),
      footprint: {
        files: Object.keys(a.footprint.files),
        symbols: [...a.footprint.symbols.defined, ...a.footprint.symbols.modified, ...a.footprint.symbols.removed],
      },
      clearance: this.clearanceFor(a.id),
    };
  }

  async read(attemptId: string, path: string): Promise<{ path: string; content: string | null }> {
    const a = this.mustAttempt(attemptId);
    const view = await this.attemptView(a);
    const p = normPath(path);
    const content = view.files.get(p) ?? null;
    if (a.mode === "api" && !TERMINAL.has(a.status)) {
      this.db.setSeen(a.id, p, content);
      this.db.setMustRead(a.id, p, false);
    }
    return { path: p, content };
  }

  /**
   * A write against what the agent last saw of the file. Main can move a file under an API-mode
   * agent (a re-plot): a write from the older copy merges 3-way with the landed change, or Bearing
   * refuses it ("read again") when the two overlap, or when one side deleted the file. A file that
   * Bearing reset to the main version must be read before the agent writes it.
   */
  private guardWrite(a: T.Attempt, path: string, content: string | null, current: string | null): { content: string | null; merged?: boolean; refused?: string } {
    if (this.db.mustRead(a.id, path)) {
      return { content, refused: `Bearing kept the main version of ${path}. Read ${path}, then make your change again on the new text.` };
    }
    const seen = this.db.seen(a.id, path);
    if (seen === undefined || seen === current || content === current) return { content };
    if (content === null) return { content, refused: `${path} changed on main after your last read. Read ${path} again before you delete it.` };
    if (current === null) return { content, refused: `Main deleted ${path} after your last read. Read the traffic before you add ${path} again.` };
    const m = merge3(seen ?? "", current, content);
    if (!m.clean) return { content, refused: `${path} changed after your last read: main moved. Read ${path} again, then write your change on the new text.` };
    return { content: m.content, merged: m.content !== content };
  }

  async list(attemptId: string, dir?: string): Promise<string[]> {
    const a = this.mustAttempt(attemptId);
    const view = await this.attemptView(a);
    const prefix = dir ? normPath(dir).replace(/\/?$/, "/") : "";
    return [...view.files.keys()].filter((p) => !prefix || p.startsWith(prefix)).sort();
  }

  async traffic(attemptId: string): Promise<T.TrafficReport> {
    const a = this.mustAttempt(attemptId);
    const main = await this.loadMain();
    const vessels = this.trafficFor(a);
    const seqList = this.db.getMeta<string[]>("mainSeq") ?? [];
    const baseIdx = seqList.indexOf(a.baseSha);
    const landed = this.landings.filter((l) => seqList.indexOf(l.mainAfter) > baseIdx);
    return {
      attemptId,
      vessels,
      mainSha: main.sha,
      landedSinceBase: landed.map((l) => ({
        intentId: l.intentId,
        title: this.intents.get(l.intentId)?.title ?? l.intentId,
        sha: l.mainAfter,
        files: Object.keys(this.attempts.get(l.attemptId)?.footprint.files ?? {}),
      })),
    };
  }

  /**
   * An agent stops without work that passes its checks: the attempt fails and leaves the traffic.
   * Ready, landing and closed attempts do not change.
   */
  async giveUp(attemptId: string, reason: string): Promise<T.AttemptStatus> {
    const a = this.mustAttempt(attemptId);
    if (TERMINAL.has(a.status) || a.status === "ready" || a.status === "landing") return a.status;
    a.status = "failed";
    this.putAttempt(a);
    this.addLog({ kind: "system", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${this.callsign(a.id)} stops: ${String(reason).slice(0, 240)}` });
    const intent = this.intents.get(a.intentId);
    if (intent && intent.status === "underway" && ![...this.attempts.values()].some((x) => x.intentId === intent.id && ACTIVE.has(x.status))) {
      intent.status = "open";
      this.putIntent(intent);
    }
    return a.status;
  }

  async ack(attemptId: string, correctionId: string, note?: string): Promise<T.Clearance> {
    const a = this.mustAttempt(attemptId);
    const c = this.corrections.get(correctionId);
    if (c && c.attemptId === a.id && c.status !== "superseded") {
      c.status = "acknowledged";
      c.acknowledgedAt = Date.now();
      c.ackNote = note ? String(note).slice(0, 300) : undefined;
      this.putCorrection(c);
      this.stats.correctionsAcknowledged += 1;
      this.persistStats();
      this.addLog({
        kind: "ack",
        attemptId: a.id,
        agentId: a.agentId,
        intentId: a.intentId,
        message: `${this.callsign(a.id)} acknowledges ${c.id}${note ? `: ${note}` : "."}`,
      });
    }
    return this.clearanceFor(a.id);
  }

  /** Corrections that a later action already followed count as acknowledged. */
  private autoAck(a: T.Attempt): void {
    for (const id of a.corrections) {
      const c = this.corrections.get(id);
      if (c && c.status === "delivered" && c.deliveredAt && Date.now() - c.deliveredAt > 0) {
        // Delivered and the agent continued: keep "delivered" until an explicit ack, but do not resend.
      }
    }
  }

  async brief(attemptId: string | undefined, intentId?: string): Promise<Brief> {
    const a = attemptId ? this.attempts.get(attemptId) : undefined;
    const intent = this.intents.get(a?.intentId ?? intentId ?? "");
    if (!intent) throw new Error("Unknown intent.");
    const main = await this.loadMain();
    const files = a ? (await this.attemptView(a)).files : main.text;
    const context: Record<string, string> = {};
    let budget = 60_000;
    const wanted = new Set([...(intent.scope?.paths ?? []), ...(a?.course.files ?? [])].map(normPath));
    for (const [path, text] of rankForBrief(files, intent, wanted)) {
      if (/(^|\/)tests?\//.test(path) && !intent.checks.some((c) => c.path === path) && !wanted.has(path)) continue;
      if (text.length > 20_000 || budget - text.length < 0) continue;
      context[path] = text;
      budget -= text.length;
    }
    return {
      attemptId: a?.id,
      intent,
      files: [...files.keys()].sort().map((path) => ({ path, size: files.get(path)?.length ?? 0 })),
      context,
      checks: intent.checks.map((c) => ({ path: c.path, description: c.description, content: c.content })),
      constraints: intent.constraints,
      traffic: a ? this.trafficFor(a) : [],
      runner: this.checkSettings(),
    };
  }

  async openIntents(): Promise<{ intents: { id: string; title: string; goal: string; status: T.IntentStatus; attempts: number; checks: string[] }[]; traffic: number }> {
    await this.ensure(this.project?.id ?? "demo");
    const active = [...this.attempts.values()].filter((a) => ACTIVE.has(a.status));
    return {
      intents: [...this.intents.values()]
        .filter((i) => !["landed", "parked", "merged-into"].includes(i.status))
        .map((i) => ({
          id: i.id,
          title: i.title,
          goal: i.goal,
          status: i.status,
          attempts: active.filter((a) => a.intentId === i.id).length,
          checks: i.checks.map((c) => c.path),
        })),
      traffic: active.length,
    };
  }

  /* ════════════════════════════ clearance + traffic ════════════════════════════ */

  private trafficFor(a: T.Attempt): T.TrafficVessel[] {
    const out: T.TrafficVessel[] = [];
    for (const other of this.attempts.values()) {
      if (other.id === a.id || !ACTIVE.has(other.status)) continue;
      const pair = this.radar.get(pairKey(a.id, other.id));
      const range = (pair?.range ?? 5) as T.Range;
      if (range > 3) continue;
      const logs = this.logs.filter((l) => l.attemptId === other.id && (l.kind === "log" || l.kind === "write" || l.kind === "declare"));
      out.push(trafficVessel(other, this.intents.get(other.intentId), this.agents.get(other.agentId), logs, range, pair?.closing ?? false));
    }
    return out.sort((x, y) => x.range - y.range);
  }

  /** Clearance for an agent: deliver pending corrections once (piggyback). */
  private clearanceFor(attemptId: string): T.Clearance {
    const a = this.mustAttempt(attemptId);
    const pending = a.corrections.map((id) => this.corrections.get(id)).filter((c): c is T.Correction => !!c && c.status === "pending");
    const now = Date.now();
    for (const c of pending) {
      c.status = "delivered";
      c.deliveredAt = now;
      this.putCorrection(c);
    }
    const verdict = latestCheck(this.checks, attemptId)?.verdict;
    return clearance(verdict, notices(pending, (id) => this.callsign(id)), this.trafficFor(a));
  }

  /* ════════════════════════════ course check ════════════════════════════ */

  private trafficViews(incoming: T.Attempt, main: MainView, signatures: Map<string, AttemptView>): VesselView[] {
    const seqList = this.db.getMeta<string[]>("mainSeq") ?? [];
    const baseIdx = seqList.indexOf(incoming.baseSha);
    const views: VesselView[] = [];
    for (const other of this.attempts.values()) {
      if (other.id === incoming.id) continue;
      const intent = this.intents.get(other.intentId);
      const agent = this.agents.get(other.agentId);
      if (!intent || !agent) continue;
      let state: VesselView["state"] | undefined;
      if (ACTIVE.has(other.status)) state = WAITING.has(other.status) ? "waiting" : "active";
      else if (other.status === "landed") {
        const landing = this.landings.find((l) => l.attemptId === other.id);
        if (landing && seqList.indexOf(landing.mainAfter) > baseIdx) state = "landed";
      }
      if (!state) continue;
      views.push(vesselView(other, intent, agent, signatures.get(other.id)?.signatures, main.signatures, state));
    }
    return views;
  }

  async courseCheck(attemptId: string, trigger: T.CourseCheck["trigger"]): Promise<T.CourseCheck | undefined> {
    const a = this.attempts.get(attemptId);
    if (!a || !ACTIVE.has(a.status)) return undefined;
    const p = this.requireProject();
    const main = await this.loadMain();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    const t0 = Date.now();

    const views = new Map<string, AttemptView>();
    views.set(a.id, await this.attemptView(a));
    for (const other of this.attempts.values()) {
      if (other.id !== a.id && (ACTIVE.has(other.status) || other.status === "landed")) {
        try {
          views.set(other.id, await this.attemptView(other));
        } catch {
          /* a fork may still be on its way */
        }
      }
    }
    const incoming = vesselView(a, intent, agent, views.get(a.id)?.signatures, main.signatures, WAITING.has(a.status) ? "waiting" : "active");
    const traffic = this.trafficViews(a, main, views);
    const previous = new Map<string, T.Range>();
    for (const v of traffic) {
      const pr = this.radar.get(pairKey(a.id, v.attempt.id));
      if (pr) previous.set(v.attempt.id, pr.range);
    }
    const cands = selectCandidates(incoming, traffic, main.graph, 3, previous).map((c) => ({
      view: c.view,
      facts: buildPairFacts(incoming, c.view, main.graph, previous.get(c.view.attempt.id)),
    }));

    let source: T.CourseCheck["source"] = "rules";
    let assessments: T.CourseAssessment[] = [];
    let confidence = 1;
    let duplicate = 0;
    let raw: Record<string, unknown> | undefined;

    if (cands.length) {
      const rules = assessWithRules(incoming, cands);
      const model = p.settings.decisionModel;
      if (model !== "rules") {
        const first = await callClef(this.env.AI as never, buildBriefClefRequest("clef-flash", incoming, cands));
        if (first) {
          let parsed = parseClefResponse(first.res, incoming, cands);
          let used = first;
          raw = { clef: first.res.answers, model: first.model, latencyMs: first.latencyMs, missing: parsed.missing };
          // Escalate to the 27B model only for ambiguous pairs: no hard facts, close range, a coin-flip answer.
          const ambiguous = cands.some((c) => {
            const as = parsed.assessments.find((x) => x.otherAttemptId === c.view.attempt.id);
            return as && !hardFacts(c.facts) && c.facts.range <= 2 && as.collision >= 0.35 && as.collision <= 0.65;
          });
          if (ambiguous) {
            const second = await callClef(this.env.AI as never, buildBriefClefRequest("clef", incoming, cands), 6000);
            if (second) {
              raw = { ...raw, escalatedFrom: { source: "clef-flash", confidence: decisiveness(parsed.assessments), latencyMs: first.latencyMs }, clef27b: second.res.answers };
              parsed = parseClefResponse(second.res, incoming, cands);
              used = second;
            }
          }
          source = used.model;
          // Facts are facts: hard evidence sets a floor, absence of evidence sets a ceiling. Clef judges the rest.
          assessments = parsed.assessments.map((as) => {
            const facts = cands.find((c) => c.view.attempt.id === as.otherAttemptId)?.facts;
            const r = rules.assessments.find((x) => x.otherAttemptId === as.otherAttemptId);
            return facts && r ? anchor(as, r, facts) : as;
          });
          confidence = Math.min(...cands.map((c) => {
            const as = assessments.find((x) => x.otherAttemptId === c.view.attempt.id);
            if (!as) return 1;
            return hardFacts(c.facts) ? 0.9 : Math.max(0.3, Math.abs(as.collision - 0.5) * 2);
          }));
          const maxSim = Math.max(0, ...cands.map((c) => c.facts.intentSimilarity));
          const clefDup = parsed.duplicate >= 0.7 && maxSim >= 0.2 ? parsed.duplicate : Math.min(parsed.duplicate, 0.5);
          duplicate = Math.max(clefDup, rules.duplicate >= 0.8 ? rules.duplicate : 0);
          if (duplicate < p.settings.thresholds.duplicate) {
            for (const as of assessments) as.duplicate = Math.min(as.duplicate, duplicate);
          }
        }
      }
      if (!assessments.length) {
        source = "rules";
        assessments = rules.assessments;
        confidence = rules.confidence;
        duplicate = rules.duplicate;
      }
    }

    const outcome = decide(
      assessments,
      cands.map((c) => c.facts),
      p.settings.thresholds,
      duplicate,
      cands.length ? confidence : 1,
    );
    const latencyMs = Date.now() - t0;
    const check: T.CourseCheck = {
      id: newId("cc"),
      attemptId: a.id,
      trigger,
      verdict: cands.length ? outcome.verdict : "clear",
      assessments,
      facts: cands.map((c) => c.facts),
      source,
      confidence: cands.length ? outcome.confidence : 1,
      latencyMs,
      at: Date.now(),
      raw,
    };
    this.checks.push(check);
    if (this.checks.length > MAX_CHECKS) this.checks.splice(0, this.checks.length - MAX_CHECKS);
    this.db.putCheck(check);
    this.emit({ type: "check", check });

    // Radar: record range and closing for each pair.
    const pairs: T.RadarPair[] = [];
    for (const c of cands) {
      const pair: T.RadarPair = {
        a: a.id,
        b: c.view.attempt.id,
        range: c.facts.range,
        closing: c.facts.closing,
        verdict: check.verdict,
        updatedAt: Date.now(),
      };
      this.radar.set(pairKey(pair.a, pair.b), pair);
      this.db.putRadar(...sortPair(pair.a, pair.b), pair);
      pairs.push(pair);
    }
    if (pairs.length) this.emit({ type: "radar", pairs });

    this.stats.courseChecks += 1;
    if (check.verdict === "clear") this.stats.clear += 1;
    if (check.verdict === "escalate") this.stats.escalations += 1;
    this.checkLatencies.push(latencyMs);
    if (this.checkLatencies.length > 400) this.checkLatencies.splice(0, 200);

    const closest = cands.length ? Math.min(...cands.map((c) => c.facts.range)) : 5;
    const closing = cands.filter((c) => c.facts.closing).map((c) => this.callsign(c.view.attempt.id));
    this.addLog({
      kind: "check",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message:
        `Course check (${trigger}): ${check.verdict}. ` +
        (cands.length ? `${cands.length} vessel${cands.length > 1 ? "s" : ""} in range, closest R${closest}` : "Open water") +
        (closing.length ? `, closing with ${closing.join(", ")}` : "") +
        ` · ${source} ${latencyMs} ms`,
      data: { checkId: check.id, source, latencyMs },
    });

    if (check.verdict === "correct" || check.verdict === "escalate") {
      for (const c of outcome.corrections) {
        const other = cands.find((x) => x.view.attempt.id === c.otherAttemptId);
        if (!other) continue;
        const giveWayView = c.giveWay === "incoming" ? incoming : other.view;
        const standOnView = c.giveWay === "incoming" ? other.view : incoming;
        if (giveWayView.state === "landed") continue;
        if (check.verdict === "escalate") continue; // a human decides first
        const drafted = draftCorrection(giveWayView, standOnView, c.facts, c.rule, c.giveWay);
        this.issueCorrection(giveWayView.attempt.id, standOnView.attempt.id, drafted, c.rule, check.id, severityOf(c.facts));
      }
    } else if (check.verdict === "merge-intents" && outcome.duplicateOf) {
      const other = cands.find((x) => x.view.attempt.id === outcome.duplicateOf);
      if (other) {
        const drafted = draftDuplicateCorrection(incoming, other.view);
        this.issueCorrection(a.id, other.view.attempt.id, drafted, "R4-first-declared-stands-on", check.id, 100);
      }
    }
    this.persistStats();
    return check;
  }

  private issueCorrection(
    attemptId: string,
    standOnAttemptId: string | undefined,
    drafted: { kind: T.CorrectionKind; message: string; constraints: T.Correction["constraints"] },
    rule: T.RuleOfTheRoad | "human",
    checkId: string,
    severity = 50,
  ): T.Correction | undefined {
    const target = this.attempts.get(attemptId);
    if (!target || !ACTIVE.has(target.status)) return undefined;
    // One live correction per (vessel, stand-on vessel, kind). Refresh it in place; send a new one
    // only when the situation gets worse (closer range, more overlapping lines, a new interface).
    for (const id of target.corrections) {
      const old = this.corrections.get(id);
      if (!old || old.standOnAttemptId !== standOnAttemptId || old.kind !== drafted.kind || old.status === "superseded") continue;
      if (old.message === drafted.message) return undefined;
      if (old.status === "pending") {
        old.message = drafted.message;
        old.constraints = drafted.constraints;
        old.severity = Math.max(old.severity ?? 0, severity);
        old.checkId = checkId;
        this.putCorrection(old);
        return old;
      }
      if (severity <= (old.severity ?? 50)) {
        old.refreshes = (old.refreshes ?? 0) + 1;
        this.corrections.set(old.id, old);
        this.db.putCorrection(old);
        return undefined;
      }
      old.status = "superseded";
      this.putCorrection(old);
    }
    const corr: T.Correction = {
      id: newId("cr"),
      attemptId,
      standOnAttemptId,
      kind: drafted.kind,
      rule,
      message: drafted.message,
      constraints: drafted.constraints,
      checkId,
      status: "pending",
      severity,
      createdAt: Date.now(),
    };
    target.corrections = [...target.corrections, corr.id];
    this.putAttempt(target);
    this.putCorrection(corr);
    this.stats.corrections += 1;

    // An interface change binds every attempt of the intent: amend the living spec with the new signature.
    if (drafted.kind === "interface" && drafted.constraints.useSignatures?.length) {
      const intent = this.intents.get(target.intentId);
      const lines = drafted.constraints.useSignatures.map((s) => `Use ${s.signature} (${s.symbol.split("#")[0]}).`);
      if (intent && lines.some((l) => !intent.constraints.includes(l))) {
        intent.constraints = [...new Set([...intent.constraints, ...lines])];
        intent.version += 1;
        intent.amendments = [
          ...intent.amendments,
          {
            version: intent.version,
            at: Date.now(),
            by: SYSTEM,
            reason: `Correction ${corr.id} (${drafted.kind}, ${rule.split("-")[0]}) for ${this.callsign(attemptId)}`,
            text: lines.join(" "),
          },
        ];
        this.putIntent(intent);
      }
    }
    this.addLog({
      kind: "correction",
      attemptId,
      agentId: target.agentId,
      intentId: target.intentId,
      // The radio log keeps the sentences; the earlier diffs stay on the correction itself.
      message: `Correction for ${this.callsign(attemptId)} · ${drafted.kind} · ${rule === "human" ? "human" : rule.split("-")[0]}${standOnAttemptId ? ` · ${this.callsign(standOnAttemptId)} stands on` : ""}: ${drafted.message.split("\n\n")[0]}`,
      files: [...new Set([...(drafted.constraints.avoidRegions ?? []).map((r) => r.path), ...(drafted.constraints.reapply ?? []).map((r) => r.path)])],
      data: { correctionId: corr.id },
    });
    this.webhook("correction", { correction: corr, callsign: this.callsign(attemptId) });
    return corr;
  }

  /** A newly created intent that duplicates traffic joins the existing intent. */
  private async mergeDuplicate(a: T.Attempt, newIntent: T.Intent, check: T.CourseCheck): Promise<T.CourseCheck> {
    const dupCorr = a.corrections.map((id) => this.corrections.get(id)).find((c) => c?.kind === "duplicate");
    const other = dupCorr?.standOnAttemptId ? this.attempts.get(dupCorr.standOnAttemptId) : undefined;
    const target = other ? this.intents.get(other.intentId) : undefined;
    if (!target || target.id === newIntent.id) return check;
    newIntent.status = "merged-into";
    newIntent.mergedInto = target.id;
    this.putIntent(newIntent);
    a.intentId = target.id;
    for (const c of target.checks) this.db.writeWorktree(a.id, c.path, c.content);
    this.bump(a.id);
    this.putAttempt(a);
    const msg =
      `Your intent "${newIntent.title}" duplicates "${target.title}". Bearing joins your attempt to that intent. ` +
      `Follow its goal and checks. Your work is compared with the other attempts. Continue your work.`;
    if (dupCorr) {
      dupCorr.message = msg;
      this.putCorrection(dupCorr);
    }
    this.addLog({ kind: "intent", intentId: target.id, attemptId: a.id, message: `"${newIntent.title}" merges into "${target.title}". ${this.callsign(a.id)} becomes another attempt on it.` });
    await this.refreshFootprint(a);
    return (await this.courseCheck(a.id, "declare")) ?? check;
  }

  /* ════════════════════════════ checks (Dynamic Workers) ════════════════════════════ */

  private testPaths(files: Map<string, string>): string[] {
    return [...files.keys()].filter((p) => /^tests\/.+\.test\.(js|mjs)$/.test(p)).sort();
  }

  /** The project's check runner (absent settings: the Bearing harness in a Dynamic Worker). */
  private checkSettings(): T.CheckSettings {
    return this.requireProject().settings.checks ?? { runner: "worker" };
  }

  /**
   * Run the checks on a tree: the Bearing harness in a Dynamic Worker, or the project's install and
   * test commands in the attempt's check container.
   */
  private async runTreeChecks(files: Map<string, string>, scope: T.CheckRun["scope"], attemptId: string): Promise<T.CheckRun> {
    const cs = this.checkSettings();
    const key = await contentKey(files);
    if (cs.runner !== "container") {
      const run = await runChecks(this.env.LOADER, key, { files, testPaths: this.testPaths(files) }, { scope });
      return { ...run, runner: "worker" };
    }
    const t0 = Date.now();
    const p = this.requireProject();
    // Container runs cost money: an hourly budget per project owner and for the deployment.
    const perOwner = Math.max(1, Math.round(Number(this.env.CHECK_RUNS_PER_OWNER_HOUR) || 240));
    const global = Math.max(1, Math.round(Number(this.env.CHECK_RUNS_PER_HOUR) || 2000));
    const budget = await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"))
      .budgetTake(p.ownerId ?? null, 1, perOwner, global, "checks")
      .catch(() => ({ granted: 1, retryAt: 0 }));
    if (!budget.granted) {
      const res: DrydockResult = { ok: false, stage: "start", exitCode: -1, installMs: 0, testMs: 0, reused: false, log: `The hourly budget for check runs is used. Run the checks again after ${clock(budget.retryAt)} UTC.` };
      return containerRun(res, { key, scope, cs, ms: 0 });
    }
    const dock = this.env.DRYDOCK.get(this.env.DRYDOCK.idFromName(`${p.id}:${attemptId}`));
    let res: DrydockResult;
    try {
      res = (await dock.run({ tree: await packTree(files), install: cs.install, test: cs.test, timeoutSec: cs.timeoutSec ?? 600 })) as DrydockResult;
    } catch (e) {
      res = { ok: false, stage: "start", exitCode: -1, installMs: 0, testMs: 0, reused: false, log: `The check container did not answer: ${String((e as Error)?.message ?? e)}` };
    }
    return containerRun(res, { key, scope, cs, ms: Date.now() - t0 });
  }

  async check(attemptId: string): Promise<T.CheckRun> {
    const a = this.mustAttempt(attemptId);
    const view = await this.attemptView(a);
    const run = await this.runTreeChecks(view.files, "attempt", a.id);
    a.checks = run;
    this.putAttempt(a);
    this.addLog({
      kind: "check",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${this.callsign(a.id)} checks: ${run.passed}/${run.passed + run.failed} pass${run.error ? ` (${run.error.slice(0, 120)})` : ""}.`,
      data: { checkRunId: run.id, ok: run.ok },
    });
    return run;
  }

  /* ════════════════════════════ submit + landing ════════════════════════════ */

  async submit(attemptId: string, summary?: string): Promise<T.SubmitResult> {
    const a = this.mustAttempt(attemptId);
    if (TERMINAL.has(a.status)) {
      return { attemptId, status: a.status, next: a.status === "landed" ? "landed" : "fix-checks", message: `The attempt is ${a.status}.`, clearance: this.clearanceFor(a.id) };
    }
    a.summary = summary ? String(summary).slice(0, 600) : a.summary;
    a.status = "submitted";
    this.putAttempt(a);
    await this.flushToFork(a).catch((e) => console.warn("flush to fork failed", String(e)));
    const run = await this.check(a.id);
    const intent = this.intents.get(a.intentId)!;
    let next: T.SubmitResult["next"];
    let message: string;
    if (!run.ok) {
      a.status = "underway";
      next = "fix-checks";
      message = `${failureSummary(run.cases)} Fix the code, then submit again.`;
    } else {
      a.status = "ready";
      const siblings = [...this.attempts.values()].filter((x) => x.intentId === a.intentId && x.id !== a.id && ACTIVE.has(x.status));
      // A re-derive of the attempt a human picked keeps that pick: it lands without a second question.
      const picked = this.pickedLineage(a);
      const needPick = !picked && (!this.requireProject().settings.autoLand || siblings.length > 0);
      if (needPick) {
        next = "awaiting-pick";
        message = `All checks pass. ${siblings.length ? `${siblings.length + 1} attempts compete on this intent.` : ""} A human picks the attempt to land.`;
        if (siblings.every((x) => x.status === "ready")) {
          intent.status = "judging";
          this.putIntent(intent);
        }
      } else {
        next = "landing-queue";
        message = "All checks pass. The attempt is in the landing queue.";
        this.enqueueLanding(a);
      }
    }
    this.putAttempt(a);
    this.addLog({
      kind: "submit",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${this.callsign(a.id)} submits "${intent.title}": ${message}`,
    });
    return { attemptId, status: a.status, checks: run, next, message, clearance: this.clearanceFor(a.id) };
  }

  /** API-mode work becomes a real commit in the attempt's Artifacts fork. */
  private async flushToFork(a: T.Attempt): Promise<void> {
    if (a.mode !== "api") return;
    const intent = this.intents.get(a.intentId)!;
    await this.ensureFork(a, intent);
    const overlay = this.db.worktree(a.id);
    if (!overlay.size) return;
    const tip = (await this.backend.resolve(a.fork.repo, this.branch)) ?? a.baseSha;
    const view = await this.attemptView(a);
    const forkTip = tip === a.baseSha ? undefined : await this.backend.readCommit(a.fork.repo, tip);
    const forkFiles = forkTip ? (await this.treeText(a.fork.repo, forkTip.treeHash)).text : (await this.treeText(this.requireProject().repo.name, a.baseTree)).text;
    // All paths: after a re-plot the attempt also carries the main changes since the fork point.
    const changes = changedVersions(forkFiles, view.files, new Set([...forkFiles.keys(), ...view.files.keys()])).map((fv) => ({ path: fv.path, content: fv.head }));
    if (!changes.length) return;
    const agent = this.agents.get(a.agentId);
    const res = await this.backend.commit({
      repo: a.fork.repo,
      branch: this.branch,
      parent: tip,
      changes,
      message: `${intent.title}\n\nWork by ${agent?.callsign ?? a.agentId} (${agent?.model ?? agent?.client ?? "agent"}).\n\nBearing-Intent: ${intent.id}\nBearing-Attempt: ${a.id}\nBearing-Base: ${a.baseSha}`,
      author: { name: agent?.callsign ?? "agent", email: `${(agent?.callsign ?? "agent").toLowerCase()}@agents.bearing.dev` },
    });
    a.headSha = res.sha;
    this.addLog({ kind: "push", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${agent?.callsign} work is in fork ${a.fork.repo} at ${res.sha.slice(0, 7)}.`, files: changes.map((c) => c.path) });
  }

  private enqueueLanding(a: T.Attempt): void {
    this.db.enqueue(a.id, Date.now());
    const job = this.landingChain.then(() => this.processQueue());
    this.landingChain = job.catch((e) => console.error("landing failed", e));
    this.ctx.waitUntil(this.landingChain);
  }

  private async processQueue(): Promise<void> {
    for (const id of this.db.queue()) {
      this.db.dequeue(id);
      const a = this.attempts.get(id);
      if (!a || a.status !== "ready") continue;
      try {
        await this.landOne(a);
      } catch (err) {
        console.error("landOne", id, err);
        a.status = "ready";
        this.putAttempt(a);
        this.addLog({ kind: "system", attemptId: a.id, message: `Landing of ${this.callsign(a.id)} stopped: ${String(err).slice(0, 200)}. Try again.` });
      }
    }
  }

  private async landOne(a: T.Attempt, attempt = 0): Promise<void> {
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    a.status = "landing";
    intent.status = "landing";
    this.putAttempt(a);
    this.putIntent(intent);
    const main = await this.loadMain();
    const base = await this.treeText(p.repo.name, a.baseTree);
    const view = await this.attemptView(a);
    const attemptSnap: Snapshot = await snapshotFromText(base.snapshot, view);
    const result = await compose({
      base: base.snapshot,
      main: main.snapshot,
      attempt: attemptSnap,
      readText: async (sha) => {
        const fromBase = findText(sha, [base, main]);
        if (fromBase !== undefined) return fromBase;
        const fromView = view.changed.find((c) => c.head !== null && attemptSnap.get(c.path)?.sha === sha);
        if (fromView) return fromView.head;
        return this.readText(p.repo.name, sha);
      },
    });
    if (!result.clean) {
      await this.markStale(a, `${result.conflicts.length} conflict${result.conflicts.length > 1 ? "s" : ""} on the new main: ${result.conflicts.map((c) => `${c.path} (${c.reason})`).join(", ")}`);
      return;
    }
    // Composed tree = main + changes (+ the intent file).
    const composed = new Map(main.text);
    for (const ch of result.changes) {
      if (ch.content === null) composed.delete(ch.path);
      else composed.set(ch.path, typeof ch.content === "string" ? ch.content : utf8.decode(ch.content));
    }
    const run = await this.runTreeChecks(composed, "composed", a.id);
    a.composedChecks = run;
    this.putAttempt(a);
    if (!run.ok) {
      await this.markStale(a, `Checks fail when combined with main. ${failureSummary(run.cases, 3)}`);
      return;
    }
    const method: T.LandingMethod = a.lineage.generation > 1 ? "rederive" : result.method;
    const applied = a.corrections.map((id) => this.corrections.get(id)).filter((c): c is T.Correction => !!c && c.status !== "superseded");
    const courseChecks = this.db.checksFor<T.CourseCheck>(a.id);
    const decision = [...this.decisions].reverse().find((d) => d.attemptIds[0] === a.id && d.kind === "pick");
    const changes = [...result.changes];
    if (p.settings.intentsInRepo) {
      const f = intentFile({ ...intent, status: "landed" }, { attemptId: a.id, agent, method });
      changes.push({ path: f.path, content: f.content });
    }
    const message = landingMessage({ intent, attempt: a, agent, method, corrections: applied, checks: run });
    const note = landingNote({ intent, attempt: a, agent, method, corrections: applied, courseChecks, checks: run, decision });
    let committed: { sha: string; tree: string };
    try {
      committed = await this.backend.commit({ repo: p.repo.name, branch: this.branch, parent: main.sha, changes, message, note, author: BEARING_AUTHOR });
    } catch (err) {
      if (err instanceof RepoConflictError || String(err).includes("RepoConflict")) {
        if (attempt < 2) return this.landOne(a, attempt + 1);
      }
      throw err;
    }
    const before = p.mainSha;
    p.mainSha = committed.sha;
    p.mainTree = committed.tree;
    this.db.setMeta("project", p);
    this.db.setMeta("mainSeq", [...(this.db.getMeta<string[]>("mainSeq") ?? []), committed.sha]);
    const landing: T.Landing = {
      id: newId("ld"),
      attemptId: a.id,
      intentId: intent.id,
      agentId: a.agentId,
      method,
      mainBefore: before,
      mainAfter: committed.sha,
      checks: run,
      correctionsApplied: applied.length,
      at: Date.now(),
      message,
    };
    this.landings.push(landing);
    this.db.putLanding(landing, note);
    a.status = "landed";
    a.landedAt = Date.now();
    intent.status = "landed";
    intent.landedSha = committed.sha;
    intent.chosenAttemptId = a.id;
    this.putAttempt(a);
    this.putIntent(intent);
    agent.status = "idle";
    agent.attemptId = undefined;
    this.putAgent(agent);
    // Siblings stay visible as alternates (the road not taken).
    for (const s of this.attempts.values()) {
      if (s.intentId === intent.id && s.id !== a.id && !TERMINAL.has(s.status)) {
        s.status = "alternate";
        this.putAttempt(s);
        this.stopVessel(s.id).catch(() => {});
      }
    }
    for (const c of applied) {
      if (c.status === "pending" || c.status === "delivered") {
        c.status = "acknowledged";
        c.acknowledgedAt = Date.now();
        this.putCorrection(c);
      }
    }
    this.stats.landings += 1;
    this.stats.landedByMethod[method] = (this.stats.landedByMethod[method] ?? 0) + 1;
    if (method === "rederive") this.stats.rederives += 0; // counted when the re-derive starts
    const newMain = await this.loadMain();
    this.emit({ type: "landing", landing });
    this.emit({ type: "main", sha: newMain.sha, tree: newMain.tree, files: newMain.files, imports: newMain.imports });
    this.addLog({
      kind: "land",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: intent.id,
      message: `"${intent.title}" lands on main by ${method} (${committed.sha.slice(0, 7)}). Checks ${run.passed}/${run.passed + run.failed} pass. Human merge fixes: 0.`,
      files: result.touched,
    });
    this.persistStats();
    this.webhook("landing", { landing, intent: { id: intent.id, title: intent.title }, callsign: agent.callsign, mainSha: committed.sha });
    await this.upstreamCorrections(a, newMain);
  }

  /** Tell vessels near the landed change that main moved under them. */
  private async upstreamCorrections(landed: T.Attempt, main: MainView): Promise<void> {
    const intent = this.intents.get(landed.intentId)!;
    const landedView = await this.attemptView(landed);
    const landedShape = shapeFromFootprint(landed.footprint, landedView.signatures);
    const sigChanges = Object.entries(landedView.signatures)
      .filter(([, s]) => s.before && s.after && s.before !== s.after)
      .map(([symbol, s]) => ({ symbol, signature: s.after! }));
    const landedInfo = { intentTitle: intent.title, files: Object.keys(landed.footprint.files), signatureChanges: sigChanges };
    const quiet: string[] = [];
    for (const other of this.attempts.values()) {
      if (other.id === landed.id || !ACTIVE.has(other.status) || other.status === "landing") continue;
      const oIntent = this.intents.get(other.intentId);
      const oAgent = this.agents.get(other.agentId);
      if (!oIntent || !oAgent) continue;
      // Re-plot: move API-mode work onto the new main now, while the agent works, not at landing time.
      const moved = await this.replot(other, main).catch((e) => {
        console.warn("replot failed", other.id, String(e));
        return undefined;
      });
      const v = vesselView(other, oIntent, oAgent, (await this.attemptView(other)).signatures, main.signatures, WAITING.has(other.status) ? "waiting" : "active");
      if (moved && (moved.merged.length || moved.reapply.length)) {
        const drafted = draftReplotCorrection(v, landedInfo, { mainSha: main.sha, merged: moved.merged, reapply: moved.reapply });
        this.issueCorrection(other.id, landed.id, drafted, "R1-landed-has-way", "landing", moved.reapply.length ? 90 : 70);
        continue;
      }
      if (moved) quiet.push(oAgent.callsign);
      const range = computeRange(v.shape, landedShape, main.graph);
      if (range > 2) continue;
      const drafted = draftUpstreamCorrection(v, landedInfo);
      this.issueCorrection(other.id, landed.id, drafted, "R1-landed-has-way", "landing");
    }
    if (quiet.length) {
      this.addLog({
        kind: "replot",
        message: `Bearing moves the work of ${quiet.join(", ")} onto main ${main.sha.slice(0, 7)}. Their files do not overlap the landed change.`,
      });
    }
  }

  /**
   * Move an API-mode attempt onto the new main (3-way, per file). Clean files carry both changes.
   * A file where the changes overlap goes back to the main version, and the agent makes its change
   * again (only while it works; an attempt that waits to land moves only when all files merge).
   * Git-mode attempts keep their base: the landing ladder merges them.
   */
  private async replot(a: T.Attempt, main: MainView): Promise<{ merged: string[]; reapply: { path: string; diff: string }[] } | undefined> {
    if (a.mode !== "api" || a.baseSha === main.sha) return undefined;
    const working = a.status === "declared" || a.status === "underway" || a.status === "rederiving";
    if (!working && a.status !== "ready") return undefined;
    const p = this.requireProject();
    const base = await this.treeText(p.repo.name, a.baseTree);
    const view = await this.attemptView(a);
    const attemptSnap: Snapshot = await snapshotFromText(base.snapshot, view);
    const result = await compose({
      base: base.snapshot,
      main: main.snapshot,
      attempt: attemptSnap,
      readText: async (sha) => {
        const known = findText(sha, [base, main]);
        if (known !== undefined) return known;
        const fromView = view.changed.find((c) => c.head !== null && attemptSnap.get(c.path)?.sha === sha);
        if (fromView) return fromView.head;
        return this.readText(p.repo.name, sha);
      },
    });
    if (result.changes.some((c) => c.content !== null && typeof c.content !== "string")) return undefined; // binary: leave it to the landing ladder
    const conflicts = new Set(result.conflicts.map((c) => c.path));
    if (conflicts.size && !working) {
      // A waiting attempt does not move. Show the human why its landing will re-derive.
      a.drift = { mainSha: main.sha, overlaps: [...conflicts] };
      this.putAttempt(a);
      return undefined;
    }
    a.drift = undefined;
    const mainMoved = (path: string) => (base.snapshot.get(path)?.sha ?? null) !== (main.snapshot.get(path)?.sha ?? null);
    const merged = result.touched.filter((path) => !conflicts.has(path) && mainMoved(path) && main.snapshot.has(path));
    const reapply = [...conflicts].map((path) => {
      const c = view.changed.find((x) => x.path === path);
      const diff = unifiedDiff(path, c?.base ?? null, c?.head ?? null);
      return { path, diff: diff.length > 3500 ? `${diff.slice(0, 3500)}\n… (diff cut)` : diff };
    });
    // The agent's copies: remember what it could know (null = it saw no file), so a later write from
    // that copy merges with the landed change, or is refused when it would remove it.
    for (const path of new Set([...result.touched, ...[...main.snapshot.keys(), ...base.snapshot.keys()].filter(mainMoved)])) {
      if (this.db.seen(a.id, path) === undefined) this.db.setSeen(a.id, path, view.files.get(path) ?? null);
    }
    // Files that go back to the main version: the agent reads them before it writes them again.
    for (const path of conflicts) this.db.setMustRead(a.id, path, true);
    this.db.clearWorktree(a.id);
    for (const ch of result.changes) this.db.writeWorktree(a.id, ch.path, ch.content === null ? null : (ch.content as string));
    const from = a.baseSha;
    a.baseSha = main.sha;
    a.baseTree = main.tree;
    this.attemptViews.delete(a.id);
    await this.refreshFootprint(a);
    this.putAttempt(a);
    this.stats.replots = (this.stats.replots ?? 0) + 1;
    const callsign = this.callsign(a.id);
    if (merged.length || reapply.length) {
      this.addLog({
        kind: "replot",
        attemptId: a.id,
        agentId: a.agentId,
        intentId: a.intentId,
        message:
          `Bearing moves ${callsign}'s work from ${from.slice(0, 7)} onto main ${main.sha.slice(0, 7)}.` +
          (merged.length ? ` Merged: ${merged.join(", ")}.` : "") +
          (reapply.length ? ` ${callsign} makes the change to ${reapply.map((r) => r.path).join(", ")} again.` : ""),
        files: result.touched,
      });
    }
    return { merged, reapply };
  }

  private async markStale(a: T.Attempt, reason: string): Promise<void> {
    a.status = "stale";
    this.putAttempt(a);
    const intent = this.intents.get(a.intentId)!;
    intent.status = "underway";
    this.putIntent(intent);
    this.addLog({ kind: "stale", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${this.callsign(a.id)} cannot land: ${reason} Bearing re-derives the intent on the new main.` });
    if (a.lineage.generation >= 3) {
      this.stats.escalations += 1;
      this.persistStats();
      this.addLog({ kind: "decision", attemptId: a.id, intentId: a.intentId, message: `Two re-derives failed for "${intent.title}". A human must decide.` });
      intent.status = "judging";
      this.putIntent(intent);
      return;
    }
    await this.rederive(a.id, reason, SYSTEM);
  }

  /* ════════════════════════════ human + system actions ════════════════════════════ */

  async createIntent(
    input: { title: string; goal: string; checks?: { path: string; content: string; description?: string }[]; priority?: "normal" | "high"; source?: T.Intent["source"] },
    by: T.Actor = HUMAN,
  ): Promise<T.Intent> {
    await this.ensure(this.project?.id ?? "demo");
    const now = Date.now();
    const intent: T.Intent = {
      id: newId("i"),
      title: String(input.title).slice(0, 140),
      goal: String(input.goal ?? "").slice(0, 4000),
      constraints: [],
      checks: (input.checks ?? [])
        .filter((c) => c && c.path && c.content)
        .map((c, i) => ({ id: `chk_${i}`, path: normPath(c.path), content: c.content, description: c.description ?? "" })),
      priority: input.priority ?? "normal",
      status: "open",
      version: 1,
      amendments: [],
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      source: input.source ?? { kind: "ui" },
    };
    this.putIntent(intent);
    this.addLog({ kind: "intent", intentId: intent.id, message: `${by.name} opens intent "${intent.title}"${intent.source.kind !== "ui" ? ` (from ${intent.source.kind}${intent.source.ref ? ` ${intent.source.ref}` : ""})` : ""}.` });
    this.webhook("intent", { intent: { id: intent.id, title: intent.title } });
    return intent;
  }

  async amendIntent(id: string, patch: { goal?: string; constraints?: string[]; reason: string }, by: T.Actor = HUMAN): Promise<T.Intent> {
    const intent = this.intents.get(id);
    if (!intent) throw new Error("Unknown intent.");
    const parts: string[] = [];
    if (patch.goal && patch.goal !== intent.goal) {
      intent.goal = patch.goal;
      parts.push(patch.goal);
    }
    if (patch.constraints) {
      const added = patch.constraints.filter((c) => !intent.constraints.includes(c));
      intent.constraints = [...patch.constraints];
      parts.push(...added);
    }
    if (!parts.length) return intent;
    intent.version += 1;
    const amendment: T.Amendment = { version: intent.version, at: Date.now(), by, reason: patch.reason || "Amended", text: parts.join(" ") };
    intent.amendments = [...intent.amendments, amendment];
    this.putIntent(intent);
    this.addLog({ kind: "intent", intentId: id, message: `${by.name} amends "${intent.title}" to v${intent.version}: ${patch.reason || "no reason given"}.` });
    // Every vessel on this intent gets the change as a correction.
    const main = await this.loadMain();
    for (const a of this.attempts.values()) {
      if (a.intentId !== id || !ACTIVE.has(a.status)) continue;
      const agent = this.agents.get(a.agentId)!;
      const v = vesselView(a, intent, agent, (await this.attemptView(a)).signatures, main.signatures, "active");
      this.issueCorrection(a.id, undefined, draftIntentAmendedCorrection(v, amendment), "human", "amend");
    }
    this.recordDecision({ kind: "amend", intentId: id, attemptIds: [], by, rationale: patch.reason || "Amended" });
    return intent;
  }

  async launch(intentId: string, input: LaunchInput = {}, by: T.Actor = HUMAN): Promise<{ attempts: T.Attempt[]; waiting: number }> {
    const p = this.requireProject();
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error("Unknown intent.");
    if (["landed", "parked", "merged-into"].includes(intent.status)) throw new Error(`Intent "${intent.title}" is ${intent.status}.`);
    const main = await this.loadMain();
    const fanout = Math.max(1, Math.min(4, Math.round(Number(input.fanout ?? intent.suggestedFanout ?? p.settings.fanout) || 1)));
    const ok = this.allowedModels();
    const asked = (input.models ?? []).filter((m) => typeof m === "string" && ok(m));
    const models = asked.length ? asked : p.settings.agentModels.filter(ok);
    if (!models.length) throw new Error("No agent model is set for this project. Add one in the settings.");
    const budget = await this.takeLlmBudget(fanout, by);
    const created: T.Attempt[] = [];
    const first = asked.length ? 0 : this.agents.size;
    for (let i = 0; i < fanout; i++) {
      const model = models[(first + i) % models.length];
      const agent = this.upsertAgent({ kind: "builtin", model });
      const id = newId("a");
      const now = Date.now();
      const a: T.Attempt = {
        id,
        intentId,
        agentId: agent.id,
        fork: { repo: repoSafe(`${p.repo.name}-${id}`) },
        mode: "api",
        baseSha: main.sha,
        baseTree: main.tree,
        status: "declared",
        course: { plan: ["Read the intent and the code", "Plan the change"], files: [], symbols: [], approach: "Planning", declaredAt: now },
        footprint: emptyFootprint(),
        corrections: [],
        lineage: { generation: 1 },
        stats: { filesChanged: 0, additions: 0, deletions: 0, steps: 0 },
        createdAt: now,
        updatedAt: now,
        waitsForBudget: i < budget.granted ? undefined : budget.retryAt,
      };
      this.putAttempt(a);
      agent.status = a.waitsForBudget ? "waiting" : "underway";
      agent.attemptId = id;
      this.putAgent(agent);
      created.push(a);
      if (!a.waitsForBudget) await this.startVessel(a, agent);
    }
    const waiting = created.filter((a) => a.waitsForBudget).length;
    if (waiting) await this.scheduleBudgetRetry(budget.retryAt);
    if (intent.status === "open" || intent.status === "draft") {
      intent.status = "underway";
      this.putIntent(intent);
    }
    const names = created.map((c) => this.agents.get(c.agentId)?.model).join(", ");
    this.addLog({
      kind: "intent",
      intentId,
      message: `${by.name} launches ${fanout} built-in agent${fanout > 1 ? "s" : ""} on "${intent.title}" (${names}).${waiting ? ` ${waiting} ${waiting === 1 ? "waits" : "wait"} for the hourly AI budget and ${waiting === 1 ? "starts" : "start"} at ${clock(budget.retryAt)} UTC.` : ""}`,
    });
    return { attempts: created, waiting };
  }

  /** Launch built-in agents on every open intent (each with its suggested fan-out). */
  async launchAll(by: T.Actor = HUMAN): Promise<{ intents: number; launched: number; queued: number }> {
    this.requireProject();
    const open = [...this.intents.values()].filter((i) => i.status === "open").sort((a, b) => a.createdAt - b.createdAt);
    let launched = 0;
    let queued = 0;
    for (const intent of open) {
      const res = await this.launch(intent.id, {}, by);
      launched += res.attempts.length - res.waiting;
      queued += res.waiting;
    }
    return { intents: open.length, launched, queued };
  }

  /**
   * Guardrail for AI spend: built-in agent starts per hour, per person (AI_AGENTS_PER_USER_HOUR) and for
   * the whole deployment (AI_AGENTS_PER_HOUR). Over the budget, an agent waits and starts when a slot frees.
   * Bearing never fakes the work.
   */
  private async takeLlmBudget(n: number, by?: T.Actor): Promise<{ granted: number; retryAt: number }> {
    const global = Math.max(1, Math.round(Number(this.env.AI_AGENTS_PER_HOUR) || LLM_STARTS_PER_HOUR));
    const perUser = Math.max(1, Math.round(Number(this.env.AI_AGENTS_PER_USER_HOUR) || LLM_STARTS_PER_USER_HOUR));
    const charge = by?.kind === "human" ? by.id : (this.project?.ownerId ?? null);
    const res = await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"))
      .budgetTake(charge, n, perUser, global)
      .catch(() => ({ granted: 0, retryAt: Date.now() + 60_000 }));
    if (res.granted < n) {
      this.addLog({ kind: "system", message: `The AI agent budget for this hour is used. ${n - res.granted} agent${n - res.granted === 1 ? "" : "s"} start at ${clock(res.retryAt)} UTC.` });
    }
    return res;
  }

  private async scheduleBudgetRetry(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, at));
  }

  /** Alarm: finish an import, then start the built-in agents that waited for the AI budget. */
  async alarm(): Promise<void> {
    if (!this.project) return;
    if (this.project.importing) {
      await this.continueImport();
      if (this.project.importing) return;
    }
    const waiting = () => [...this.attempts.values()].filter((a) => a.waitsForBudget && !TERMINAL.has(a.status)).sort((a, b) => a.createdAt - b.createdAt);
    const due = waiting().filter((a) => (a.waitsForBudget ?? 0) <= Date.now());
    if (due.length) {
      const budget = await this.takeLlmBudget(due.length);
      for (let i = 0; i < due.length; i++) {
        const a = due[i];
        const agent = this.agents.get(a.agentId);
        if (i < budget.granted && agent) {
          a.waitsForBudget = undefined;
          this.putAttempt(a);
          agent.status = "underway";
          this.putAgent(agent);
          await this.startVessel(a, agent, a.lineage.rederivedFrom);
          this.addLog({ kind: "system", attemptId: a.id, agentId: agent.id, intentId: a.intentId, message: `${agent.callsign} starts: the AI budget has room again.` });
        } else {
          a.waitsForBudget = budget.retryAt;
          this.putAttempt(a);
        }
      }
    }
    const left = waiting();
    if (left.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...left.map((a) => a.waitsForBudget!))));
  }

  private async startVessel(a: T.Attempt, agent: T.AgentInfo, rederiveOf?: string): Promise<void> {
    const p = this.requireProject();
    const ok = this.allowedModels();
    const model = agent.model && ok(agent.model) ? agent.model : (p.settings.agentModels.find(ok) ?? DEFAULT_SETTINGS.agentModels[0]);
    const stub = this.env.VESSEL.get(this.env.VESSEL.idFromName(`${p.id}:${a.id}`));
    await stub.start({ projectId: p.id, attemptId: a.id, intentId: a.intentId, agentId: agent.id, callsign: agent.callsign, model, rederiveOf });
  }

  private async stopVessel(attemptId: string): Promise<void> {
    const p = this.project;
    if (!p) return;
    const a = this.attempts.get(attemptId);
    const agent = a ? this.agents.get(a.agentId) : undefined;
    if (agent?.kind !== "builtin") return;
    await this.env.VESSEL.get(this.env.VESSEL.idFromName(`${p.id}:${attemptId}`)).stop();
  }

  async park(intentId: string, reason: string, by: T.Actor = HUMAN): Promise<T.Intent> {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error("Unknown intent.");
    intent.status = "parked";
    this.putIntent(intent);
    for (const a of this.attempts.values()) {
      if (a.intentId === intentId && ACTIVE.has(a.status)) {
        a.status = "abandoned";
        this.putAttempt(a);
        this.stopVessel(a.id).catch(() => {});
      }
    }
    this.recordDecision({ kind: "park", intentId, attemptIds: [], by, rationale: reason });
    this.addLog({ kind: "decision", intentId, message: `${by.name} parks "${intent.title}": ${reason || "no reason given"}.` });
    return intent;
  }

  /** Human pick: land this attempt. */
  /** True when a human picked this attempt or the attempt it was re-derived from. */
  private pickedLineage(a: T.Attempt): boolean {
    const latest = [...this.decisions].reverse().find((d) => d.kind === "pick" && d.intentId === a.intentId);
    if (!latest) return false;
    let cur: T.Attempt | undefined = a;
    for (let i = 0; cur && i < 6; i++) {
      if (cur.id === latest.attemptIds[0]) return true;
      cur = cur.lineage.rederivedFrom ? this.attempts.get(cur.lineage.rederivedFrom) : undefined;
    }
    return false;
  }

  async land(attemptId: string, rationale: string, by: T.Actor = HUMAN): Promise<{ status: T.AttemptStatus; message: string; landing?: T.Landing }> {
    const a = this.mustAttempt(attemptId);
    if (a.status === "landed") return { status: a.status, message: "The attempt is already on main." };
    if (TERMINAL.has(a.status)) return { status: a.status, message: `The attempt is ${a.status}. Re-derive it first.` };
    if (!a.checks?.ok) {
      const run = await this.check(a.id);
      if (!run.ok) return { status: a.status, message: `${failureSummary(run.cases)} Bearing cannot land a failed attempt.` };
    }
    this.recordDecision({ kind: "pick", intentId: a.intentId, attemptIds: [a.id], by, rationale });
    a.status = "ready";
    this.putAttempt(a);
    this.enqueueLanding(a);
    await this.landingChain;
    const landing = this.landings.find((l) => l.attemptId === a.id);
    const now = this.attempts.get(a.id)!;
    return {
      status: now.status,
      landing,
      message: landing ? `Landed by ${landing.method} at ${landing.mainAfter.slice(0, 7)}.` : `The attempt did not land (${now.status}). Bearing re-derives it.`,
    };
  }

  async rederive(attemptId: string, reason: string, by: T.Actor = HUMAN): Promise<{ attempt: T.Attempt }> {
    const old = this.mustAttempt(attemptId);
    const p = this.requireProject();
    const main = await this.loadMain();
    if (old.status !== "stale") {
      old.status = "stale";
      this.putAttempt(old);
    }
    const oldAgent = this.agents.get(old.agentId);
    const builtin = oldAgent?.kind === "builtin";
    const agent = builtin ? oldAgent! : this.upsertAgent({ kind: "builtin", model: p.settings.agentModels[0] });
    const budget = await this.takeLlmBudget(1, by);
    const id = newId("a");
    const now = Date.now();
    const a: T.Attempt = {
      id,
      intentId: old.intentId,
      agentId: agent.id,
      fork: { repo: repoSafe(`${p.repo.name}-${id}`) },
      mode: "api",
      baseSha: main.sha,
      baseTree: main.tree,
      status: "rederiving",
      course: { ...old.course, declaredAt: now },
      footprint: emptyFootprint(),
      corrections: [],
      lineage: { generation: old.lineage.generation + 1, rederivedFrom: old.id },
      stats: { filesChanged: 0, additions: 0, deletions: 0, steps: 0 },
      createdAt: now,
      updatedAt: now,
      waitsForBudget: budget.granted ? undefined : budget.retryAt,
    };
    this.putAttempt(a);
    agent.status = a.waitsForBudget ? "waiting" : "underway";
    agent.attemptId = a.id;
    this.putAgent(agent);
    this.stats.rederives += 1;
    this.persistStats();
    if (by.kind === "human") this.recordDecision({ kind: "rederive", intentId: a.intentId, attemptIds: [old.id, a.id], by, rationale: reason });
    this.addLog({ kind: "rederive", attemptId: a.id, agentId: agent.id, intentId: a.intentId, message: `Re-derive "${this.intents.get(a.intentId)?.title}" on main ${main.sha.slice(0, 7)} (generation ${a.lineage.generation}). Reason: ${reason}` });
    if (!builtin && oldAgent) {
      this.issueCorrection(old.id, undefined, { kind: "upstream", message: `Your attempt cannot land on the new main. Bearing re-derives it as ${a.id}. Stop work on ${old.id}.`, constraints: {} }, "R1-landed-has-way", "rederive");
    }
    if (a.waitsForBudget) await this.scheduleBudgetRetry(a.waitsForBudget);
    else await this.startVessel(a, agent, old.id);
    return { attempt: a };
  }

  private recordDecision(d: Omit<T.Decision, "id" | "at">): T.Decision {
    const decision: T.Decision = { id: newId("dc"), at: Date.now(), ...d };
    this.decisions.push(decision);
    this.db.putDecision(decision);
    this.emit({ type: "decision", decision });
    if (d.by.kind === "human") this.webhook("decision", { decision });
    return decision;
  }

  /* ════════════════════════════ read views ════════════════════════════ */

  async attemptDiff(attemptId: string): Promise<{ files: { path: string; status: T.FileChangeStatus; additions: number; deletions: number; diff: string }[] }> {
    const a = this.mustAttempt(attemptId);
    const view = await this.attemptView(a);
    return {
      files: view.changed.map((c) => {
        const d = lineDiff(c.base ?? "", c.head ?? "");
        return {
          path: c.path,
          status: c.base === null ? "A" : c.head === null ? "D" : "M",
          additions: d.additions,
          deletions: d.deletions,
          diff: unifiedDiff(c.path, c.base, c.head),
        };
      }),
    };
  }

  async landingDetail(id: string): Promise<{ landing: T.Landing; note: unknown; diff: Awaited<ReturnType<HarborMaster["attemptDiff"]>> } | null> {
    const landing = this.landings.find((l) => l.id === id);
    if (!landing) return null;
    const noteText = this.db.landingNote(id);
    let note: unknown = noteText;
    try {
      note = noteText ? JSON.parse(noteText) : null;
    } catch {
      /* keep text */
    }
    return { landing, note, diff: await this.attemptDiff(landing.attemptId) };
  }

  async file(ref: string, path: string): Promise<string | null> {
    const p = this.requireProject();
    if (ref === "main" || ref === p.mainSha) return (await this.loadMain()).text.get(normPath(path)) ?? null;
    const a = this.attempts.get(ref);
    if (a) return (await this.attemptView(a)).files.get(normPath(path)) ?? null;
    const commit = await this.backend.readCommit(p.repo.name, ref);
    if (!commit) return null;
    return (await this.treeText(p.repo.name, commit.treeHash)).text.get(normPath(path)) ?? null;
  }

  /** Files for a live preview: "main" or an attempt id. */
  async previewFiles(ref: string): Promise<{ key: string; files: Record<string, string> } | null> {
    await this.ensure(this.project?.id ?? "demo");
    let files: Map<string, string>;
    if (ref === "main") files = (await this.loadMain()).text;
    else {
      const a = this.attempts.get(ref);
      if (!a) return null;
      files = (await this.attemptView(a)).files;
    }
    const js = new Map([...files].filter(([p]) => /\.(m?js)$/.test(p) && !p.startsWith("tests/")));
    return { key: await contentKey(js), files: Object.fromEntries(js) };
  }

  async connectInfo(origin: string): Promise<{ mcpUrl: string; hookUrl: string; gitRemoteExample?: string; projectKeyHint: string; artifacts: { namespace: string; repo: string; remote?: string; backend: string } }> {
    const p = await this.ensure(this.project?.id ?? "demo");
    return {
      mcpUrl: `${origin}/mcp`,
      hookUrl: `${origin}/hooks/claude-code?project=${encodeURIComponent(p.id)}`,
      gitRemoteExample: p.repo.remote ? p.repo.remote.replace(/\/[^/]+\.git$/, `/${p.repo.name}-a_xxxxxx.git`) : undefined,
      projectKeyHint: `Set BEARING_KEY to a personal API key (above). Project id: ${this.project?.id ?? ""}.`,
      artifacts: { namespace: p.repo.namespace, repo: p.repo.name, remote: p.repo.remote, backend: p.repo.backend },
    };
  }

  /* ════════════════════════════ Claude Code hook ════════════════════════════ */

  /**
   * PostToolUse hook from Claude Code. The agent's checkout identifies its attempt by the fork remote
   * (git mode) or by an attempt id the agent wrote into BEARING_ATTEMPT. Returns pending corrections
   * as additional context, so the agent sees them mid-task without a stop.
   */
  async claudeHook(input: {
    cwd?: string;
    session_id?: string;
    tool_name?: string;
    tool_input?: { file_path?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean; edits?: { old_string: string; new_string: string; replace_all?: boolean }[] };
    attemptId?: string;
  }): Promise<{ hookSpecificOutput?: { hookEventName: "PostToolUse"; additionalContext: string } }> {
    let attempt: T.Attempt | undefined = input.attemptId ? this.attempts.get(input.attemptId) : undefined;
    const cwd = input.cwd ? normDir(input.cwd) : undefined;
    if (!attempt && cwd) {
      // The agent's working copy (or a parent of it) was registered at declare time.
      let dir = cwd;
      for (let i = 0; i < 6 && dir && !attempt; i++) {
        const id = this.db.hook(`cwd:${dir}`);
        if (id) attempt = this.attempts.get(id);
        dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      }
    }
    if (!attempt && input.session_id) {
      const id = this.db.hook(`session:${input.session_id}`);
      if (id) attempt = this.attempts.get(id);
    }
    if (!attempt || !ACTIVE.has(attempt.status)) return {};
    if (input.session_id) this.db.setHook(`session:${input.session_id}`, attempt.id);

    const abs = input.tool_input?.file_path;
    if (abs && /^(Write|Edit|MultiEdit)$/.test(input.tool_name ?? "")) {
      const rel = normPath(cwd && abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs.replace(/^.*?\/((src|tests|harness)\/)/, "$1"));
      const view = await this.attemptView(attempt);
      let next: string | undefined;
      if (input.tool_name === "Write" && typeof input.tool_input?.content === "string") next = input.tool_input.content;
      else {
        let cur = view.files.get(rel);
        const edits = input.tool_input?.edits ?? (input.tool_input?.old_string !== undefined ? [{ old_string: input.tool_input.old_string, new_string: input.tool_input.new_string ?? "", replace_all: input.tool_input.replace_all }] : []);
        if (cur !== undefined) {
          for (const e of edits) cur = e.replace_all ? cur.split(e.old_string).join(e.new_string) : cur.replace(e.old_string, e.new_string);
          next = cur;
        }
      }
      let refused: string | undefined;
      if (next !== undefined && attempt.mode === "api" && input.tool_name === "Write") {
        // A full-file write from the agent's own copy: guard it like bearing_write (main may have moved).
        const g = this.guardWrite(attempt, rel, next, view.files.get(rel) ?? null);
        if (g.refused) refused = g.refused;
        else this.db.writeWorktree(attempt.id, rel, g.content);
        this.db.setSeen(attempt.id, rel, next);
      } else if (next !== undefined) this.db.writeWorktree(attempt.id, rel, next);
      if (refused) {
        return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `BEARING: ${refused}` } };
      }
      if (!attempt.course.files.includes(rel)) attempt.course.files = [...attempt.course.files, rel];
      if (attempt.status === "declared") attempt.status = "underway";
      await this.refreshFootprint(attempt);
      this.putAttempt(attempt);
      this.addLog({ kind: "write", attemptId: attempt.id, agentId: attempt.agentId, intentId: attempt.intentId, message: `${this.callsign(attempt.id)} edits ${rel} (Claude Code hook).`, files: [rel] });
      await this.courseCheck(attempt.id, "write");
    }
    const clr = this.clearanceFor(attempt.id);
    if (!clr.corrections.length) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: [
          "BEARING COURSE CORRECTION — apply it in your next edits, then call bearing_ack. Continue your work.",
          ...clr.corrections.map((c) => `- [${c.id}] ${c.message}`),
        ].join("\n"),
      },
    };
  }

  /* ════════════════════════════ settings + webhooks ════════════════════════════ */

  async settings(): Promise<T.ProjectSettings> {
    return this.requireProject().settings;
  }

  async updateSettings(raw: Partial<T.ProjectSettings>): Promise<T.ProjectSettings> {
    const p = this.requireProject();
    const patch = sanitizeSettings(raw, this.allowedModels());
    p.settings = { ...p.settings, ...patch, thresholds: { ...p.settings.thresholds, ...(patch.thresholds ?? {}) } };
    this.db.setMeta("project", p);
    this.addLog({ kind: "system", message: `Settings change: ${Object.keys(patch).join(", ")}.` });
    return p.settings;
  }

  /** Agent models a settings change or a launch can choose: the operator's list (AGENT_MODELS) and the defaults. */
  private allowedModels(): (m: string) => boolean {
    const ok = new Set([...(this.env.AGENT_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean), ...DEFAULT_SETTINGS.agentModels]);
    return (m) => ok.has(m);
  }

  private webhook(event: string, payload: Record<string, unknown>): void {
    const targets = this.project?.settings.webhooks.filter((w) => w.enabled && (w.events as string[]).includes(event)) ?? [];
    for (const w of targets) {
      const body =
        w.format === "slack"
          ? { text: slackText(event, payload) }
          : { event, project: this.project?.id, at: new Date().toISOString(), ...payload };
      this.ctx.waitUntil(
        fetch(w.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          .then(() => undefined)
          .catch((e) => console.warn("webhook failed", w.url, String(e))),
      );
    }
  }

  /* ════════════════════════════ scale simulation (Sector shards) ════════════════════════════ */

  private simRun?: { id: string; stop: boolean };

  async simStart(input: { agents?: number; sectors?: number; coordinate?: boolean; seconds?: number }): Promise<T.SimStats> {
    await this.ensure(this.project?.id ?? "demo");
    if (this.simRun) this.simRun.stop = true;
    const run = { id: newId("sim"), stop: false };
    this.simRun = run;
    const agents = Math.max(10, Math.min(100_000, Math.round(input.agents ?? 10_000)));
    const sectors = Math.max(1, Math.min(64, Math.round(input.sectors ?? 16)));
    const coordinate = input.coordinate ?? true;
    const seconds = Math.max(10, Math.min(600, input.seconds ?? 180));
    const perSector = Math.ceil(agents / sectors);
    const modules = Math.max(4, Math.round(perSector / 12));
    const pid = this.requireProject().id;
    const stubs = Array.from({ length: sectors }, (_, i) => this.env.SECTOR.get(this.env.SECTOR.idFromName(`${pid}:sim:${i}`)));
    // Baseline shard: same density, no course checks.
    const baseline = this.env.SECTOR.get(this.env.SECTOR.idFromName(`${pid}:sim:baseline`));
    const seed = Date.now() % 100_000;
    await Promise.all([
      ...stubs.map((s, i) => s.configure({ sector: i, sectors, modules, filesPerModule: 40, agents: perSector, seed, coordinate })),
      baseline.configure({ sector: 99, sectors: 1, modules, filesPerModule: 40, agents: Math.min(perSector, 4000), seed, coordinate: false }),
    ]);
    const startedAt = Date.now();
    this.sim = {
      running: true,
      agents,
      sectors,
      courseChecksPerSec: 0,
      correctionsPerSec: 0,
      landingsPerSec: 0,
      conflictsAtLanding: 0,
      collisionsAvoided: 0,
      p50CheckMs: 0,
      p99CheckMs: 0,
      startedAt,
      elapsedMs: 0,
      coordinate,
      ticks: 0,
      totalCourseChecks: 0,
      totalLandings: 0,
    };
    this.emit({ type: "sim", sim: this.sim });
    this.addLog({ kind: "system", message: `Simulation starts: ${agents.toLocaleString("en-US")} agents over ${sectors} sector${sectors > 1 ? "s" : ""}. Course checks run in each sector in parallel.` });
    const loop = async () => {
      const totals = { checks: 0, corrections: 0, landings: 0, conflicts: 0, avoided: 0, baseLandings: 0, baseConflicts: 0 };
      const window: { at: number; checks: number; corrections: number; replots: number; landings: number; perSector: number[] }[] = [];
      let lat: number[] = [];
      let ticks = 0;
      while (!run.stop && Date.now() - startedAt < seconds * 1000) {
        const tickStart = Date.now();
        const timed = await Promise.all([
          Promise.all(stubs.map(async (s) => { const t0 = Date.now(); const r = await s.tick(); return { r, ms: Date.now() - t0 }; })),
          baseline.tick(),
        ]);
        const results = timed[0].map((x) => x.r);
        const base = timed[1];
        // Amortized cost per course check, from wall time around each sector RPC (Workers freeze timers during compute).
        for (const x of timed[0]) if (x.r.courseChecks > 0) lat.push(Math.round((x.ms / x.r.courseChecks) * 1000) / 1000);
        void tickStart;
        ticks += 1;
        const now = Date.now();
        let checks = 0;
        let corrections = 0;
        let replots = 0;
        let landings = 0;
        for (const r of results) {
          checks += r.courseChecks;
          corrections += r.corrections;
          replots += r.replots ?? 0;
          landings += r.landings;
          totals.conflicts += r.conflictsAtLanding;
          totals.avoided += r.collisionsAvoided;
        }
        totals.checks += checks;
        totals.corrections += corrections;
        totals.landings += landings;
        totals.baseLandings += base.landings;
        totals.baseConflicts += base.conflictsAtLanding;
        window.push({ at: now, checks, corrections, replots, landings, perSector: results.map((r) => r.courseChecks) });
        while (window.length > 2 && now - window[0].at > 5000) window.shift();
        const span = Math.max(0.25, (now - window[0].at) / 1000 + 0.001);
        const sum = (k: "checks" | "corrections" | "replots" | "landings") => window.slice(1).reduce((m, w) => m + w[k], 0);
        if (lat.length > 20_000) lat = lat.slice(-5000);
        const sorted = [...lat].sort((a, b) => a - b);
        const pct = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
        const perSecSector = stubs.map((_, i) => Math.round(window.slice(1).reduce((m, w) => m + (w.perSector[i] ?? 0), 0) / span));
        this.sim = {
          running: true,
          agents,
          sectors,
          courseChecksPerSec: Math.round(sum("checks") / span),
          correctionsPerSec: Math.round(sum("corrections") / span),
          replotsPerSec: Math.round(sum("replots") / span),
          landingsPerSec: Math.round(sum("landings") / span),
          conflictsAtLanding: totals.conflicts,
          collisionsAvoided: totals.avoided,
          p50CheckMs: round(pct(0.5)),
          p99CheckMs: round(pct(0.99)),
          startedAt,
          elapsedMs: now - startedAt,
          coordinate,
          conflictRate: totals.landings ? round(totals.conflicts / totals.landings) : 0,
          baselineConflictRate: totals.baseLandings ? round(totals.baseConflicts / totals.baseLandings) : 0,
          sectorLoad: perSecSector,
          ticks,
          totalCourseChecks: totals.checks,
          totalLandings: totals.landings,
        };
        this.emit({ type: "sim", sim: this.sim });
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this.simRun === run) {
        this.sim = { ...this.sim!, running: false };
        this.db.setMeta("sim", this.sim);
        this.emit({ type: "sim", sim: this.sim });
        this.addLog({
          kind: "system",
          message: `Simulation ends: ${totals.checks.toLocaleString("en-US")} course checks, ${totals.landings.toLocaleString("en-US")} landings. Conflicts at landing: ${pctText(this.sim.conflictRate)} with Bearing, ${pctText(this.sim.baselineConflictRate)} without.`,
        });
        this.simRun = undefined;
      }
    };
    this.ctx.waitUntil(loop().catch((e) => console.error("sim failed", e)));
    return this.sim;
  }

  async simStop(): Promise<T.SimStats | undefined> {
    if (this.simRun) this.simRun.stop = true;
    if (this.sim) {
      this.sim = { ...this.sim, running: false };
      this.db.setMeta("sim", this.sim);
      this.emit({ type: "sim", sim: this.sim });
    }
    return this.sim;
  }

  /* ════════════════════════════ helpers ════════════════════════════ */

  async version(): Promise<string> {
    return BUILD_ID;
  }

  private mustAttempt(id: string): T.Attempt {
    const a = this.attempts.get(id);
    if (!a) throw new Error(`Unknown attempt ${id}. Call bearing_declare first.`);
    return a;
  }

  /** LLM polish for correction text is optional; templates are the source of truth. */
  async polish(text: string): Promise<string> {
    const res = await chat(this.env.AI as never, "@cf/zai-org/glm-4.7-flash", [
      { role: "system", content: "Rewrite the message in ASD-STE100: short imperative sentences, max 20 words each, active voice. Keep every file name, line number and signature. Output only the message." },
      { role: "user", content: text },
    ], { maxTokens: 300, timeoutMs: 8000 });
    return res?.message.content?.trim() || text;
  }
}

/* ════════════════════════════ module helpers ════════════════════════════ */

/** HH:MM in UTC, for log lines. */
function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

const SYSTEM: T.Actor = { kind: "system", id: "bearing", name: "Bearing" };
const HUMAN: T.Actor = { kind: "human", id: "human", name: "Human" };

function emptyStats(): T.HarborStats {
  return {
    courseChecks: 0,
    clear: 0,
    corrections: 0,
    correctionsAcknowledged: 0,
    escalations: 0,
    landings: 0,
    landedByMethod: { "fast-forward": 0, merge: 0, rederive: 0 },
    rederives: 0,
    humanMergeFixes: 0,
    medianCheckLatencyMs: 0,
  };
}

function emptyFootprint(): T.Footprint {
  return { files: {}, symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] }, computedAt: Date.now() };
}

function normPath(p: string): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

/** Severity of a pair situation: closer range, overlapping lines and interface hits weigh more. */
function severityOf(f: T.PairFacts): number {
  return (5 - f.range) * 10 + Math.min(5, f.hunkOverlaps.length) * 3 + Math.min(3, f.interfaceHits.length) * 6 + (f.closing ? 2 : 0);
}

function normDir(p: string): string {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function sortPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Clef judges; facts anchor. Hard evidence sets a floor; no evidence sets a ceiling. */
function anchor(model: T.CourseAssessment, rules: T.CourseAssessment, facts: T.PairFacts): T.CourseAssessment {
  const hard = facts.range === 0 || facts.interfaceHits.length > 0;
  const soft = facts.range >= 3 && !facts.closing && facts.interfaceHits.length === 0;
  let collision = model.collision;
  let interference = model.interference;
  if (hard) {
    collision = Math.max(collision, rules.collision * 0.95);
    interference = Math.max(interference, rules.interference * 0.95);
  }
  if (soft) {
    collision = Math.min(collision, 0.45);
    interference = Math.min(interference, 1.4);
  }
  const giveWayConfidence = model.giveWay === rules.giveWay ? Math.max(rules.giveWayConfidence, model.giveWayConfidence) : model.giveWayConfidence;
  return { ...model, collision: round(collision), interference: round(interference), giveWayConfidence: round(giveWayConfidence) };
}

function hardFacts(f: T.PairFacts): boolean {
  return f.hunkOverlaps.length > 0 || f.interfaceHits.length > 0 || f.sharedSymbols.length > 0;
}

function decisiveness(as: T.CourseAssessment[]): number {
  return as.length ? Math.min(...as.map((a) => Math.abs(a.collision - 0.5) * 2)) : 1;
}

/** Keep a settings patch inside safe bounds (the demo API can be open to the public). */
function sanitizeSettings(raw: Partial<T.ProjectSettings>, modelOk: (m: string) => boolean): Partial<T.ProjectSettings> {
  const out: Partial<T.ProjectSettings> = {};
  const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
  if (typeof raw.autoLand === "boolean") out.autoLand = raw.autoLand;
  if (typeof raw.intentsInRepo === "boolean") out.intentsInRepo = raw.intentsInRepo;
  const fanout = num(raw.fanout, 1, 4);
  if (fanout !== undefined) out.fanout = Math.round(fanout);
  if (raw.decisionModel === "clef" || raw.decisionModel === "clef-flash" || raw.decisionModel === "rules") out.decisionModel = raw.decisionModel;
  if (Array.isArray(raw.agentModels)) {
    const models = raw.agentModels.filter((m): m is string => typeof m === "string" && modelOk(m)).slice(0, 6);
    if (models.length) out.agentModels = models;
  }
  if (raw.thresholds && typeof raw.thresholds === "object") {
    const t: Partial<T.PolicyThresholds> = {};
    const c = num(raw.thresholds.collision, 0, 1);
    const i = num(raw.thresholds.interference, 0, 4);
    const d = num(raw.thresholds.duplicate, 0, 1);
    const m = num(raw.thresholds.minConfidence, 0, 1);
    if (c !== undefined) t.collision = c;
    if (i !== undefined) t.interference = i;
    if (d !== undefined) t.duplicate = d;
    if (m !== undefined) t.minConfidence = m;
    out.thresholds = t as T.PolicyThresholds;
  }
  if (raw.checks && typeof raw.checks === "object") {
    const c = raw.checks as Partial<T.CheckSettings>;
    const cmd = (v: unknown) => (typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, 500) : undefined);
    const secs = num(c.timeoutSec, 60, 1800);
    out.checks = {
      runner: c.runner === "worker" ? "worker" : "container",
      ...(cmd(c.install) ? { install: cmd(c.install) } : {}),
      ...(cmd(c.test) ? { test: cmd(c.test) } : {}),
      ...(secs !== undefined ? { timeoutSec: Math.round(secs) } : {}),
    };
  }
  if (Array.isArray(raw.webhooks)) {
    out.webhooks = raw.webhooks
      .filter((w) => w && typeof w.url === "string" && /^https:\/\/[^\s/]+\.[^\s]+$/.test(w.url))
      .slice(0, 5)
      .map((w, n) => ({
        id: typeof w.id === "string" ? w.id.slice(0, 40) : `wh_${n + 1}`,
        url: w.url.slice(0, 500),
        events: Array.isArray(w.events) ? w.events.filter((e): e is T.BearingEventType => typeof e === "string").slice(0, 12) : [],
        format: w.format === "slack" ? "slack" : "json",
        enabled: w.enabled !== false,
      }));
  }
  return out;
}

/** A file of an uploaded folder: text, or bytes in base64. */
export interface SeedFile {
  path: string;
  text?: string;
  base64?: string;
  executable?: boolean;
}

const MAX_UPLOAD_FILES = 5000;
const MAX_UPLOAD_BYTES = 20_000_000;

/** Uploaded files as commit changes: clean paths, no .git, size limits. */
export function seedChanges(files: SeedFile[]): { path: string; content: string | Uint8Array; mode?: string }[] {
  const out = new Map<string, { path: string; content: string | Uint8Array; mode?: string }>();
  let bytes = 0;
  for (const f of files.slice(0, MAX_UPLOAD_FILES + 1)) {
    const path = String(f.path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || path.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || seg === ".git")) continue;
    let content: string | Uint8Array;
    if (typeof f.text === "string") content = f.text;
    else if (typeof f.base64 === "string") content = Uint8Array.from(atob(f.base64), (ch) => ch.charCodeAt(0));
    else continue;
    bytes += typeof content === "string" ? new TextEncoder().encode(content).length : content.length;
    if (bytes > MAX_UPLOAD_BYTES) throw new Error(`The folder is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB. Leave out build output and dependencies, or push it with git.`);
    out.set(path, { path, content, ...(f.executable ? { mode: "100755" } : {}) });
  }
  if (out.size > MAX_UPLOAD_FILES) throw new Error(`The folder has more than ${MAX_UPLOAD_FILES} files. Push it with git instead.`);
  return [...out.values()];
}

const BRIEF_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|mts|json|md|css|scss|html|vue|svelte|py|go|rs|rb|java|kt|toml|ya?ml)$/;

/**
 * Files for an agent's first look, most useful first: the files of its course and of the intent's scope,
 * the manifest and the README, then files whose path shares words with the intent.
 */
export function rankForBrief(files: Map<string, string>, intent: T.Intent, wanted: Set<string>): [string, string][] {
  const words = new Set((`${intent.title} ${intent.goal}`.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)));
  const score = (path: string): number => {
    let s = 0;
    if (wanted.has(path)) s += 100;
    if (/^(package\.json|readme\.md|tsconfig\.json|wrangler\.jsonc?|pyproject\.toml|go\.mod|cargo\.toml)$/i.test(path)) s += 40;
    if (/(^|\/)(src|lib|app|pages|components|server|api)\//.test(path)) s += 5;
    for (const part of path.toLowerCase().split(/[^a-z0-9]+/)) if (words.has(part) || words.has(part.replace(/s$/, ""))) s += 15;
    if (/(^|\/)(dist|build|vendor|node_modules|\.next|coverage)\//.test(path) || /\.min\.|lock|\.snap$/.test(path)) s -= 200;
    return s - path.split("/").length;
  };
  return [...files]
    .filter(([path]) => BRIEF_EXT.test(path) || wanted.has(path))
    .map(([path, text]) => ({ path, text, s: score(path) }))
    .sort((x, y) => y.s - x.s || (x.path < y.path ? -1 : 1))
    .map((x) => [x.path, x.text]);
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "when", "add", "make", "show", "use", "can", "are", "not", "all", "one", "each", "new", "has", "have", "who", "its", "their", "them", "then", "than", "page"]);

/** A check container's result as a CheckRun: one case for the install, one for the tests. */
export function containerRun(res: DrydockResult, o: { key: string; scope: T.CheckRun["scope"]; cs: T.CheckSettings; ms: number }): T.CheckRun {
  const installCmd = o.cs.install || "npm ci (or npm install)";
  const testCmd = o.cs.test || "npm test";
  const tail = (n: number) => (res.log.length > n ? `…${res.log.slice(-n)}` : res.log).trim();
  const installed = res.stage !== "install" && res.stage !== "start";
  const cases: T.CheckCaseResult[] = [];
  if (res.stage !== "start") {
    cases.push({ file: "install", name: installCmd, ok: installed, ms: res.installMs, ...(installed ? {} : { error: tail(3000) }) });
  }
  if (installed && res.stage !== "no-test") {
    cases.push({ file: "test", name: testCmd, ok: res.ok, ms: res.testMs, ...(res.ok ? {} : { error: tail(3000) }) });
  }
  const error =
    res.stage === "start"
      ? res.log.slice(0, 500)
      : res.stage === "no-test"
        ? "No test command. The project has no package.json test script. An owner sets the test command in Project settings → Checks."
        : res.stage === "timeout"
          ? `The checks took more than ${o.cs.timeoutSec ?? 600} s. Bearing stopped them.`
          : undefined;
  return {
    id: newId("cr"),
    subject: o.key,
    scope: o.scope,
    ok: res.ok,
    passed: cases.filter((c) => c.ok).length,
    failed: cases.filter((c) => !c.ok).length + (res.stage === "no-test" || res.stage === "start" ? 1 : 0),
    cases,
    ms: o.ms,
    at: Date.now(),
    runner: "container",
    log: res.log,
    ...(error ? { error } : {}),
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function pctText(x: number | undefined): string {
  return `${((x ?? 0) * 100).toFixed(1)}%`;
}

function findText(sha: string, trees: TreeText[]): string | undefined {
  for (const t of trees) {
    for (const [path, e] of t.snapshot) {
      if (e.sha === sha) return t.text.get(path) ?? undefined;
    }
  }
  return undefined;
}

async function snapshotFromText(base: Snapshot, view: AttemptView): Promise<Snapshot> {
  const { applyFileChanges } = await import("../core/git/snapshot");
  const changes = view.changed.map((c) => ({ path: c.path, content: c.head }));
  const { snapshot } = await applyFileChanges(base, changes);
  return snapshot;
}

function slackText(event: string, p: Record<string, unknown>): string {
  if (event === "landing") {
    const l = p.landing as T.Landing;
    const i = p.intent as { title: string };
    return `:anchor: *${i.title}* landed on main by ${l.method} (\`${String(p.mainSha).slice(0, 7)}\`) · ${p.callsign} · checks ${l.checks.passed}/${l.checks.passed + l.checks.failed} · human merge fixes: 0`;
  }
  if (event === "correction") {
    const c = p.correction as T.Correction;
    return `:large_purple_diamond: Correction for ${p.callsign} (${c.kind}, ${c.rule}): ${c.message}`;
  }
  if (event === "decision") {
    const d = p.decision as T.Decision;
    return `:scales: Decision (${d.kind}) by ${d.by.name}: ${d.rationale}`;
  }
  if (event === "intent") return `:compass: New intent: *${(p.intent as { title: string }).title}*`;
  return `${event}: ${JSON.stringify(p).slice(0, 300)}`;
}

