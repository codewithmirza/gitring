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
import { DEFAULT_SETTINGS, isLandingMode, noTestRan, withDefaults } from "../core/types";
import { Db } from "./store";
import { DerivedHistory } from "./derived";
import type { CompareAnswer, HistoryAnswer, SearchAnswer, WhyAnswer } from "../core/history";
import { readTimeline } from "./timeline";
import type { TimelinePage } from "../core/timeline";
import { CHECK_RUN, callsignFor, colorFor, newId, rand, repoSafe } from "./ids";
import { hmacSha256Hex, seal, sha256Hex, unseal } from "../directory/crypto";
import { deliverWebhook, newWebhookSecret, SECRET_SEAL, secretHint } from "./webhooks";
import { approvalLine, approvalNeeded, approvalPath, canDecide, riskSigns } from "../core/approvals";
import { changeMeaning } from "../core/analysis/meaning";
import { checkFolderRules, planNotes, planRefusal, sanitizeFolderRules } from "../core/coord/folder-rules";
import { pushKeys } from "../worker/push";
import { canAnswerQuestion, escalationFacts, escalationOptions, inboxOf, REDO_OPTIONS, STEWARD_OPTIONS, taskPath, type InboxItem } from "../core/inbox";
import { stewardFindings, stewardModel, wordFinding } from "./steward";
import { atLeast, type Role } from "../core/accounts";
import type { Env } from "../worker/env";
import type { RepoBackend } from "../platform/repo/backend";
import { RepoConflictError, type CommitMeta, type FileChange } from "../platform/repo/backend";
import { ArtifactsBackend } from "../platform/repo/artifacts";
import { MemoryTreeCache, readSnapshot, diffSnapshots, applyFileChanges, type Snapshot, type SnapshotChange } from "../core/git/snapshot";
import { hashObject, hashObjectSync, isValidBranchName, utf8 } from "../core/git/objects";
import { buildImportGraph, graphFromEdges } from "../core/analysis/graph";
import { isAnalyzable, pathAliasesOf } from "../core/analysis/symbols";
import { unifiedDiff, isProbablyText, lineDiff } from "../core/text/diff";
import {
  measureTraffic,
  pickCandidates,
  hasHardFacts,
  modelConfidence,
  buildPairFacts,
  assessWithRules,
  parseClefResponse,
  decide,
  draftCorrection,
  draftUpstreamCorrection,
  draftReplotCorrection,
  draftDuplicateCorrection,
  draftIntentAmendedCorrection,
  DUPLICATE_MIN_SIMILARITY,
  DUPLICATE_UNSHARED_CAP,
  SOFT_PAIR_CAP,
  isSoftPair,
  modelCannotChangeVerdict,
  type VesselView,
} from "../core/coord";
import { computeRange, shapeFromFootprint } from "../core/analysis/range";
import type { FootprintOptions } from "../core/analysis/footprint";
import { buildBriefClefRequest } from "../core/coord/clef-brief";
import { compose } from "../core/land/compose";
import { MAX_CARRY_FILE_BYTES, MAX_CARRY_TOTAL_BYTES, notCarriedText, overSize, planCarry, withoutChanges, type NotCarried } from "../core/land/carry";
import { merge3 } from "../core/text/merge3";
import { landingMessage, landingNote, intentFile, parseTrailers } from "../core/logbook";
import { MAX_TEXT_BYTES, MAX_TEXT_FILES, githubRepoName, normalizeGitUrl, publicHostname, textEligible } from "../core/repo-rules";
import { runChecks, contentKey } from "../platform/checks/runner";
import { packTree, type DrydockResult, type PackFile } from "../drydock/drydock";
import { callClef, contextBudget } from "../platform/ai/models";
import { syncToGithub, type UpstreamMark } from "../platform/github/sync";
import { guessModel } from "../platform/ai/guess";
import { guessTree } from "../core/guess";
import { isTemplateId, templateFiles, TEMPLATES } from "../core/templates";
import { githubSnapshot, SNAPSHOT_LIMITS, SnapshotTooLarge } from "../platform/github/tarball";
import { upstreamChanges } from "../platform/github/upstream";
import {
  ACTIVE,
  WAITING,
  PROTOCOL,
  adviceFor,
  changedVersions,
  checkGraph,
  clearance,
  failureSummary,
  fileNodes,
  footprintOf,
  knownMemberOf,
  langOf,
  latestCheck,
  median,
  notices,
  opaqueChanges,
  overlayFiles,
  overlaySnapshot,
  contributionRows,
  signaturesOf,
  symbolIndex,
  trafficVessel,
  vesselView,
  type AttemptView,
  type MainView,
  type TreeText,
} from "./views";
import { checkAck } from "./ack-check";

/** Commits that gitring makes. ".invalid" is a reserved domain: no person can own this address. */
const GITRING_AUTHOR = { name: "gitring", email: "noreply@gitring.invalid" };
export const BUILD_ID = "0.9.2+20261011e";
const MAX_LOGS = 500;
/** An error as one line for the log. The log of the platform shows only the stack of an error object, and the message is the part that tells what happened. */
function errorLine(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  const name = typeof e?.name === "string" && e.name ? e.name : "Error";
  return `${name}: ${(typeof e?.message === "string" ? e.message : String(err)).slice(0, 300)}`;
}
/** The lines that a "same lines" change request names, as one text. Empty for any other kind of change request. */
function regionKey(c: { kind: T.CorrectionKind; constraints: T.Correction["constraints"] }): string {
  const regions = c.constraints.avoidRegions;
  if (c.kind !== "region" || !regions?.length) return "";
  return regions.map((r) => `${r.path}:${r.lines[0]}-${r.lines[1]}`).sort().join("|");
}

const MAX_CHECKS = 300;
/** Above this many radar pairs, a check forgets the pairs of work that left the traffic (see trimRadar). */
const MAX_RADAR_PAIRS = 2000;
const TERMINAL: ReadonlySet<T.AttemptStatus> = new Set(["landed", "abandoned", "alternate", "failed", "stale"]);
/** Default built-in AI agent starts per hour for the whole deployment (AI_AGENTS_PER_HOUR overrides). */
const LLM_STARTS_PER_HOUR = 40;
/** Default built-in AI agent starts per hour and person (AI_AGENTS_PER_USER_HOUR overrides). */
const LLM_STARTS_PER_USER_HOUR = 12;
/**
 * A merge run that no run has finished stays "in progress" this long. After that, the queue starts it
 * again (the object that ran it stopped: evicted or crashed).
 */
const LANDING_LEASE_MS = 5 * 60_000;
/** One merge starts at most this many times (crashes included). Then a person decides. */
const MAX_LANDING_STARTS = 4;
/** The steward counts the facts this often while agents work (project setting `steward`). */
const STEWARD_EVERY_MS = 3 * 60_000;
/** The model words at most this many new findings in one sweep (each call can take seconds). */
const STEWARD_WORDS_PER_SWEEP = 3;
/** What people and agents read when the gitring test harness ran no test (nothing is verified). */
const NO_TEST_RAN = "No test ran. A person must decide to merge.";
/** The UTF-8 byte order mark as text. gitring's text of a file never starts with it (TextDecoder takes it away). */
const BOM = "﻿";
/**
 * Bytes that one blob reader keeps after a read (a merge reads a file for its size, then for the commit).
 * The project object has 128 MB of memory: these limits, and MAX_CARRY_TOTAL_BYTES, keep a merge far below it.
 */
const READER_CACHE_BYTES = MAX_CARRY_TOTAL_BYTES;
/** The test container gets at most this many bytes of files without text, and reads at most this many such files. */
const MAX_TEST_TREE_BYTES = 16_000_000;
const MAX_TEST_TREE_READS = 5000;
/** Blobs of unknown size that gitring reads at once (it learns the size of a blob only when it reads it). */
const SIZE_READS = 4;
/** Characters of text that the cache of blob ids keeps (about 8 MB of memory). */
const TEXT_ID_CHARS = 4_000_000;

/** Reads blobs for a merge (see HarborMaster.blobReader). */
interface BlobReader {
  /** Exact text, or null for a blob that is not text (or not exactly text). */
  readText(sha: string): Promise<string | null>;
  readBytes(sha: string): Promise<Uint8Array | null>;
  /** Like readText, from what gitring holds only: undefined when gitring must read a repository for it. */
  knownText(sha: string): Promise<string | null | undefined>;
}

/** The merge run in progress (meta "landing"): written before the landing work starts, cleared when it ends. */
interface LandingRun {
  /** The work copy that merges. */
  id: string;
  startedAt: number;
  /** The object instance that started the run (see bootId). */
  boot: string;
  /** How many times this merge started. */
  tries: number;
}

export interface LaunchInput {
  fanout?: number;
  models?: string[];
}

/**
 * What the Worker tells the project object about one call (the MCP tools use it): the address of this
 * deployment, for links in answers, and the person who calls, with the role that the Worker checked.
 */
export interface CallInfo {
  origin?: string;
  viewer?: { id: string; role: Role };
  /**
   * Change requests that an earlier answer of the same tool call delivered (submit, then status). The answer
   * holds them again until the agent confirms them: the agent reads them only in the last answer of the call.
   */
  again?: string[];
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
  /** How the checks run: the gitring harness, or the project's install and test commands in a container. */
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
  private questions = new Map<string, T.Question>();
  private radar = new Map<string, T.RadarPair>();
  /** Every commit that was main → its place in main's history (the table main_seq). */
  private mainIndex = new Map<string, number>();
  private stats: T.HarborStats = emptyStats();
  private checkLatencies: number[] = [];

