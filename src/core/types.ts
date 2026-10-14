/**
 * gitring — core domain types.
 *
 * Vocabulary:
 *   Intent      the source: a goal plus executable checks. Replaces issue + pull request.
 *   Attempt     one agent's work on one intent, in its own Artifacts fork. Replaces branch / worktree.
 *   Course      what an agent declares BEFORE it writes code: plan, files, symbols.
 *   Footprint   what an agent actually touched (from real diffs).
 *   Course check  gitring's collision assessment of a course against all traffic.
 *   Correction  an amendment to an agent's brief. The agent keeps working. Replaces "rejected / conflict".
 *   Landing     integration into main via the landing ladder (fast-forward → merge → re-derive).
 *   Logbook     the "why" record: intent, course, corrections, checks, decision (git notes).
 *
 * This file has no runtime dependencies. It is shared by the Worker, the Durable Objects and the web UI.
 */

export type Millis = number;

/* ───────────────────────────── actors ───────────────────────────── */

export type ActorKind = "human" | "agent" | "system";

export interface Actor {
  kind: ActorKind;
  /** Human: a display name. Agent: the agent id. System: "gitring". */
  id: string;
  name: string;
}

/* ───────────────────────────── project ───────────────────────────── */

export type RepoBackendKind = "artifacts";

export interface ProjectRepo {
  backend: RepoBackendKind;
  /** Artifacts namespace. */
  namespace: string;
  /** Canonical repo name. Only the HarborMaster writes to its `main`. */
  name: string;
  /** Git remote URL of the canonical repo in Artifacts. */
  remote?: string;
  defaultBranch: string;
  /** Main is not the default branch of the Artifacts repo (an import of another branch): forks copy every branch. */
  forkAllBranches?: boolean;
}

export interface ProjectSettings {
  /**
   * When a person must say yes before work merges (the tests pass first):
   *   automatic  never; a person still decides when no test ran or when work copies compete
   *   risky      when the change looks risky (see riskSigns in core/approvals.ts)
   *   ask        every time
   */
  landing: LandingMode;
  /** Who answers an approval: the person who sent the agent ("sender"; an owner can always answer), or only an owner. */
  approver: ApproverRule;
  /**
   * Old name of `landing`: true means "automatic". gitring keeps it equal to `landing` (withDefaults), so
   * that old settings and old clients keep working. Write `landing`.
   */
  autoLand: boolean;
  /** Default number of parallel attempts per intent (best-of-N). */
  fanout: number;
  /** Decision model for course checks. "rules" = deterministic rules only (also the fallback when a model call fails). */
  decisionModel: "clef" | "clef-flash" | "rules";
  /** Models for built-in agents, used round-robin. */
  agentModels: string[];
  /** Write `.gitring/intents/<slug>.md` into the repo when an intent lands. */
  intentsInRepo: boolean;
  /** Probability thresholds for the course-check policy. */
  thresholds: PolicyThresholds;
  /** Outbound webhooks (Slack, CI, mirrors). */
  webhooks: WebhookTarget[];
  /** How gitring runs checks. Absent: the gitring test harness in a Dynamic Worker. */
  checks?: CheckSettings;
  /**
   * Merge work when no test ran (the project has no test file for it). False (the default): a person must
   * decide to merge it. Applies to the gitring test harness; a container run decides by its exit code.
   */
  allowUntested: boolean;
  /** Where merged code goes on GitHub. */
  github: GithubSettings;
  /** Who does a task again when the work of an outside agent cannot merge. */
  redo: RedoPolicy;
  /** agent-first: minutes to wait for the outside agent before a built-in agent starts (5–120). */
  redoWaitMinutes: number;
}

/**
 * GitHub sync of main:
 *   off           merged code stays in Cloudflare Artifacts
 *   pull-request  gitring pushes each merge to `branch` and keeps one pull request open to the default branch
 *   main          gitring pushes each merge to the default branch (fast-forward only)
 */
export type GithubSyncMode = "off" | "pull-request" | "main";

export interface GithubSettings {
  /** "owner/name" on github.com. Absent: not linked (a GitHub import links its repository). */
  repo?: string;
  mode: GithubSyncMode;
  /** Branch that gitring pushes in pull-request mode. */
  branch: string;
  /**
   * The GitHub branch that main follows: changes come from it, "Straight to main" moves it, and pull
   * requests go to it. Absent: the repository's default branch (an import sets the imported branch).
   */
  base?: string;
}

export type GithubSyncState =
  | "off" // mode off
  | "not-linked" // no GitHub repository
  | "no-app" // the deployment has no GitHub App
  | "not-installed" // the GitHub App is not on the repository
  | "pending" // a sync runs
  | "ok" // GitHub has main
  | "blocked" // GitHub moved and gitring cannot fast-forward it (main mode)
  | "error";

