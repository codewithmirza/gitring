/**
 * The settings of one project: approvals, models, webhooks, check runner and rules by folder.
 *
 * The defaults and `withDefaults` are in `settings-defaults.ts`. The GitHub settings are in `github.ts`.
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Person } from "./basics";
import type { GithubSettings } from "./github";
import type { GitringEventType } from "./state";

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
  /**
   * The steward watches the project while agents work (harbor/steward.ts): every few minutes it counts the
   * facts of the records and puts a real anomaly into the inbox in plain words. Off by default.
   */
  steward: boolean;
  /** Rules by folder: who says yes to a change there (see core/coord/folder-rules.ts). Owners set them. */
  folderRules: FolderRule[];
  /**
   * When gitring runs the tests of main plus the work:
   *   before  before each merge (the default): work merges only when they pass
   *   after   after the merge: work whose own tests pass merges at once; gitring tests main in the
   *           background, finds the merge that broke it, reverts it and tells the agent
   */
  testsWhen: TestsWhen;
  /** The largest train: how many independent work copies merge in one go (1–16, default 8). */
  maxTrain: number;
}

export type TestsWhen = "before" | "after";

/**
 * A rule by folder. `pattern` is a path pattern (`**` any folders, `*` one name part): `migrations/**`,
 * `docs/*.md`, `*.sql`.
 *   owner-yes  a change there needs the yes of an owner
 *   no-yes     a change there needs no yes (not for competing work copies: a person still chooses one)
 *   members    only the agents of these people may change it; the plan of another agent is refused,
 *              and work that changed it anyway needs the yes of an owner
 * gitring checks the files of a plan (declare) and the changed files of the work (submit).
 */
export type FolderRule = { pattern: string; rule: "owner-yes" | "no-yes" } | { pattern: string; rule: "members"; members: Person[] };

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
  /**
   * The start of the signing secret ("whsec_Ab12…"), so that a person knows which secret is in use. gitring
   * keeps the secret itself sealed apart from the settings, and shows it only once. Absent: requests to this
   * webhook are not signed (a webhook from before signatures; make a new secret in Settings).
   */
  secretHint?: string;
}

/** A webhook in a settings change: `newSecret` asks gitring to replace its signing secret. */
export type WebhookInput = WebhookTarget & { newSecret?: boolean };

/** The answer of a settings change: the settings, and the secrets of new webhooks (only in this answer). */
export type SettingsAnswer = ProjectSettings & { webhookSecrets?: Record<string, string> };