  private backendCache?: RepoBackend;
  private treeCache = new MemoryTreeCache(5000);
  private treeTexts = new Map<string, Promise<TreeText>>();
  private mainView?: MainView;
  private mainLoading?: Promise<MainView>;
  private attemptViews = new Map<string, { key: string; view: AttemptView }>();
  /** Views of work copies that gitring makes now (see attemptView). */
  private attemptViewLoads = new Map<string, { key: string; view: Promise<AttemptView> }>();
  /** Text → blob id, for the files that agents wrote (see textBlobId). */
  private textIds = new Map<string, string>();
  private textIdChars = 0;
  private attemptVersion = new Map<string, number>();
  private forks = new Map<string, Promise<void>>();
  private landingChain: Promise<unknown> = Promise.resolve();
  private outbox: T.GitringEvent[] = [];
  private flushScheduled = false;
  private seq = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Db(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      this.load();
      this.wakeQueue();
    });
  }

  /* ════════════════════════════ load / bootstrap ════════════════════════════ */

  private load(): void {
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
  private migrateApprovals(): void {
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

  private get backend(): RepoBackend {
    if (this.backendCache) return this.backendCache;
    this.backendCache = new ArtifactsBackend(this.env.ARTIFACTS, { author: GITRING_AUTHOR, treeCache: this.treeCache });
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

  /** The project. A project exists only after init (POST /api/projects). */
  async ensure(_projectId?: string): Promise<T.Project> {
    if (this.project) return this.project;
    throw new Error("Unknown project. Create it first.");
  }

  /**
   * Create the canonical repo in Artifacts from a source:
   *   empty   a README in one commit
   *   git     Artifacts imports a public https remote (history kept); main = the remote's default branch
   *   push    an empty repo; the owner pushes to it with plain git (gitring adopts the pushed branch)
   *   upload  the files of a folder from the owner's computer, in one commit
   *   template  the files of a starter template (core/templates.ts), in one commit; its tests run in
   *           the gitring test runner (fast: no container, no test budget)
   * Imports run in the background: the project shows "importing" until Artifacts is done. After an
   * import, a push or an upload, gitring guesses the test commands (see guessTests).
   */
  async init(opts: { projectId: string; name?: string; source?: T.ProjectSource; ownerId?: string; files?: SeedFile[] }): Promise<T.ProjectState> {
    const generation = (this.db.getMeta<number>("generation") ?? 0) + 1;
    const source: T.ProjectSource = opts.source ?? { kind: "empty" };
    if (source.kind === "sample") throw new Error("The sample left gitring. Import a repository, upload a folder, push with git, or start empty.");
    if (source.kind === "template" && !isTemplateId(source.template)) throw new Error(`Unknown template "${source.template}". Use one of: ${TEMPLATES.map((t) => t.id).join(", ")}.`);
    const namespace = this.env.ARTIFACTS_NAMESPACE ?? "gitring";
    this.project = undefined;
    this.backendCache = undefined;
    const repoName = repoSafe(`${opts.projectId}-g${generation}-${Date.now().toString(36)}`);
    const draft: T.Project = {
      id: opts.projectId,
      name: opts.name ?? opts.projectId,
      repo: { backend: "artifacts", namespace, name: repoName, defaultBranch: "main" },
      mainSha: "",
      mainTree: "",
      createdAt: Date.now(),
      source,
      ownerId: opts.ownerId,
      settings: {
        ...DEFAULT_SETTINGS,
        decisionModel: "clef-flash",
        agentModels: this.operatorModels(),
        // Task files in the repository are a choice of the owner (Settings → Merging).
        intentsInRepo: false,
        // Repositories run their own tests in a container. Templates have tests for the gitring test runner.
        checks: source.kind === "template" ? { runner: "worker" as const } : { runner: "container" as const },
      },
    };
    this.project = draft;
    this.db.setMeta("generation", generation);
    // A project id that comes back (a project that was not made, then made again) starts clean: the
    // choice of the tests, the agents that wait for an import and the fix task belong to the old project.
    for (const key of ["checksSet", "launchAfterImport", "pullTestTask"]) this.db.setMeta(key, undefined);

    // A public repository (any git host, or GitHub): Artifacts imports it with its history.
    if (source.kind === "git" || (source.kind === "github" && !source.private)) {
      const url = source.kind === "git" ? normalizeGitUrl(source.url) : `https://github.com/${source.repo}`;
      const branch = source.branch;
      const res = await this.env.ARTIFACTS.import({
        source: { url, ...(branch ? { branch } : {}), depth: 200 },
        target: { name: repoName, opts: { description: `gitring project ${opts.projectId} (import of ${url})` } },
      });
      draft.repo.remote = res.remote;
      draft.repo.defaultBranch = branch || res.defaultBranch || "main";
      draft.importing = { url, startedAt: Date.now(), ...(source.kind === "github" ? { github: { repo: source.repo, branch: branch ?? "", snapshot: false } } : {}) };
      this.db.setMeta("project", draft);
      this.addLog({ kind: "system", message: `Import starts: ${url} into Cloudflare Artifacts (${repoName}).` });
      await this.ctx.storage.setAlarm(Date.now() + 2000);
      const state = await this.state();
      this.emit({ type: "snapshot", state });
      return state;
    }

    // A private GitHub repository: gitring reads one commit through the GitHub App (Artifacts imports
    // public remotes only), in the background.
    if (source.kind === "github") {
      const handle = await this.backend.ensureRepo(repoName, { description: `gitring project ${opts.projectId} (import of github.com/${source.repo})` });
      draft.repo.remote = handle.remote;
      draft.repo.defaultBranch = source.branch || "main";
      draft.importing = { url: `https://github.com/${source.repo}`, startedAt: Date.now(), github: { repo: source.repo, branch: source.branch ?? "", snapshot: true } };
      // Private code: the project stays private, whatever happens to the link later.
      draft.privateCode = { repo: source.repo, at: Date.now() };
      this.db.setMeta("project", draft);
      this.addLog({ kind: "system", message: `Import starts: github.com/${source.repo} (private) through the gitring GitHub App.` });
      await this.ctx.storage.setAlarm(Date.now() + 200);
      const state = await this.state();
      this.emit({ type: "snapshot", state });
      return state;
    }

    const handle = await this.backend.ensureRepo(repoName, { description: `gitring project ${opts.projectId}` });
    draft.repo.remote = handle.remote;

    if (source.kind === "push") {
      // An empty repo: the owner pushes an existing repository with plain git. gitring adopts the push.
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
      source.kind === "upload"
        ? uploaded
        : source.kind === "template" && isTemplateId(source.template)
          ? templateFiles(source.template, { name: draft.name })
          : [{ path: "README.md", content: `# ${draft.name}\n\nThis repository lives in gitring. Agents send a plan before they change it.\n` }];
    const seed = await this.backend.commit({
      repo: repoName,
      branch: "main",
      parent: "",
      changes,
      message:
        source.kind === "upload"
          ? `Upload ${draft.name}\n\n${changes.length} files from a folder.\n\nGitring-Seed: upload`
          : source.kind === "template"
            ? `Start ${draft.name} from the ${TEMPLATES.find((t) => t.id === source.template)?.title ?? source.template} template\n\n${changes.length} files.\n\nGitring-Seed: template ${source.template}`
            : `Start ${draft.name}\n\nGitring-Seed: ${source.kind}`,
      author: GITRING_AUTHOR,
    });
    draft.mainSha = seed.sha;
    draft.mainTree = seed.tree;
    this.db.setMeta("project", draft);
    this.resetMainSeq(seed.sha);
    this.addLog({ kind: "system", message: `Project ready. Main is ${seed.sha.slice(0, 7)} in Cloudflare Artifacts (${repoName}).` });
    await this.loadMain();
    this.persistStats();
    // An uploaded folder brings its own tests: gitring guesses the commands (in the background).
    if (source.kind === "upload") this.ctx.waitUntil(this.guessTests().catch((e) => console.warn("guess failed", errorLine(e))));
    const state = await this.state();
    this.emit({ type: "snapshot", state });
    return state;
  }

  /** Alarm step for an import: wait until Artifacts has the repo (or the owner's push), then read main. */
  private async continueImport(): Promise<void> {
    const p = this.project;
    if (!p?.importing || p.importing.error) return;
    if (p.importing.github?.snapshot) {
      // One snapshot import at a time ("Check now" and the alarm can both ask).
      this.snapshotRun ??= this.importGithubSnapshot().finally(() => (this.snapshotRun = undefined));
      return this.snapshotRun;
    }
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
    const asked = p.source?.kind === "git" || p.source?.kind === "github" ? p.source.branch : undefined;
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
      p.importing = { ...p.importing, error: asked ? `The repository has no branch "${asked}".` : "gitring did not find the default branch of the repository. Import it again and name the branch." };
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
    // Push tokens open the canonical repo; after the adoption only gitring writes to it.
    for (const id of p.importing?.tokenIds ?? []) await this.backend.revokeToken(p.repo.name, id).catch(() => false);
    // A public GitHub import keeps GitHub's commit ids: GitHub has this commit.
    if (p.importing?.github && !p.importing.github.snapshot) this.setGh(p.importing.github.repo, { last: sha, private: false });
    p.importing = undefined;
    this.db.setMeta("project", p);
    this.resetMainSeq(sha);
    this.mainView = undefined;
    const main = await this.loadMain();
    this.addLog({ kind: "system", message: `${url === "git push" ? "Push received" : `Import done: ${url}`} at ${sha.slice(0, 7)} on ${branch} (${main.files.length} files). Write tasks for agents.` });
    this.persistStats();
    this.emit({ type: "snapshot", state: await this.state() });
    // The code is in main now: gitring guesses how it installs and tests itself (in the background).
    const guessed = this.guessTests().catch((e) => console.warn("guess failed", errorLine(e)));
    this.ctx.waitUntil(guessed);
    // Built-in agents that the creator asked for start now (see launchWhenReady), after the guess: their
    // first test run uses the guessed commands.
    const later = this.db.getMeta<{ intentId: string; fanout: number; by: T.Actor }>("launchAfterImport");
    if (later) {
      this.db.setMeta("launchAfterImport", undefined);
      this.ctx.waitUntil(
        guessed
          .then(() => this.launch(later.intentId, { fanout: later.fanout }, later.by))
          .then(() => undefined)
          .catch((e) => this.addLog({ kind: "system", intentId: later.intentId, message: `The built-in agents did not start after the import: ${String((e as Error)?.message ?? e).slice(0, 200)}` })),
      );
    }
  }

  /**
   * Start built-in agents on a task now, or when the import is done (a new project can have its first
   * task before its code is in main). Answers the work copies that started now.
   */
  async launchWhenReady(intentId: string, fanout: number, by: T.Actor = HUMAN): Promise<{ attempts: string[]; afterImport: boolean }> {
    const p = this.requireProject();
    if (p.importing && !p.importing.error) {
      this.db.setMeta("launchAfterImport", { intentId, fanout, by });
      return { attempts: [], afterImport: true };
    }
    const res = await this.launch(intentId, { fanout }, by);
    return { attempts: res.attempts.map((a) => a.id), afterImport: false };
  }

  /**
   * Guess the test commands from the files of main (after an import, a push or an upload), unless someone
   * already set the tests (meta "checksSet"). The rules read the manifests; when they find no test
   * command, a model reads the README and the file list. A guess with no test command changes nothing.
   */
  async guessTests(): Promise<T.CheckSettings | null> {
    if (this.db.getMeta<boolean>("checksSet")) return null;
    const p = this.requireProject();
    if (p.importing) return null;
    // Tests with commands, or the gitring test runner, are a choice (also on a project from before
    // "checksSet"): only the bare default (a container, no commands) gets a guess.
    const cur = p.settings.checks;
    if (cur && (cur.runner === "worker" || cur.install || cur.test)) return null;
    const main = await this.loadMain();
    const g = await guessTree({ label: p.name, paths: [...main.snapshot.keys()], read: async (path) => main.text.get(path) ?? null, ask: guessModel(this.env.AI) });
    // A person (or an agent) set the tests while the model answered: their choice stays.
    if (this.db.getMeta<boolean>("checksSet") || this.project !== p) return null;
    const checks: T.CheckSettings | null = g.runner === "worker" ? { runner: "worker" } : g.test ? { runner: "container", ...(g.install ? { install: g.install } : {}), test: g.test } : null;
    if (!checks) {
      this.addLog({ kind: "system", message: "gitring found no test command in the files of main. An owner sets it in Settings → Tests." });
      return null;
    }
    p.settings = withDefaults({ ...p.settings, checks });
    this.db.setMeta("project", p);
    this.addLog({
      kind: "system",
      message:
        checks.runner === "worker"
          ? "Tests: the gitring test runner runs tests/*.test.js. An owner can change it in Settings → Tests."
          : `Tests: gitring runs "${checks.test}"${checks.install ? ` after "${checks.install}"` : ""}.${g.guessed ? " A model guessed these commands." : ""} An owner can change them in Settings → Tests.`,
    });
    this.emit({ type: "snapshot", state: await this.state() });
    return checks;
  }

  /**
   * Import a private GitHub repository: the commit at the branch tip, as files, in one gitring commit.
   * gitring remembers that this commit is the GitHub commit, so GitHub sync and pulls continue GitHub's
   * history.
   */
  private snapshotRun?: Promise<void>;

  private async importGithubSnapshot(): Promise<void> {
    const p = this.requireProject();
    const g = p.importing?.github;
    if (!g || !p.importing) return;
    const fail = async (error: string) => {
      if (!p.importing) return;
      p.importing = { ...p.importing, error };
      this.db.setMeta("project", p);
      this.addLog({ kind: "system", message: `Import failed: ${error}` });
      this.emit({ type: "snapshot", state: await this.state() });
    };
    const tries = (g.tries ?? 0) + 1;
    if (tries > 3) return fail(`gitring tried three times to read ${g.repo} and stopped. Try again with a new project, or push the repository with git.`);
    p.importing = { ...p.importing, github: { ...g, tries } };
    this.db.setMeta("project", p);
    // A watchdog: if this run dies (memory), the alarm tries again, at most three times.
    await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
    const retryLater = async (why: string) => {
      this.addLog({ kind: "system", message: `Import of ${g.repo}: ${why} gitring tries again soon.` });
      await this.ctx.storage.setAlarm(Date.now() + 30_000 * tries);
    };
    try {
      const access = await this.directory().githubRepoAccess(g.repo);
      if (!access.ok) {
        if (access.state === "error") return retryLater(access.message);
        return fail(access.installUrl ? `${access.message} Install the app: ${access.installUrl}` : access.message);
      }
      const headers = { "User-Agent": "gitring", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${access.token}` };
      let branch = g.branch;
      if (!branch) {
        const info = await fetch(`https://api.github.com/repos/${g.repo}`, { headers });
        if (info.status >= 500) return retryLater(`GitHub answered ${info.status}.`);
        branch = info.ok ? ((await info.json<{ default_branch?: string }>()).default_branch ?? "main") : "main";
      }
      const res = await fetch(`https://api.github.com/repos/${g.repo}/commits/${encodeURIComponent(branch)}`, { headers: { ...headers, Accept: "application/vnd.github.sha" } });
      if (res.status >= 500) return retryLater(`GitHub answered ${res.status}.`);
      const githubSha = (await res.text()).trim();
      if (!res.ok || !/^[0-9a-f]{40}$/.test(githubSha)) return fail(`GitHub has no branch "${branch}" in ${g.repo}.`);
      p.repo.defaultBranch = branch;
      // An earlier run may have made the commit and then stopped: adopt it.
      const existing = await this.backend.resolve(p.repo.name, branch).catch(() => null);
      if (existing) {
        const meta = await this.backend.readCommit(p.repo.name, existing);
        const m = /Gitring-GitHub: (\S+)@([0-9a-f]{40})/.exec(meta?.message ?? "");
        if (!m || m[1].toLowerCase() !== g.repo.toLowerCase()) return fail("The project's repository already has commits that are not this import.");
        this.setGh(g.repo, { known: { ...this.gh(g.repo).known, [existing]: m[2] }, last: m[2], private: true });
        return this.adoptMain(branch, existing);
      }
      const snap = await githubSnapshot({ repo: g.repo, sha: githubSha, token: access.token });
      if (!snap.files.length) return fail(`${g.repo} has no files on ${branch}.`);
      const files = await this.matchGitTree(g.repo, githubSha, snap.files, access.token);
      this.holdPrivate(g.repo);
      const seed = await this.backend.commit({
        repo: p.repo.name,
        branch,
        parent: "",
        changes: files,
        message: `Import ${g.repo}\n\nThe files of ${branch} at ${githubSha} on GitHub (${files.length} files).\n\nGitring-Seed: github\nGitring-GitHub: ${g.repo}@${githubSha}`,
        author: GITRING_AUTHOR,
      });
      this.setGh(g.repo, { known: { ...this.gh(g.repo).known, [seed.sha]: githubSha }, last: githubSha, private: true });
      await this.adoptMain(branch, seed.sha);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      // Network trouble is worth another try; a repository that is too large is not.
      if (e instanceof SnapshotTooLarge || /larger than|more than|has no/.test(msg)) return fail(msg);
      return retryLater(msg);
    }
  }

  /**
   * GitHub makes tarballs with `git archive`: files marked export-ignore are missing, and line endings or
   * $Id$ can change. gitring compares each file with the commit's tree (git blob ids) and takes the
   * missing or different files from the Git Data API, so that main has exactly GitHub's files.
   * Without the tree (GitHub did not answer three times, or the tree is too large to list) the import
   * attempt fails: a snapshot that gitring could not check is never recorded as GitHub's commit.
   * One byte budget (the snapshot limits) covers the tarball's files and the files read one by one.
   */
  private async matchGitTree(repo: string, sha: string, files: FileChange[], token: string, limits = SNAPSHOT_LIMITS): Promise<FileChange[]> {
    const headers = { "User-Agent": "gitring", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}` };
    const tree = await this.githubTree(repo, sha, headers);
    const want = new Map(tree.filter((e) => e.type === "blob").map((e) => [e.path, e]));
    const out: FileChange[] = [];
    const fix: { path: string; sha: string; mode: string; size: number }[] = [];
    const tooLarge = () => new SnapshotTooLarge(`${repo} is larger than ${Math.round(limits.maxBytes / 1e6)} MB. Push it with git instead (history and all files).`);
    let bytes = 0;
    for (const f of files) {
      const e = want.get(f.path);
      if (!e) continue; // not in the commit (cannot happen for git archive, but stay exact)
      const data = typeof f.content === "string" ? utf8.encode(f.content) : (f.content ?? new Uint8Array());
      if ((await hashObject("blob", data)) === e.sha) {
        out.push({ ...f, mode: e.mode === "100755" ? "100755" : e.mode === "120000" ? "120000" : "100644" });
        bytes += data.length;
      } else fix.push({ path: f.path, sha: e.sha, mode: e.mode, size: e.size ?? 0 });
      want.delete(f.path);
    }
    for (const [path, e] of want) fix.push({ path, sha: e.sha, mode: e.mode, size: e.size ?? 0 });
    if (fix.length > 500) throw new Error(`${fix.length} files of ${repo} differ from its tarball. Push the repository with git instead.`);
    if (out.length + fix.length > limits.maxFiles) throw new SnapshotTooLarge(`${repo} has more than ${limits.maxFiles} files. Push it with git instead.`);
    // The sizes in the tree say what the files read one by one add, before gitring reads any of them.
    if (bytes + fix.reduce((n, x) => n + x.size, 0) > limits.maxBytes) throw tooLarge();
    for (const x of fix) {
      if (x.size > 15_000_000) throw new Error(`${x.path} is larger than 15 MB. Push the repository with git instead.`);
      const blob = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${x.sha}`, { headers: { ...headers, Accept: "application/vnd.github.raw" } });
      if (!blob.ok) throw new Error(`GitHub did not send ${x.path} (${blob.status}).`);
      const content = new Uint8Array(await blob.arrayBuffer());
      bytes += content.length;
      if (bytes > limits.maxBytes) throw tooLarge();
      out.push({ path: x.path, content, mode: x.mode === "100755" ? "100755" : x.mode === "120000" ? "120000" : "100644" });
    }
    return out;
  }

  /** The file list of a commit (GET /git/trees/{sha}?recursive=1), with two more tries after a GitHub error. */
  private async githubTree(repo: string, sha: string, headers: Record<string, string>): Promise<{ path: string; mode: string; type: string; sha: string; size?: number }[]> {
    let last = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 400 * 3 ** (attempt - 2)));
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`, { headers: { ...headers, Accept: "application/vnd.github+json" } });
        if (res.ok) {
          const tree = await res.json<{ truncated?: boolean; tree?: { path: string; mode: string; type: string; sha: string; size?: number }[] }>();
          if (tree.truncated) throw new SnapshotTooLarge(`GitHub does not list all files of ${repo}: it has more than the API shows. Push it with git instead.`);
          if (Array.isArray(tree.tree)) return tree.tree;
          last = "GitHub sent no file list";
        } else {
          last = `GitHub answered ${res.status}`;
          // The commit is gone or the token may not read it: another try does not help now.
          if (res.status === 404 || res.status === 401) break;
        }
      } catch (e) {
        if (e instanceof SnapshotTooLarge) throw e;
        last = String((e as Error)?.message ?? e).slice(0, 120);
      }
    }
    throw new Error(`gitring could not read the file list of ${repo} (${last}).`);
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
   * A push project: a write token for the owner's first `git push` (24 hours). gitring revokes it when
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

  /**
   * A member clones the project with plain git: the remote of main and a read token for 6 hours. The
   * Worker builds the git command (the token goes in a header, not in the URL).
   */
  async cloneAccess(): Promise<{ remote: string; token: string; expiresAt: string; branch: string }> {
    const p = this.requireProject();
    if (p.importing?.error) throw new Error(`The import did not finish: ${p.importing.error}`);
    if (p.importing) throw new Error(p.importing.push ? "This project waits for its first git push. Clone it after the push." : "The repository is still importing. Try again in a minute.");
    const tok = await this.backend.createToken(p.repo.name, "read", 6 * 3600);
    const remote = p.repo.remote ?? (await this.backend.remoteUrl(p.repo.name));
    if (!tok || !remote) throw new Error("gitring cannot give a clone remote now. Try again.");
    return { remote, token: tok.token, expiresAt: tok.expiresAt, branch: this.branch };
  }

  /** "Check now": look for the owner's push without waiting for the alarm. */
  async checkImport(): Promise<T.ProjectState> {
    await this.continueImport();
    return this.state();
  }

  private async readText(repo: string, sha: string): Promise<string | null> {
    const cached = this.db.getBlobText(sha);
    if (cached) return cached.text;
    const bytes = await this.backend.readBlob(repo, sha);
    if (!bytes) return null;
    // Very large files stay opaque: agents do not edit them through gitring, and SQLite rows stay small.
    const text = bytes.length <= MAX_TEXT_BYTES && isProbablyText(bytes) ? utf8.decode(bytes) : null;
    this.db.putBlobText(sha, text);
    return text;
  }

  /** Blob ids → how the text that gitring holds gives the blob: as it is, with a byte order mark first, or not at all. */
  private exactBlobs = new Map<string, "same" | "bom" | "no">();
  /** Blob ids → size in bytes, for blobs that gitring read for a merge. */
  private blobSizes = new Map<string, number>();

  /**
   * The text of the blob `sha` that gives exactly its bytes again as UTF-8, from `text` (the text that gitring
   * holds), or null. The text that gitring reads has no byte order mark: a blob with one gets it back here.
   * Latin-1 text, for example, gives null.
   */
  private async exactText(sha: string, text: string): Promise<string | null> {
    let how = this.exactBlobs.get(sha);
    if (how === undefined) {
      how = (await hashObject("blob", utf8.encode(text))) === sha ? "same" : (await hashObject("blob", utf8.encode(`${BOM}${text}`))) === sha ? "bom" : "no";
      if (this.exactBlobs.size > 20_000) this.exactBlobs.clear();
      this.exactBlobs.set(sha, how);
    }
    return how === "same" ? text : how === "bom" ? `${BOM}${text}` : null;
  }

  /**
   * Blob reads for a merge, a re-plot or the test container. Text comes from what gitring holds (text that
   * only gitring has, the text trees it read, `known` contents), then from the repositories in order. Text is
   * given only when it is exactly the blob, so gitring never changes the bytes of a file that it carries:
   * any other blob goes as bytes. `knownText` never reads a repository (it reads the blob store of the object).
   */
  private blobReader(o: { trees: TreeText[]; repos: string[]; textBlobs?: Map<string, string>; known?: Map<string, string | Uint8Array>; texts?: [string, string][] }): BlobReader {
    const index = new Map<string, string>(o.texts ?? []);
    for (const t of o.trees) {
      for (const [path, e] of t.snapshot) {
        const text = t.text.get(path);
        if (text !== undefined && !index.has(e.sha)) index.set(e.sha, text);
      }
    }
    const repos = [...new Set(o.repos)];
    // Bytes that this reader read once (a merge reads a blob for its size, then for the commit).
    const cache = new Map<string, Uint8Array>();
    let cached = 0;
    const knownText = async (sha: string): Promise<string | null | undefined> => {
      const own = o.textBlobs?.get(sha);
      if (own !== undefined) return own;
      const k = o.known?.get(sha);
      if (k !== undefined) return typeof k === "string" ? k : null;
      let text = index.get(sha);
      if (text === undefined) {
        // A blob that gitring read before (in this project object's store): no repository read.
        const stored = this.db.getBlobText(sha);
        if (!stored) return undefined;
        if (stored.text === null) return null;
        text = stored.text;
      }
      return this.exactText(sha, text);
    };
    const readBytes = async (sha: string): Promise<Uint8Array | null> => {
      const own = o.textBlobs?.get(sha);
      if (own !== undefined) return utf8.encode(own);
      const k = o.known?.get(sha);
      if (k !== undefined) return typeof k === "string" ? utf8.encode(k) : k;
      const hit = cache.get(sha);
      if (hit) return hit;
      for (const repo of repos) {
        const bytes = await this.backend.readBlob(repo, sha).catch(() => null);
        if (!bytes) continue;
        // Keep what readText keeps, so that the next merge or test run knows this blob without a read.
        if (!this.db.getBlobText(sha)) this.db.putBlobText(sha, bytes.length <= MAX_TEXT_BYTES && isProbablyText(bytes) ? utf8.decode(bytes) : null);
        this.blobSizes.set(sha, bytes.length);
        if (this.blobSizes.size > 20_000) this.blobSizes.clear();
        if (cached + bytes.length <= READER_CACHE_BYTES) {
          cache.set(sha, bytes);
          cached += bytes.length;
        }
        return bytes;
      }
      return null;
    };
    const readText = async (sha: string): Promise<string | null> => {
      const held = await knownText(sha);
      if (held !== undefined) return held;
      for (const repo of repos) {
        const text = await this.readText(repo, sha);
        if (text !== null) return this.exactText(sha, text);
      }
      return null;
    };
    return { readText, readBytes, knownText };
  }

  /** A blob reader for the tree of a work copy: its own text first, then its base, then the repositories. */
  private async workReader(a: T.Attempt, view: AttemptView, more: TreeText[] = []): Promise<BlobReader> {
    const p = this.requireProject();
    const base = await this.treeText(p.repo.name, a.baseTree);
    const texts: [string, string][] = [];
    for (const c of view.changed) {
      const e = view.snapshot.get(c.path);
      if (c.head !== null && e) texts.push([e.sha, c.head]);
    }
    return this.blobReader({ trees: [base, ...more], repos: [view.repo, p.repo.name], textBlobs: view.textBlobs, texts });
  }

  /** The parts of the work of a work copy that do not merge, and why. */
  private async leftOut(a: T.Attempt): Promise<NotCarried[]> {
    const view = await this.attemptView(a);
    if (!view.opaque.length) return view.notCarried;
    return [...view.notCarried, ...(await this.largeChanges(view, await this.workReader(a, view)))];
  }

  /**
   * Changes of the work that are too large to carry (see overSize): the size of each changed file without
   * text. A mode change counts too, because the merge writes the bytes of the file again.
   */
  private async largeChanges(view: AttemptView, reader: BlobReader): Promise<NotCarried[]> {
    const sized = view.opaque.filter((c) => c.status !== "D" && c.newSha && c.mode !== "160000");
    const sizes: { path: string; bytes: number }[] = [];
    for (let i = 0; i < sized.length; i += SIZE_READS) {
      await Promise.all(
        sized.slice(i, i + SIZE_READS).map(async (c) => {
          sizes.push({ path: c.path, bytes: this.blobSizes.get(c.newSha!) ?? (await reader.readBytes(c.newSha!))?.length ?? 0 });
        }),
      );
    }
    return overSize(sizes);
  }

  /**
   * The whole tree for the test container: text files as text, the other files as bytes, with their git modes.
   * A file larger than MAX_CARRY_FILE_BYTES, and files past the limits of the test tree, stay out (`left`).
   */
  private async fullTree(snapshot: Snapshot, reader: BlobReader): Promise<{ files: Map<string, PackFile>; left: string[] }> {
    const files = new Map<string, PackFile>();
    const left: string[] = [];
    // Text that gitring holds first; the other files are read from the repositories, a few at a time.
    const blobs: [string, { sha: string; mode: string }][] = [];
    const entries = [...snapshot].filter(([, e]) => e.mode !== "160000");
    for (let i = 0; i < entries.length; i += 64) {
      await Promise.all(
        entries.slice(i, i + 64).map(async ([path, e]) => {
          const text = await reader.knownText(e.sha);
          if (typeof text === "string") files.set(path, { content: text, mode: e.mode });
          else blobs.push([path, e]);
        }),
      );
    }
    blobs.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    let bytes = 0;
    for (let i = 0; i < blobs.length; i += SIZE_READS) {
      await Promise.all(
        blobs.slice(i, i + SIZE_READS).map(async ([path, e], j) => {
          const size = this.blobSizes.get(e.sha);
          if (i + j >= MAX_TEST_TREE_READS || (size !== undefined && (size > MAX_CARRY_FILE_BYTES || bytes + size > MAX_TEST_TREE_BYTES))) {
            left.push(path);
            return;
          }
          const content = await reader.readBytes(e.sha);
          if (!content || content.length > MAX_CARRY_FILE_BYTES || bytes + content.length > MAX_TEST_TREE_BYTES) {
            left.push(path);
            return;
          }
          bytes += content.length;
          files.set(path, { content, mode: e.mode });
        }),
      );
    }
    return { files, left: left.sort() };
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
      const aliases = pathAliasesOf(tt.text);
      const graph = buildImportGraph(analyzable, aliases);
      const index = symbolIndex(analyzable);
      const view: MainView = {
        ...tt,
        sha: p.mainSha,
        files: fileNodes(tt.snapshot, tt.text),
        graph,
        imports: graph.edges.map(([a, b]) => [a, b] as [string, string]),
        signatures: index.signatures,
        definedIn: index.definedIn,
        ...(aliases ? { aliases } : {}),
      };
      this.mainView = view;
      return view;
    })().finally(() => {
      this.mainLoading = undefined;
    });
    return this.mainLoading;
  }

  /** The place of a commit in main's history, or -1 when it never was main. */
  private mainPlace(sha: string): number {
    return this.mainIndex.get(sha) ?? -1;
  }

  /** A commit becomes main: it gets the next place (a commit that was main already keeps its place). */
  private appendMainSeq(sha: string): void {
    this.mainIndex.set(sha, this.db.appendMain(sha));
  }

  /** Main starts at one commit (a new repository). */
  private resetMainSeq(sha: string): void {
    this.mainIndex = new Map([[sha, this.db.resetMain(sha)]]);
  }

  private bump(attemptId: string): void {
    this.attemptVersion.set(attemptId, (this.attemptVersion.get(attemptId) ?? 0) + 1);
  }

  /**
   * Files, changes and signatures of an attempt (cached per content version, base and head). Calls that come
   * while the view is made wait for the same view: they do not make it again.
   */
  private attemptView(a: T.Attempt): Promise<AttemptView> {
    const version = this.attemptVersion.get(a.id) ?? 0;
    const key = `${version}:${a.baseTree}:${a.headSha ?? ""}`;
    const cached = this.attemptViews.get(a.id);
    if (cached && cached.key === key) return Promise.resolve(cached.view);
    const loading = this.attemptViewLoads.get(a.id);
    if (loading && loading.key === key) return loading.view;
    const view = this.makeAttemptView(a, version, key).finally(() => {
      if (this.attemptViewLoads.get(a.id)?.view === view) this.attemptViewLoads.delete(a.id);
    });
    this.attemptViewLoads.set(a.id, { key, view });
    return view;
  }

  /**
   * Blob id of a text, at once: a view of a work copy must not wait for WebCrypto, or many calls wait for the
   * same view. A view hashes the same written files again and again, so the ids stay cached.
   */
  private textBlobId(text: string): string {
    const hit = this.textIds.get(text);
    if (hit) return hit;
    const sha = hashObjectSync("blob", utf8.encode(text));
    if (this.textIdChars + text.length > TEXT_ID_CHARS) {
      this.textIds.clear();
      this.textIdChars = 0;
    }
    this.textIds.set(text, sha);
    this.textIdChars += text.length;
    return sha;
  }

  private async makeAttemptView(a: T.Attempt, version: number, key: string): Promise<AttemptView> {
    const p = this.requireProject();
    const headSha = a.headSha;
    const base = await this.treeText(p.repo.name, a.baseTree);
    // The tree that the work starts from: the last push in git mode, else the base.
    let tt = base;
    let repo = p.repo.name;
    if (a.mode === "git") {
      const head = headSha ? await this.backend.readCommit(a.fork.repo, headSha) : null;
      if (head) {
        tt = await this.treeText(a.fork.repo, head.treeHash);
        repo = a.fork.repo;
      }
    }
    // Text on top: shadow edits (from the Claude Code hook) on the last push, or the written files of api mode.
    const overlay = this.db.worktree(a.id);
    const files = overlayFiles(tt.text, overlay);
    const { snapshot: real, textBlobs } = await overlaySnapshot(tt.snapshot, overlay, (text) => this.textBlobId(text));
    // What merges: every real change, with a few parts left out (and named to the agent).
    const plan = planCarry(base.snapshot, real, new Set(overlay.keys()));
    const paths = diffSnapshots(base.snapshot, plan.work).map((c) => c.path);
    const changed = changedVersions(base.text, files, paths, { base: base.snapshot, head: plan.work });
    const opaque = opaqueChanges(base.snapshot, plan.work, changed);
    const { signatures, imports } = footprintOf(changed, new Set(files.keys()), this.footprintOptions());
    const view: AttemptView = { version, files, changed, signatures, imports, snapshot: plan.work, repo, textBlobs, opaque, notCarried: plan.notCarried };
    this.attemptViews.set(a.id, { key, view });
    return view;
  }

  /** What a footprint knows from main: the path aliases, and the members of classes and objects. */
  private footprintOptions(): FootprintOptions {
    const main = this.mainView;
    return main ? { aliases: main.aliases, knownMember: knownMemberOf(main.definedIn) } : {};
  }

  /** Check files are written by gitring, not by agents: they never count as a collision. */
  private checkPaths(): Set<string> {
    return new Set([...this.intents.values()].flatMap((i) => i.checks.map((c) => c.path)));
  }

  private async refreshFootprint(a: T.Attempt): Promise<AttemptView> {
    this.bump(a.id);
    // The footprint reads the aliases and the members of main (see footprintOptions).
    if (!this.mainView) await this.loadMain().catch(() => undefined);
    const view = await this.attemptView(a);
    const managed = this.checkPaths();
    const own = view.changed.filter((c) => !managed.has(c.path));
    const { footprint } = footprintOf(own, new Set(view.files.keys()), this.footprintOptions());
    a.footprint = footprint;
    a.meaning = changeMeaning(own, view.opaque.map((c) => c.path));
    let additions = 0;
    let deletions = 0;
    for (const t of Object.values(footprint.files)) {
      additions += t.additions;
      deletions += t.deletions;
    }
    a.stats = { ...a.stats, filesChanged: Object.keys(footprint.files).length + view.opaque.length, additions, deletions };
    await this.withdrawIfChanged(a, view);
    return view;
  }

  /* ════════════════════════════ events, logs, stats ════════════════════════════ */

  private emit(ev: T.GitringEvent): void {
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
    // Viewers (people who only watch a public project) do not get member-only data: every event goes
    // through forViewer, the one place that decides what they see.
    const viewerBatch = batch.map(forViewer);
    const viewerData = viewerBatch.every((e, i) => e === batch[i]) ? data : JSON.stringify(viewerBatch.length === 1 ? viewerBatch[0] : viewerBatch);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(this.ctx.getTags(ws).includes("viewer") ? viewerData : data);
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
    // A task that does not wait for a person any more: its open redo question has no use.
    if (i.status !== "judging") this.closeRedoQuestions(i.id, "A person or an agent acted on the task.");
  }

  private putAttempt(a: T.Attempt): void {
    // An approval waits only while the work copy is "ready". In any other state no answer can come.
    if (a.approval?.status === "waiting" && a.status !== "ready") this.closeApproval(a, closedBecause(a.status));
    a.updatedAt = Date.now();
    this.attempts.set(a.id, a);
    this.db.putAttempt(a);
    this.emit({ type: "attempt", attempt: a });
    this.wakeOnChange(a);
    if (TERMINAL.has(a.status)) this.closeQuestionsOf(a);
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
    if (c.status === "pending") this.wake(c.attemptId, requestEvent(c.id, c.kind));
  }

  private putQuestion(q: T.Question): void {
    q.updatedAt = Date.now();
    this.questions.set(q.id, q);
    this.db.putQuestion(q);
    this.emit({ type: "question", question: q });
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
      questions: this.questionList(),
      logs: this.logs.slice(-400),
      radar: [...this.radar.values()],
      files: main.files,
      imports: main.imports,
      stats: { ...this.stats, medianCheckLatencyMs: median(this.checkLatencies) },
    };
  }

  /* ════════════════════════════ WebSocket (hibernation API) ════════════════════════════ */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const projectId = url.searchParams.get("project") ?? "";
      await this.ensure(projectId);
      // The Worker checked the role and says it here (only the Worker can reach this object). The tags
      // name the role and the person, so that a change of access closes the right sockets.
      const viewer = url.searchParams.get("role") === "viewer";
      const user = url.searchParams.get("user") ?? "";
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, [viewer ? "viewer" : "member", user ? `u:${user}` : "anon"]);
      const snapshot: T.GitringEvent = { type: "snapshot", state: await this.state() };
      server.send(JSON.stringify(viewer ? forViewer(snapshot) : snapshot));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * Access changed: close the live connections that it concerns, so that each one connects again and
   * gets its role checked (a removed member, a signed-out person, a project that became private or
   * archived). The close code tells the browser what to do: 4401 sign in, 4403 the access changed.
   */
  async closeSockets(who: { userId?: string; viewers?: boolean; all?: boolean }, code: 4401 | 4403 = 4403): Promise<number> {
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      const hit = who.all || (who.userId && tags.includes(`u:${who.userId}`)) || (who.viewers && tags.includes("viewer"));
      if (!hit) continue;
      try {
        ws.close(code, code === 4401 ? "Sign in again." : "Your access to this project changed.");
        n++;
      } catch {
        /* already closed */
      }
    }
    return n;
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

  async declare(input: T.DeclareInput & { attemptId?: string; projectId?: string; workdir?: string; by?: T.Actor }): Promise<T.DeclareResult> {
    await this.ensure(input.projectId);
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
    if (!intent) throw new Error("Unknown task. Give intentId from gitring_intents, or give newIntent.");
    if (intent.status === "landed" || intent.status === "parked") {
      throw new Error(`The task "${intent.title}" is ${taskStatusWord(intent.status)}. Choose an open task.`);
    }

    const mode = input.mode ?? "api";
    let attempt = input.attemptId ? this.attempts.get(input.attemptId) : undefined;
    const now = Date.now();
    const uses = [...new Set((input.uses ?? []).map(String))].slice(0, 100);
    const course: T.Course = {
      plan: (input.plan ?? []).slice(0, 20).map(String),
      files: [...new Set((input.files ?? []).map(normPath))],
      symbols: [...new Set((input.symbols ?? []).map(String))],
      ...(uses.length ? { uses } : {}),
      approach: String(input.approach ?? "").slice(0, 400),
      // A new plan for the same work copy keeps the time of the first plan: R4 compares the true order.
      declaredAt: attempt?.course.declaredAt ?? now,
    };
    // The rules by folder: a plan that touches files only other people's agents may change is refused here,
    // before any work exists. The other rules go into the answer as plain sentences.
    const ruled = checkFolderRules(p.settings.folderRules, course.files, (attempt?.sender ?? personOf(input.by))?.id);
    const refusal = planRefusal(ruled);
    if (refusal) throw new Error(refusal);
    const rules = planNotes(ruled);
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
        ...(personOf(input.by) ? { sender: personOf(input.by) } : {}),
        createdAt: now,
        updatedAt: now,
      };
    } else {
      if (!attempt.sender && personOf(input.by)) attempt.sender = personOf(input.by);
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
      message: `${agent.callsign} sends a plan for "${intent.title}": ${course.approach || course.plan[0] || "no approach given"}`,
      files: course.files,
    });

    // Fork: git mode needs the remote now. Api mode makes no fork: the work lives in gitring's own
    // storage as a changeset over main. A fork is made later, on demand (`workCopyRemote`).
    let workspace: T.DeclareResult["workspace"] = { mode, baseSha: attempt.baseSha };
    if (mode === "git") {
      await this.ensureFork(attempt, intent);
      const tok = await this.backend.createToken(attempt.fork.repo, "write", 6 * 3600);
      workspace = {
        mode,
        baseSha: attempt.baseSha,
        remote: attempt.fork.remote ?? (await this.backend.remoteUrl(attempt.fork.repo)),
        token: tok?.token,
        tokenExpiresAt: tok?.expiresAt,
      };
    }

    await this.refreshFootprint(attempt);
    // A work copy is in flight: the steward (when on) watches from now on.
    await this.armSteward();
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
      ...(rules.length ? { rules } : {}),
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
          message: `Add the tests of "${intent.title}"\n\nGitring-Intent: ${intent.id}\nGitring-Attempt: ${a.id}`,
          author: GITRING_AUTHOR,
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

  async log(input: T.LogInput, call: CallInfo = {}): Promise<T.Clearance> {
    const a = this.mustAttempt(input.attemptId);
    this.mayChange(a, call.viewer);
    this.heard(a);
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
      await this.refreshGitBase(a);
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
    await this.courseCheck(a.id, trigger);
    return this.clearanceFor(a.id);
  }

  /**
   * Git mode: when the agent merged a newer main into its work (git pull), its base is that main commit.
   * gitring looks for main commits in the pushed history (at most 300 commits back) and moves the base
   * to the newest one, so that the next merge compares the work with the main that the agent saw.
   */
  private async refreshGitBase(a: T.Attempt): Promise<void> {
    if (a.mode !== "git" || !a.headSha) return;
    const from = this.mainPlace(a.baseSha);
    let best = from;
    let bestSha: string | undefined;
    const seen = new Set<string>();
    const queue = [a.headSha];
    while (queue.length && seen.size < 300) {
      const sha = queue.shift()!;
      if (seen.has(sha) || sha === a.baseSha) continue;
      seen.add(sha);
      const at = this.mainIndex.get(sha);
      if (at !== undefined && at > from) {
        if (at > best) {
          best = at;
          bestSha = sha;
        }
        continue; // older main commits are behind this one
      }
      const c = await this.backend.readCommit(a.fork.repo, sha).catch(() => null);
      if (c) queue.push(...c.parents);
    }
    if (!bestSha) return;
    const commit = await this.backend.readCommit(this.requireProject().repo.name, bestSha).catch(() => null);
    if (!commit) return;
    const from7 = a.baseSha.slice(0, 7);
    a.baseSha = bestSha;
    a.baseTree = commit.treeHash;
    this.attemptViews.delete(a.id);
    this.addLog({ kind: "replot", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${this.callsign(a.id)} merged main into its work: its base moves from ${from7} to ${bestSha.slice(0, 7)}.` });
  }

  /**
   * Git mode: take the latest push to the work copy, so that an agent that did not report its push with
   * gitring_log is still checked and tested on its own code. Returns true when the head moved.
   */
  private async adoptForkTip(a: T.Attempt): Promise<boolean> {
    if (a.mode !== "git" || TERMINAL.has(a.status)) return false;
    const tip = await this.backend.resolve(a.fork.repo, this.branch).catch(() => null);
    if (!tip || tip === a.headSha) return false;
    a.headSha = tip;
    this.db.clearWorktree(a.id); // the push supersedes shadow edits
    if (a.status === "declared") a.status = "underway";
    await this.refreshGitBase(a);
    await this.refreshFootprint(a);
    this.putAttempt(a);
    this.addLog({
      kind: "push",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${this.callsign(a.id)} pushed ${tip.slice(0, 7)} to its work copy.`,
      files: Object.keys(a.footprint.files),
    });
    await this.courseCheck(a.id, "push");
    return true;
  }

  async write(input: T.WriteInput, call: CallInfo = {}): Promise<T.WriteResult> {
    const a = this.mustAttempt(input.attemptId);
    this.mayChange(a, call.viewer);
    this.heard(a);
    if (TERMINAL.has(a.status)) throw new Error(`Work copy ${a.id} is ${copyStatusWord(a.status)}. ${this.overAdvice(a)}`);
    if (a.mode === "git") throw new Error("This work copy uses git mode. Push to its remote. gitring reads your latest push at gitring_check and gitring_submit.");
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
      if (path.startsWith(".gitring/")) continue;
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
        (merged.length ? ` gitring merged the write with main changes in ${merged.join(", ")}.` : "") +
        (refused.length ? ` gitring did not write ${refused.map((r) => r.path).join(", ")}: the file changed after the last read.` : ""),
      files: written,
    });
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

  /**
   * A file of a work copy. Every member can read it. Only a read of the agent (the person who sent it, or a call
   * from inside gitring) is an answer of the agent and the base of its next write of the file.
   */
  async read(attemptId: string, path: string, call: CallInfo = {}): Promise<{ path: string; content: string | null }> {
    const a = this.mustAttempt(attemptId);
    const mine = this.sentBy(a, call.viewer);
    if (mine) this.heard(a);
    const view = await this.attemptView(a);
    const p = normPath(path);
    const content = view.files.get(p) ?? null;
    if (mine && a.mode === "api" && !TERMINAL.has(a.status)) {
      this.db.setSeen(a.id, p, content);
      this.db.setMustRead(a.id, p, false);
    }
    return { path: p, content };
  }

  /**
   * A write against what the agent last saw of the file. Main can move a file under an API-mode
   * agent (a re-plot): a write from the older copy merges 3-way with the landed change, or gitring
   * refuses it ("read again") when the two overlap, or when one side deleted the file. A file that
   * gitring reset to the main version must be read before the agent writes it.
   */
  private guardWrite(a: T.Attempt, path: string, content: string | null, current: string | null): { content: string | null; merged?: boolean; refused?: string } {
    if (this.db.mustRead(a.id, path)) {
      return { content, refused: `gitring kept the main version of ${path}. Read ${path}, then make your change again on the new text.` };
    }
    const seen = this.db.seen(a.id, path);
    if (seen === undefined || seen === current || content === current) return { content };
    if (content === null) return { content, refused: `${path} changed on main after your last read. Read ${path} again before you delete it.` };
    if (current === null) return { content, refused: `Main deleted ${path} after your last read. Call gitring_traffic before you add ${path} again.` };
    const m = merge3(seen ?? "", current, content);
    if (!m.clean) return { content, refused: `${path} changed after your last read: main moved. Read ${path} again, then write your change on the new text.` };
    return { content: m.content, merged: m.content !== content };
  }

  async list(attemptId: string, dir?: string, call: CallInfo = {}): Promise<string[]> {
    const a = this.mustAttempt(attemptId);
    if (this.sentBy(a, call.viewer)) this.heard(a);
    const view = await this.attemptView(a);
    const prefix = dir ? normPath(dir).replace(/\/?$/, "/") : "";
    return [...view.files.keys()].filter((p) => !prefix || p.startsWith(prefix)).sort();
  }

  async traffic(attemptId: string, call: CallInfo = {}): Promise<T.TrafficReport> {
    const a = this.mustAttempt(attemptId);
    if (this.sentBy(a, call.viewer)) this.heard(a);
    const main = await this.loadMain();
    const vessels = this.trafficFor(a);
    const baseIdx = this.mainPlace(a.baseSha);
    const landed = this.landings.filter((l) => this.mainPlace(l.mainAfter) > baseIdx);
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

  /**
   * The agent confirms a change request. gitring checks the code of the work copy against the constraints of
   * the request (see ack-check.ts). When the code still breaks them, the request stays open and the answer
   * says what to change. An id that is not an open request of this work copy is an error that names the open ones.
   */
  async ack(attemptId: string, correctionId: string, note?: string, call: CallInfo = {}): Promise<T.AckResult> {
    const a = this.mustAttempt(attemptId);
    this.mayChange(a, call.viewer);
    this.heard(a);
    const c = this.corrections.get(String(correctionId ?? "").trim());
    const answer = (outcome: T.AckResult["outcome"], message: string): T.AckResult => ({ correctionId, outcome, ...(c?.check ? { check: c.check } : {}), message, clearance: this.clearanceFor(a.id) });
    if (!c || c.attemptId !== a.id) throw new Error(`${correctionId || "This id"} is not a change request of work copy ${a.id}. ${this.openRequestsLine(a)}`);
    if (c.status === "superseded") throw new Error(`The change request ${c.id} is old: a newer change request replaced it. ${this.openRequestsLine(a)}`);
    if (c.status === "acknowledged") return answer("already", `You confirmed ${c.id} before.`);
    if (c.status === "closed") return answer("already", `The change request ${c.id} closed when the work merged.`);
    // The latest push of a git-mode work copy is the code that the agent confirms.
    await this.adoptForkTip(a);
    const view = await this.attemptView(a);
    const standOn = c.standOnAttemptId ? this.attempts.get(c.standOnAttemptId) : undefined;
    // The lines of a request count while the work that holds them is still in the traffic.
    const regions = !c.standOnAttemptId || (!!standOn && ACTIVE.has(standOn.status));
    const now = Date.now();
    const result = checkAck(c, { footprint: a.footprint, files: view.files, signatures: view.signatures }, { regions });
    c.check = { ...result, at: now };
    c.ackNote = note ? String(note).slice(0, 300) : c.ackNote;
    if (result.applied === false) {
      // The agent knows the request now: it stays open, and it does not come again as new.
      c.status = "delivered";
      c.deliveredAt = c.deliveredAt ?? now;
      this.putCorrection(c);
      this.addLog({ kind: "ack", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${this.callsign(a.id)} confirms ${c.id}, but the code check fails: ${result.reason}` });
      return answer("open", `${result.reason} Change it, then call gitring_ack again. The change request stays open.`);
    }
    c.status = "acknowledged";
    c.acknowledgedAt = now;
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
    return answer("acknowledged", result.applied ? `Confirmed. ${result.reason}` : "Confirmed.");
  }

  /** "Open change requests of a_1: cr_1, cr_2." or "Work copy a_1 has no open change request." */
  private openRequestsLine(a: T.Attempt): string {
    const open = a.corrections.filter((id) => {
      const s = this.corrections.get(id)?.status;
      return s === "pending" || s === "delivered";
    });
    return open.length ? `Open change requests of ${a.id}: ${open.join(", ")}.` : `Work copy ${a.id} has no open change request.`;
  }

  /**
   * The first prompt of a built-in agent: the task, the tests, and the text of the files it likely needs, in
   * rank order. `model` sets the size: a model with a 1M-token context (GLM 5.3) gets far more file text.
   */
  async brief(attemptId: string | undefined, intentId?: string, opts: { model?: string } = {}): Promise<Brief> {
    const a = attemptId ? this.attempts.get(attemptId) : undefined;
    const intent = this.intents.get(a?.intentId ?? intentId ?? "");
    if (!intent) throw new Error("Unknown task.");
    const main = await this.loadMain();
    const files = a ? (await this.attemptView(a)).files : main.text;
    const context: Record<string, string> = {};
    const size = contextBudget(opts.model);
    let budget = size.briefChars;
    const wanted = new Set([...(intent.scope?.paths ?? []), ...(a?.course.files ?? [])].map(normPath));
    for (const [path, text] of rankForBrief(files, intent, wanted)) {
      if (/(^|\/)tests?\//.test(path) && !intent.checks.some((c) => c.path === path) && !wanted.has(path)) continue;
      // A huge file stays out (the agent reads it with read_file when it needs it).
      if (text.length > size.fileChars || budget - text.length < 0) continue;
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
    await this.ensure(this.project?.id);
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

  /**
   * Clearance for an agent: deliver pending corrections once (piggyback). `deliver: false` (a caller that did
   * not send the agent): the verdict and the traffic, and the change requests stay for the agent.
   */
  private clearanceFor(attemptId: string, deliver = true): T.Clearance {
    const a = this.mustAttempt(attemptId);
    const pending = deliver ? a.corrections.map((id) => this.corrections.get(id)).filter((c): c is T.Correction => !!c && c.status === "pending") : [];
    const now = Date.now();
    for (const c of pending) {
      c.status = "delivered";
      c.deliveredAt = now;
      this.putCorrection(c);
    }
    // A check names a pair, and "correct" means that one agent of the pair changes course. The agent that
    // keeps its lines has no change request: its answer says "clear", and not "change request".
    const open = a.corrections.some((id) => {
      const c = this.corrections.get(id);
      return c?.status === "pending" || c?.status === "delivered";
    });
    const checked = latestCheck(this.checks, attemptId)?.verdict;
    const verdict = checked === "correct" && !open ? "clear" : checked;
    return this.withQuestions(a, clearance(verdict, notices(pending, (id) => this.callsign(id)), this.trafficFor(a)));
  }

  /** Both agents of an escalated pair read that a person decides, and that they continue. */
  private withQuestions(a: T.Attempt, clr: T.Clearance): T.Clearance {
    const q = [...this.questions.values()].find((x) => x.status === "open" && x.kind === "escalation" && x.attemptIds.includes(a.id));
    if (!q) return clr;
    const otherId = q.attemptIds.find((id) => id !== a.id);
    const words = `A person decides how your work and the work of ${this.callsign(otherId) ?? "another agent"} fit together. Continue your work. If your work must change, gitring sends a change request.`;
    return { ...clr, advice: clr.verdict === "escalate" && !clr.corrections.length ? words : `${clr.advice} ${words}` };
  }

  /* ════════════════════════════ course check ════════════════════════════ */

  private trafficViews(incoming: T.Attempt, main: MainView, signatures: Map<string, AttemptView>): VesselView[] {
    const baseIdx = this.mainPlace(incoming.baseSha);
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
        if (landing && this.mainPlace(landing.mainAfter) > baseIdx) state = "landed";
      }
      if (!state) continue;
      views.push(vesselView(other, intent, agent, signatures.get(other.id)?.signatures, main.signatures, state, main.definedIn));
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
    const incoming = vesselView(a, intent, agent, views.get(a.id)?.signatures, main.signatures, WAITING.has(a.status) ? "waiting" : "active", main.definedIn);
    const traffic = this.trafficViews(a, main, views);
    const previous = new Map<string, T.Range>();
    for (const v of traffic) {
      const pr = this.radar.get(pairKey(a.id, v.attempt.id));
      if (pr) previous.set(v.attempt.id, pr.range);
    }
    // Main plus the imports that the work copies of this check add (new files included).
    const graph = checkGraph(main, views.values(), this.checkPaths());
    const measured = measureTraffic(incoming, traffic, graph, previous);
    const cands = pickCandidates(measured, 3).map((c) => ({
      view: c.view,
      facts: buildPairFacts(incoming, c.view, graph, previous.get(c.view.attempt.id)),
    }));

    let source: T.CourseCheck["source"] = "rules";
    let assessments: T.CourseAssessment[] = [];
    let confidence = 1;
    let duplicate = 0;
    let raw: Record<string, unknown> | undefined;

    if (cands.length) {
      const rules = assessWithRules(incoming, cands);
      const model = p.settings.decisionModel;
      // Soft pairs (one import apart or more) cannot reach a correction, so the model cannot change the verdict.
      // The fixed rules decide then, and no model call is made.
      if (model !== "rules" && !modelCannotChangeVerdict(cands.map((c) => c.facts), p.settings.thresholds)) {
        // "clef" asks the large model first (the fast model answers when it does not). "clef-flash" asks the
        // fast model, and the large model only for ambiguous pairs.
        const large = model === "clef";
        let first = await callClef(this.env.AI as never, buildBriefClefRequest(large ? "clef" : "clef-flash", incoming, cands), large ? 6000 : undefined);
        if (!first && large) first = await callClef(this.env.AI as never, buildBriefClefRequest("clef-flash", incoming, cands));
        if (first) {
          let parsed = parseClefResponse(first.res, incoming, cands);
          let used = first;
          raw = { clef: first.res.answers, model: first.model, latencyMs: first.latencyMs, missing: parsed.missing };
          // Escalate to the 27B model only for ambiguous pairs: no hard facts, close range, a coin-flip answer.
          const ambiguous = !large && cands.some((c) => {
            const as = parsed.assessments.find((x) => x.otherAttemptId === c.view.attempt.id);
            return as && !hasHardFacts(c.facts) && c.facts.range <= 2 && as.collision >= 0.35 && as.collision <= 0.65;
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
          // Only the pairs that need a change request count: a doubt about an unrelated pair cannot send the check to a person.
          confidence = modelConfidence(
            cands.map((c) => ({ facts: c.facts, assessment: assessments.find((x) => x.otherAttemptId === c.view.attempt.id) })),
            p.settings.thresholds,
          );
          const maxSim = Math.max(0, ...cands.map((c) => c.facts.intentSimilarity));
          const clefDup = parsed.duplicate >= 0.7 && maxSim >= DUPLICATE_MIN_SIMILARITY ? parsed.duplicate : Math.min(parsed.duplicate, DUPLICATE_UNSHARED_CAP);
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

    // Radar: record range and closing for every measured pair, near or far, so that the next check sees a far
    // pair come closer. A candidate pair gets the verdict of this check. A far pair is too far apart to collide:
    // "clear". A near pair after the 20 candidates keeps its last verdict. A pair that is not a candidate is
    // written only when it changes.
    const pairs: T.RadarPair[] = [];
    const candidateIds = new Set(cands.map((c) => c.view.attempt.id));
    for (const m of measured) {
      const id = m.view.attempt.id;
      const before = this.radar.get(pairKey(a.id, id));
      const candidate = candidateIds.has(id);
      const far = m.range > 3 && !m.closing;
      const verdict = candidate ? check.verdict : far ? "clear" : before?.verdict;
      if (!candidate && before && before.range === m.range && before.closing === m.closing && before.verdict === verdict) continue;
      const pair: T.RadarPair = { a: a.id, b: id, range: m.range, closing: m.closing, updatedAt: Date.now() };
      if (verdict) pair.verdict = verdict;
      this.radar.set(pairKey(pair.a, pair.b), pair);
      this.db.putRadar(...sortPair(pair.a, pair.b), pair);
      pairs.push(pair);
    }
    if (pairs.length) this.emit({ type: "radar", pairs });
    this.trimRadar();

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
        `Conflict check (${TRIGGER_WORD[trigger] ?? trigger}): ${VERDICT_WORD[check.verdict] ?? check.verdict}. ` +
        (cands.length ? `${cands.length} other work ${cands.length > 1 ? "copies" : "copy"} near, closest at distance ${closest}` : "No other work near") +
        (closing.length ? `, coming closer: ${closing.join(", ")}` : "") +
        ` · ${source === "rules" ? "rules" : "AI model"} ${latencyMs} ms`,
      data: { checkId: check.id, source, latencyMs },
    });

    if (check.verdict === "correct" || check.verdict === "escalate") {
      for (const c of outcome.corrections) {
        const other = cands.find((x) => x.view.attempt.id === c.otherAttemptId);
        if (!other) continue;
        const giveWayView = c.giveWay === "incoming" ? incoming : other.view;
        const standOnView = c.giveWay === "incoming" ? other.view : incoming;
        if (giveWayView.state === "landed") continue;
        if (check.verdict === "escalate") {
          // A person decides first: gitring asks which work adapts. Both agents continue while they wait.
          if (other.view.state !== "landed") this.askAboutPair(incoming, other.view, c.facts, check.id);
          continue;
        }
        const drafted = draftCorrection(giveWayView, standOnView, c.facts, c.rule, c.giveWay);
        this.issueCorrection(giveWayView.attempt.id, standOnView.attempt.id, drafted, c.rule, check.id, severityOf(c.facts));
      }
    } else if (check.verdict === "merge-intents" && outcome.duplicateOf) {
      const other = cands.find((x) => x.view.attempt.id === outcome.duplicateOf);
      if (other) {
        const drafted = draftDuplicateCorrection(incoming, other.view);
        this.issueCorrection(a.id, other.view.attempt.id, drafted, "R4-first-declared-stands-on", check.id, 100);
      }
      // The same task as other work does not end the check: the other pairs that collide get their change requests too.
      this.correctOtherPairs(outcome.corrections, cands, incoming, check.id);
    }
    this.persistStats();
    return check;
  }

  /**
   * The radar keeps far pairs too, so it grows with each check. Above `max` pairs, it forgets each pair with a
   * side that left the traffic for good (merged, stopped, replaced): no check and no view reads those pairs again.
   */
  private trimRadar(max = MAX_RADAR_PAIRS): void {
    if (this.radar.size <= max) return;
    const gone = (id: string): boolean => {
      const x = this.attempts.get(id);
      return !x || TERMINAL.has(x.status);
    };
    for (const [key, pair] of this.radar) {
      if (!gone(pair.a) && !gone(pair.b)) continue;
      this.radar.delete(key);
      this.db.deleteRadar(...sortPair(pair.a, pair.b));
    }
  }

  /** The change requests of the flagged pairs of a "merge-intents" check (the duplicate pair is not one of them). */
  private correctOtherPairs(corrections: ReturnType<typeof decide>["corrections"], cands: { view: VesselView; facts: T.PairFacts }[], incoming: VesselView, checkId: string): void {
    for (const c of corrections) {
      const other = cands.find((x) => x.view.attempt.id === c.otherAttemptId);
      if (!other) continue;
      const giveWayView = c.giveWay === "incoming" ? incoming : other.view;
      const standOnView = c.giveWay === "incoming" ? other.view : incoming;
      if (giveWayView.state === "landed") continue;
      const drafted = draftCorrection(giveWayView, standOnView, c.facts, c.rule, c.giveWay);
      this.issueCorrection(giveWayView.attempt.id, standOnView.attempt.id, drafted, c.rule, checkId, severityOf(c.facts));
    }
  }

  private issueCorrection(
    attemptId: string,
    standOnAttemptId: string | undefined,
    drafted: { kind: T.CorrectionKind; message: string; constraints: T.Correction["constraints"] },
    rule: T.RuleOfTheRoad | "human",
    checkId: string,
    severity = 50,
    /**
     * The change request answers an event: a person changes the task or sends the work back, the work does not
     * merge, GitHub changes main. Each event is news for the agent. The agent gets the new request, even when it
     * did not confirm the earlier request of the same kind (or already did).
     */
    event = false,
  ): T.Correction | undefined {
    const target = this.attempts.get(attemptId);
    if (!target || !ACTIVE.has(target.status)) return undefined;
    // One live correction per (vessel, stand-on vessel, kind). Refresh it in place; send a new one
    // only when the situation gets worse (closer range, more overlapping lines, a new interface).
    // Many work copies can edit the same lines. The agent gets one change request for those lines, not one for
    // each work copy: a work copy that edits lines that a live change request already names joins that request.
    // An event is not a situation that gets worse: a new event always gives a new change request (see `event`).
    const regions = regionKey(drafted);
    for (const id of target.corrections) {
      const old = this.corrections.get(id);
      if (regions && old && standOnAttemptId && old.kind === "region" && old.status !== "superseded" && old.standOnAttemptId && old.standOnAttemptId !== standOnAttemptId && regionKey(old) === regions) {
        const first = this.attempts.get(old.standOnAttemptId);
        if (first && ACTIVE.has(first.status)) {
          if (!old.alsoStandOn?.includes(standOnAttemptId)) {
            // The request names the work copy that was declared last. The agent waits for that one, so the agents in a row
            // go one after the other (each waits for the one before it). If it named the first one, all would wake together.
            const joined = this.attempts.get(standOnAttemptId);
            if (joined && joined.course.declaredAt > first.course.declaredAt) {
              old.alsoStandOn = [...(old.alsoStandOn ?? []), old.standOnAttemptId];
              old.standOnAttemptId = standOnAttemptId;
              old.message = drafted.message;
              old.constraints = drafted.constraints;
            } else {
              old.alsoStandOn = [...(old.alsoStandOn ?? []), standOnAttemptId];
            }
            this.putCorrection(old);
          }
          return undefined;
        }
      }
      if (event && old && old.kind === drafted.kind && old.standOnAttemptId === standOnAttemptId && old.status !== "superseded") {
        // The same words, and the agent did not read them yet: it gets them once.
        if (old.status === "pending" && old.message === drafted.message) return undefined;
        // Else the new request replaces the old one, and it always goes to the agent.
        old.status = "superseded";
        this.putCorrection(old);
        continue;
      }
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
            reason: `Change request ${corr.id} (${KIND_WORD[drafted.kind] ?? drafted.kind}) for ${this.callsign(attemptId)}`,
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
      // The activity feed keeps the sentences; the earlier diffs stay on the change request itself.
      message: `Change request for ${this.callsign(attemptId)} (${KIND_WORD[drafted.kind] ?? drafted.kind}${standOnAttemptId ? `; ${this.callsign(standOnAttemptId)} continues` : ""}): ${drafted.message.split("\n\n")[0]}`,
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
      `Your task "${newIntent.title}" is the same as "${target.title}". gitring joins your work copy to that task. ` +
      `Follow its goal and tests. gitring compares your work with the other work copies. Continue your work.`;
    if (dupCorr) {
      dupCorr.message = msg;
      this.putCorrection(dupCorr);
    }
    this.addLog({ kind: "intent", intentId: target.id, attemptId: a.id, message: `"${newIntent.title}" is the same task as "${target.title}". ${this.callsign(a.id)} becomes another work copy on it.` });
    await this.refreshFootprint(a);
    return (await this.courseCheck(a.id, "declare")) ?? check;
  }

  /* ════════════════════════════ checks (Dynamic Workers) ════════════════════════════ */

  private testPaths(files: Map<string, string>): string[] {
    return [...files.keys()].filter((p) => /^tests\/.+\.test\.(js|mjs)$/.test(p)).sort();
  }

  /** The project's check runner (absent settings: the gitring harness in a Dynamic Worker). */
  private checkSettings(): T.CheckSettings {
    return this.requireProject().settings.checks ?? { runner: "worker" };
  }

  /**
   * Run the checks on a tree: the gitring harness in a Dynamic Worker (the text files), or the project's
   * install and test commands in the attempt's check container. The container gets the whole tree from
   * `full` (binary files and modes too), so it tests the same tree that merges.
   */
  private async runTreeChecks(
    files: Map<string, string>,
    scope: T.CheckRun["scope"],
    attemptId: string,
    full?: () => Promise<{ files: Map<string, PackFile>; left: string[] }>,
  ): Promise<T.CheckRun> {
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
    if (!budget.granted) return budgetWait(key, scope, budget.retryAt);
    const dock = this.env.DRYDOCK.get(this.env.DRYDOCK.idFromName(`${p.id}:${attemptId}`));
    let res: DrydockResult;
    let left: string[] = [];
    try {
      const tree = full ? await full() : undefined;
      left = tree?.left ?? [];
      res = (await dock.run({ tree: await packTree(tree?.files ?? files), install: cs.install, test: cs.test, timeoutSec: cs.timeoutSec ?? 600 })) as DrydockResult;
    } catch (e) {
      res = { ok: false, stage: "start", exitCode: -1, installMs: 0, testMs: 0, reused: false, log: `The test container did not answer: ${String((e as Error)?.message ?? e)}` };
    }
    if (left.length) {
      const names = `${left.slice(0, 5).join(", ")}${left.length > 5 ? ` and ${left.length - 5} more` : ""}`;
      res = { ...res, log: `gitring did not copy ${left.length} large file${left.length === 1 ? "" : "s"} into the test container: ${names}.\n${res.log}` };
    }
    return containerRun(res, { key, scope, cs, ms: Date.now() - t0 });
  }

  async check(attemptId: string, call: CallInfo = {}): Promise<T.CheckRun> {
    const a = this.mustAttempt(attemptId);
    this.mayChange(a, call.viewer);
    this.heard(a);
    await this.adoptForkTip(a);
    const view = await this.attemptView(a);
    const run = await this.runTreeChecks(view.files, "attempt", a.id, async () => this.fullTree(view.snapshot, await this.workReader(a, view)));
    if (run.wait) {
      // The test budget is used: no test ran. This is not a failure. Keep the last result and say when gitring tries again.
      this.addLog({
        kind: "check",
        attemptId: a.id,
        agentId: a.agentId,
        intentId: a.intentId,
        message: `${this.callsign(a.id)} tests: not run. ${run.wait.message}`,
        data: { checkRunId: run.id, ok: false, retryAt: run.wait.retryAt },
      });
      return run;
    }
    a.checks = run;
    // A real run means the budget has room: the merge does not wait any more.
    a.mergeWait = undefined;
    this.putAttempt(a);
    this.addLog({
      kind: "check",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${this.callsign(a.id)} tests: ${run.passed}/${run.passed + run.failed} pass${run.error ? ` (${run.error.slice(0, 120)})` : ""}.`,
      // The tests that failed, by name: the steward reads the runs of a work copy from the log.
      data: { checkRunId: run.id, ok: run.ok, failed: run.cases.filter((c) => !c.ok).slice(0, 8).map((c) => ({ file: c.file, name: c.name })) },
    });
    return run;
  }

  /* ════════════════════════════ submit + landing ════════════════════════════ */

  async submit(attemptId: string, summary?: string, call: CallInfo = {}): Promise<T.SubmitResult> {
    this.rememberOrigin(call.origin);
    const a = this.mustAttempt(attemptId);
    this.mayChange(a, call.viewer);
    if (TERMINAL.has(a.status)) {
      return { attemptId, status: a.status, next: a.status === "landed" ? "landed" : "fix-checks", message: `The work copy is ${copyStatusWord(a.status)}.`, clearance: this.clearanceFor(a.id) };
    }
    this.heard(a);
    await this.adoptForkTip(a);
    if (a.status === "ready" && a.approval?.status === "waiting" && (!a.approval.digest || (await this.digestOf(a)) === a.approval.digest)) {
      // The agent asks again, and a person has not answered: the same work, the same question.
      return { attemptId, status: a.status, checks: a.composedChecks ?? a.checks, next: "awaiting-approval", approval: a.approval, ...this.mayAnswerOf(a, call.viewer), message: this.waitingMessage(a), clearance: this.clearanceFor(a.id) };
    }
    a.summary = summary ? String(summary).slice(0, 600) : a.summary;
    a.status = "submitted";
    this.putAttempt(a);
    const run = await this.check(a.id);
    // Parts of the work that gitring does not merge: the agent hears it now, not after the merge.
    const left = await this.leftOut(a);
    if (a.status !== "submitted") {
      // Another submit of this work copy was faster: it already queued or merged the work while these tests ran.
      return { attemptId, status: a.status, checks: run, next: a.status === "landed" ? "landed" : a.status === "underway" ? "fix-checks" : "landing-queue", message: `The work copy is ${copyStatusWord(a.status)}.`, clearance: this.clearanceFor(a.id) };
    }
    const intent = this.intents.get(a.intentId)!;
    let next: T.SubmitResult["next"];
    let message: string;
    let approvalAsked: T.Approval | undefined;
    if (!run.ok && !run.wait) {
      a.status = "underway";
      next = "fix-checks";
      message = `${failureSummary(run.cases)} Fix the code, then submit again.`;
    } else {
      a.status = "ready";
      // The test budget is used: the tests did not run, and that is not a failure. The work copy goes on,
      // and the tests of main plus this work run at the merge, when the budget has room.
      const lead = run.wait ? run.wait.message : "All tests pass.";
      if (run.wait) a.mergeWait = { until: run.wait.retryAt, message: run.wait.message };
      const siblings = [...this.attempts.values()].filter((x) => x.intentId === a.intentId && x.id !== a.id && ACTIVE.has(x.status));
      // A re-derive of the attempt a person picked keeps that pick: it lands without a second question about rivals or missing tests.
      const picked = this.pickedLineage(a);
      // No test ran (the gitring test harness): nothing is verified, so a person decides, unless the owner allows it.
      const untested = noTestRan(run) && !this.requireProject().settings.allowUntested;
      const need = await this.approvalFor(a, { untested, competing: siblings.length, picked });
      if (need) {
        const approval = await this.askApproval(a, need);
        next = "awaiting-approval";
        const compete = siblings.length ? ` ${siblings.length + 1} work copies compete on this task.` : "";
        message = `${untested ? "No test ran. The work is not verified." : lead}${compete} ${this.approverWords(approval)} must say yes before this merges.`;
        if (siblings.every((x) => x.status === "ready")) {
          intent.status = "judging";
          this.putIntent(intent);
        }
        approvalAsked = approval;
      } else {
        next = "landing-queue";
        message = run.wait ? `${lead} The work copy waits in the merge queue.` : "All tests pass. The work copy is in the merge queue.";
        this.enqueueLanding(a);
      }
    }
    if (left.length) message = `${message} ${notCarriedText(left)}`;
    this.putAttempt(a);
    this.addLog({
      kind: "submit",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${this.callsign(a.id)} submits "${intent.title}": ${message}`,
    });
    if (approvalAsked) {
      this.webhook("approval", { attemptId: a.id, approval: approvalAsked, task: intent.title, agent: this.callsign(a.id), line: approvalLine(a), link: this.approvalLink(a) });
      this.notifyPeople(approvalAsked.approver ? [approvalAsked.approver.id] : [], "approval", Boolean(approvalAsked.ownerOnly));
    }
    return { attemptId, status: a.status, checks: run, next, message, ...(approvalAsked ? { approval: approvalAsked, ...this.mayAnswerOf(a, call.viewer) } : {}), clearance: this.clearanceFor(a.id) };
  }

  /**
   * The remote of a work copy for a person or a tool that needs real git (a clone of the work, a branch read).
   * Api-mode work copies have no fork until now: this makes the fork and puts the work into it as one commit.
   */
  async workCopyRemote(attemptId: string): Promise<{ repo: string; remote: string; headSha?: string }> {
    const a = this.mustAttempt(attemptId);
    await this.flushToFork(a);
    const remote = a.fork.remote ?? (await this.backend.remoteUrl(a.fork.repo)) ?? "";
    return { repo: a.fork.repo, remote, ...(a.headSha ? { headSha: a.headSha } : {}) };
  }

  /** API-mode work becomes a real commit in the attempt's Artifacts fork (made when it is needed, not at submit). */
  private async flushToFork(a: T.Attempt): Promise<void> {
    if (a.mode !== "api") return;
    const intent = this.intents.get(a.intentId)!;
    await this.ensureFork(a, intent);
    const overlay = this.db.worktree(a.id);
    if (!overlay.size) return;
    const tip = (await this.backend.resolve(a.fork.repo, this.branch)) ?? a.baseSha;
    const view = await this.attemptView(a);
    const forkTip = tip === a.baseSha ? undefined : await this.backend.readCommit(a.fork.repo, tip);
    const forkTree = forkTip ? await this.treeText(a.fork.repo, forkTip.treeHash) : await this.treeText(this.requireProject().repo.name, a.baseTree);
    // Every entry that differs: after a re-plot the attempt also carries the main changes since the fork point,
    // binary files included, and a delete of a binary file is a change too.
    const reader = await this.workReader(a, view, [forkTree]);
    const changes: FileChange[] = [];
    for (const ch of diffSnapshots(forkTree.snapshot, view.snapshot)) {
      const e = view.snapshot.get(ch.path);
      if (!e) {
        changes.push({ path: ch.path, content: null });
        continue;
      }
      if (e.mode === "160000") continue; // a submodule entry cannot be written
      const content = (await reader.readText(e.sha)) ?? (await reader.readBytes(e.sha));
      if (content !== null) changes.push({ path: ch.path, content, mode: e.mode });
    }
    if (!changes.length) return;
    const agent = this.agents.get(a.agentId);
    const res = await this.backend.commit({
      repo: a.fork.repo,
      branch: this.branch,
      parent: tip,
      changes,
      message: `${intent.title}\n\nWork by ${agent?.callsign ?? a.agentId} (${agent?.model ?? agent?.client ?? "agent"}).\n\nGitring-Intent: ${intent.id}\nGitring-Attempt: ${a.id}\nGitring-Base: ${a.baseSha}`,
      author: { name: agent?.callsign ?? "agent", email: `${(agent?.callsign ?? "agent").toLowerCase()}@agents.gitring.invalid` },
    });
    a.headSha = res.sha;
    this.addLog({ kind: "push", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The work of ${agent?.callsign} is in its work copy ${a.fork.repo} at ${res.sha.slice(0, 7)}.`, files: changes.map((c) => c.path) });
  }

  private enqueueLanding(a: T.Attempt): void {
    // New work, or a yes of a person: the stops of an earlier merge do not count any more.
    if (a.mergeStops) {
      a.mergeStops = undefined;
      this.putAttempt(a);
    }
    this.db.enqueue(a.id, Date.now());
    void this.driveQueue();
  }

  /** Run the queue after the merge that runs now. One merge runs at a time. */
  private driveQueue(): Promise<unknown> {
    const job = this.landingChain.then(() => this.processQueue());
    this.landingChain = job.catch((e) => console.error("landing failed", errorLine(e), e));
    this.ctx.waitUntil(this.landingChain);
    return this.landingChain;
  }

  /**
   * The queue and the marker of the merge in progress are in storage. An object that starts again after
   * an eviction or a crash runs what they hold, so a queued work copy does not wait for a request.
   */
  private wakeQueue(): void {
    if (!this.project || this.project.importing) return;
    const stuck = [...this.attempts.values()].some((a) => a.status === "landing");
    if (!stuck && !this.db.queue().length && !this.db.getMeta<LandingRun>("landing")) return;
    void this.driveQueue();
  }

  /**
   * Merge the queued work copies, one after the other. A work copy leaves the queue only when its merge
   * ends. A merge that a stopped object began (its marker is older than the lease) starts again.
   */
  private async processQueue(): Promise<void> {
    if (!this.project || this.project.importing) return;
    // An older version of gitring dropped the queue entry when a merge began: a "landing" work copy without one is stuck.
    const queued = new Set(this.db.queue());
    for (const a of this.attempts.values()) {
      if (a.status === "landing" && !queued.has(a.id)) this.db.enqueue(a.id, Date.now());
    }
    for (let round = 0; round < 100; round++) {
      const next = this.pickLanding();
      if (!next) break;
      await this.runLanding(next.attempt, next.tries);
    }
    // The lease alarm of a merge that ended is not needed any more: the alarm goes to the next real wake time.
    const wakeAt = this.nextWake();
    if (wakeAt !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, wakeAt));
  }

  /** The earliest time that gitring must wake by itself: agents that wait for the AI budget, work given back, the merge queue. */
  private nextWake(): number | undefined {
    const times = [
      ...[...this.attempts.values()].filter((a) => a.waitsForBudget && !TERMINAL.has(a.status)).map((a) => a.waitsForBudget!),
      ...[...this.attempts.values()].filter((a) => a.returned && !TERMINAL.has(a.status)).map((a) => a.returned!.until),
    ];
    const queueAt = this.queueWakeAt();
    if (queueAt !== undefined) times.push(queueAt);
    const stewardAt = this.stewardWakeAt();
    if (stewardAt !== undefined) times.push(stewardAt);
    return times.length ? Math.min(...times) : undefined;
  }

  /** The next queued merge that may start now, with the number of times it starts. */
  private pickLanding(): { attempt: T.Attempt; tries: number } | undefined {
    const now = Date.now();
    const marker = this.db.getMeta<LandingRun>("landing");
    for (const id of this.db.queue()) {
      const a = this.attempts.get(id);
      if (!a || (a.status !== "ready" && a.status !== "landing")) {
        this.db.dequeue(id);
        if (marker?.id === id) this.db.setMeta("landing", undefined);
        continue;
      }
      // The test budget is used: this merge waits for the time that gitring gave. The alarm wakes the queue then.
      if (a.mergeWait && a.mergeWait.until > now) continue;
      const held = marker?.id === id ? marker : undefined;
      // Another object began this merge: it may still run until the lease ends.
      if (held && held.boot !== this.bootId && held.startedAt + LANDING_LEASE_MS > now) continue;
      return { attempt: a, tries: (held?.tries ?? 0) + 1 };
    }
    return undefined;
  }

  /** The next time a queued merge may start later than now: the end of a lease or of a wait for the test budget. */
  private queueWakeAt(): number | undefined {
    const now = Date.now();
    const marker = this.db.getMeta<LandingRun>("landing");
    const queue = this.db.queue();
    const times: number[] = [];
    if (marker && queue.includes(marker.id)) times.push(marker.startedAt + LANDING_LEASE_MS);
    for (const id of queue) {
      const wait = this.attempts.get(id)?.mergeWait;
      if (wait) times.push(wait.until);
    }
    const later = times.filter((t) => t > now);
    return later.length ? Math.min(...later) : undefined;
  }

  /** Write the marker, merge, then clear the marker and the queue entry. A stop in between leaves both. */
  private async runLanding(a: T.Attempt, tries: number): Promise<void> {
    if (tries > MAX_LANDING_STARTS) {
      await this.askAboutStoppedMerge(
        a,
        `The merge did not finish after ${MAX_LANDING_STARTS} tries. A yes starts it again.`,
        `The merge of the work of ${this.callsign(a.id)} did not finish after ${MAX_LANDING_STARTS} tries. A person must decide on "${this.intents.get(a.intentId)?.title ?? "this task"}".`,
      );
      return;
    }
    const startedAt = Date.now();
    this.db.setMeta("landing", { id: a.id, startedAt, boot: this.bootId, tries } satisfies LandingRun);
    // If this object stops, the alarm starts the merge again when the lease ends.
    await this.scheduleBudgetRetry(startedAt + LANDING_LEASE_MS);
    let outcome: "done" | "wait" = "done";
    try {
      outcome = await this.landOne(a);
    } catch (err) {
      console.error("landOne", a.id, errorLine(err), err);
      outcome = await this.mergeStopped(a, err);
    }
    this.db.setMeta("landing", undefined);
    // A merge that waits (for the test budget, or to try again after an error) stays in the queue.
    if (outcome !== "wait") this.db.dequeue(a.id);
  }

  /**
   * The merge stopped with an error: the repository did not answer, for example. The work is fine, so the work
   * copy stays in the queue and gitring tries the merge again after a short wait (1, 2 and 4 seconds). A merge
   * that stops a fourth time goes to a person. gitring never drops a queued work copy without saying so.
   */
  private async mergeStopped(a: T.Attempt, err: unknown): Promise<"done" | "wait"> {
    const intent = this.intents.get(a.intentId);
    const name = this.callsign(a.id);
    const reason = String(err).slice(0, 200);
    a.status = "ready";
    a.mergeStops = (a.mergeStops ?? 0) + 1;
    if (intent?.status === "landing") {
      intent.status = "underway";
      this.putIntent(intent);
    }
    if (a.mergeStops >= MAX_LANDING_STARTS) {
      a.mergeWait = undefined;
      await this.askAboutStoppedMerge(
        a,
        `The merge stopped ${a.mergeStops} times with an error: ${reason}. A yes starts it again.`,
        `The merge of the work of ${name} stopped ${a.mergeStops} times: ${reason}. A person must decide on "${intent?.title ?? "this task"}".`,
      );
      return "done";
    }
    const seconds = 2 ** (a.mergeStops - 1);
    a.mergeWait = { until: Date.now() + seconds * 1000, message: `The merge stopped: ${reason}. gitring tries it again in ${seconds} second${seconds === 1 ? "" : "s"}.` };
    this.putAttempt(a);
    this.addLog({ kind: "system", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The merge of the work of ${name} stopped: ${reason}. gitring tries it again in ${seconds} second${seconds === 1 ? "" : "s"}.` });
    return "wait";
  }

  /** A merge that cannot finish goes to a person. A yes starts it again. */
  private async askAboutStoppedMerge(a: T.Attempt, why: string, logMessage: string): Promise<void> {
    this.db.setMeta("landing", undefined);
    this.db.dequeue(a.id);
    const intent = this.intents.get(a.intentId);
    a.status = "ready";
    const approval = await this.askApproval(a, { reason: "merge-stopped", why: [why] });
    this.putAttempt(a);
    if (intent) {
      intent.status = "judging";
      this.putIntent(intent);
    }
    this.webhook("approval", { attemptId: a.id, approval, task: intent?.title ?? "", agent: this.callsign(a.id), line: approvalLine(a), link: this.approvalLink(a) });
    this.notifyPeople(approval.approver ? [approval.approver.id] : [], "approval");
    this.stats.escalations += 1;
    this.persistStats();
    this.addLog({ kind: "decision", attemptId: a.id, intentId: a.intentId, message: logMessage });
  }

  /**
   * The commit on main that merged this work copy, when a run made it and stopped: the message of the
   * commit names the work copy. gitring merges one work copy at a time, so only the last commits can hold it.
   */
  private async mainHolds(a: T.Attempt): Promise<CommitMeta | undefined> {
    const recent = await this.backend.log(this.requireProject().repo.name, this.branch, 8);
    return recent.find((c) => parseTrailers(c.message)["Gitring-Attempt"] === a.id);
  }

  /** Main has the merge of this work copy: a run stopped after the commit. Write the record now, commit nothing. */
  private async finishFromMain(a: T.Attempt, commit: CommitMeta): Promise<void> {
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    const word = parseTrailers(commit.message)["Gitring-Method"];
    const method: T.LandingMethod = word === "fast-forward" || word === "rederive" ? word : "merge";
    const applied = a.corrections.map((id) => this.corrections.get(id)).filter((c): c is T.Correction => !!c && c.status !== "superseded");
    const run: T.CheckRun = a.composedChecks ?? a.checks ?? { id: newId(CHECK_RUN), subject: commit.treeHash, scope: "composed", ok: true, passed: 0, failed: 0, cases: [], ms: 0, at: Date.now() };
    const decision = [...this.decisions].reverse().find((d) => d.attemptIds[0] === a.id && d.kind === "pick");
    const note =
      (await this.backend.readNote(p.repo.name, commit.hash).catch(() => null)) ??
      landingNote({ intent, attempt: a, agent, method, corrections: applied, courseChecks: this.db.checksFor<T.CourseCheck>(a.id), checks: run, decision });
    this.addLog({
      kind: "system",
      attemptId: a.id,
      message: `Main has the merge of the work of ${this.callsign(a.id)} already (${commit.hash.slice(0, 7)}). gitring writes its record now.`,
    });
    await this.recordLanding(a, {
      committed: { sha: commit.hash, tree: commit.treeHash },
      before: commit.parents[0] ?? p.mainSha,
      method,
      applied,
      run,
      message: commit.message,
      note,
      touched: Object.keys(a.footprint.files),
    });
  }

  /** "wait": the test budget is used. The work copy stays queued and gitring tries again later. */
  private async landOne(a: T.Attempt, attempt = 0): Promise<"done" | "wait"> {
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    // A run that stopped after its commit: main has the merge. Finish the record, do not commit twice.
    const held = await this.mainHolds(a);
    if (held) {
      await this.finishFromMain(a, held);
      return "done";
    }
    // A question that a person has not answered: nothing merges. This is the rule, whatever put the work in the queue.
    if (a.approval?.status === "waiting") return "done";
    // A yes counts for the work that the person saw. If the work changed since, the yes does not count.
    if (a.approval?.status === "approved" && a.approval.digest && (await this.digestOf(a)) !== a.approval.digest) {
      a.approval = { ...a.approval, status: "withdrawn", closed: "The agent changed the work after the yes." };
      a.status = "underway";
      this.putAttempt(a);
      this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The merge of the work of ${this.callsign(a.id)} stops: the work changed after the yes. The agent must submit again.` });
      this.refreshJudging(a.intentId);
      return "done";
    }
    const intentBefore = intent.status;
    a.status = "landing";
    intent.status = "landing";
    this.putAttempt(a);
    this.putIntent(intent);
    const main = await this.loadMain();
    const base = await this.treeText(p.repo.name, a.baseTree);
    const view = await this.attemptView(a);
    const reader = await this.workReader(a, view, [main]);
    // The real tree of the work: binary and large files, modes and symlinks merge too. A file too large to carry stays out.
    const large = await this.largeChanges(view, reader);
    const left = [...view.notCarried, ...large];
    const work = large.length ? withoutChanges(base.snapshot, view.snapshot, large.map((n) => n.path)) : view.snapshot;
    const result = await compose({ base: base.snapshot, main: main.snapshot, attempt: work, readText: reader.readText, readBytes: reader.readBytes });
    if (!result.clean) {
      await this.markStale(a, `${result.conflicts.length} conflict${result.conflicts.length > 1 ? "s" : ""} on the new main: ${result.conflicts.map((c) => `${c.path} (${c.reason})`).join(", ")}`);
      return "done";
    }
    // Composed tree = main + changes (+ the intent file). The text tree is for the gitring harness; the
    // test container gets the whole tree.
    const composed = new Map(main.text);
    for (const ch of result.changes) {
      if (typeof ch.content === "string" && textEligible(ch.path)) composed.set(ch.path, ch.content);
      else composed.delete(ch.path);
    }
    const run = await this.runTreeChecks(composed, "composed", a.id, async () => {
      const { snapshot, blobs } = await applyFileChanges(main.snapshot, result.changes);
      return this.fullTree(snapshot, this.blobReader({ trees: [main], repos: [p.repo.name, view.repo], known: blobs }));
    });
    if (run.wait) {
      // The test budget is used: no test ran. This is not a failure. The work copy stays queued,
      // it does not go back to its agent, and the alarm starts the merge again at the next window.
      a.status = "ready";
      a.mergeWait = { until: run.wait.retryAt, message: run.wait.message };
      intent.status = intentBefore === "landing" ? "underway" : intentBefore;
      this.putAttempt(a);
      this.putIntent(intent);
      this.addLog({ kind: "system", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The merge of the work of ${this.callsign(a.id)} waits. ${run.wait.message}` });
      return "wait";
    }
    a.mergeWait = undefined;
    a.composedChecks = run;
    this.putAttempt(a);
    if (!run.ok) {
      await this.markStale(a, `Tests fail on main plus this work. ${failureSummary(run.cases, 3)}`);
      return "done";
    }
    if (noTestRan(run) && !p.settings.allowUntested && !this.pickedLineage(a)) {
      // No test ran on main plus this work: nothing is verified. A person must say yes first.
      a.status = "ready";
      const approval = await this.askApproval(a, { reason: "no-test-ran", why: ["No test ran on main plus this work. The work is not verified."] });
      intent.status = "judging";
      this.putAttempt(a);
      this.putIntent(intent);
      this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The merge of the work of ${this.callsign(a.id)} stops. ${NO_TEST_RAN}` });
      this.webhook("approval", { attemptId: a.id, approval, task: intent.title, agent: this.callsign(a.id), line: approvalLine(a), link: this.approvalLink(a) });
      this.notifyPeople(approval.approver ? [approval.approver.id] : [], "approval");
      return "done";
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
      committed = await this.backend.commit({ repo: p.repo.name, branch: this.branch, parent: main.sha, changes, message, note, author: GITRING_AUTHOR });
    } catch (err) {
      // Main is not where gitring thinks: a run that stopped after its commit, or a commit from outside gitring.
      // A second try on the same main fails the same way. Catch up with the real main, then compose and test again.
      if ((err instanceof RepoConflictError || String(err).includes("RepoConflict")) && attempt < 1 && (await this.catchUpMain(a))) {
        return this.landOne(a, attempt + 1);
      }
      throw err;
    }
    await this.recordLanding(a, { committed, before: main.sha, method, applied, run, message, note, touched: result.touched, left });
    return "done";
  }

  /**
   * A commit to main failed because main moved. Read the real main and catch up, oldest commit first: a merge
   * of a work copy that a stopped run made gets its record now (finishFromMain); a commit that gitring did not
   * make becomes main as it is. True when gitring's main moved, so that the merge of `current` can try again.
   */
  private async catchUpMain(current: T.Attempt): Promise<boolean> {
    const p = this.requireProject();
    const before = p.mainSha;
    const tip = await this.backend.resolve(p.repo.name, this.branch).catch(() => null);
    if (!tip || tip === before) return false;
    const recent = await this.backend.log(p.repo.name, this.branch, 20).catch(() => [] as CommitMeta[]);
    const at = recent.findIndex((c) => c.hash === before);
    // When gitring's main is not among the last commits, only the tip counts.
    const newer = (at >= 0 ? recent.slice(0, at) : recent.slice(0, 1)).reverse();
    for (const c of newer) {
      const id = parseTrailers(c.message)["Gitring-Attempt"];
      // The merge of this work copy itself: the next try finds it on main and writes its record.
      if (id === current.id) break;
      const other = id ? this.attempts.get(id) : undefined;
      if (other && !this.landings.some((l) => l.mainAfter === c.hash)) {
        this.addLog({ kind: "system", attemptId: current.id, message: `Main moved under the merge of the work of ${this.callsign(current.id)}: a stopped run merged the work of ${this.callsign(other.id)} (${c.hash.slice(0, 7)}). gitring writes that record first.` });
        await this.finishFromMain(other, c);
      }
      if (p.mainSha !== c.hash) await this.adoptMainCommit(c);
    }
    return p.mainSha !== before;
  }

  /**
   * A commit on main that gitring did not record becomes gitring's main: a commit from outside gitring, or
   * one that a stopped run made. The agents near its files hear that main moved.
   */
  private async adoptMainCommit(c: CommitMeta): Promise<void> {
    const p = this.requireProject();
    const old = await this.loadMain();
    p.mainSha = c.hash;
    p.mainTree = c.treeHash;
    this.db.setMeta("project", p);
    this.appendMainSeq(c.hash);
    const main = await this.loadMain();
    const files = diffSnapshots(old.snapshot, main.snapshot).map((ch) => ch.path);
    this.emit({ type: "main", sha: main.sha, tree: main.tree, files: main.files, imports: main.imports });
    this.addLog({
      kind: "system",
      message: `Main has a commit that gitring did not record: ${c.hash.slice(0, 7)} "${c.message.split("\n")[0].slice(0, 80)}". It is main now (${files.length} file${files.length === 1 ? "" : "s"}).`,
      files,
    });
    this.webhook("main", { reason: "outside", mainBefore: old.sha, mainSha: c.hash, files });
    if (files.length) await this.mainMovedUnder(main, { title: `Commit ${c.hash.slice(0, 7)}`, files });
  }

  /**
   * Write what a merge on main means for gitring: the new main, the landing, the statuses, the events.
   * It is safe to run again: a work copy that the record has already counts once. The writes up to the
   * first await are one step, so a stop never leaves half of them.
   */
  private async recordLanding(
    a: T.Attempt,
    done: {
      committed: { sha: string; tree: string };
      before: string;
      method: T.LandingMethod;
      applied: T.Correction[];
      run: T.CheckRun;
      message: string;
      note: string;
      touched: string[];
      /** Parts of the work that gitring did not merge. */
      left?: NotCarried[];
    },
  ): Promise<void> {
    const { committed, before, method, applied, run, message, note, touched, left = [] } = done;
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    if (p.mainSha === before) {
      p.mainSha = committed.sha;
      p.mainTree = committed.tree;
      this.db.setMeta("project", p);
      this.appendMainSeq(committed.sha);
    }
    let landing = this.landings.find((l) => l.attemptId === a.id && l.mainAfter === committed.sha);
    const counted = !!landing;
    if (!landing) {
      landing = {
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
      // The history of main follows in the background; a fault there never stops the merge record.
      try {
        this.derived.landed(touched.length);
      } catch (e) {
        console.warn("history", errorLine(e));
      }
    }
    a.status = "landed";
    a.mergeWait = undefined;
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
    // The agent did not confirm these change requests before the merge: they close, they are not "acknowledged".
    for (const c of applied) {
      if (c.status === "pending" || c.status === "delivered") {
        c.status = "closed";
        this.putCorrection(c);
      }
    }
    if (!counted) {
      this.stats.landings += 1;
      this.stats.landedByMethod[method] = (this.stats.landedByMethod[method] ?? 0) + 1;
    }
    if (method === "rederive") this.stats.rederives += 0; // counted when the re-derive starts
    this.persistStats();
    const newMain = await this.loadMain();
    this.emit({ type: "landing", landing });
    this.emit({ type: "main", sha: newMain.sha, tree: newMain.tree, files: newMain.files, imports: newMain.imports });
    this.addLog({
      kind: "land",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: intent.id,
      message: `"${intent.title}" merged into main by ${METHOD_WORD[method]} (${committed.sha.slice(0, 7)}). Tests ${run.passed}/${run.passed + run.failed} pass.${left.length ? ` ${notCarriedText(left, false)}` : ""}`,
      files: touched,
    });
    this.webhook("landing", { landing, intent: { id: intent.id, title: intent.title }, callsign: agent.callsign, mainSha: committed.sha });
    if (p.settings.github.mode !== "off" && p.settings.github.repo) {
      this.ctx.waitUntil(this.githubSync().catch((e) => console.warn("github sync failed", String(e))));
    }
    // The task that merged GitHub's conflicting changes is in: bring the rest of the GitHub changes in.
    if (p.settings.github.repo && this.gh(p.settings.github.repo).conflict?.intentId === intent.id) {
      this.ctx.waitUntil(this.githubPull({ reason: "task" }).catch((e) => console.warn("github pull failed", String(e))));
    }
    await this.upstreamCorrections(a, newMain);
    this.wakeAll({ kind: "main-moved", at: Date.now(), mainSha: committed.sha, message: `Main moved to ${committed.sha.slice(0, 7)}: "${intent.title}" merged.` });
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
        message: `gitring rebases the work of ${quiet.join(", ")} onto main ${main.sha.slice(0, 7)}. Their files do not overlap the merged change.`,
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
    const reader = await this.workReader(a, view, [main]);
    // Without readBytes: a binary file that the work changes is no text to move. It stays for the landing ladder.
    const result = await compose({ base: base.snapshot, main: main.snapshot, attempt: view.snapshot, readText: reader.readText });
    if (result.conflicts.some((c) => c.reason === "binary")) return undefined; // binary: leave it to the landing ladder
    if (result.changes.some((c) => c.content !== null && typeof c.content !== "string")) return undefined;
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
          `gitring rebases the work of ${callsign} from ${from.slice(0, 7)} onto main ${main.sha.slice(0, 7)}.` +
          (merged.length ? ` Merged: ${merged.join(", ")}.` : "") +
          (reapply.length ? ` ${callsign} makes its change to ${reapply.map((r) => r.path).join(", ")} again.` : ""),
        files: result.touched,
      });
    }
    return { merged, reapply };
  }

  /** Give work that cannot merge back to its outside agent, on the new main. */
  private async returnToAgent(a: T.Attempt, reason: string, policy: "agent-first" | "agent-only"): Promise<void> {
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const main = await this.loadMain();
    const now = Date.now();
    const minutes = Math.max(5, Math.min(120, Math.round(p.settings.redoWaitMinutes || 15)));
    const name = this.callsign(a.id) ?? a.agentId;
    a.status = "underway";
    a.returns = (a.returns ?? 0) + 1;
    a.returned = { at: now, until: now + minutes * 60_000, reason, policy };
    this.putAttempt(a);
    if (intent.status !== "underway") {
      intent.status = "underway";
      this.putIntent(intent);
    }
    let steps: string;
    if (a.mode === "api") {
      const moved = await this.replot(a, main).catch((e) => {
        console.warn("replot failed", a.id, String(e));
        return undefined;
      });
      const again = moved?.reapply.map((r) => r.path) ?? [];
      steps =
        (moved ? `gitring moved your work copy onto the new main.` : `Your work copy is on main ${main.sha.slice(0, 7)}.`) +
        (again.length ? ` Read ${again.join(", ")} again, and make your change on the new text.` : " Fix the code so that the tests pass.") +
        ` Then call gitring_check and gitring_submit again.`;
    } else {
      steps = `Call gitring_update to get the new main. Merge it into your work, fix the conflicts, run the tests, push, then call gitring_submit again.`;
    }
    const after = policy === "agent-first" ? `If you do not answer in ${minutes} minutes, a built-in agent does the task again.` : `If you do not answer in ${minutes} minutes, a person decides.`;
    this.issueCorrection(
      a.id,
      undefined,
      { kind: "upstream", message: `Your work on "${intent.title}" cannot merge into main ${main.sha.slice(0, 7)}: ${reason} ${steps} ${after}`, constraints: {} },
      "R1-landed-has-way",
      "redo",
      95,
      true, // each time the work comes back is news: the agent must read it, also the second and the third time
    );
    this.addLog({
      kind: "stale",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${name} cannot merge "${intent.title}": ${reason} gitring gives the work back to ${name} (try ${a.returns} of 3).`,
    });
    // Not a.returned.until: a call of the agent can clear a.returned (heard) while this method waits.
    await this.scheduleBudgetRetry(now + minutes * 60_000);
  }

  /** The outside agent did not answer in time: a built-in agent (agent-first) or a person (agent-only) takes over. */
  private async returnTimedOut(a: T.Attempt): Promise<void> {
    const r = a.returned;
    if (!r) return;
    a.returned = undefined;
    this.putAttempt(a);
    const intent = this.intents.get(a.intentId);
    const name = this.callsign(a.id) ?? a.agentId;
    const minutes = Math.round((r.until - r.at) / 60_000);
    if (r.policy === "agent-first") {
      this.addLog({ kind: "stale", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${name} did not answer in ${minutes} minutes. A built-in agent does "${intent?.title}" again on the new main.` });
      await this.rederive(a.id, `${name} did not answer after the merge failed. ${r.reason}`, SYSTEM);
      return;
    }
    await this.askPersonToDecide(
      a,
      `${name} did not answer in ${minutes} minutes after the work came back. ${r.reason}`.trim(),
      `${name} did not answer in ${minutes} minutes. A person must decide on "${intent?.title}".`,
    );
  }

  /** Any tool call of the agent on its work copy is an answer: the work no longer waits for it. */
  private heard(a: T.Attempt): void {
    if (!a.returned) return;
    a.returned = undefined;
    this.putAttempt(a);
  }

  /**
   * Bring the new main into a work copy (MCP gitring_update).
   *   api  gitring moves the work copy onto main; files where both sides changed go back to main, and the agent writes its change again
   *   git  a read-only remote and token for main (6 hours), to merge main with git
   */
  async update(attemptId: string, call: CallInfo = {}): Promise<T.UpdateResult> {
    const a = this.mustAttempt(attemptId);
    this.mayChange(a, call.viewer);
    if (TERMINAL.has(a.status)) throw new Error(`Work copy ${a.id} is ${copyStatusWord(a.status)}. ${this.overAdvice(a)}`);
    this.heard(a);
    const p = this.requireProject();
    const main = await this.loadMain();
    if (a.mode === "api") {
      if (a.baseSha === main.sha) return { mode: "api", mainSha: main.sha, merged: [], readAgain: [], message: "Your work copy is on the current main." };
      const moved = await this.replot(a, main);
      const readAgain = moved?.reapply.map((r) => r.path) ?? [];
      return {
        mode: "api",
        mainSha: main.sha,
        merged: moved?.merged ?? [],
        readAgain,
        message: moved
          ? `Your work copy is on main ${main.sha.slice(0, 7)}.${readAgain.length ? ` Read ${readAgain.join(", ")} again, and make your change on the new text.` : ""}`
          : "gitring could not move this work copy now (it waits to merge). Submit again after the merge queue.",
      };
    }
    const tok = await this.backend.createToken(p.repo.name, "read", 6 * 3600);
    const remote = p.repo.remote ?? (await this.backend.remoteUrl(p.repo.name));
    if (!tok || !remote) throw new Error("gitring cannot give a remote for main now. Try again.");
    return {
      mode: "git",
      mainSha: main.sha,
      branch: this.branch,
      remote,
      token: tok.token,
      tokenExpiresAt: tok.expiresAt,
      commands: [gitPullCommand(remote, tok.token, this.branch), "# fix conflicts, run the tests, commit", "git push", "# then call gitring_submit"],
      message: `Main is at ${main.sha.slice(0, 7)}. The token is read-only and lasts 6 hours.`,
    };
  }

  private async markStale(a: T.Attempt, reason: string): Promise<void> {
    const agent = this.agents.get(a.agentId);
    const policy = this.requireProject().settings.redo;
    // Work of an outside agent goes back to that agent first (redo policy), at most 3 times.
    if (agent && agent.kind !== "builtin" && policy !== "builtin") {
      if ((a.returns ?? 0) < 3) {
        await this.returnToAgent(a, reason, policy);
        return;
      }
      if (policy === "agent-only") {
        // Three tries by the agent failed, and no built-in agent may take the task: a person decides.
        const it = this.intents.get(a.intentId)!;
        await this.askPersonToDecide(
          a,
          `The work did not merge after 3 tries by ${this.callsign(a.id)}: ${reason}`,
          `The work of ${this.callsign(a.id)} did not merge after 3 tries. A person must decide on "${it.title}".`,
        );
        return;
      }
    }
    const intent = this.intents.get(a.intentId)!;
    if (a.lineage.generation >= 3) {
      await this.askPersonToDecide(a, `Two redos failed: ${reason}`, `Two redos failed for "${intent.title}". A person must decide.`);
      return;
    }
    a.status = "stale";
    this.putAttempt(a);
    intent.status = "underway";
    this.putIntent(intent);
    this.addLog({ kind: "stale", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The work of ${this.callsign(a.id)} cannot merge: ${reason} gitring does the task again on the new main.` });
    await this.rederive(a.id, reason, SYSTEM);
  }

  /**
   * The one way for "a person decides" when work did not merge and no agent tries again: the work copy stops
   * (stale, with the reason), the task waits for a person, and a redo question goes to the inbox of the
   * people who may answer, to the webhooks and to the push notifications. The answer starts a redo on the
   * new main or pauses the task (answerQuestion).
   */
  private async askPersonToDecide(a: T.Attempt, why: string, logMessage: string): Promise<T.Question> {
    a.status = "stale";
    a.stoppedFor = why;
    a.returned = undefined;
    this.putAttempt(a);
    const intent = this.intents.get(a.intentId)!;
    const now = Date.now();
    const facts = [why, "No agent tries again. A person decides what happens next."];
    const old = [...this.questions.values()].find((q) => q.status === "open" && q.kind === "redo" && q.intentId === a.intentId);
    const q: T.Question = old
      ? { ...old, attemptIds: [a.id], facts, askedAt: now }
      : { id: newId("q"), kind: "redo", status: "open", intentId: a.intentId, attemptIds: [a.id], facts, options: [...REDO_OPTIONS], askedAt: now, updatedAt: now };
    this.putQuestion(q);
    intent.status = "judging";
    this.putIntent(intent);
    this.stats.escalations += 1;
    this.persistStats();
    this.addLog({ kind: "decision", attemptId: a.id, intentId: a.intentId, message: logMessage });
    this.questionAsked(q);
    return q;
  }

  /* ════════════════════════════ human + system actions ════════════════════════════ */

  async createIntent(
    input: { title: string; goal: string; checks?: { path: string; content: string; description?: string }[]; priority?: "normal" | "high"; source?: T.Intent["source"] },
    by: T.Actor = HUMAN,
  ): Promise<T.Intent> {
    await this.ensure(this.project?.id);
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
    this.addLog({ kind: "intent", intentId: intent.id, message: `${by.name} opens the task "${intent.title}"${intent.source.kind !== "ui" ? ` (from ${intent.source.kind}${intent.source.ref ? ` ${intent.source.ref}` : ""})` : ""}.` });
    this.webhook("intent", { intent: { id: intent.id, title: intent.title } });
    return intent;
  }

  async amendIntent(id: string, patch: { goal?: string; constraints?: string[]; reason: string }, by: T.Actor = HUMAN): Promise<T.Intent> {
    const intent = this.intents.get(id);
    if (!intent) throw new Error("Unknown task.");
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
    const amendment: T.Amendment = { version: intent.version, at: Date.now(), by, reason: patch.reason || "Goal changed", text: parts.join(" ") };
    intent.amendments = [...intent.amendments, amendment];
    this.putIntent(intent);
    this.addLog({ kind: "intent", intentId: id, message: `${by.name} changes the goal of "${intent.title}" (version ${intent.version}): ${patch.reason || "no reason given"}.` });
    // Every vessel on this intent gets the change as a correction.
    const main = await this.loadMain();
    for (const a of this.attempts.values()) {
      if (a.intentId !== id || !ACTIVE.has(a.status)) continue;
      const agent = this.agents.get(a.agentId)!;
      const v = vesselView(a, intent, agent, (await this.attemptView(a)).signatures, main.signatures, "active");
      this.issueCorrection(a.id, undefined, draftIntentAmendedCorrection(v, amendment), "human", "amend", 50, true);
    }
    this.recordDecision({ kind: "amend", intentId: id, attemptIds: [], by, rationale: patch.reason || "Goal changed" });
    return intent;
  }

  async launch(intentId: string, input: LaunchInput = {}, by: T.Actor = HUMAN): Promise<{ attempts: T.Attempt[]; waiting: number }> {
    const p = this.requireProject();
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error("Unknown task.");
    if (["landed", "parked", "merged-into"].includes(intent.status)) throw new Error(`The task "${intent.title}" is ${taskStatusWord(intent.status)}.`);
    const main = await this.loadMain();
    const fanout = Math.max(1, Math.min(4, Math.round(Number(input.fanout ?? intent.suggestedFanout ?? p.settings.fanout) || 1)));
    const ok = this.allowedModels();
    const asked = (input.models ?? []).filter((m) => typeof m === "string" && ok(m));
    const models = asked.length ? asked : this.projectModels(p);
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
        course: { plan: ["Read the task and the code", "Plan the change"], files: [], symbols: [], approach: "Planning", declaredAt: now },
        footprint: emptyFootprint(),
        corrections: [],
        lineage: { generation: 1 },
        stats: { filesChanged: 0, additions: 0, deletions: 0, steps: 0 },
        ...(personOf(by) ? { sender: personOf(by) } : {}),
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
      message: `${by.name} starts ${fanout} built-in agent${fanout > 1 ? "s" : ""} on "${intent.title}" (${names}).${waiting ? ` ${waiting} ${waiting === 1 ? "waits" : "wait"} for the hourly AI budget and ${waiting === 1 ? "starts" : "start"} at ${clock(budget.retryAt)} UTC.` : ""}`,
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
   * gitring never fakes the work.
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

  /** Alarm: finish an import, start the built-in agents that waited for the AI budget, then run the merge queue. */
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
    for (const a of [...this.attempts.values()]) {
      if (a.returned && a.returned.until <= Date.now() && !TERMINAL.has(a.status)) await this.returnTimedOut(a);
    }
    // The merge queue: queued work copies run, and a merge that a stopped object began starts again.
    await this.driveQueue();
    // The steward: every few minutes while agents work, count the facts and put a new finding in the inbox.
    await this.stewardSweep();
    const next = this.nextWake();
    if (next !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }

  /* ════════════════════════════ the steward ════════════════════════════ */

  /** The steward works only while agents work: a work copy in flight, or work in the merge queue. */
  private stewardActive(): boolean {
    const p = this.project;
    if (!p?.settings.steward || p.importing) return false;
    return [...this.attempts.values()].some((a) => ACTIVE.has(a.status)) || this.db.queue().length > 0;
  }

  /** When the next sweep of the steward is due (undefined: the steward is off, or no agent works). */
  private stewardWakeAt(): number | undefined {
    if (!this.stewardActive()) return undefined;
    return (this.db.getMeta<number>("stewardAt") ?? Date.now()) + STEWARD_EVERY_MS;
  }

  /** Make sure the alarm comes by the next sweep of the steward (the setting turned on, or a work copy started). */
  private async armSteward(): Promise<void> {
    const at = this.stewardWakeAt();
    if (at === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, at));
  }

  /**
   * One sweep of the steward (harbor/steward.ts): count the facts, and put each new finding in the inbox as a
   * question of kind "steward" with the one answer "Seen". The facts decide; the model only words the first
   * sentence, and the template sentence stands when it fails. One fact gives one open note: a fact with an
   * open note is not asked again, and a fact that a person saw comes back only when its measure doubled.
   */
  private async stewardSweep(force = false): Promise<void> {
    if (!this.stewardActive()) return;
    const now = Date.now();
    const last = this.db.getMeta<number>("stewardAt") ?? 0;
    if (!force && now - last < STEWARD_EVERY_MS) return;
    this.db.setMeta("stewardAt", now);
    const findings = stewardFindings({
      now,
      attempts: [...this.attempts.values()],
      agents: [...this.agents.values()],
      intents: [...this.intents.values()],
      corrections: [...this.corrections.values()],
      logs: this.logs,
      landings: this.landings,
      queue: this.db.queueEntries(),
    });
    const notes = [...this.questions.values()].filter((q) => q.kind === "steward");
    const ask = stewardModel(this.env.AI);
    let worded = 0;
    for (const f of findings) {
      if (notes.some((q) => q.status === "open" && q.fact === f.key)) continue;
      const seen = notes.filter((q) => q.status !== "open" && q.fact === f.key).sort((x, y) => x.updatedAt - y.updatedAt).at(-1);
      if (seen && f.measure < 2 * Math.max(1, seen.measure ?? 1)) continue;
      let facts = f.facts;
      if (worded < STEWARD_WORDS_PER_SWEEP) {
        worded += 1;
        const sentence = await wordFinding(ask, f);
        if (sentence) facts = [sentence, ...f.facts];
      }
      // The sweep waited for the model: the project may have closed meanwhile.
      if (!this.project) return;
      const at = Date.now();
      const q: T.Question = { id: newId("q"), kind: "steward", status: "open", intentId: f.intentId, attemptIds: f.attemptIds, fact: f.key, measure: f.measure, facts, options: [...STEWARD_OPTIONS], askedAt: at, updatedAt: at };
      this.putQuestion(q);
      notes.push(q);
      this.addLog({ kind: "system", ...(f.attemptIds[0] ? { attemptId: f.attemptIds[0] } : {}), ...(f.intentId ? { intentId: f.intentId } : {}), message: `The steward noticed: ${facts[0]}` });
      this.questionAsked(q);
    }
  }

  private async startVessel(a: T.Attempt, agent: T.AgentInfo, rederiveOf?: string): Promise<void> {
    const p = this.requireProject();
    const ok = this.allowedModels();
    const model = agent.model && ok(agent.model) ? agent.model : this.projectModels(p)[0];
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
    if (!intent) throw new Error("Unknown task.");
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
    this.addLog({ kind: "decision", intentId, message: `${by.name} pauses "${intent.title}": ${reason || "no reason given"}.` });
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

  /* ════════════════════════════ approvals ════════════════════════════ */

  /**
   * A hash of what a person approves: the agent's own contribution (the removed and added lines of each change
   * block, whole files that it adds or deletes, binary files and modes), without the base and without line
   * numbers. When main moves, or gitring merges main into the work, and the agent changes nothing, the answer
   * still counts. Any change by the agent changes the hash.
   */
  private async digestOf(a: T.Attempt, view?: AttemptView): Promise<string> {
    const v = view ?? (await this.attemptView(a));
    const digest = `${DIGEST_V2}${await sha256Hex(contributionRows(v.changed, v.opaque).join("\n"))}`;
    // A question from an older version holds the hash of whole files. When it still names this work, it takes the new hash.
    const ap = a.approval;
    if (ap?.digest && !ap.digest.startsWith(DIGEST_V2) && ap.digest === (await legacyDigest(v))) {
      ap.digest = digest;
      this.db.putAttempt(a);
    }
    return digest;
  }

  /** Does this work need a person before it merges? The project setting, the signs of the change and the rivals decide. */
  private async approvalFor(a: T.Attempt, f: { untested: boolean; competing: number; picked: boolean }): Promise<{ reason: T.ApprovalReason; why: string[]; ownerOnly?: boolean } | null> {
    const settings = this.requireProject().settings;
    // The rules by folder see every changed file, binary files included.
    const rules = checkFolderRules(settings.folderRules, Object.keys(a.meaning?.files ?? a.footprint.files), a.sender?.id);
    const need = approvalNeeded({ mode: settings.landing, untested: f.untested && !f.picked, competing: f.picked ? 0 : f.competing, signs: riskSigns(a), rules });
    if (!need) return null;
    // The same work that a person said yes to: no second question.
    if (a.approval?.status === "approved" && a.approval.digest && (await this.digestOf(a)) === a.approval.digest) return null;
    return need;
  }

  /** Ask a person to say yes. The work copy stays "ready" and does not merge until the answer comes. */
  private async askApproval(a: T.Attempt, need: { reason: T.ApprovalReason; why: string[]; ownerOnly?: boolean }): Promise<T.Approval> {
    const approval: T.Approval = {
      id: newId("ap"),
      status: "waiting",
      reason: need.reason,
      why: need.why,
      digest: await this.digestOf(a),
      // A rule by folder asks for an owner: the sender of the agent is not the one who answers.
      ...(need.ownerOnly ? { ownerOnly: true } : a.sender ? { approver: a.sender } : {}),
      askedAt: Date.now(),
    };
    a.approval = approval;
    a.status = "ready";
    this.putAttempt(a);
    this.addLog({
      kind: "decision",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `gitring asks ${this.approverWords(approval)} to say yes to the work of ${this.callsign(a.id)}. ${need.why[0] ?? ""}`.trim(),
    });
    return approval;
  }

  private approverWords(ap: Pick<T.Approval, "approver" | "ownerOnly">): string {
    if (ap.ownerOnly) return "An owner of the project";
    return ap.approver?.name ?? "A person of the project";
  }

  /** May the caller answer the question of this work copy? Only a question that waits has an answer for this. */
  private mayAnswerOf(a: T.Attempt, viewer: CallInfo["viewer"]): { mayAnswer?: boolean } {
    if (!viewer || a.approval?.status !== "waiting") return {};
    return { mayAnswer: canDecide(a.approval, viewer, this.requireProject().settings.approver) };
  }

  private waitingMessage(a: T.Attempt): string {
    const ap = a.approval!;
    return `${ap.why[0] ?? "A person must decide."} ${this.approverWords(ap)} must say yes before this merges.`;
  }

  /** The address where a person answers: in the gitring app. The Worker tells the object its own address when it can. */
  private approvalLink(a: T.Attempt): string {
    const path = approvalPath(this.requireProject().id, a.id);
    const origin = this.db.getMeta<string>("origin");
    return origin ? `${origin}${path}` : path;
  }

  /** The address of this deployment (from a request), for links in webhooks and answers. Only https (or local http) counts. */
  rememberOrigin(origin?: string): void {
    if (!origin || !/^(https:\/\/[^/\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(origin)) return;
    if (this.db.getMeta<string>("origin") !== origin) this.db.setMeta("origin", origin);
  }

  /** A question that cannot be answered any more: the agent changed the work, or the work copy closed. */
  private closeApproval(a: T.Attempt, why: string): void {
    const ap = a.approval;
    if (!ap || ap.status !== "waiting") return;
    a.approval = { ...ap, status: "withdrawn", closed: why };
    this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The question about the work of ${this.callsign(a.id)} closes. ${why}` });
    this.refreshJudging(a.intentId);
  }

  /** A task that waits for a decision, but has no work left that waits: it is in work (or open) again. */
  private refreshJudging(intentId: string): void {
    const intent = this.intents.get(intentId);
    if (!intent || intent.status !== "judging") return;
    const mine = [...this.attempts.values()].filter((x) => x.intentId === intentId);
    if (mine.some((x) => x.status === "ready")) return;
    intent.status = mine.some((x) => ACTIVE.has(x.status)) ? "underway" : "open";
    this.putIntent(intent);
  }

  /** The agent changed the work after a person was asked, or after the yes: that answer does not count for the new work. */
  private async withdrawIfChanged(a: T.Attempt, view: AttemptView): Promise<void> {
    const ap = a.approval;
    if (!ap || !ap.digest || (ap.status !== "waiting" && ap.status !== "approved") || TERMINAL.has(a.status)) return;
    if ((await this.digestOf(a, view)) === ap.digest) return;
    if (ap.status === "approved") a.approval = { ...ap, status: "withdrawn", closed: "The agent changed the work after the yes." };
    if (a.status === "ready") a.status = "underway";
    // A question that waits closes in putAttempt, because the work copy is not "ready" any more.
    this.putAttempt(a);
  }

  /**
   * A person answers the approval of a work copy: "approve" sends the work to the merge queue, "send-back"
   * gives the agent the note as a change request. The first valid answer counts. The same answer again
   * changes nothing. `who` carries the role that the Worker checked; the rules of canDecide apply here too.
   * `expect.approvalId` is the question that the person saw: an old question never takes a new answer.
   */
  async decide(
    attemptId: string,
    input: T.ApprovalAnswer,
    who: { id: string; name: string; role: Role },
    how: "app" | "chat" | "cli" = "app",
    expect: { approvalId?: string } = {},
    origin?: string,
  ): Promise<T.ApprovalResult> {
    this.rememberOrigin(origin);
    const p = this.requireProject();
    const a = this.mustAttempt(attemptId);
    const ap = a.approval;
    if (!ap) throw new Error("This work copy has no question to answer.");
    const out = (outcome: T.ApprovalResult["outcome"], message: string, extra: Partial<T.ApprovalResult> = {}): T.ApprovalResult => ({ attemptId, outcome, approval: a.approval ?? ap, status: a.status, message, ...extra });
    if (!canDecide(ap, who, p.settings.approver)) {
      const rule = p.settings.approver;
      return out(
        "refused",
        !atLeast(who.role, "member")
          ? "You need the member role to answer."
          : rule === "owner" || ap.ownerOnly || !ap.approver
            ? "Only an owner of the project can answer this."
            : `Only ${ap.approver.name} (who sent the agent) or an owner of the project can answer this.`,
      );
    }
    if (expect.approvalId && expect.approvalId !== ap.id) return out("withdrawn", "This question is old. The work changed, and gitring asked again. Open the new question.");
    if (ap.status === "withdrawn") return out("withdrawn", `This question is closed. ${ap.closed ?? ""}`.trim());
    if (ap.status !== "waiting") return out("already", `${ap.answer?.by.name ?? "A person"} ${ap.status === "approved" ? "said yes to" : "sent back"} this work already.`);
    if (a.status !== "ready") return out("withdrawn", "This work is not waiting any more.");
    // The work must be what the question showed.
    if (ap.digest && (await this.digestOf(a)) !== ap.digest) {
      if (a.approval === ap && ap.status === "waiting") {
        a.status = "underway";
        this.putAttempt(a);
      }
      return out("withdrawn", "The agent changed the work after the question. gitring asks again when the agent submits.");
    }
    // Another answer can come in while the work is read: the first one counts.
    if (a.approval !== ap || ap.status !== "waiting") return this.decide(attemptId, input, who, how, expect, origin);
    const intent = this.intents.get(a.intentId)!;
    const by: T.Actor = { kind: "human", id: who.id, name: who.name };
    const note = String(input.note ?? "").trim().slice(0, 1000);
    const answer = { by: { id: who.id, name: who.name }, how, ...(note ? { note } : {}), at: Date.now() };
    const where = how === "chat" ? " in the chat of the agent" : how === "cli" ? " with the gitring command line" : "";
    const sign = { attemptId: a.id, task: intent.title, agent: this.callsign(a.id), line: approvalLine(a), link: this.approvalLink(a) };

    if (input.answer === "approve") {
      a.approval = { ...ap, status: "approved", answer };
      this.putAttempt(a); // the answer is stored before the merge starts
      this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${who.name} says yes to the work of ${this.callsign(a.id)} on "${intent.title}"${where}.` });
      this.webhook("approval", { ...sign, approval: a.approval });
      const res = await this.landWork(a.id, note || "Approved.", by);
      return out("approved", res.message, { ...(res.landing ? { landing: res.landing } : {}), ...(res.waits ? { waits: res.waits } : {}) });
    }

    // Send back.
    a.approval = { ...ap, status: "sent-back", answer };
    const decision = this.recordDecision({ kind: "send-back", intentId: a.intentId, attemptIds: [a.id], by, rationale: note || "Sent back without a note." });
    this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${who.name} sends the work of ${this.callsign(a.id)} on "${intent.title}" back${where}${note ? `: ${note}` : "."}` });
    this.webhook("approval", { ...sign, approval: a.approval });
    const agent = this.agents.get(a.agentId);
    if (agent?.kind === "builtin") {
      // A built-in agent is done with this work copy: another built-in agent does the task again, and the note is part of the task.
      if (note) {
        intent.constraints = [...intent.constraints, `A person sent the work back: ${note}`];
        intent.version += 1;
        intent.amendments = [...intent.amendments, { version: intent.version, at: Date.now(), by, reason: "A person sent the work back.", text: note }];
        this.putIntent(intent);
      }
      this.putAttempt(a);
      await this.rederive(a.id, note ? `A person sent the work back: ${note}` : "A person sent the work back.", by);
      this.refreshJudging(a.intentId);
      return out("sent-back", "The work went back. A built-in agent does the task again and reads your note.");
    }
    a.status = "underway";
    this.putAttempt(a);
    this.issueCorrection(
      a.id,
      undefined,
      {
        kind: "review",
        message: `${who.name} sends your work back${note ? `: ${note}` : " without a note."} Change the work, run the tests, and submit again.`,
        constraints: note ? { notes: [note] } : {},
      },
      "human",
      decision.id,
      90,
      true,
    );
    this.refreshJudging(a.intentId);
    return out("sent-back", "The work went back to the agent with your note. The agent changes it and submits again.");
  }

  /* ════════════════════════════ questions for a person ════════════════════════════ */

  /** Open questions, and the latest 50 answered or closed ones. Oldest first. */
  private questionList(): T.Question[] {
    const all = [...this.questions.values()].sort((a, b) => a.askedAt - b.askedAt);
    const done = new Set(all.filter((q) => q.status !== "open").slice(-50));
    return all.filter((q) => q.status === "open" || done.has(q));
  }

  /**
   * A conflict check escalated a pair: ask a person which work adapts. The question holds the change request
   * for each side (drafted now, from the facts that the person reads). A new escalation of the same pair
   * updates the open question: the person sees one question for one pair.
   */
  private askAboutPair(inc: VesselView, oth: VesselView, facts: T.PairFacts, checkId: string): void {
    const draft = (giveWay: VesselView, standOn: VesselView, side: "incoming" | "other") => {
      const d = draftCorrection(giveWay, standOn, facts, "R4-first-declared-stands-on", side);
      return { attemptId: giveWay.attempt.id, standOnAttemptId: standOn.attempt.id, kind: d.kind, message: d.message, constraints: d.constraints };
    };
    const a = inc.attempt.id;
    const b = oth.attempt.id;
    // The decision model can take a while: a work copy that closed in the meantime has nothing to adapt.
    if (![a, b].every((id) => ACTIVE.has(this.attempts.get(id)?.status as T.AttemptStatus))) return;
    const pair = (q: T.Question) => q.kind === "escalation" && q.attemptIds.includes(a) && q.attemptIds.includes(b);
    const old = [...this.questions.values()].find((q) => q.status === "open" && pair(q));
    // A person answered for this pair already: the answer stands, and gitring does not ask again.
    const answered = old ? undefined : [...this.questions.values()].filter((q) => q.status === "answered" && pair(q)).sort((x, y) => x.updatedAt - y.updatedAt).at(-1);
    if (answered) {
      const chosen = answered.drafts?.[answered.answer?.option ?? ""];
      // "No conflict: both continue": nothing to do. Else the side that the person chose adapts again (a new request only when the conflict grows).
      if (!chosen) return;
      const [giveWay, standOn] = chosen.attemptId === a ? [inc, oth] : [oth, inc];
      const d = draftCorrection(giveWay, standOn, facts, "R4-first-declared-stands-on", giveWay === inc ? "incoming" : "other");
      this.personDecided({ attemptId: giveWay.attempt.id, standOnAttemptId: standOn.attempt.id, kind: d.kind, message: d.message, constraints: d.constraints }, answered.answer?.note, checkId, severityOf(facts), false);
      return;
    }
    // An open question keeps its order: its first work copy stays "first".
    const incomingFirst = !old || old.attemptIds[0] === a;
    const [first, second] = incomingFirst ? [inc, oth] : [oth, inc];
    const now = Date.now();
    const words = escalationFacts(facts, { a: inc.agent.callsign, b: oth.agent.callsign, taskA: inc.intent.title, taskB: oth.intent.title });
    const drafts = incomingFirst
      ? { first: draft(oth, inc, "other"), second: draft(inc, oth, "incoming") }
      : { first: draft(inc, oth, "incoming"), second: draft(oth, inc, "other") };
    const q: T.Question = {
      ...(old ?? { id: newId("q"), kind: "escalation" as const, status: "open" as const, askedAt: now, updatedAt: now }),
      intentId: first.attempt.intentId,
      attemptIds: [first.attempt.id, second.attempt.id],
      checkId,
      facts: words,
      options: escalationOptions(first.agent.callsign, second.agent.callsign),
      drafts,
    };
    this.putQuestion(q);
    if (old) return;
    this.addLog({
      kind: "decision",
      attemptId: a,
      intentId: inc.attempt.intentId,
      message: `gitring asks a person which work adapts: ${inc.agent.callsign} or ${oth.agent.callsign}. Both continue until the answer.`,
    });
    this.questionAsked(q);
  }

  /** A new question is in the inbox of the people who may answer: tell the webhooks and the devices of those people. */
  private questionAsked(q: T.Question): void {
    const intent = this.intents.get(q.intentId);
    this.webhook("question", { question: q, task: intent?.title ?? "", link: this.questionLink(q) });
    const senders = q.attemptIds.map((id) => this.attempts.get(id)?.sender?.id).filter((x): x is string => Boolean(x));
    this.notifyPeople([...new Set(senders)], "question");
  }

  /** The address of a question in the gitring app: the task, where the decision list shows it. */
  private questionLink(q: T.Question): string {
    const path = taskPath(this.requireProject().id, q.intentId);
    const origin = this.db.getMeta<string>("origin");
    return origin ? `${origin}${path}` : path;
  }

  /**
   * A push notification (without content) to the devices of the people who answer: the senders, or every person
   * who may answer when no person sent the work. The Directory knows the people and their devices. Without
   * the push keys of the deployment, nothing goes out.
   */
  private notifyPeople(users: string[], kind: "approval" | "question", ownerOnly = false): void {
    const p = this.project;
    // Push is off without the keys of the deployment: no call to the Directory then.
    if (!p || !this.env.DIRECTORY || !pushKeys(this.env)) return;
    const need = p.settings.approver === "owner" || ownerOnly ? "owner" : "member";
    const send = (async () => this.directory().pushInbox(p.id, { users: need === "owner" ? [] : users, need, kind }))();
    this.ctx.waitUntil(send.then(() => undefined).catch((e) => console.warn("push failed", errorLine(e))));
  }

  /**
   * The escalation questions of a work copy that closed have no use: nobody can adapt now. A note of the
   * steward closes when every work copy it names closed: the anomaly is over.
   */
  private closeQuestionsOf(a: T.Attempt): void {
    for (const q of this.questions.values()) {
      if (q.status !== "open" || !q.attemptIds.includes(a.id)) continue;
      if (q.kind === "escalation") this.putQuestion({ ...q, status: "closed", closed: `The work of ${this.callsign(a.id) ?? "an agent"} closed. ${closedBecause(a.status)}` });
      else if (q.kind === "steward" && q.attemptIds.every((id) => id === a.id || TERMINAL.has(this.attempts.get(id)?.status as T.AttemptStatus))) {
        this.putQuestion({ ...q, status: "closed", closed: "The work of this note closed." });
      }
    }
  }

  private closeRedoQuestions(intentId: string, why: string): void {
    for (const q of this.questions.values()) {
      if (q.status === "open" && q.kind === "redo" && q.intentId === intentId) this.putQuestion({ ...q, status: "closed", closed: why });
    }
  }

  /**
   * The change request after a person chose which work adapts (rule "human"). `d` is the drafted request for the
   * side that adapts; the note of the person goes with it. `event`: the answer itself (always news for the agent);
   * a later check of the same pair sends the request again only when the conflict grows.
   */
  private personDecided(d: NonNullable<T.Question["drafts"]>[string], note: string | undefined, checkId: string, severity: number, event: boolean): T.Correction | undefined {
    return this.issueCorrection(
      d.attemptId,
      d.standOnAttemptId,
      {
        kind: d.kind,
        message: `A person decided: ${this.callsign(d.standOnAttemptId) ?? "the other agent"} continues, and your work adapts.${note ? ` Note: ${note}` : ""} ${d.message}`,
        constraints: note ? { ...d.constraints, notes: [...(d.constraints.notes ?? []), note] } : d.constraints,
      },
      "human",
      checkId,
      severity,
      event,
    );
  }

  /**
   * A person answers a question. The first valid answer counts; the same answer again changes nothing.
   *   escalation  "first" or "second": the side that adapts gets the change request ("a person decided").
   *               "both": nothing changes, and the question closes.
   *   redo        "redo": a built-in agent does the task again on the new main. "park": the task pauses.
   * `who` carries the role that the Worker checked; the rules of canAnswerQuestion apply here too.
   */
  async answerQuestion(questionId: string, input: T.QuestionAnswer, who: { id: string; name: string; role: Role }, origin?: string): Promise<T.QuestionResult> {
    this.rememberOrigin(origin);
    const p = this.requireProject();
    const q = this.questions.get(questionId);
    if (!q) throw new Error("Unknown question.");
    const out = (outcome: T.QuestionResult["outcome"], message: string): T.QuestionResult => ({ outcome, question: this.questions.get(questionId) ?? q, message });
    const senders = q.attemptIds.map((id) => this.attempts.get(id)?.sender);
    if (!canAnswerQuestion(senders, who, p.settings.approver)) {
      return out("refused", !atLeast(who.role, "member") ? "You need the member role to answer." : "Only a person who sent one of the agents, or an owner of the project, can answer this.");
    }
    if (q.status === "answered") return out("already", `${q.answer?.by.name ?? "A person"} answered this question already.`);
    if (q.status === "closed") return out("closed", `This question is closed. ${q.closed ?? ""}`.trim());
    const option = q.options.find((o) => o.id === input.option);
    if (!option) throw new Error(`Give one of these answers: ${q.options.map((o) => o.id).join(", ")}.`);
    const note = String(input.note ?? "").trim().slice(0, 1000);
    const by: T.Actor = { kind: "human", id: who.id, name: who.name };
    // The answer is stored first: a second answer that comes while this one works finds it.
    this.putQuestion({ ...q, status: "answered", answer: { by: { id: who.id, name: who.name }, option: option.id, ...(note ? { note } : {}), at: Date.now() } });
    const rationale = `${option.label}.${note ? ` ${note}` : ""}`;
    const intent = this.intents.get(q.intentId);
    let message: string;
    if (q.kind === "escalation") {
      const decision = this.recordDecision({ kind: "resolve-escalation", intentId: q.intentId, attemptIds: q.attemptIds, by, rationale });
      const d = q.drafts?.[option.id];
      const sent = d ? this.personDecided(d, note, decision.id, 90, true) : undefined;
      message = d ? (sent ? `${option.label}. ${this.callsign(d.attemptId) ?? "The agent"} gets a change request.` : `${option.label}. The work that adapts is closed, so no change request went out.`) : "Both agents continue. Nothing changes.";
    } else if (q.kind === "steward") {
      // A note of the steward: "Seen" closes it, and nothing else changes.
      message = "The note is closed.";
    } else {
      try {
        if (option.id === "park") {
          await this.park(q.intentId, note || "A person paused the task after the work did not merge.", by);
          message = "The task is paused.";
        } else {
          const a = this.attempts.get(q.attemptIds[0]);
          if (!a) throw new Error("The work copy of this question is gone.");
          const res = await this.rederive(a.id, note ? `A person asked for a redo: ${note}` : "A person asked for a redo on the new main.", by);
          message = `A built-in agent does "${intent?.title ?? "the task"}" again on the new main.${res.attempt.waitsForBudget ? " It starts when the hourly AI budget has room." : ""}`;
        }
      } catch (err) {
        // When nothing happened (no redo started), the question waits again, and the person sees why.
        const started = [...this.attempts.values()].some((x) => x.lineage.rederivedFrom === q.attemptIds[0]);
        if (!started && this.questions.get(questionId)?.status === "answered") this.putQuestion({ ...q, status: "open" });
        throw err;
      }
    }
    this.addLog({ kind: "decision", intentId: q.intentId, attemptId: q.attemptIds[0], message: `${who.name} answers the question about "${intent?.title ?? "a task"}": ${rationale}` });
    this.webhook("question", { question: this.questions.get(questionId), task: intent?.title ?? "", link: this.questionLink(q) });
    return out("answered", message);
  }

  /** What waits for this person in this project (the inbox; GET /api/me/inbox joins the projects). */
  async inbox(viewer: { id: string; role: Role }): Promise<InboxItem[]> {
    const p = this.requireProject();
    return inboxOf(
      { project: p.id, rule: p.settings.approver, intents: [...this.intents.values()], attempts: [...this.attempts.values()], agents: [...this.agents.values()], questions: [...this.questions.values()] },
      viewer,
    );
  }

  /**
   * A person asks the agent to change some lines of its work (a line comment in the app). The agent gets a
   * change request, like any other: in the answer of its next call.
   */
  async requestChange(attemptId: string, input: { path: string; from: number; to: number; text: string }, who: { id: string; name: string }): Promise<T.Correction> {
    const a = this.mustAttempt(attemptId);
    if (TERMINAL.has(a.status)) throw new Error(`The work copy is ${copyStatusWord(a.status)}. The agent does not work on it any more.`);
    const path = String(input.path ?? "").trim().replace(/^\/+/, "");
    const from = Math.floor(Number(input.from));
    const to = Math.floor(Number(input.to));
    const text = String(input.text ?? "").trim().slice(0, 1000);
    if (!path || path.length > 500) throw new Error("Give the path of the file.");
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) throw new Error("Give the lines: from and to. From is 1 or more, and to is not before from.");
    if (!text) throw new Error("Write what the agent must change.");
    const lines = from === to ? `line ${from}` : `lines ${from}–${to}`;
    const corr = this.issueCorrection(
      a.id,
      undefined,
      { kind: "review", message: `${who.name} asks you to change ${path} ${lines}: ${text} Change it, run the tests, and call gitring_ack.`, constraints: { notes: [`${path} ${lines}: ${text}`] } },
      "human",
      "person",
      80,
      true,
    );
    if (!corr) throw new Error("gitring sent this request already. The agent did not read it yet.");
    this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${who.name} asks ${this.callsign(a.id)} to change ${path} ${lines}.`, files: [path] });
    return corr;
  }

  /** What an agent reads when its work copy is over without a merge, or merged: what to do next. */
  private overAdvice(a: T.Attempt): string {
    if (a.status === "landed") return "The work is in main. Send a new plan with gitring_declare for another change.";
    const redo = [...this.attempts.values()].find((x) => x.lineage.rederivedFrom === a.id && !TERMINAL.has(x.status));
    if (redo) return `gitring does the task again as ${redo.id}. Stop work on ${a.id}.`;
    if (a.status === "alternate") return "Another work copy of this task is merged. Stop work on this copy.";
    if (a.status === "stale" && a.stoppedFor) return `${a.stoppedFor} A person decides what happens next. Stop work on ${a.id}.`;
    return "Send a new plan with gitring_declare to continue.";
  }

  /** Where is this work copy? An agent that waits for a person calls this. The answer also brings new change requests. */
  async status(attemptId: string, call: CallInfo = {}): Promise<T.WorkStatus> {
    this.rememberOrigin(call.origin);
    const a = this.mustAttempt(attemptId);
    const returned = a.returned; // heard() clears it
    // A member who did not send the agent looks: that is not an answer of the agent.
    if (this.sentBy(a, call.viewer)) this.heard(a);
    const intent = this.intents.get(a.intentId)!;
    const ap = a.approval;
    const landing = this.landings.find((l) => l.attemptId === a.id);
    let message: string;
    if (a.status === "landed") message = `Merged${landing ? ` at ${landing.mainAfter.slice(0, 7)}` : ""}. The task is done.`;
    else if (ap?.status === "waiting" && a.status === "ready") message = `${this.waitingMessage(a)} Wait. Do not change the work copy.`;
    else if (ap?.status === "sent-back" && a.status === "underway") message = `${ap.answer?.by.name ?? "A person"} sent the work back${ap.answer?.note ? `: ${ap.answer.note}` : "."} Change the work, run the tests, and submit again.`;
    else if (ap?.status === "approved" && (a.status === "ready" || a.status === "landing")) message = a.mergeWait ? `${a.mergeWait.message} The merge waits in the queue.` : "A person said yes. The merge is in the queue.";
    else if (ap?.status === "withdrawn" && a.status === "underway") message = `${ap.closed ?? "The question closed."} Submit again to ask again.`;
    else if (a.status === "underway" && returned) message = `The work did not merge: ${returned.reason} The work is back with you. Change it on the new main, run the tests, and submit again.`;
    else if (a.mergeWait && (a.status === "ready" || a.status === "landing")) message = `${a.mergeWait.message} The work copy waits in the merge queue. Do not change it.`;
    else if (a.status === "underway") message = "The work copy is in work. It is not in the merge queue. Change it, run the tests, and call gitring_submit.";
    else if (TERMINAL.has(a.status)) message = `The work copy is ${copyStatusWord(a.status)}. ${this.overAdvice(a)}`;
    else message = `The work copy is ${copyStatusWord(a.status)}.`;
    return {
      attemptId,
      status: a.status,
      task: { id: intent.id, title: intent.title, status: intent.status },
      ...(ap ? { approval: ap, ...this.mayAnswerOf(a, call.viewer) } : {}),
      line: approvalLine(a),
      link: this.approvalLink(a),
      mainSha: this.requireProject().mainSha,
      ...(landing ? { landing: { sha: landing.mainAfter, method: landing.method, at: landing.at } } : {}),
      ...(a.mergeWait ? { mergeWait: a.mergeWait } : {}),
      message,
      // A member who did not send the agent sees the state, and the change requests stay for the agent.
      clearance: this.withAgain(a, this.clearanceFor(attemptId, this.sentBy(a, call.viewer)), call.again),
    };
  }

  /**
   * The change requests of an earlier answer in the same tool call (see CallInfo.again) that the agent did
   * not confirm yet: the last answer of the call holds them again, so they are never lost.
   */
  private withAgain(a: T.Attempt, clr: T.Clearance, again?: string[]): T.Clearance {
    if (!again?.length) return clr;
    const have = new Set(clr.corrections.map((c) => c.id));
    const extra = again.map((id) => this.corrections.get(id)).filter((c): c is T.Correction => !!c && c.attemptId === a.id && c.status === "delivered" && !have.has(c.id));
    if (!extra.length) return clr;
    const corrections = [...notices(extra, (id) => this.callsign(id)), ...clr.corrections];
    return this.withQuestions(a, { ...clr, corrections, advice: adviceFor(clr.verdict, corrections.length, clr.traffic) });
  }

  /**
   * gitring asks a person in the chat of the agent (a form), so the agent does not read that answer: its change
   * requests wait again. The answer of the second call holds them, or the next call of the agent when the person
   * never answers the form.
   */
  async holdCorrections(attemptId: string, ids: string[]): Promise<void> {
    for (const id of new Set(ids)) {
      const c = this.corrections.get(id);
      if (!c || c.attemptId !== attemptId || c.status !== "delivered") continue;
      c.status = "pending";
      c.deliveredAt = undefined;
      this.putCorrection(c);
    }
  }

  /**
   * A person merges a work copy ("pick"). When the work copy waits for an answer, this is the yes of that
   * approval: the rules of canDecide apply (`role`: the role that the Worker checked; callers inside gitring
   * are owners). `waits`: the merge waits for the hourly test budget (not a failure).
   */
  async land(attemptId: string, rationale: string, by: T.Actor = HUMAN, role: Role = "owner"): Promise<{ status: T.AttemptStatus; message: string; landing?: T.Landing; waits?: { until: number }; refused?: true }> {
    const asked = this.mustAttempt(attemptId);
    if (asked.approval?.status === "waiting") {
      const res = await this.decide(attemptId, { answer: "approve", note: rationale }, { id: by.id, name: by.name, role }, "app");
      return { status: res.status, message: res.message, ...(res.landing ? { landing: res.landing } : {}), ...(res.waits ? { waits: res.waits } : {}), ...(res.outcome === "refused" ? { refused: true as const } : {}) };
    }
    return this.landWork(attemptId, rationale, by);
  }

  /** The merge of a work copy that a person chose, or said yes to. */
  private async landWork(attemptId: string, rationale: string, by: T.Actor): Promise<{ status: T.AttemptStatus; message: string; landing?: T.Landing; waits?: { until: number } }> {
    const a = this.mustAttempt(attemptId);
    if (a.status === "landed") return { status: a.status, message: "This work copy is already on main." };
    if (TERMINAL.has(a.status)) return { status: a.status, message: `The work copy is ${copyStatusWord(a.status)}. Redo it on the new main first.` };
    let deferred: T.CheckRun["wait"];
    if (!a.checks?.ok) {
      const run = await this.check(a.id);
      // The test budget is used: no test ran, and that is not a failure. The tests of main plus this work decide at the merge.
      if (run.wait) deferred = run.wait;
      else if (!run.ok) return { status: a.status, message: `${failureSummary(run.cases)} gitring does not merge work whose tests fail.` };
    }
    this.recordDecision({ kind: "pick", intentId: a.intentId, attemptIds: [a.id], by, rationale });
    a.status = "ready";
    if (deferred) a.mergeWait = { until: deferred.retryAt, message: deferred.message };
    this.putAttempt(a);
    this.enqueueLanding(a);
    await this.landingChain;
    const landing = this.landings.find((l) => l.attemptId === a.id);
    const now = this.attempts.get(a.id)!;
    return {
      status: now.status,
      landing,
      ...(!landing && now.mergeWait ? { waits: { until: now.mergeWait.until } } : {}),
      message: landing
        ? `Merged by ${METHOD_WORD[landing.method]} at ${landing.mainAfter.slice(0, 7)}.`
        : now.mergeWait
          ? `${now.mergeWait.message} The work copy waits in the merge queue.`
          : `The work did not merge (${copyStatusWord(now.status)}). gitring does the task again on the new main.`,
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
    const agent = builtin ? oldAgent! : this.upsertAgent({ kind: "builtin", model: this.projectModels(p)[0] });
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
      // The redo keeps the time of the plan that it redoes, so R4 stays fair to it.
      course: { ...old.course, declaredAt: old.course.declaredAt ?? now },
      footprint: emptyFootprint(),
      corrections: [],
      lineage: { generation: old.lineage.generation + 1, rederivedFrom: old.id },
      stats: { filesChanged: 0, additions: 0, deletions: 0, steps: 0 },
      ...((old.sender ?? personOf(by)) ? { sender: old.sender ?? personOf(by) } : {}),
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
    if (by.kind === "human") {
      this.recordDecision({ kind: "rederive", intentId: a.intentId, attemptIds: [old.id, a.id], by, rationale: reason });
      // A person started the redo: the task does not wait for a person any more (unless other work waits).
      this.closeRedoQuestions(a.intentId, `${by.name} started a redo.`);
      this.refreshJudging(a.intentId);
    }
    this.addLog({ kind: "rederive", attemptId: a.id, agentId: agent.id, intentId: a.intentId, message: `Redo "${this.intents.get(a.intentId)?.title}" on main ${main.sha.slice(0, 7)} (try ${a.lineage.generation}). Reason: ${reason}` });
    // The outside agent of the old work copy reads "stop work" in the answer of its next call (see overAdvice).
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
    const text = view.changed.map((c) => {
      const d = lineDiff(c.base ?? "", c.head ?? "");
      return {
        path: c.path,
        status: (c.base === null ? "A" : c.head === null ? "D" : "M") as T.FileChangeStatus,
        additions: d.additions,
        deletions: d.deletions,
        diff: unifiedDiff(c.path, c.base, c.head),
      };
    });
    // Changes without text (binary or large files, modes): they merge too, so people see them.
    const other = view.opaque.map((c) => ({ path: c.path, status: c.status, additions: 0, deletions: 0, diff: opaqueDiff(c) }));
    return { files: [...text, ...other].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)) };
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

  /**
   * The whole history of the project, oldest first, one page at a time (the Replay view reads it). It reads
   * the activity log and the conflict checks from storage, not only the recent window of the live state.
   * `after`: the `next` cursor of the page before (absent: from the start).
   */
  async events(after?: string | null, limit?: number): Promise<TimelinePage> {
    this.requireProject();
    const sources = {
      intents: this.intents.values(),
      attempts: this.attempts.values(),
      corrections: this.corrections.values(),
      decisions: this.decisions,
      landings: this.landings,
      agents: this.agents.values(),
    };
    return readTimeline(this.ctx.storage.sql, sources, after ?? null, limit);
  }

  /** Changes on every start of this object: versions of work copies are counted in memory. */
  private readonly bootId = rand(6);

  /**
   * A cheap version of a ref for HTTP caching (ETag), without reading files: main and commits are their
   * commit ids; a work copy is its id, base, last push and edit counter. Null: unknown ref.
   */
  async refVersion(ref: string): Promise<string | null> {
    const p = this.requireProject();
    if (ref === "main") return p.mainSha || null;
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    const a = this.attempts.get(ref);
    if (!a) return null;
    return `${a.id}@${a.baseSha.slice(0, 10)}.${(a.headSha ?? "").slice(0, 10)}.${this.attemptVersion.get(a.id) ?? 0}.${this.bootId}`;
  }

  /** The files of main, a work copy (base + its work) or a commit, for the code view. */
  async tree(ref: string): Promise<T.TreeResponse> {
    const p = this.requireProject();
    if (ref === "main" || ref === p.mainSha) {
      const m = await this.loadMain();
      return { ref, sha: m.sha, files: m.files };
    }
    const a = this.attempts.get(ref);
    if (a) {
      const view = await this.attemptView(a);
      // Every file of the work, text or not (the tree that merges), plus text the agent wrote to a path git cannot hold.
      const paths = new Set([...view.snapshot.keys(), ...view.files.keys()]);
      const files = [...paths].sort().map((path) => ({ path, size: view.files.get(path)?.length ?? 0, lang: langOf(path) }));
      return { ref, sha: (await this.refVersion(ref)) ?? a.id, files };
    }
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`Unknown ref ${ref}. Use main, a work copy id or a commit id.`);
    const commit = await this.backend.readCommit(p.repo.name, ref);
    if (!commit) throw new Error(`Commit ${ref.slice(0, 7)} is not in this project.`);
    const tt = await this.treeText(p.repo.name, commit.treeHash);
    return { ref, sha: ref, files: fileNodes(tt.snapshot, tt.text) };
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

  /* ════════════════════════════ history questions (derived data: ./derived.ts) ════════════════════════════ */

  private derivedData?: DerivedHistory;
  private get derived(): DerivedHistory {
    this.derivedData ??= new DerivedHistory({
      sql: this.ctx.storage.sql,
      main: () => {
        const p = this.project;
        return p && !p.importing && p.mainSha && p.mainTree ? { repo: p.repo.name, sha: p.mainSha, tree: p.mainTree } : undefined;
      },
      landings: () => this.landings,
      note: (id) => this.db.landingNote(id),
      callsign: (agentId) => this.agents.get(agentId)?.callsign ?? agentId,
      title: (intentId) => this.intents.get(intentId)?.title ?? intentId,
      commit: (sha) => this.backend.readCommit(this.requireProject().repo.name, sha),
      readTree: async (tree) => {
        const hit = this.treeCache.get(tree);
        if (hit) return hit;
        const entries = await this.backend.readTree(this.requireProject().repo.name, tree);
        if (entries) this.treeCache.set(tree, entries);
        return entries;
      },
      text: (blob) => this.readText(this.requireProject().repo.name, blob),
      treeText: (tree) => this.treeText(this.requireProject().repo.name, tree),
      workCopy: async (id) => {
        const a = this.attempts.get(id);
        if (!a) return undefined;
        const view = await this.attemptView(a);
        const deleted = view.changed.filter((c) => c.head === null).map((c) => c.path);
        return { attempt: a, files: view.files, deleted, callsign: this.callsign(a.id) ?? a.agentId, title: this.intents.get(a.intentId)?.title ?? a.intentId };
      },
      background: (work) => this.ctx.waitUntil(work.catch((e) => console.warn("history", errorLine(e)))),
    });
    return this.derivedData;
  }

  /** Why a line (or a file) is what it is on main, a commit of main or a work copy. */
  async why(input: { path: string; line?: number; ref?: string }): Promise<WhyAnswer> {
    return this.derived.why(input);
  }

  /** The changes of a file or a folder, or of main, the newest first. */
  async pathHistory(input: { path?: string; limit?: number }): Promise<HistoryAnswer> {
    return this.derived.history(input);
  }

  /** Find a text in the files of main. */
  async searchCode(input: { query: string; path?: string; limit?: number }): Promise<SearchAnswer> {
    return this.derived.search(input);
  }

  /** The changes between two versions (main, a commit id or a work copy id), for all files or under a path. */
  async compareRefs(from: string, to: string, path?: string): Promise<CompareAnswer> {
    return this.derived.compare(from, to, path);
  }

  /** Files for a live preview: "main" or an attempt id. */
  async previewFiles(ref: string): Promise<{ key: string; files: Record<string, string> } | null> {
    await this.ensure(this.project?.id);
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

  async connectInfo(origin: string): Promise<T.ConnectInfo> {
    const p = await this.ensure(this.project?.id);
    const providers = await this.directory()
      .providers()
      .catch(() => ({ github: null }));
    const [slackKey, githubKey] = await Promise.all([
      this.env.SLACK_SIGNING_SECRET ? hookKey(this.env.SLACK_SIGNING_SECRET, "slack", p.id) : null,
      this.env.GITHUB_WEBHOOK_SECRET ? hookKey(this.env.GITHUB_WEBHOOK_SECRET, "github", p.id) : null,
    ]);
    return {
      projectId: p.id,
      mcpUrl: `${origin}/mcp`,
      hookUrl: `${origin}/hooks/claude/${encodeURIComponent(p.id)}`,
      intentsUrl: `${origin}/hooks/intents`,
      artifacts: { namespace: p.repo.namespace, repo: p.repo.name, remote: p.repo.remote, backend: p.repo.backend },
      inputs: { slack: Boolean(this.env.SLACK_SIGNING_SECRET), githubIssues: Boolean(providers.github?.webhook) },
      ...(slackKey ? { slackUrl: `${origin}/hooks/slack?project=${encodeURIComponent(p.id)}&key=${slackKey}` } : {}),
      ...(githubKey ? { githubHookUrl: `${origin}/hooks/github?project=${encodeURIComponent(p.id)}&key=${githubKey}` } : {}),
      githubApp: providers.github ? { slug: providers.github.slug, installUrl: providers.github.installUrl } : null,
    };
  }

  /** The GitHub repository of this project: the linked one, else the imported one. */
  async githubRepoOf(): Promise<string | null> {
    const p = this.requireProject();
    return p.settings.github.repo || (p.source?.kind === "github" ? p.source.repo : null) || null;
  }

  private directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
  }

  /* ════════════════════════════ GitHub sync ════════════════════════════ */

  /*
   * GitHub state is kept per repository (meta "gh:<owner/name>"): unlinking and linking again, or a run
   * that finishes after a relink, never mixes the commit pairs, pulls or conflicts of two repositories.
   */
  private ghKey(repo: string): string {
    return `gh:${repo.toLowerCase()}`;
  }

  private gh(repo: string): GithubRepoState {
    return this.db.getMeta<GithubRepoState>(this.ghKey(repo)) ?? { known: {}, upstreamOf: {} };
  }

  private setGh(repo: string, patch: Partial<GithubRepoState>): GithubRepoState {
    const next = { ...this.gh(repo), ...patch };
    next.known = Object.fromEntries(Object.entries(next.known).slice(-1000));
    next.upstreamOf = Object.fromEntries(Object.entries(next.upstreamOf).slice(-200));
    this.db.setMeta(this.ghKey(repo), next);
    return next;
  }

  /** Move state of the first GitHub sync version (separate meta keys) into the per-repository state. */
  private migrateGithubState(): void {
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

  /**
   * What gitring knows about the linked repository (the Worker asks before a project goes public, and
   * when an owner changes the GitHub settings): whether it is private, whether private code came into
   * the project, and the person whose GitHub rights gitring checks for the link.
   */
  async githubFacts(): Promise<{ repo?: string; private?: boolean; privateCode?: boolean; actor?: { userId: string; gone?: string } }> {
    const p = this.requireProject();
    const repo = p.settings.github.repo;
    const privateCode = Boolean(p.privateCode);
    if (!repo) return { privateCode };
    const st = this.gh(repo);
    return { repo, private: st.private, privateCode, ...(st.actor ? { actor: { userId: st.actor.userId, ...(st.actor.gone ? { gone: st.actor.gone } : {}) } } : {}) };
  }

  /** Private code (or a private issue) came in from `repo`: the project stays private from now on. */
  private holdPrivate(repo: string): void {
    const p = this.requireProject();
    if (p.privateCode) return;
    p.privateCode = { repo, at: Date.now() };
    this.db.setMeta("project", p);
  }

  /**
   * The person whose GitHub rights gitring re-checks for this link (the importer, or the owner who
   * linked it or turned on sync), and what GitHub said at that time.
   */
  async setGithubActor(userId: string | null, facts: { read: boolean; push: boolean; private?: boolean }): Promise<void> {
    const repo = this.requireProject().settings.github.repo;
    if (!repo) return;
    this.setGh(repo, {
      actor: userId ? { userId, checkedAt: Date.now(), read: facts.read, push: facts.push } : undefined,
      ...(facts.private !== undefined ? { private: facts.private } : {}),
    });
  }

  /**
   * A person left the project (or is a viewer now). When gitring checked their GitHub rights for the
   * link, it stops: sync and pulls of a private repository wait until an owner saves the GitHub settings
   * again, and that owner's rights count then.
   */
  async githubActorLeft(userId: string): Promise<void> {
    const p = this.requireProject();
    const repo = p.settings.github.repo;
    if (!repo || !userId) return;
    const st = this.gh(repo);
    if (!st.actor || st.actor.userId !== userId || st.actor.gone) return;
    const gone = `The person whose GitHub rights gitring checked for ${repo} is no longer a member of this project. An owner saves the GitHub settings again (Settings → GitHub); then that owner's GitHub rights count.`;
    this.setGh(repo, { actor: { ...st.actor, read: false, push: false, gone } });
    this.addLog({ kind: "system", message: `GitHub ${repo}: ${gone}` });
    if (p.settings.github.mode !== "off") this.setGithub({ state: "error", message: gone, repo, mode: p.settings.github.mode, at: Date.now() });
  }

  /**
   * Does the person behind the link still have the rights on GitHub (push for sync, read for pulls of a
   * private repository)? GitHub is asked at most once a day; with `fresh`, it is asked now (a private
   * repository: a read that GitHub allowed earlier does not count). Links made with the operator key
   * have no person to check.
   */
  private async githubRights(repo: string, need: "read" | "push", fresh = false): Promise<{ ok: true } | { ok: false; message: string }> {
    const st = this.gh(repo);
    const actor = st.actor;
    if (!actor) return { ok: true };
    if (actor.gone) return { ok: false, message: actor.gone };
    const recent = Date.now() - actor.checkedAt < 24 * 3600_000;
    if (!fresh && recent && actor[need]) return { ok: true };
    try {
      const perm = await this.directory().githubPermission(actor.userId, repo);
      this.setGh(repo, { actor: { ...actor, checkedAt: Date.now(), read: perm.read, push: perm.push }, ...(perm.private !== undefined ? { private: perm.private } : {}) });
      if (perm[need]) return { ok: true };
      return { ok: false, message: `The person who linked ${repo} can no longer ${need === "push" ? "push to" : "read"} it on GitHub (${perm.message}) An owner links it again in Settings → GitHub.` };
    } catch (e) {
      // GitHub did not answer. For a push, a recent good answer still counts (a week), so a short outage
      // stops nothing. For a private repository's code, nothing comes in without an answer.
      if (!fresh && actor[need] && Date.now() - actor.checkedAt < 7 * 24 * 3600_000) return { ok: true };
      return { ok: false, message: `gitring could not check the GitHub rights for ${repo}: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
    }
  }

  /**
   * An issue of the repository becomes a task. An issue of a private repository goes only into a private
   * project, and only when the person behind the link can read the repository now: the issue text is
   * private too, and from then on the project stays private.
   */
  async githubIssueIntent(input: { repo: string; private?: boolean; title: string; goal: string; number?: number }): Promise<{ intent: T.Intent } | { refused: string }> {
    const p = this.requireProject();
    const repo = input.repo;
    const isPrivate = input.private ?? this.gh(repo).private ?? false;
    if (isPrivate) {
      if ((await this.directory().visibilityOf(p.id)) === "public") return { refused: `${repo} is private on GitHub, and this project is public. The issue does not become a task.` };
      const rights = await this.githubRights(repo, "read", true);
      if (!rights.ok) return { refused: rights.message };
      this.setGh(repo, { private: true });
      this.holdPrivate(repo);
    }
    const intent = await this.createIntent(
      { title: input.title, goal: input.goal || input.title, source: { kind: "webhook", ref: `github:${repo}#${input.number ?? ""}` } },
      { kind: "system", id: "github", name: "GitHub" },
    );
    return { intent };
  }

  /** The GitHub sync status for people (settings and the overview). */
  async githubStatus(): Promise<T.GithubSyncStatus> {
    const p = this.requireProject();
    const g = p.settings.github;
    const pull = g.repo ? this.gh(g.repo).pull : undefined;
    const withPull = (st: T.GithubSyncStatus): T.GithubSyncStatus => (pull ? { ...st, pull } : st);
    if (g.mode === "off") return withPull({ state: "off", message: "GitHub sync is off. Merged code stays in Cloudflare Artifacts.", mode: "off", ...(g.repo ? { repo: g.repo } : {}) });
    if (!g.repo) return { state: "not-linked", message: "Link a GitHub repository to send merged code to GitHub.", mode: g.mode };
    const st = p.github;
    if (st && st.repo === g.repo && st.mode === g.mode) return withPull(st);
    return withPull({ state: "pending", message: "gitring sends main to GitHub after the next merge, or when you choose Sync now.", repo: g.repo, mode: g.mode, branch: g.mode === "main" ? g.base : g.branch });
  }

  private githubRun?: Promise<T.GithubSyncStatus>;
  private githubAgain = false;

  /** Send main to GitHub now (settings.github). One run at a time; a request during a run runs again after it. */
  async githubSync(): Promise<T.GithubSyncStatus> {
    const p = this.requireProject();
    const g = p.settings.github;
    if (g.mode === "off" || !g.repo) return this.githubStatus();
    if (this.githubRun) {
      this.githubAgain = true;
      return this.githubRun;
    }
    this.githubRun = this.githubSyncOnce(p, g.repo, g.mode, g.branch, g.base).finally(() => {
      this.githubRun = undefined;
      if (this.githubAgain) {
        this.githubAgain = false;
        this.ctx.waitUntil(this.githubSync().catch((e) => console.warn("github sync failed", String(e))));
      }
    });
    return this.githubRun;
  }

  private async githubSyncOnce(p: T.Project, repo: string, mode: "pull-request" | "main", branch: string, baseBranch?: string): Promise<T.GithubSyncStatus> {
    const base = { repo, mode, ...(mode === "pull-request" ? { branch } : baseBranch ? { branch: baseBranch } : {}) };
    if (!p.mainSha) return this.setGithub({ state: "pending", message: "Main is empty. gitring syncs after the first commit.", ...base });
    const before = p.github;
    this.setGithub({ ...(before?.repo === repo ? before : {}), state: "pending", message: "gitring sends main to GitHub.", ...base, at: Date.now() });
    const rights = await this.githubRights(repo, "push");
    if (!rights.ok) return this.setGithub({ state: "error", message: rights.message, ...base, at: Date.now() });
    const run = async (fresh: boolean) => {
      const access = await this.directory()
        .githubRepoAccess(repo, fresh)
        .catch((e) => ({ ok: false as const, state: "error" as const, message: `gitring could not ask GitHub: ${String((e as Error)?.message ?? e).slice(0, 160)}`, installUrl: undefined as string | undefined }));
      if (!access.ok) return { access };
      const st = this.gh(repo);
      const out = await syncToGithub(
        { repo, token: access.token },
        {
          backend: this.backend,
          source: p.repo.name,
          mainSha: p.mainSha,
          mode,
          branch,
          base: baseBranch,
          known: st.known,
          upstreamOf: st.upstreamOf,
          pr: {
            title: `gitring: merged work for ${p.name}`,
            body: [
              "This pull request holds the work that gitring merged on main.",
              "Each commit is one merged task. Its record (plan, conflict checks, change requests, tests) is a git note on `refs/notes/gitring` in the gitring repository.",
              "",
              "Merge it with **Create a merge commit**: then the next pull request shows only new work.",
            ].join("\n"),
          },
        },
      );
      return { out };
    };
    let res = await run(false);
    if ("out" in res && res.out?.unauthorized) res = await run(true);
    if ("access" in res && res.access && !res.access.ok) {
      const a = res.access;
      return this.setGithub({ state: a.state, message: a.message, ...base, ...(a.installUrl ? { installUrl: a.installUrl } : {}), at: Date.now() });
    }
    const out = (res as { out: Awaited<ReturnType<typeof syncToGithub>> }).out;
    // Pairs are kept even when the run stopped: the next run continues from them.
    this.setGh(repo, { known: out.known, ...(out.status.githubSha && (out.status.state === "ok" || out.status.state === "pending") ? { last: out.status.githubSha } : {}) });
    // The link changed during the run: the answer belongs to the old repository.
    if (this.requireProject().settings.github.repo?.toLowerCase() !== repo.toLowerCase()) return this.githubStatus();
    const st = this.setGithub(out.status);
    if (out.more) this.githubAgain = true;
    // Straight to main, and GitHub has commits that gitring does not have: bring them in, then send again.
    if (st.state === "blocked" && mode === "main" && !this.pullRun && /commits that gitring does not have/.test(st.message)) {
      this.ctx.waitUntil(
        this.githubPull({ reason: "sync" })
          .then((after) => (after.pull?.state === "merged" ? this.githubSync() : undefined))
          .catch((e) => console.warn("github pull failed", String(e))),
      );
    }
    if (st.state === "ok" && st.githubSha !== before?.githubSha) {
      this.addLog({ kind: "system", message: `GitHub ${repo}: ${st.message}` });
    } else if (st.state !== "ok" && st.state !== "pending" && (st.state !== before?.state || st.message !== before?.message)) {
      this.addLog({ kind: "system", message: `GitHub sync of ${repo} stopped: ${st.message}` });
    }
    return st;
  }

  private setGithub(st: T.GithubSyncStatus): T.GithubSyncStatus {
    const p = this.requireProject();
    const { pull: _pull, ...rest } = st;
    p.github = rest;
    this.db.setMeta("project", p);
    const repo = p.settings.github.repo;
    const pull = repo ? this.gh(repo).pull : undefined;
    const out = pull ? { ...rest, pull } : rest;
    this.emit({ type: "github", github: out });
    return out;
  }

  private setPull(repo: string, pull: T.GithubPullStatus): void {
    this.setGh(repo, { pull });
    const p = this.requireProject();
    if (p.settings.github.repo?.toLowerCase() !== repo.toLowerCase()) return;
    this.emit({ type: "github", github: { ...(p.github ?? { state: "off", message: "" }), pull } });
  }

  /* ───────────── bring GitHub changes into main ───────────── */

  private pullRun?: Promise<void>;
  private pullAgain = false;

  /** A GitHub commit that main has: the last sync of main, else the last pull or sync, or the import. */
  private githubSince(repo: string): string | null {
    const p = this.requireProject();
    const st = this.gh(repo);
    return st.known[p.mainSha] ?? st.last ?? null;
  }

  /**
   * Bring new commits of the followed GitHub branch into main (a push webhook, Pull now, a merged
   * conflict task, or a blocked sync). One run at a time, after the merges in the queue; a request
   * during a run runs once more after it. Answers the GitHub status with the pull result.
   */
  async githubPull(opts: { reason?: "webhook" | "manual" | "task" | "sync"; ref?: string; defaultBranch?: string } = {}): Promise<T.GithubSyncStatus> {
    const p = this.requireProject();
    const g = p.settings.github;
    const repo = g.repo;
    if (!repo) throw new Error("Link a GitHub repository first (Settings → GitHub).");
    if (p.importing) return this.githubStatus();
    // GitHub is optional: a push on GitHub changes main only when an owner turned GitHub sync on. A member
    // can still bring the changes in by hand (Pull now).
    if (opts.reason === "webhook" && g.mode === "off") return this.githubStatus();
    // A push webhook: only pushes to the followed branch matter.
    if (opts.ref && opts.ref !== `refs/heads/${g.base || opts.defaultBranch}`) return this.githubStatus();
    if (this.pullRun) {
      this.pullAgain = true;
    } else {
      const reason = opts.reason ?? "manual";
      // Pulls run in the merge queue: no merge moves main while gitring reads and merges GitHub's changes.
      const job = this.landingChain.then(() => this.githubPullOnce(repo, reason));
      this.landingChain = job.catch(() => undefined);
      this.pullRun = job
        .catch((e) => this.setPull(repo, { state: "error", message: `gitring could not bring the GitHub changes in: ${String((e as Error)?.message ?? e).slice(0, 200)}`, at: Date.now() }))
        .finally(() => {
          this.pullRun = undefined;
          if (this.pullAgain) {
            this.pullAgain = false;
            this.ctx.waitUntil(this.githubPull({ reason }).catch((e) => console.warn("github pull failed", String(e))));
          }
        });
    }
    await this.pullRun;
    return this.githubStatus();
  }

  private async githubPullOnce(repo: string, reason: string, again = 0): Promise<void> {
    const p = this.requireProject();
    const sameLink = () => this.requireProject().settings.github.repo?.toLowerCase() === repo.toLowerCase();
    if (!sameLink()) return;
    const since = this.githubSince(repo);
    if (!since) {
      return this.setPull(repo, { state: "error", message: "gitring does not know which GitHub commit main came from. Bringing changes in works for projects imported from GitHub.", at: Date.now() });
    }
    const st0 = this.gh(repo);
    this.setPull(repo, { ...(st0.pull ?? { message: "" }), state: "pending", message: "gitring reads the GitHub changes.", at: Date.now() });
    // A private repository: the person behind the link must be able to read it now (GitHub is asked on
    // every pull). When gitring does not know yet whether it is private, the daily check runs here and
    // the answer of GitHub below decides.
    let checkedNow = false;
    if (st0.private !== false) {
      const rights = await this.githubRights(repo, "read", st0.private === true);
      if (!rights.ok) return this.setPull(repo, { state: "error", message: rights.message, at: Date.now() });
      checkedNow = st0.private === true;
    }
    const access = await this.directory()
      .githubRepoAccess(repo)
      .catch(() => ({ ok: false as const, state: "error" as const, message: "gitring could not ask GitHub for access.", installUrl: undefined as string | undefined }));
    // Public repositories work without the app (GitHub's limits for anonymous calls apply).
    const token = access.ok ? access.token : null;
    const main = await this.loadMain();
    const conflict = this.gh(repo).conflict;
    const conflictIntent = conflict ? this.intents.get(conflict.intentId) : undefined;
    // Only the files that the merged conflict task changed count as merged by hand.
    let resolved: Record<string, string | null> | undefined;
    if (conflict && conflictIntent?.status === "landed") {
      const chosen = conflictIntent.chosenAttemptId ? this.attempts.get(conflictIntent.chosenAttemptId) : undefined;
      const touched = new Set(Object.keys(chosen?.footprint.files ?? {}));
      resolved = Object.fromEntries(Object.entries(conflict.files).filter(([path]) => touched.has(path)));
    }
    const res = await upstreamChanges({ repo, token, backend: this.backend, source: p.repo.name, main: main.snapshot, since, resolved, branch: p.settings.github.base });
    if (!sameLink()) return;
    if (res.state === "error") {
      const hint = !access.ok && access.installUrl ? ` Install the gitring GitHub App on ${repo} for private repositories.` : "";
      return this.setPull(repo, { state: "error", message: `${res.message}${hint}`, at: Date.now() });
    }
    // What GitHub says now counts: a repository that turned private is private from this pull on.
    this.setGh(repo, { private: res.private });
    if (res.private && !checkedNow) {
      // The read that GitHub allowed at link time does not count: the person must read it now.
      const rights = await this.githubRights(repo, "read", true);
      if (!rights.ok) return this.setPull(repo, { state: "error", message: rights.message, at: Date.now() });
    }
    // Private code never flows into a public project.
    if (res.private && (await this.directory().visibilityOf(p.id)) === "public") {
      return this.setPull(repo, { state: "error", message: `${repo} is private on GitHub, and this project is public. Make the project private to bring the changes in.`, at: Date.now() });
    }
    if (res.state === "up-to-date") {
      this.closeConflictTask(repo, "GitHub has nothing new for this task: main has every GitHub change.");
      return this.setPull(repo, { state: "up-to-date", message: res.message, headSha: res.head, at: Date.now() });
    }
    // From here on, GitHub's content goes into the project (a task's text, or main).
    if (res.private) this.holdPrivate(repo);
    if (res.state === "conflict") {
      const files = Object.fromEntries(res.conflicts.map((c) => [c.path, c.theirs]));
      const open = conflict && conflictIntent && !["landed", "parked", "merged-into"].includes(conflictIntent.status);
      const same = open && Object.keys(files).every((f) => f in conflict!.files && conflict!.files[f] === files[f]);
      let intentId = conflict?.intentId;
      if (!same) {
        if (open) this.closeConflictTask(repo, "GitHub has newer changes: a new task replaces this one.");
        const diffs = res.conflicts.map((c) => c.diff).join("\n");
        const intent = await this.createIntent(
          {
            title: `Merge GitHub changes into main (${res.conflicts.length} file${res.conflicts.length === 1 ? "" : "s"})`,
            goal: [
              `GitHub ${repo} ${res.branch} has ${res.commits} new commit${res.commits === 1 ? "" : "s"} (${res.compareUrl}).`,
              `In ${res.conflicts.map((c) => c.path).join(", ")}, GitHub and main changed the same lines.`,
              "Apply GitHub's change below to main's version of these files. Keep the work that is on main.",
              "When this task merges, gitring brings the other GitHub changes in.",
              "",
              diffs.length > 2600 ? `${diffs.slice(0, 2600)}\n… (the full change: ${res.compareUrl})` : diffs,
            ].join("\n"),
            priority: "high",
            source: { kind: "webhook", ref: `github:${repo}` },
          },
          { kind: "system", id: "github", name: "GitHub" },
        );
        intentId = intent.id;
        this.setGh(repo, { conflict: { head: res.head, files, intentId } });
      }
      return this.setPull(repo, { state: "conflict", message: `${res.message} The task "Merge GitHub changes into main" asks an agent or a person to merge them.`, headSha: res.head, files: Object.keys(files), intentId, compareUrl: res.compareUrl, at: Date.now() });
    }
    const n = `${res.commits} commit${res.commits === 1 ? "" : "s"}`;
    const links = Object.keys(res.gitlinks);
    // Main has exactly GitHub's files (GitHub merged gitring's pull request with a merge commit): no commit.
    // Main is GitHub's head from now on, so the next sync starts there and opens no empty pull request.
    if (!res.changes.length && !links.length && res.headTree === main.tree) {
      const st = this.gh(repo);
      this.setGh(repo, { known: { ...st.known, [main.sha]: res.head }, last: res.head });
      this.closeConflictTask(repo, "GitHub has nothing new for this task: main has every GitHub change.");
      this.addLog({ kind: "system", message: `GitHub ${repo} ${res.branch} has main's files at ${res.head.slice(0, 7)} (${n}). Nothing to merge.` });
      this.setPull(repo, { state: "up-to-date", message: `main has the files of GitHub ${res.branch} (${res.head.slice(0, 7)}).`, headSha: res.head, mainSha: main.sha, at: Date.now() });
      // The sync status follows (the pull request is merged: the branch moves, no new pull request opens).
      if (p.settings.github.mode !== "off" && reason !== "sync") this.ctx.waitUntil(this.githubSync().catch((e) => console.warn("github sync failed", String(e))));
      return;
    }
    // New GitHub commits: one merge commit on main, also when main already had every change (then the
    // commit is empty), so that GitHub's history joins main's and the next sync can fast-forward.
    const message = [
      `Bring GitHub changes into main`,
      "",
      `${n} from ${repo} ${res.branch} (${res.base.slice(0, 7)}..${res.head.slice(0, 7)}).${res.authors.length ? ` Changes by ${res.authors.join(", ")}.` : ""}`,
      ...(res.changes.length ? [] : ["main already had these changes."]),
      ...(links.length ? [`Submodules (kept on GitHub): ${links.slice(0, 5).join(", ")}.`] : []),
      "",
      `Gitring-Upstream: ${repo}@${res.head}`,
    ].join("\n");
    let committed: { sha: string; tree: string };
    try {
      committed = await this.backend.commit({ repo: p.repo.name, branch: this.branch, parent: main.sha, changes: res.changes, message, author: GITRING_AUTHOR });
    } catch (err) {
      // main moved while gitring read GitHub: read again on the new main.
      if ((err instanceof RepoConflictError || String(err).includes("RepoConflict")) && again < 3) return this.githubPullOnce(repo, reason, again + 1);
      throw err;
    }
    const before = p.mainSha;
    p.mainSha = committed.sha;
    p.mainTree = committed.tree;
    this.db.setMeta("project", p);
    this.appendMainSeq(committed.sha);
    const st = this.gh(repo);
    this.setGh(repo, { upstreamOf: { ...st.upstreamOf, [committed.sha]: links.length ? { head: res.head, gitlinks: res.gitlinks } : res.head }, last: res.head });
    this.closeConflictTask(repo, "GitHub's changes are in main now.");
    const files = res.changes.map((c) => c.path);
    const newMain = await this.loadMain();
    this.emit({ type: "main", sha: newMain.sha, tree: newMain.tree, files: newMain.files, imports: newMain.imports });
    this.addLog({ kind: "system", message: `GitHub changes merged into main: ${n} from ${repo} ${res.branch} (${committed.sha.slice(0, 7)}, ${files.length} file${files.length === 1 ? "" : "s"}).`, files });
    this.setPull(repo, { state: "merged", message: `main has ${n} from GitHub ${res.branch} (${res.head.slice(0, 7)}).`, headSha: res.head, mainSha: committed.sha, compareUrl: res.compareUrl, at: Date.now() });
    this.webhook("main", { reason: "github", mainBefore: before, mainSha: committed.sha, files });
    if (files.length) await this.mainMovedUnder(newMain, { title: `GitHub changes (${repo})`, files });
    // The tests run on the new main. A failure does not undo the pull: it opens a task for agents.
    if (files.length) this.ctx.waitUntil(this.testMainAfterPull(repo, newMain, n).catch((e) => console.warn("tests after pull failed", errorLine(e))));
    // Send the merge back, so the GitHub branch has main again (fast-forward or the pull request).
    if (p.settings.github.mode !== "off" && reason !== "sync") this.ctx.waitUntil(this.githubSync().catch((e) => console.warn("github sync failed", String(e))));
  }

  /** The test runs of main after GitHub changes, one after the other. */
  private pullTests: Promise<unknown> = Promise.resolve();

  /**
   * The tests of main after GitHub changes came in. When tests fail, a high-priority task asks agents to
   * fix them (one open task at a time). A run that did not happen opens no task: the test budget, a test
   * container that did not start, or a project with no test command (nothing in the code to fix).
   * One run at a time, so that two pulls in a row cannot open two tasks.
   */
  private testMainAfterPull(repo: string, main: MainView, what: string): Promise<T.CheckRun> {
    const run = this.pullTests.then(() => this.testMainOnce(repo, main, what));
    this.pullTests = run.catch(() => undefined);
    return run;
  }

  private async testMainOnce(repo: string, main: MainView, what: string): Promise<T.CheckRun> {
    const run = await this.runTreeChecks(main.text, "main", "main");
    const total = run.passed + run.failed;
    if (run.wait) {
      this.addLog({ kind: "check", message: `Tests after the GitHub changes: not run. ${run.wait.message}`, data: { checkRunId: run.id, ok: false } });
      return run;
    }
    const failed = run.cases.filter((c) => !c.ok);
    if (run.ok) {
      const message = noTestRan(run) ? "Tests after the GitHub changes: no test ran. Add tests in tests/*.test.js." : `Tests after the GitHub changes: ${run.passed}/${total} pass.`;
      this.addLog({ kind: "check", message, data: { checkRunId: run.id, ok: true } });
      return run;
    }
    if (!failed.length && run.runner === "container") {
      this.addLog({ kind: "check", message: `Tests after the GitHub changes: not run. ${run.error ?? "The test container gave no result."}`, data: { checkRunId: run.id, ok: false } });
      return run;
    }
    this.addLog({
      kind: "check",
      message: failed.length ? `Tests after the GitHub changes: ${failed.length} of ${total} fail on main ${main.sha.slice(0, 7)}.` : `Tests after the GitHub changes: the tests do not run on main ${main.sha.slice(0, 7)}.`,
      data: { checkRunId: run.id, ok: false },
    });
    const openId = this.db.getMeta<string>("pullTestTask");
    const open = openId ? this.intents.get(openId) : undefined;
    if (open && !["landed", "parked", "merged-into"].includes(open.status)) return run;
    const intent = await this.createIntent(
      {
        title: "Fix the tests after GitHub changes",
        goal: [
          failed.length
            ? `${what} from GitHub ${repo} came into main (${main.sha.slice(0, 7)}). After that change, ${failed.length} of ${total} tests fail on main:`
            : `${what} from GitHub ${repo} came into main (${main.sha.slice(0, 7)}). After that change, the tests do not run on main.`,
          ...failed.slice(0, 12).map((c) => `- ${c.file} ${c.name}: ${(c.error ?? "failed").replace(/\s+/g, " ").slice(0, 300)}`),
          ...(failed.length > 12 ? [`- and ${failed.length - 12} more`] : []),
          ...(run.error ? [`Test runner: ${run.error.slice(0, 300)}`] : []),
          "",
          "Fix the code or the tests, so that every test passes on main. Keep the GitHub changes.",
        ].join("\n"),
        priority: "high",
        source: { kind: "webhook", ref: `github:${repo}` },
      },
      { kind: "system", id: "github", name: "GitHub" },
    );
    this.db.setMeta("pullTestTask", intent.id);
    return run;
  }

  /** The conflict task of a repository is done or not needed any more. */
  private closeConflictTask(repo: string, why: string): void {
    const conflict = this.gh(repo).conflict;
    if (!conflict) return;
    this.setGh(repo, { conflict: undefined });
    const intent = this.intents.get(conflict.intentId);
    if (intent && !["landed", "parked", "merged-into"].includes(intent.status)) {
      this.park(intent.id, why, { kind: "system", id: "github", name: "GitHub" }).catch(() => undefined);
    }
  }

  /** Main moved without a merged task (GitHub changes): move API-mode work along and tell the agents. */
  private async mainMovedUnder(main: MainView, change: { title: string; files: string[] }): Promise<void> {
    const landedInfo = { intentTitle: change.title, files: change.files, signatureChanges: [] };
    for (const other of this.attempts.values()) {
      if (!ACTIVE.has(other.status) || other.status === "landing") continue;
      const oIntent = this.intents.get(other.intentId);
      const oAgent = this.agents.get(other.agentId);
      if (!oIntent || !oAgent) continue;
      const moved = await this.replot(other, main).catch(() => undefined);
      const v = vesselView(other, oIntent, oAgent, (await this.attemptView(other)).signatures, main.signatures, WAITING.has(other.status) ? "waiting" : "active");
      if (moved && (moved.merged.length || moved.reapply.length)) {
        this.issueCorrection(other.id, undefined, draftReplotCorrection(v, landedInfo, { mainSha: main.sha, merged: moved.merged, reapply: moved.reapply }), "R1-landed-has-way", "github", moved.reapply.length ? 90 : 70, true);
        continue;
      }
      if (other.footprint && Object.keys(other.footprint.files).some((f) => change.files.includes(f))) {
        this.issueCorrection(other.id, undefined, draftUpstreamCorrection(v, landedInfo), "R1-landed-has-way", "github", 50, true);
      }
    }
    this.wakeAll({ kind: "main-moved", at: Date.now(), mainSha: main.sha, message: `Main moved to ${main.sha.slice(0, 7)}: ${change.title}.` });
  }

  /* ════════════════════════════ Claude Code hook ════════════════════════════ */

  /**
   * PostToolUse hook from Claude Code. The agent's checkout identifies its attempt by the fork remote
   * (git mode) or by an attempt id the agent wrote into GITRING_ATTEMPT. Returns pending corrections
   * as additional context, so the agent sees them mid-task without a stop. `call.viewer`: the person of the key.
   * The hook of another person (not the sender, not an owner) changes nothing and gets nothing.
   */
  async claudeHook(input: {
    cwd?: string;
    session_id?: string;
    tool_name?: string;
    tool_input?: { file_path?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean; edits?: { old_string: string; new_string: string; replace_all?: boolean }[] };
    attemptId?: string;
  }, call: CallInfo = {}): Promise<{ hookSpecificOutput?: { hookEventName: "PostToolUse"; additionalContext: string } }> {
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
    if (!attempt || !ACTIVE.has(attempt.status) || !this.mayAct(attempt, call.viewer)) return {};
    if (input.session_id) this.db.setHook(`session:${input.session_id}`, attempt.id);

    const abs = input.tool_input?.file_path;
    if (abs && /^(Write|Edit|MultiEdit)$/.test(input.tool_name ?? "")) {
      // An edit is an answer of the agent: work that came back to it does not go to another agent now.
      this.heard(attempt);
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
        // A full-file write from the agent's own copy: guard it like gitring_write (main may have moved).
        const g = this.guardWrite(attempt, rel, next, view.files.get(rel) ?? null);
        if (g.refused) refused = g.refused;
        else this.db.writeWorktree(attempt.id, rel, g.content);
        this.db.setSeen(attempt.id, rel, next);
      } else if (next !== undefined) this.db.writeWorktree(attempt.id, rel, next);
      if (refused) {
        return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `GITRING: ${refused}` } };
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
          "GITRING CHANGE REQUEST — apply it in your next edits, then call gitring_ack. Continue your work.",
          ...clr.corrections.map((c) => `- [${c.id}] ${c.message}`),
        ].join("\n"),
      },
    };
  }

  /* ════════════════════════════ settings + webhooks ════════════════════════════ */

  async settings(): Promise<T.ProjectSettings> {
    return this.requireProject().settings;
  }

  async updateSettings(raw: Partial<T.ProjectSettings>): Promise<T.SettingsAnswer> {
    const patch = sanitizeSettings(raw, this.allowedModels());
    // Webhook secrets: the new ones go into this answer only (shown once in Settings).
    let webhookSecrets: Record<string, string> | undefined;
    if (patch.webhooks) {
      const made = await this.webhookSecrets(patch.webhooks, raw.webhooks);
      patch.webhooks = made.list;
      if (Object.keys(made.shown).length) webhookSecrets = made.shown;
    }
    // The project after the wait above (from here to the save, nothing waits).
    const p = this.requireProject();
    const oldGithub = p.settings.github;
    // GitHub settings merge: a field that the patch leaves out keeps its value; repo "" unlinks.
    const rawG = raw.github && typeof raw.github === "object" ? (raw.github as unknown as Record<string, unknown>) : undefined;
    if (rawG && patch.github) {
      const pg = patch.github;
      patch.github = {
        mode: "mode" in rawG ? pg.mode : oldGithub.mode,
        branch: "branch" in rawG ? pg.branch : oldGithub.branch,
        ...("repo" in rawG ? (pg.repo ? { repo: pg.repo } : {}) : oldGithub.repo ? { repo: oldGithub.repo } : {}),
        ...("base" in rawG ? (pg.base ? { base: pg.base } : {}) : oldGithub.base ? { base: oldGithub.base } : {}),
      };
    }
    p.settings = withDefaults({ ...p.settings, ...patch, thresholds: { ...p.settings.thresholds, ...(patch.thresholds ?? {}) } });
    // Someone chose the tests: a later guess (after an import or a push) does not change them.
    if (patch.checks) this.db.setMeta("checksSet", true);
    const g = p.settings.github;
    const githubChanged = Boolean(patch.github) && (g.repo !== oldGithub.repo || g.mode !== oldGithub.mode || g.branch !== oldGithub.branch || g.base !== oldGithub.base);
    if (patch.github && g.repo?.toLowerCase() !== oldGithub.repo?.toLowerCase()) {
      // Another repository (or none): its state stays apart (per repository); the old conflict task stops.
      if (oldGithub.repo) this.closeConflictTask(oldGithub.repo, "The project links another GitHub repository now.");
      p.github = undefined;
      this.ctx.waitUntil(this.directory().githubLink(p.id, g.repo ?? null).catch(() => undefined));
    }
    this.db.setMeta("project", p);
    this.addLog({ kind: "system", message: `Settings change: ${Object.keys(patch).join(", ")}.` });
    // The steward turned on: its first sweep comes with the next alarm.
    if (patch.steward) await this.armSteward();
    if (githubChanged) {
      if (g.mode !== "off" && g.repo) this.ctx.waitUntil(this.githubSync().catch((e) => console.warn("github sync failed", String(e))));
      else this.setGithub(await this.githubStatus());
    }
    return webhookSecrets ? { ...p.settings, webhookSecrets } : p.settings;
  }

  /** Agent models a settings change or a launch can choose: the operator's list (AGENT_MODELS) and the defaults. */
  private allowedModels(): (m: string) => boolean {
    const ok = new Set([...this.operatorModels(), ...DEFAULT_SETTINGS.agentModels]);
    return (m) => ok.has(m);
  }

  /** The agent models of this deployment for new projects: AGENT_MODELS, or the defaults (GLM 5.3 Flash, GLM 5.3). */
  private operatorModels(): string[] {
    const list = (this.env.AGENT_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    return list.length ? list : DEFAULT_SETTINGS.agentModels;
  }

  /**
   * The agent models of a project that the deployment still offers. When none is left (the project chose
   * models before the deployment changed its list), the project uses the models of the deployment.
   */
  private projectModels(p: T.Project): string[] {
    const own = p.settings.agentModels.filter(this.allowedModels());
    return own.length ? own : this.operatorModels();
  }

  /**
   * Send an event to the webhooks that want it. Each request is signed with the secret of its webhook
   * (gitring-signature) and gets 3 more tries on a server or network error. The delivery runs in the
   * background: a slow webhook never holds a merge.
   */
  private webhook(event: string, payload: Record<string, unknown>): void {
    const targets = this.project?.settings.webhooks.filter((w) => w.enabled && (w.events as string[]).includes(event)) ?? [];
    for (const w of targets) {
      const body =
        w.format === "slack"
          ? { text: slackText(event, payload) }
          : { event, project: this.project?.id, at: new Date().toISOString(), ...payload };
      this.ctx.waitUntil(
        (async () => {
          const res = await deliverWebhook(w.url, JSON.stringify(body), await this.webhookSecret(w.id));
          if (!res.ok) console.warn("webhook failed", w.url, res.status ?? res.error, `${res.tries} tries`);
        })().catch((e) => console.warn("webhook failed", w.url, String(e))),
      );
    }
  }

  /** The signing secret of a webhook (undefined: a webhook from before signatures, or no key to open it). */
  private async webhookSecret(id: string): Promise<string | undefined> {
    const sealed = this.db.getMeta<Record<string, string>>("webhookSecrets")?.[id];
    const key = this.env.GITRING_SECRET;
    if (!sealed || !key) return undefined;
    return unseal<string>(key, sealed, SECRET_SEAL).catch(() => undefined);
  }

  /**
   * The signing secrets of a new webhook list. A webhook gets a new secret when it is new, when its URL
   * changes, or when the person asks for one (`newSecret`). The answer holds each new secret once; the
   * project keeps it sealed. Secrets of removed webhooks go.
   */
  private async webhookSecrets(next: T.WebhookTarget[], raw: unknown): Promise<{ list: T.WebhookTarget[]; shown: Record<string, string> }> {
    const asked = new Set(
      (Array.isArray(raw) ? (raw as T.WebhookInput[]) : []).filter((w) => w && w.newSecret === true && typeof w.id === "string").map((w) => w.id),
    );
    const wants = (w: T.WebhookTarget, old: T.WebhookTarget | undefined) => !old || old.url !== w.url || asked.has(w.id);
    // Seal a candidate secret for each webhook (at most 5) first. These are the only waits: another change of
    // the settings can come in between, so the choice below reads the settings after them.
    const key = this.env.GITRING_SECRET;
    const made = new Map<string, { secret: string; sealed: string }>();
    for (const w of key ? next : []) {
      const secret = newWebhookSecret();
      made.set(w.id, { secret, sealed: await seal(key!, secret, SECRET_SEAL) });
    }
    // No wait from here to the save of the settings: the stored secrets and the list change together.
    const before = new Map(this.requireProject().settings.webhooks.map((w) => [w.id, w]));
    const stored = this.db.getMeta<Record<string, string>>("webhookSecrets") ?? {};
    const shown: Record<string, string> = {};
    const kept: Record<string, string> = {};
    const list: T.WebhookTarget[] = [];
    for (const w of next) {
      const old = before.get(w.id);
      const { secretHint: _hint, ...plain } = w;
      const fresh = wants(w, old) ? made.get(w.id) : undefined;
      if (wants(w, old) && !fresh) throw new Error("gitring cannot make a secret for the webhook: the server has no GITRING_SECRET.");
      if (fresh) {
        shown[w.id] = fresh.secret;
        kept[w.id] = fresh.sealed;
        list.push({ ...plain, secretHint: secretHint(fresh.secret) });
      } else if (stored[w.id]) {
        kept[w.id] = stored[w.id];
        list.push({ ...plain, ...(old?.secretHint ? { secretHint: old.secretHint } : {}) });
      } else {
        list.push(plain);
      }
    }
    this.db.setMeta("webhookSecrets", Object.keys(kept).length ? kept : undefined);
    return { list, shown };
  }

  async version(): Promise<string> {
    return BUILD_ID;
  }

  /* ════════════════════════════ work copy owners, agents that wait ════════════════════════════ */

  /**
   * Did the caller send the agent of this work copy? Also true for a call from inside gitring or with the
   * operator key (no viewer), and for work that no person sent.
   */
  private sentBy(a: T.Attempt, viewer?: CallInfo["viewer"]): boolean {
    return !viewer || !a.sender || a.sender.id === viewer.id;
  }

  /** May the caller change this work copy? The person who sent the agent, an owner, or the operator key may. */
  private mayAct(a: T.Attempt, viewer?: CallInfo["viewer"]): boolean {
    return this.sentBy(a, viewer) || viewer?.role === "owner";
  }

  private mayChange(a: T.Attempt, viewer?: CallInfo["viewer"]): void {
    if (this.mayAct(a, viewer)) return;
    throw new Error(`Work copy ${a.id} belongs to the agent of ${a.sender?.name ?? "another person"}. Only that person or an owner of the project can change it.`);
  }

  /**
   * The new change requests of a work copy, for the answer of a tool that does not deliver them itself
   * (MCP gitring_read, gitring_list, gitring_traffic, gitring_check, gitring_update). Only the person who sent
   * the agent gets them. Another member gets null: a read of another person must not take them from the agent.
   */
  async news(attemptId: string, call: CallInfo = {}): Promise<T.Clearance | null> {
    const a = this.attempts.get(attemptId);
    if (!a || !this.sentBy(a, call.viewer)) return null;
    return this.clearanceFor(a.id);
  }

  /** The agents that wait, per work copy. Memory only: a restart loses them, and the next call of the agent sees the state. */
  private waiters = new Map<string, Set<(ev: T.WaitEvent) => void>>();
  /** The state of a work copy that agents wait on: a change of the status or of the approval wakes them. */
  private waitSeen = new Map<string, { status: T.AttemptStatus; approval?: T.Approval["status"] }>();

  /**
   * MCP gitring_wait: wait until something new reaches the work copy (a change request, a move of main, the
   * answer of a person, a new status), or until the time runs out (default 25 s, at most 50 s). A change request
   * that waits already, or a work copy that is over, answers at once.
   */
  async wait(attemptId: string, opts: CallInfo & { seconds?: number } = {}): Promise<T.WaitResult> {
    const a = this.mustAttempt(attemptId);
    this.mayChange(a, opts.viewer);
    // An owner who did not send the agent can wait too, but the change requests stay for the agent.
    const mine = this.sentBy(a, opts.viewer);
    if (mine) this.heard(a);
    const asked = Number(opts.seconds ?? WAIT_SECONDS.default);
    const seconds = Number.isFinite(asked) ? Math.max(0, Math.min(WAIT_SECONDS.max, asked)) : WAIT_SECONDS.default;
    const ready = TERMINAL.has(a.status) || (mine && a.corrections.some((id) => this.corrections.get(id)?.status === "pending"));
    const heardOf = ready || !seconds ? [] : await this.waitFor(a, seconds * 1000);
    const now = this.mustAttempt(attemptId);
    const clr = this.clearanceFor(now.id, mine);
    // The change requests of the answer are the news: also those that waited before the call, and not those that changed again.
    const events = mine ? [...heardOf.filter((e) => e.kind !== "change-request"), ...clr.corrections.map((n) => requestEvent(n.id, n.kind))] : heardOf;
    if (ready && TERMINAL.has(now.status)) events.push(statusEvent(now.status));
    return { attemptId, status: now.status, events, clearance: clr, message: this.waitMessage(now, events, clr) };
  }

  private waitFor(a: T.Attempt, ms: number): Promise<T.WaitEvent[]> {
    return new Promise((resolve) => {
      const events: T.WaitEvent[] = [];
      const set = this.waiters.get(a.id) ?? new Set<(ev: T.WaitEvent) => void>();
      this.waiters.set(a.id, set);
      if (!this.waitSeen.has(a.id)) this.waitSeen.set(a.id, { status: a.status, approval: a.approval?.status });
      let gather: ReturnType<typeof setTimeout> | undefined;
      const end = () => {
        clearTimeout(timer);
        if (gather) clearTimeout(gather);
        set.delete(on);
        if (!set.size) {
          this.waiters.delete(a.id);
          this.waitSeen.delete(a.id);
        }
        resolve(events);
      };
      // The events of one step come together (a send-back is a new status and a change request).
      const on = (ev: T.WaitEvent) => {
        events.push(ev);
        gather ??= setTimeout(end, WAIT_GATHER_MS);
      };
      set.add(on);
      const timer = setTimeout(end, ms);
    });
  }

  private wake(attemptId: string, ev: T.WaitEvent): void {
    for (const on of [...(this.waiters.get(attemptId) ?? [])]) on(ev);
  }

  private wakeAll(ev: T.WaitEvent): void {
    for (const id of [...this.waiters.keys()]) this.wake(id, ev);
  }

  /** A new status or a new state of the approval wakes the agents that wait on the work copy. */
  private wakeOnChange(a: T.Attempt): void {
    const seen = this.waitSeen.get(a.id);
    if (!seen) return;
    const approval = a.approval?.status;
    if (seen.status !== a.status) this.wake(a.id, statusEvent(a.status));
    if (approval && seen.approval !== approval) this.wake(a.id, { kind: "approval", at: Date.now(), approval, message: approvalWord(a) });
    seen.status = a.status;
    seen.approval = approval;
  }

  /** What an agent that waited does now. */
  private waitMessage(a: T.Attempt, events: T.WaitEvent[], clr: T.Clearance): string {
    if (a.status === "landed") return "The work merged. The task is done.";
    if (TERMINAL.has(a.status)) return `The work copy is ${waitStatusWord(a.status)}. ${this.overAdvice(a)}`;
    if (clr.corrections.length) return clr.advice;
    if (a.approval?.status === "waiting" && a.status === "ready") return `${this.waitingMessage(a)} Call gitring_wait again to wait for the answer.`;
    if (!events.length) return `No news. The work copy is ${waitStatusWord(a.status)}. Call gitring_wait again, or continue your work.`;
    if (events.some((e) => e.kind === "main-moved") && !WAITING.has(a.status)) return "Main moved. Call gitring_update before you change files that the merge changed. Continue your work.";
    return `The work copy is ${waitStatusWord(a.status)}. ${WAITING.has(a.status) ? "Call gitring_wait again to wait for the merge." : "Continue your work."}`;
  }

  private mustAttempt(id: string): T.Attempt {
    const a = this.attempts.get(id);
    if (!a) throw new Error(`Unknown work copy ${id}. Call gitring_declare first.`);
    return a;
  }

}