export interface GithubSyncStatus {
  state: GithubSyncState;
  /** One sentence for people. */
  message: string;
  /** Repository, "owner/name". */
  repo?: string;
  mode?: GithubSyncMode;
  /** Branch on GitHub that gitring updates. */
  branch?: string;
  /** The gitring main commit that GitHub has now. */
  syncedSha?: string;
  /** The GitHub commit for syncedSha. */
  githubSha?: string;
  /** Open pull request (pull-request mode). */
  prUrl?: string;
  prNumber?: number;
  /** Install the GitHub App on the repository (state not-installed). */
  installUrl?: string;
  /** Open the pull request by hand (the app has no pull-request permission). */
  compareUrl?: string;
  at?: Millis;
  /** Changes on GitHub that gitring brings into main (pull). */
  pull?: GithubPullStatus;
}

/**
 * Bringing GitHub changes into main:
 *   up-to-date  main has everything on the GitHub default branch
 *   merged      gitring merged new GitHub commits into main
 *   conflict    GitHub and main changed the same lines; a task asks an agent or a person to merge them
 *   error       gitring could not read GitHub (the message says why)
 */
export interface GithubPullStatus {
  state: "up-to-date" | "merged" | "conflict" | "error" | "pending";
  message: string;
  /** The GitHub commit that main has now (or would have, for a conflict). */
  headSha?: string;
  /** main after the merge. */
  mainSha?: string;
  /** Conflict: the files, and the task that merges them. */
  files?: string[];
  intentId?: string;
  compareUrl?: string;
  at: Millis;
}

/** Files of a ref (GET /api/projects/:p/tree?ref=main | <work copy id> | <commit sha>). */
export interface TreeResponse {
  /** The ref as asked. */
  ref: string;
  /** The commit (main or a commit sha) or "<work copy id>@<version>" for a work copy with unsaved edits. */
  sha: string;
  files: FileNode[];
}

/** What the Connect page needs: endpoints of this deployment and which inputs it has. */
export interface ConnectInfo {
  projectId: string;
  /** MCP endpoint (streamable HTTP). */
  mcpUrl: string;
  /** Claude Code PostToolUse hook for this project. */
  hookUrl: string;
  /** Endpoint that opens a task from any app. */
  intentsUrl: string;
  artifacts: { namespace: string; repo: string; remote?: string; backend: string };
  /** Inputs this deployment has set up. */
  inputs: { slack: boolean; githubIssues: boolean };
  /** The Slack command URL of this project (members only; it carries the project's key). */
  slackUrl?: string;
  /** A plain GitHub repository webhook for this project (members only; it carries the project's key). */
  githubHookUrl?: string;
  /** The GitHub App of this deployment (sign-in, issues, sync). */
  githubApp: { slug: string; installUrl: string } | null;
}

export type LandingMode = "automatic" | "risky" | "ask";
export type ApproverRule = "sender" | "owner";

/**
 * Redo when the work of an outside agent (MCP or git) cannot merge on the new main:
 *   agent-first  the same agent gets the work back; after redoWaitMinutes without an answer, a built-in agent does it
 *   agent-only   the same agent gets the work back; without an answer, a person decides
 *   builtin      a built-in agent does the task again at once
 * Work of built-in agents is always done again by a built-in agent.
 */
export type RedoPolicy = "agent-first" | "agent-only" | "builtin";

/**
 * Check runners:
 *   worker     gitring's test harness in a Dynamic Worker: tests/*.test.js, no dependencies, no network (fast).
 *   container  A Linux container (Cloudflare Containers, Node.js 24): the install command, then the test command.
 *              Network in the container reaches package registries only.
 */
export interface CheckSettings {
  runner: "worker" | "container";
  /** Container: install dependencies. Empty: `npm ci` with a package-lock.json, else `npm install` with a package.json. */
  install?: string;
  /** Container: run the tests. Empty: `npm test` when package.json has a test script. */
  test?: string;
  /** Container: time limit for install + test, in seconds (60–1800). Default 600. */
  timeoutSec?: number;
}

export interface PolicyThresholds {
  /** P(collision) at or above this → not clear. */
  collision: number;
  /** Interference score (0–4) at or above this → correction. */
  interference: number;
  /** P(duplicate) at or above this → merge intents. */
  duplicate: number;
  /** Decision confidence below this → ask the larger model, then escalate to a human. */
  minConfidence: number;
}

export interface WebhookTarget {
  id: string;
  url: string;
  events: GitringEventType[];
  /** "slack" formats a Slack message; "json" posts the raw event. */
  format: "json" | "slack";
  enabled: boolean;
}

