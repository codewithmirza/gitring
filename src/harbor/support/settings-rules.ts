/**
 * Cleans the settings that a person sends: keeps known fields, clamps numbers and checks webhook addresses.
 * Called by HarborSettings in ../master/settings.ts. Never store a setting that this file did not clean.
 */
import type * as T from "../../core/types";
import { DEFAULT_SETTINGS, isLandingMode } from "../../core/types";
import { sanitizeFolderRules } from "../../core/coord/folder-rules";
import { isValidBranchName } from "../../core/git/objects";
import { githubRepoName, publicHostname } from "../../core/repo-rules";
import { rand } from "../ids";

/** Keep a settings patch inside safe bounds (any owner, key or client can send a patch). */
export function sanitizeSettings(raw: Partial<T.ProjectSettings>, modelOk: (m: string) => boolean): Partial<T.ProjectSettings> {
  const out: Partial<T.ProjectSettings> = {};
  const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
  // `landing` decides. An old client sends autoLand only: true means "automatic", false means "ask".
  if (isLandingMode(raw.landing)) out.landing = raw.landing;
  else if (typeof raw.autoLand === "boolean") out.landing = raw.autoLand ? "automatic" : "ask";
  if (raw.approver === "sender" || raw.approver === "owner") out.approver = raw.approver;
  if (typeof raw.intentsInRepo === "boolean") out.intentsInRepo = raw.intentsInRepo;
  if (typeof raw.allowUntested === "boolean") out.allowUntested = raw.allowUntested;
  if (typeof raw.steward === "boolean") out.steward = raw.steward;
  if (raw.testsWhen === "before" || raw.testsWhen === "after") out.testsWhen = raw.testsWhen;
  const train = num(raw.maxTrain, 1, 16);
  if (train !== undefined) out.maxTrain = Math.round(train);
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

export function publicWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && publicHostname(u.hostname);
  } catch {
    return false;
  }
}