/* ════════════════════════════ module helpers ════════════════════════════ */

/**
 * The key in a plain webhook URL of one project (/hooks/slack, /hooks/github): the shared secret of the
 * deployment, bound to the project. Someone who knows the shared secret still cannot aim a hook at
 * another project.
 */
export async function hookKey(secret: string, kind: "slack" | "github", projectId: string): Promise<string> {
  return (await hmacSha256Hex(secret, `hook:${kind}:${projectId}`)).slice(0, 32);
}

/**
 * The command that merges main into a git work copy. The token goes in an HTTP header and not in the remote
 * URL: git writes a remote URL to FETCH_HEAD and prints it in errors, and a shell keeps it in its history.
 */
export function gitPullCommand(remote: string, token: string, branch: string): string {
  const secret = token.split("?expires=")[0];
  return `git -c http.extraHeader="Authorization: Basic ${btoa(`x:${secret}`)}" pull --no-rebase ${remote} ${branch}`;
}

/** The project state for a viewer: outbound webhook addresses (they can hold secrets) stay with members. */
export function viewerState(state: T.ProjectState): T.ProjectState {
  return { ...state, project: { ...state.project, settings: { ...state.project.settings, webhooks: [] } } };
}

/** One event as a viewer gets it. Add a case here for every event that carries member-only data. */
function forViewer(ev: T.GitringEvent): T.GitringEvent {
  switch (ev.type) {
    case "snapshot":
      return { ...ev, state: viewerState(ev.state) };
    default:
      return ev;
  }
}

