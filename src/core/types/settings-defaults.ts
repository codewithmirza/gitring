/**
 * The default settings of a project, and the function that fills the fields that an old project lacks.
 *
 * Call `withDefaults` on every stored settings object before you read it.
 * The types of the settings are in `settings.ts`. Reached through `src/core/types.ts`, the front door.
 */
import type { LandingMode, PolicyThresholds, ProjectSettings } from "./settings";

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
  // GLM 5.3 Flash for most work, GLM 5.3 for hard work (Workers AI, 1,048,576-token context).
  agentModels: ["@cf/zai-org/glm-5.3-flash", "@cf/zai-org/glm-5.3"],
  intentsInRepo: true,
  thresholds: DEFAULT_THRESHOLDS,
  webhooks: [],
  github: { mode: "off", branch: "gitring" },
  redo: "agent-first",
  redoWaitMinutes: 15,
  allowUntested: false,
  steward: false,
  folderRules: [],
  testsWhen: "before",
  maxTrain: 8,
};

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
    folderRules: Array.isArray(s?.folderRules) ? s!.folderRules : [],
  };
}