/** Where the code of a project came from. Artifacts holds the canonical repo for every kind. */
export type ProjectSource =
  /** Old projects only: the sample left the product (2026-10-10). */
  | { kind: "sample" }
  | { kind: "empty" }
  /** A GitHub repository (public or private) through the GitHub App: a snapshot of `branch` at `sha`. */
  | { kind: "github"; repo: string; branch?: string; sha?: string; private?: boolean }
  | { kind: "git"; url: string; branch?: string; host?: "github" | "gitlab" | "bitbucket" | "other"; private?: boolean }
  | { kind: "upload"; files: number }
  | { kind: "push" };

export interface Project {
  id: string;
  name: string;
  repo: ProjectRepo;
  mainSha: string;
  mainTree: string;
  createdAt: Millis;
  settings: ProjectSettings;
  /** Absent on projects created before sources existed: those are samples. */
  source?: ProjectSource;
  /** The Directory user who created the project (budget and default owner). */
  ownerId?: string;
  /**
   * Set while main is empty: Artifacts imports the repository (git), or gitring waits for the owner's
   * first `git push` (push). Main fills when it is done.
   */
  importing?: {
    url: string;
    startedAt: Millis;
    error?: string;
    push?: boolean;
    tokenIds?: string[];
    /** A GitHub import: a private repository comes as a snapshot of one commit (public ones keep history). */
    github?: { repo: string; branch: string; snapshot: boolean; tries?: number };
  };
  /** GitHub sync of main (settings.github). */
  github?: GithubSyncStatus;
  /**
   * Code or an issue of a private GitHub repository came into this project (an import, a pull, a task).
   * Set once, never cleared: the project stays private, also after an unlink or a relink.
   */
  privateCode?: { repo: string; at: Millis };
}

/* ───────────────────────────── intent ───────────────────────────── */

export type IntentStatus =
  | "draft" // written, checks not approved yet
  | "open" // ready; agents can take it
  | "underway" // at least one attempt is active
  | "judging" // attempts are ready; a human pick is necessary
  | "landing" // in the landing queue
  | "landed"
  | "parked" // human stopped it
  | "merged-into"; // a duplicate; merged into another intent

export interface CheckSpec {
  id: string;
  /** Repo-relative path of the test file, for example `tests/dark-mode.test.js`. */
  path: string;
  /** Test source. gitring writes it into each attempt's working tree. */
  content: string;
  description: string;
}

export interface Amendment {
  version: number;
  at: Millis;
  by: Actor;
  /** Why the intent changed (a human edit, a correction, a merged duplicate). */
  reason: string;
  /** The text added to the goal or constraints. */
  text: string;
}

export interface Intent {
  id: string;
  title: string;
  /** Markdown. The living spec. */
  goal: string;
  /** Extra constraints that corrections or humans add. Agents must follow them. */
  constraints: string[];
  checks: CheckSpec[];
  scope?: { paths?: string[]; symbols?: string[] };
  priority: "normal" | "high";
  status: IntentStatus;
  version: number;
  amendments: Amendment[];
  createdBy: Actor;
  createdAt: Millis;
  updatedAt: Millis;
  parentId?: string;
  mergedInto?: string;
  chosenAttemptId?: string;
  landedSha?: string;
  /** How many built-in agents a launch starts by default (best-of-N). */
  suggestedFanout?: number;
  source: { kind: "ui" | "mcp" | "webhook" | "seed"; ref?: string };
}

/* ───────────────────────────── agents ───────────────────────────── */

export type AgentKind = "builtin" | "mcp" | "git";

export interface AgentInfo {
  id: string;
  /** Radio callsign shown in the UI, for example "KESTREL-7". */
  callsign: string;
  kind: AgentKind;
  /** Model id, for example "@cf/zai-org/glm-5.3-flash" or "claude-code". */
  model?: string;
  /** Client name for external agents: "claude-code", "codex", "cursor", … */
  client?: string;
  /** Index into the identity palette (0–11). */
  color: number;
  status: "idle" | "underway" | "waiting" | "offline";
  attemptId?: string;
  lastSeen: Millis;
}

/* ───────────────────────────── course + footprint ───────────────────────────── */

/** A symbol key is `<path>#<name>`, for example `src/products.js#formatPrice`. */
export type SymbolKey = string;

export interface Course {
  /** Short plan steps, in order. */
  plan: string[];
  /** Files the agent intends to touch. */
  files: string[];
  /** Symbols the agent intends to define or change. */
  symbols: SymbolKey[];
  /**
   * Symbols the plan will call but not change (`path#name`). The check compares them with the changes of
   * other plans, so two plans can be at range 1 before any code exists.
   */
  uses?: SymbolKey[];
  /** One-sentence approach. */
  approach: string;
  /** When the work copy sent its first plan. A new plan for the same work copy, and a redo, keep it (R4). */
  declaredAt: Millis;
}