/** GitHub state of one linked repository (meta "gh:<owner/name>"). */
interface GithubRepoState {
  /** gitring commit → GitHub commit (the import, and commits that sync made). */
  known: Record<string, string>;
  /** The GitHub commit that gitring brought in or made last. */
  last?: string;
  /** gitring commits that brought GitHub changes in → GitHub's commit (and its submodule pointers). */
  upstreamOf: Record<string, UpstreamMark>;
  /** Open conflict: GitHub's head then, the conflicting files (GitHub's blob ids) and the task. */
  conflict?: { head: string; files: Record<string, string | null>; intentId: string };
  pull?: T.GithubPullStatus;
  /**
   * The person whose GitHub rights gitring re-checks, and the last answer. `gone`: the person left the
   * project; the sentence says so, and nothing is pushed or read for a private repository until an
   * owner saves the GitHub settings again.
   */
  actor?: { userId: string; checkedAt: number; read: boolean; push: boolean; gone?: string };
  /** Whether GitHub showed the repository as private the last time gitring asked. */
  private?: boolean;
}


/** HH:MM in UTC, for log lines. */
function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

const SYSTEM: T.Actor = { kind: "system", id: "gitring", name: "gitring" };
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
    medianCheckLatencyMs: 0,
  };
}

/** The person behind an action, for `sender`. Absent for the system, a script with no person, and a name that is not an account. */
function personOf(by: T.Actor | undefined): T.Person | undefined {
  if (!by || by.kind !== "human" || !by.id || by.id === "human" || by.id === "anonymous") return undefined;
  return { id: by.id, name: by.name };
}

