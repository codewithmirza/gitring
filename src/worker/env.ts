import type { HarborMaster } from "../harbor/harbor";
import type { Vessel } from "../vessel/vessel";
import type { LocalArtifacts } from "../platform/repo/emulator";
import type { Sector } from "../sim/sector";

/** Bindings. Optional ones are absent in the offline environment. */
export interface Env {
  HARBOR: DurableObjectNamespace<HarborMaster>;
  VESSEL: DurableObjectNamespace<Vessel>;
  SECTOR: DurableObjectNamespace<Sector>;
  EMULATOR: DurableObjectNamespace<LocalArtifacts>;
  LOADER: WorkerLoader;
  ARTIFACTS?: Artifacts;
  AI?: Ai;
  ASSETS?: Fetcher;
  /** "offline" disables remote AI and uses the emulator. */
  BEARING_MODE?: string;
  /** "artifacts" (default when the binding exists) or "emulator". */
  REPO_BACKEND?: string;
  /** Artifacts namespace bound to ARTIFACTS (informational, for remotes and logs). */
  ARTIFACTS_NAMESPACE?: string;
  /** Optional shared key for MCP, hooks and write APIs. Unset = open demo. */
  BEARING_KEY?: string;
  /** Comma-separated models for built-in vessels. */
  AGENT_MODELS?: string;
  /** Optional: verify GitHub webhook signatures (X-Hub-Signature-256). */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Optional: verify Slack request signatures (X-Slack-Signature). */
  SLACK_SIGNING_SECRET?: string;
}

export function isOffline(env: Env): boolean {
  return env.BEARING_MODE === "offline" || !env.AI;
}