export type FileChangeStatus = "A" | "M" | "D";

/** Inclusive 1-based line range in the BASE version of the file. */
export type LineRange = [number, number];

export interface FileTouch {
  status: FileChangeStatus;
  /** Ranges of base lines that the change replaces or removes (empty for pure inserts at a point). */
  hunks: LineRange[];
  additions: number;
  deletions: number;
}

export interface SymbolTouches {
  /** New symbols. */
  defined: SymbolKey[];
  /** Existing symbols whose body changed. */
  modified: SymbolKey[];
  /** Existing symbols removed. */
  removed: SymbolKey[];
  /** Existing exported symbols whose parameter list changed (interface change). */
  signatureChanged: SymbolKey[];
  /** Symbols the changed code uses (calls or reads), resolved through imports when possible. */
  referenced: SymbolKey[];
  /** Optional: for each referenced symbol, the files where the changed code uses it. */
  referencedIn?: Record<SymbolKey, string[]>;
}

export interface Footprint {
  files: Record<string, FileTouch>;
  symbols: SymbolTouches;
  computedAt: Millis;
}

/* ───────────────────────────── attempts ───────────────────────────── */

export type AttemptStatus =
  | "declared" // course declared, fork ready, no edits yet
  | "underway" // edits in progress
  | "submitted" // agent says done; waiting for checks
  | "checking"
  | "ready" // checks pass; waiting for a pick or the landing queue
  | "landing"
  | "landed"
  | "stale" // could not land on the new main; re-derive scheduled
  | "rederiving"
  | "alternate" // a sibling attempt landed; this one stays visible as an alternate
  | "abandoned"
  | "failed";