/** Why a question closes, by the new state of the work copy. */
function closedBecause(status: T.AttemptStatus): string {
  switch (status) {
    case "alternate":
      return "Another work copy of this task merged first.";
    case "landed":
      return "The work is on main.";
    case "abandoned":
      return "The work copy stopped.";
    case "stale":
    case "failed":
      return "The work cannot merge on the new main.";
    case "rederiving":
      return "The work is done again on the new main.";
    default:
      return "The agent changed the work.";
  }
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
  const soft = isSoftPair(facts);
  let collision = model.collision;
  let interference = model.interference;
  if (hard) {
    collision = Math.max(collision, rules.collision * 0.95);
    interference = Math.max(interference, rules.interference * 0.95);
  }
  if (soft) {
    collision = Math.min(collision, SOFT_PAIR_CAP.collision);
    interference = Math.min(interference, SOFT_PAIR_CAP.interference);
  }
  const giveWayConfidence = model.giveWay === rules.giveWay ? Math.max(rules.giveWayConfidence, model.giveWayConfidence) : model.giveWayConfidence;
  return { ...model, collision: round(collision), interference: round(interference), giveWayConfidence: round(giveWayConfidence) };
}

function decisiveness(as: T.CourseAssessment[]): number {
  return as.length ? Math.min(...as.map((a) => Math.abs(a.collision - 0.5) * 2)) : 1;
}