export interface CheckCaseResult {
  file: string;
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface CheckRun {
  id: string;
  /** Tree hash or overlay hash that was tested. */
  subject: string;
  /** "attempt" = the attempt alone. "composed" = main + attempt (the landing candidate). */
  scope: "attempt" | "composed";
  ok: boolean;
  passed: number;
  failed: number;
  cases: CheckCaseResult[];
  ms: number;
  at: Millis;
  /** Runner error (syntax error, timeout). */
  error?: string;
  /** "worker" (Dynamic Worker harness) or "container" (install + test commands). Absent: worker. */
  runner?: "worker" | "container";
  /** Container runs: the end of the combined output (at most 8 KB). */
  log?: string;
  /**
   * How many tests ran (the gitring test harness). 0 means no test ran: nothing is verified, and a
   * person must decide to merge (see noTestRan). Absent on runs from before this field: passed + failed.
   */
  ran?: number;
  /**
   * The run did not happen: the hourly test budget is used. This is not a failure and not a pass.
   * gitring tries again at `retryAt`. `message` is the plain sentence for people and agents.
   */
  wait?: { retryAt: Millis; message: string };
}

export interface Attempt {
  id: string;
  intentId: string;
  agentId: string;
  fork: { repo: string; remote?: string };
  /** "api": gitring holds the working tree (MCP read/write). "git": the agent pushes to the fork. */
  mode: "api" | "git";
  baseSha: string;
  baseTree: string;
  headSha?: string;
  status: AttemptStatus;
  course: Course;
  footprint: Footprint;
  /** Ids of corrections sent to this attempt. */
  corrections: string[];
  checks?: CheckRun;
  composedChecks?: CheckRun;
  lineage: { generation: number; rederivedFrom?: string };
  /** Set when main moved and some files of a waiting attempt overlap the landed change: landing re-derives them. */
  drift?: { mainSha: string; overlaps: string[] };
  /** Built-in agents only: the hourly AI budget is used, so the agent starts at this time (gitring retries then). */
  waitsForBudget?: Millis;
  /**
   * Outside agents: the work could not merge and came back to its agent (redo policy). Any tool call of
   * the agent on this work copy clears it. At `until`, a built-in agent (agent-first) or a person
   * (agent-only) takes over.
   */
  returned?: { at: Millis; until: Millis; reason: string; policy: "agent-first" | "agent-only" };
  /** How many times the work came back to its agent. */
  returns?: number;
  /**
   * The merge waits: the hourly test budget is used. The work copy stays in the merge queue until `until`.
   * This is not a failure and does not count as a return. `message` is the plain sentence for people.
   */
  mergeWait?: { until: Millis; message: string };
  /**
   * How many times the merge of this work copy stopped with an error (a repository that did not answer, for
   * example). gitring tries the merge again after a short wait, and asks a person after the fourth stop.
   */
  mergeStops?: number;
  summary?: string;
  /**
   * The person who sent the agent: the one who connected it, or who started the built-in agent. Absent on
   * old work copies and on work that no person started. This person answers the approval of the work.
   */
  sender?: Person;
  /**
   * The latest approval of this work copy (see Approval). A new ask replaces it; the old answers stay in
   * the decisions and the log.
   */
  approval?: Approval;
  stats: { filesChanged: number; additions: number; deletions: number; steps: number; tokens?: number };
  createdAt: Millis;
  updatedAt: Millis;
  landedAt?: Millis;
}

/** A person, as gitring shows them: the account id and the name. */
export interface Person {
  id: string;
  name: string;
}

/**
 * An approval is a merge that waits for a person. gitring asks for one when the work is ready, its tests
 * pass, and a person must say yes (see approvalNeeded in core/approvals.ts).
 *
 *   waiting    asked; nobody answered yet. The work copy is "ready" and does not merge.
 *   approved   a person said yes. The work copy goes to the merge queue.
 *   sent-back  a person said "not yet" and gave a note. The note went to the agent as a change request.
 *   withdrawn  the answer cannot come any more: the agent changed the work, or the work copy closed.
 *
 * Only one answer counts: the first valid one. The same answer twice has no second effect.
 */
export type ApprovalStatus = "waiting" | "approved" | "sent-back" | "withdrawn";

export type ApprovalReason =
  | "no-test-ran" // nothing is verified
  | "competing" // other work copies compete on the same task
  | "project-asks" // the project asks before every merge
  | "looks-risky" // the project asks when a change looks risky, and this one does
  | "merge-stopped"; // the merge did not finish after several tries

export interface Approval {
  id: string;
  status: ApprovalStatus;
  /** The main reason. `why` has all of them. */
  reason: ApprovalReason;
  /** Plain sentences for people: why a person must say yes. */
  why: string[];
  /**
   * A hash of what the person sees: the base of the work copy and each changed file. An answer counts for
   * this work only. If the agent changes the work, the approval is withdrawn and gitring asks again.
   */
  digest: string;
  /** The person who answers: the sender of the work copy. Absent: any member. Owners can always answer. */
  approver?: Person;
  askedAt: Millis;
  answer?: { by: Person; how: "app" | "chat"; note?: string; at: Millis };
  /** Withdrawn: the plain reason. */
  closed?: string;
}

/* ───────────────────────────── course check ───────────────────────────── */

/**
 * Range: the distance between two pieces of work in the code graph.
 *   0 same lines or same symbol body changed by both
 *   1 one changes a symbol (or its signature) that the other uses
 *   2 same file, different symbols
 *   3 files linked by a direct import
 *   4 files two imports apart
 *   5 unrelated (open water)
 */
export type Range = 0 | 1 | 2 | 3 | 4 | 5;

export interface PairFacts {
  otherAttemptId: string;
  otherAgentId: string;
  otherIntentId: string;
  /** Status of the other vessel: in flight, waiting to land, or landed after our base. */
  otherState: "active" | "waiting" | "landed";
  sharedFiles: string[];
  /** Symbols both sides define or modify. */
  sharedSymbols: SymbolKey[];
  /** Signature changes on one side that the other side references. */
  interfaceHits: { changedBy: "incoming" | "other"; symbol: SymbolKey; usedAt: string[] }[];
  /** Base-line hunks that overlap on a shared file. */
  hunkOverlaps: { path: string; incoming: LineRange; other: LineRange }[];
  range: Range;
  previousRange?: Range;
  /** Constant bearing, decreasing range: the two are closing on each other. */
  closing: boolean;
  /** Intent title similarity, 0–1 (duplicate signal). */
  intentSimilarity: number;
}

export interface CourseAssessment {
  otherAttemptId: string;
  /** P(the two collide if both continue unchanged). */
  collision: number;
  /** Probability-weighted interference level 0–4 (see INTERFERENCE_LEVELS). */
  interference: number;
  /** P(the incoming intent duplicates the other intent). */
  duplicate: number;
  giveWay: "incoming" | "other";
  giveWayConfidence: number;
  rule: RuleOfTheRoad;
}

export type Verdict = "clear" | "correct" | "merge-intents" | "escalate";

export type RuleOfTheRoad =
  | "R1-landed-has-way" // main always stands on; in-flight work adapts
  | "R2-waiting-stands-on" // work waiting to land stands on against active work
  | "R3-producer-stands-on" // the side that changes an interface stands on; consumers adapt
  | "R4-first-declared-stands-on" // earlier course stands on
  | "R5-priority-stands-on" // high-priority intent stands on
  | "R6-smaller-gives-way"; // smaller footprint adapts (cheaper)

export interface CourseCheck {
  id: string;
  attemptId: string;
  trigger: "declare" | "log" | "write" | "push" | "main-advanced" | "intent-amended";
  verdict: Verdict;
  assessments: CourseAssessment[];
  facts: PairFacts[];
  source: "clef" | "clef-flash" | "rules";
  confidence: number;
  latencyMs: number;
  at: Millis;
  /** Raw decision-model answers, kept for the logbook. */
  raw?: unknown;
}

/* ───────────────────────────── corrections ───────────────────────────── */

export type CorrectionKind =
  | "interface" // use the new signature of a symbol another vessel changes
  | "region" // keep out of lines another vessel is changing
  | "duplicate" // another vessel does the same work; merge or narrow scope
  | "upstream" // main moved under you; adapt to the landed change
  | "intent-amended" // a human changed the intent
  | "review"; // a person sent the work back with a note

export interface Correction {
  id: string;
  /** The give-way attempt. It receives the correction. */
  attemptId: string;
  /** The stand-on attempt, if any. */
  standOnAttemptId?: string;
  /**
   * More attempts that edit the same lines at the same time. The agent gets one change request for the lines,
   * not one for each of them. `standOnAttemptId` is the one that declared last. An agent that waits for that
   * one stands in a row behind the others. If every agent waited for the first one, all would wake up together.
   */
  alsoStandOn?: string[];
  kind: CorrectionKind;
  rule: RuleOfTheRoad | "human";
  /** Instruction text for the agent (ASD-STE100 style, imperative, short). */
  message: string;
  /** Machine-readable constraints, mirrored into the intent constraints. */
  constraints: {
    avoidRegions?: { path: string; lines: LineRange }[];
    useSignatures?: { symbol: SymbolKey; signature: string }[];
    notes?: string[];
    /** Files to change again on the new main: gitring kept the main version; the diff is the agent's earlier change. */
    reapply?: { path: string; diff: string }[];
    /** Set when gitring moved the work onto a new main (re-plot). */
    replot?: { mainSha: string };
  };
  checkId: string;
  status: "pending" | "delivered" | "acknowledged" | "superseded";
  /** Severity of the situation when issued (higher = closer / more overlap). gitring re-sends only when it grows. */
  severity?: number;
  /** How many times the advice was refreshed in place without a new delivery. */
  refreshes?: number;
  createdAt: Millis;
  deliveredAt?: Millis;
  acknowledgedAt?: Millis;
  ackNote?: string;
}

/* ───────────────────────────── logs, landings, decisions ───────────────────────────── */

export type LogKind =
  | "declare"
  | "log"
  | "write"
  | "push"
  | "check"
  | "correction"
  | "ack"
  | "submit"
  | "land"
  | "stale"
  | "rederive"
  | "replot"
  | "decision"
  | "intent"
  | "system";

export interface LogEntry {
  id: string;
  at: Millis;
  kind: LogKind;
  attemptId?: string;
  agentId?: string;
  intentId?: string;
  message: string;
  files?: string[];
  data?: Record<string, unknown>;
}

export type LandingMethod = "fast-forward" | "merge" | "rederive";

export interface Landing {
  id: string;
  attemptId: string;
  intentId: string;
  agentId: string;
  method: LandingMethod;
  mainBefore: string;
  mainAfter: string;
  checks: CheckRun;
  correctionsApplied: number;
  at: Millis;
  /** Commit message (with gitring trailers). */
  message: string;
}

export type DecisionKind = "pick" | "send-back" | "park" | "rederive" | "amend" | "approve-checks" | "resolve-escalation";

export interface Decision {
  id: string;
  kind: DecisionKind;
  intentId: string;
  attemptIds: string[];
  by: Actor;
  rationale: string;
  at: Millis;
}

/* ───────────────────────────── traffic (what an agent sees about others) ───────────────────────────── */

export interface TrafficVessel {
  attemptId: string;
  agentId: string;
  callsign: string;
  intentId: string;
  intentTitle: string;
  status: AttemptStatus;
  approach: string;
  files: string[];
  symbols: SymbolKey[];
  /** The latest log lines of that vessel (its live context). */
  recentLogs: string[];
  range: Range;
  closing: boolean;
}

export interface TrafficReport {
  attemptId: string;
  vessels: TrafficVessel[];
  mainSha: string;
  /** Intents that landed after this attempt's base (upstream). */
  landedSinceBase: { intentId: string; title: string; sha: string; files: string[] }[];
}

/* ───────────────────────────── state + events (UI protocol) ───────────────────────────── */

export interface RadarPair {
  a: string; // attempt id
  b: string;
  range: Range;
  closing: boolean;
  /** Last course-check verdict that involved both. */
  verdict?: Verdict;
  updatedAt: Millis;
}

export interface FileNode {
  path: string;
  size: number;
  lang: string;
}

export interface ProjectState {
  project: Project;
  intents: Intent[];
  attempts: Attempt[];
  agents: AgentInfo[];
  corrections: Correction[];
  checks: CourseCheck[];
  landings: Landing[];
  decisions: Decision[];
  logs: LogEntry[];
  radar: RadarPair[];
  /** Files of main (the chart's land mass). */
  files: FileNode[];
  /** Import edges of main, as [from, to] paths. */
  imports: [string, string][];
  stats: HarborStats;
}

export interface HarborStats {
  courseChecks: number;
  clear: number;
  corrections: number;
  correctionsAcknowledged: number;
  escalations: number;
  landings: number;
  landedByMethod: Record<LandingMethod, number>;
  rederives: number;
  /** Times gitring moved in-flight work onto a new main (re-plot). */
  replots?: number;
  medianCheckLatencyMs: number;
}

export type GitringEventType =
  | "snapshot"
  | "intent"
  | "attempt"
  | "agent"
  | "correction"
  | "check"
  | "landing"
  | "decision"
  | "log"
  | "radar"
  | "main"
  | "stats"
  | "github"
  | "approval";

export type GitringEvent =
  | { type: "snapshot"; state: ProjectState }
  | { type: "intent"; intent: Intent }
  | { type: "attempt"; attempt: Attempt }
  | { type: "agent"; agent: AgentInfo }
  | { type: "correction"; correction: Correction }
  | { type: "check"; check: CourseCheck }
  | { type: "landing"; landing: Landing }
  | { type: "decision"; decision: Decision }
  | { type: "log"; log: LogEntry }
  | { type: "radar"; pairs: RadarPair[] }
  | { type: "main"; sha: string; tree: string; files: FileNode[]; imports: [string, string][] }
  | { type: "stats"; stats: HarborStats }
  | { type: "github"; github: GithubSyncStatus }
  /** Webhooks only: an approval was asked, answered or withdrawn. The UI reads `attempt.approval` from "attempt" events. */
  | { type: "approval"; attemptId: string; approval: Approval };

/* ───────────────────────────── agent protocol (MCP + built-in vessels) ───────────────────────────── */

export interface AgentIdentity {
  /** Stable id from the client if it has one; gitring creates one if absent. */
  id?: string;
  name?: string;
  client?: string;
  model?: string;
  kind?: AgentKind;
}

/** Answer of gitring_update: how the agent brings the new main into its work copy. */
export type UpdateResult =
  | { mode: "api"; mainSha: string; merged: string[]; readAgain: string[]; message: string }
  | { mode: "git"; mainSha: string; branch: string; remote: string; token: string; tokenExpiresAt: string; commands: string[]; message: string };

export interface DeclareInput {
  agent: AgentIdentity;
  /** Join an existing intent… */
  intentId?: string;
  /** …or bring a new intent (gitring creates it, then checks for duplicates). */
  newIntent?: { title: string; goal: string };
  plan: string[];
  files: string[];
  symbols: string[];
  /** Symbols the plan will call but not change (`path#name`), see Course.uses. */
  uses?: string[];
  approach: string;
  /** "git" asks for a fork remote + token; "api" uses gitring_read / gitring_write. */
  mode?: "api" | "git";
}

export interface CorrectionNotice {
  id: string;
  kind: CorrectionKind;
  message: string;
  constraints: Correction["constraints"];
  from?: string; // callsign of the stand-on vessel
  more?: number; // other vessels that edit the same lines (see Correction.alsoStandOn)
}

export interface Clearance {
  verdict: Verdict;
  /** New corrections since the agent last saw any. The agent must apply them. */
  corrections: CorrectionNotice[];
  /** Nearby vessels (their live context). */
  traffic: TrafficVessel[];
  /** One-line summary for the agent. */
  advice: string;
}

export interface DeclareResult {
  attemptId: string;
  agentId: string;
  callsign: string;
  intent: Pick<Intent, "id" | "title" | "goal" | "constraints" | "version"> & { checks: { path: string; description: string }[] };
  workspace: {
    mode: "api" | "git";
    baseSha: string;
    /** Git mode only. */
    remote?: string;
    token?: string;
    tokenExpiresAt?: string;
  };
  clearance: Clearance;
  /** How to work with gitring (short protocol reminder). */
  protocol: string[];
}

export interface LogInput {
  attemptId: string;
  message: string;
  files?: string[];
  symbols?: string[];
  /** Git mode: the new head commit the agent pushed to its fork. */
  headSha?: string;
}

export interface WriteInput {
  attemptId: string;
  files: { path: string; content?: string; delete?: boolean }[];
  message?: string;
}

export interface WriteResult {
  written: string[];
  /** Files that changed under the agent after its last read (main moved). gitring merged the write with those changes. */
  merged?: string[];
  /** Files that gitring did not write: the write overlaps changes that the agent did not read yet. */
  refused?: { path: string; reason: string }[];
  footprint: { files: string[]; symbols: SymbolKey[] };
  clearance: Clearance;
}

export interface SubmitResult {
  attemptId: string;
  status: AttemptStatus;
  checks?: CheckRun;
  /** Where the attempt goes next. "awaiting-approval": a person must say yes (see `approval`). */
  next: "landing-queue" | "awaiting-approval" | "fix-checks" | "landed";
  message: string;
  /** Set when next is "awaiting-approval": the approval that waits. */
  approval?: Approval;
  /** Set with `approval`, when the caller said who it is: may this person answer? */
  mayAnswer?: boolean;
  clearance: Clearance;
}

/** Answer of the status tool: where a work copy is, and what a person said about it. */
export interface WorkStatus {
  attemptId: string;
  status: AttemptStatus;
  task: { id: string; title: string; status: IntentStatus };
  approval?: Approval;
  /** Set with a question that waits, when the caller said who it is: may this person answer? */
  mayAnswer?: boolean;
  /** The size of the change and the tests, in one line. */
  line: string;
  /** Where a person answers the approval: an address in the gitring app. */
  link: string;
  mainSha: string;
  landing?: { sha: string; method: LandingMethod; at: Millis };
  mergeWait?: { until: Millis; message: string };
  /** One sentence for the agent: what to do now. */
  message: string;
  clearance: Clearance;
}

/** What the person who answers an approval sends. */
export interface ApprovalAnswer {
  answer: "approve" | "send-back";
  /** For send-back: what the agent must change. Shown to the agent as a change request. */
  note?: string;
}

/** The result of an answer. */
export interface ApprovalResult {
  attemptId: string;
  /**
   * What the answer did. "already": the approval had an answer before, nothing changed now. "withdrawn":
   * the question is closed (the agent changed the work). "refused": this person may not answer it.
   */
  outcome: "approved" | "sent-back" | "already" | "withdrawn" | "refused";
  approval: Approval;
  status: AttemptStatus;
  message: string;
  landing?: Landing;
  /** The merge waits for the hourly test budget. */
  waits?: { until: Millis };
}

/* ───────────────────────────── constants ───────────────────────────── */

export const INTERFERENCE_LEVELS = [
  "none: the changes are independent",
  "near: same area, no shared lines or interfaces",
  "textual: the changes edit the same lines and will conflict as text",
  "semantic: one change breaks an interface or behavior the other depends on",
  "contradictory: the intents want opposite outcomes",
] as const;

export const DEFAULT_THRESHOLDS: PolicyThresholds = {
  collision: 0.5,
  interference: 1.7,
  duplicate: 0.7,
  minConfidence: 0.55,
};

export const DEFAULT_SETTINGS: ProjectSettings = {
  landing: "risky",
  approver: "sender",
  autoLand: false,
  fanout: 1,
  decisionModel: "clef-flash",
  agentModels: ["@cf/moonshotai/kimi-k2.7-code", "@cf/openai/gpt-oss-120b", "@cf/qwen/qwen3.8-27b"],
  intentsInRepo: true,
  thresholds: DEFAULT_THRESHOLDS,
  webhooks: [],
  github: { mode: "off", branch: "gitring" },
  redo: "agent-first",
  redoWaitMinutes: 15,
  allowUntested: false,
};

/**
 * True when the run verified nothing: the gitring test harness ran no test and nothing failed. A
 * container run is not counted: its exit code decides. A run that waits for the test budget is not
 * counted either: it did not happen.
 */
export function noTestRan(run: Pick<CheckRun, "ok" | "ran" | "runner" | "passed" | "failed" | "wait"> | null | undefined): boolean {
  if (!run || run.wait || !run.ok || run.runner === "container") return false;
  return (run.ran ?? run.passed + run.failed) === 0;
}

export function isLandingMode(v: unknown): v is LandingMode {
  return v === "automatic" || v === "risky" || v === "ask";
}

/** Settings of a stored project, with defaults for fields added after the project was made. */
export function withDefaults(s: Partial<ProjectSettings> | undefined): ProjectSettings {
  const base = { ...DEFAULT_SETTINGS, ...(s ?? {}) } as ProjectSettings;
  // `landing` decides. A project from before it existed has only `autoLand`: false asks every time, true never asks.
  const landing: LandingMode = isLandingMode(s?.landing) ? s!.landing : typeof s?.autoLand === "boolean" ? (s.autoLand ? "automatic" : "ask") : DEFAULT_SETTINGS.landing;
  return {
    ...base,
    landing,
    approver: s?.approver === "owner" ? "owner" : "sender",
    autoLand: landing === "automatic",
    thresholds: { ...DEFAULT_THRESHOLDS, ...(s?.thresholds ?? {}) },
    webhooks: Array.isArray(s?.webhooks) ? s!.webhooks : [],
    github: { ...DEFAULT_SETTINGS.github, ...(s?.github ?? {}) },
  };
}