/** Keep a settings patch inside safe bounds (any owner, key or client can send a patch). */
function sanitizeSettings(raw: Partial<T.ProjectSettings>, modelOk: (m: string) => boolean): Partial<T.ProjectSettings> {
  const out: Partial<T.ProjectSettings> = {};
  const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
  // `landing` decides. An old client sends autoLand only: true means "automatic", false means "ask".
  if (isLandingMode(raw.landing)) out.landing = raw.landing;
  else if (typeof raw.autoLand === "boolean") out.landing = raw.autoLand ? "automatic" : "ask";
  if (raw.approver === "sender" || raw.approver === "owner") out.approver = raw.approver;
  if (typeof raw.intentsInRepo === "boolean") out.intentsInRepo = raw.intentsInRepo;
  if (typeof raw.allowUntested === "boolean") out.allowUntested = raw.allowUntested;
  if (typeof raw.steward === "boolean") out.steward = raw.steward;
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
  if (raw.github && typeof raw.github === "object") {
    const g = raw.github as Partial<T.GithubSettings>;
    const repo = typeof g.repo === "string" ? githubRepoName(g.repo) : undefined;
    if (typeof g.repo === "string" && g.repo.trim() && !repo) throw new Error("Give the GitHub repository as owner/name, or as its https://github.com URL.");
    // Branch names follow git's rules (git check-ref-format): no "." or ".." segments, no ".lock", no
    // control characters, spaces, "~", "^", ":", "?", "*", "[", "\\" or "@{", no leading "-" or "/".
    // "./main" would reach GitHub as "main": a pull request branch that is the base branch.
    const branchName = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(v.trim()) && isValidBranchName(v.trim()) ? v.trim() : undefined);
    const branch = branchName(g.branch);
    const base = branchName(g.base);
    const badName = (v: unknown) => typeof v === "string" && v.trim() && !branchName(v);
    if (badName(g.branch) || badName(g.base)) throw new Error("Give a branch name that git accepts: letters, digits, dots, dashes and slashes, no \"..\", no \".\" segment, no \".lock\".");
    out.github = {
      mode: g.mode === "pull-request" || g.mode === "main" ? g.mode : "off",
      branch: branch ?? DEFAULT_SETTINGS.github.branch,
      ...(repo ? { repo } : {}),
      ...(base ? { base } : {}),
    };
  }
  if (raw.redo === "agent-first" || raw.redo === "agent-only" || raw.redo === "builtin") out.redo = raw.redo;
  const wait = num(raw.redoWaitMinutes, 5, 120);
  if (wait !== undefined) out.redoWaitMinutes = Math.round(wait);
  if (Array.isArray(raw.folderRules)) out.folderRules = sanitizeFolderRules(raw.folderRules);
  if (Array.isArray(raw.webhooks)) {
    // Outbound webhooks: https to a public host (gitring posts to it from the server).
    out.webhooks = raw.webhooks
      .filter((w) => w && typeof w.url === "string" && /^https:\/\/[^\s/]+\.[^\s]+$/.test(w.url) && publicWebhookUrl(w.url))
      .slice(0, 5)
      .map((w, n, all) => ({
        // An id names one webhook (its signing secret goes with the id): a repeated id gets a new one.
        id: typeof w.id === "string" && all.findIndex((x) => String(x.id).slice(0, 40) === w.id.slice(0, 40)) === n ? w.id.slice(0, 40) : `wh_${n + 1}_${rand(4)}`,
        url: w.url.slice(0, 500),
        events: Array.isArray(w.events) ? w.events.filter((e): e is T.GitringEventType => typeof e === "string").slice(0, 12) : [],
        format: w.format === "slack" ? "slack" : "json",
        enabled: w.enabled !== false,
      }));
  }
  return out;
}

function publicWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && publicHostname(u.hostname);
  } catch {
    return false;
  }
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
/**
 * The result when the hourly test budget is used: the tests did not run. It is not a failure (no case
 * failed) and not a pass (`ok` is false). `error` has the same sentence for tools that print only the error.
 */
export function budgetWait(key: string, scope: T.CheckRun["scope"], retryAt: number): T.CheckRun {
  const message = `The test budget for this hour is used. gitring tries again at ${clock(retryAt)} UTC.`;
  return { id: newId(CHECK_RUN), subject: key, scope, ok: false, passed: 0, failed: 0, cases: [], ms: 0, at: Date.now(), runner: "container", error: message, wait: { retryAt, message } };
}

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
        ? "No test command. The project has no package.json test script. An owner sets the test command in Settings → Tests."
        : res.stage === "timeout"
          ? `The tests took more than ${o.cs.timeoutSec ?? 600} s. gitring stopped them.`
          : undefined;
  return {
    id: newId(CHECK_RUN),
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

/** The start of an approval hash of the agent's contribution (see digestOf). */
const DIGEST_V2 = "v2:";

/** The approval hash of older versions: each changed text file and its new text. */
async function legacyDigest(v: AttemptView): Promise<string> {
  const rows = await Promise.all(v.changed.map(async (c) => `${c.path}\0${c.head === null ? "-" : await sha256Hex(c.head)}`));
  return sha256Hex(rows.sort().join("\n"));
}

/** A short git-style note for a change without text: a binary file, or a new mode. */
function opaqueDiff(c: SnapshotChange): string {
  if (c.status === "M" && c.oldSha === c.newSha) return `Mode changes to ${c.mode}.`;
  if (c.status === "D") return "Binary or large file deleted.";
  return c.mode === "120000" ? "Symbolic link." : "Binary or large file.";
}

function slackText(event: string, p: Record<string, unknown>): string {
  if (event === "landing") {
    const l = p.landing as T.Landing;
    const i = p.intent as { title: string };
    return `:white_check_mark: *${i.title}* merged into main by ${METHOD_WORD[l.method]} (\`${String(p.mainSha).slice(0, 7)}\`) · ${p.callsign} · tests ${l.checks.passed}/${l.checks.passed + l.checks.failed}`;
  }
  if (event === "correction") {
    const c = p.correction as T.Correction;
    return `:large_purple_diamond: Change request for ${p.callsign} (${KIND_WORD[c.kind] ?? c.kind}): ${c.message}`;
  }
  if (event === "decision") {
    const d = p.decision as T.Decision;
    return `:scales: ${d.by.name} decided (${DECISION_WORD[d.kind] ?? d.kind}): ${d.rationale}`;
  }
  if (event === "approval") {
    const ap = p.approval as T.Approval;
    const who = ap.approver?.name ?? "A person of the project";
    if (ap.status === "waiting") return `:raised_hand: ${who}, say yes or send back: *${p.task}* by ${p.agent}. ${p.line} ${ap.why[0] ?? ""} ${p.link}`.trim();
    if (ap.status === "approved") return `:white_check_mark: ${ap.answer?.by.name ?? "A person"} said yes to *${p.task}* (${p.agent}).`;
    return `:leftwards_arrow_with_hook: ${ap.answer?.by.name ?? "A person"} sent *${p.task}* back to ${p.agent}${ap.answer?.note ? `: ${ap.answer.note}` : "."}`;
  }
  if (event === "question") {
    const q = p.question as T.Question;
    if (q.status === "answered") return `:scales: ${q.answer?.by.name ?? "A person"} answered about *${p.task}*: ${q.options.find((o) => o.id === q.answer?.option)?.label ?? q.answer?.option}.`;
    if (q.status === "closed") return `:heavy_minus_sign: The question about *${p.task}* closed. ${q.closed ?? ""}`.trim();
    return `:raised_hand: A person decides on *${p.task}*: ${q.facts[0] ?? ""} ${q.options.map((o) => o.label).join(" / ")}. ${p.link}`.trim();
  }
  if (event === "intent") return `:memo: New task: *${(p.intent as { title: string }).title}*`;
  return `${event}: ${JSON.stringify(p).slice(0, 300)}`;
}

/* Plain words for people and agents (activity feed, tool results, Slack). */
const METHOD_WORD: Record<T.LandingMethod, string> = { "fast-forward": "fast-forward", merge: "3-way merge", rederive: "redo" };
const VERDICT_WORD: Record<T.Verdict, string> = { clear: "clear", correct: "change request", "merge-intents": "same task as other work", escalate: "a person decides" };
const KIND_WORD: Record<T.CorrectionKind, string> = { interface: "function change", region: "same lines", duplicate: "same task", upstream: "main moved", "intent-amended": "task changed", review: "a person sent it back" };
const TRIGGER_WORD: Record<T.CourseCheck["trigger"], string> = { declare: "plan", log: "report", write: "write", push: "push", "main-advanced": "main moved", "intent-amended": "task changed" };
const DECISION_WORD: Record<T.DecisionKind, string> = { pick: "chose a work copy", "send-back": "sent work back", rederive: "redo", amend: "changed the goal", park: "paused the task", "approve-checks": "approved the tests", "resolve-escalation": "decided" };

function taskStatusWord(s: T.IntentStatus): string {
  const words: Partial<Record<T.IntentStatus, string>> = { landed: "merged", parked: "paused", "merged-into": "joined to another task", judging: "waiting for a person", underway: "in work", landing: "merging", draft: "a draft" };
  return words[s] ?? s;
}

function copyStatusWord(s: T.AttemptStatus): string {
  const words: Partial<Record<T.AttemptStatus, string>> = { landed: "merged", landing: "merging", stale: "out of date", rederiving: "in a redo", alternate: "an alternative", abandoned: "stopped", declared: "new", underway: "in work", ready: "ready to merge" };
  return words[s] ?? s;
}

/** gitring_wait: how long an agent waits, in seconds (contract C1). */
const WAIT_SECONDS = { default: 25, max: 50 };
/** Events that come within this time of the first one go into the same answer of gitring_wait. */
const WAIT_GATHER_MS = 50;

/** The status of a work copy in the words of gitring_wait (no "-ing" forms). */
function waitStatusWord(s: T.AttemptStatus): string {
  const words: Partial<Record<T.AttemptStatus, string>> = { landing: "in the merge", checking: "in the tests", submitted: "sent for a merge" };
  return words[s] ?? copyStatusWord(s);
}

function requestEvent(id: string, kind: T.CorrectionKind): T.WaitEvent {
  return { kind: "change-request", at: Date.now(), correctionId: id, message: `gitring sent the change request ${id} (${KIND_WORD[kind] ?? kind}).` };
}

function statusEvent(status: T.AttemptStatus): T.WaitEvent {
  return { kind: "status", at: Date.now(), status, message: `The work copy is ${waitStatusWord(status)}.` };
}

/** The answer of a person (or the state of the question), in one sentence for the agent. */
function approvalWord(a: T.Attempt): string {
  const ap = a.approval;
  const who = ap?.answer?.by.name ?? "A person";
  if (ap?.status === "approved") return `${who} said yes to the merge.`;
  if (ap?.status === "sent-back") return `${who} sent the work back.`;
  if (ap?.status === "withdrawn") return "The question to the person closed. Submit again to ask again.";
  return "A person must say yes before the merge.";
}
