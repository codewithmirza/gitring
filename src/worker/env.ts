import type { HarborMaster } from "../harbor/harbor";
import type { Vessel } from "../vessel/vessel";
import type { Sector } from "../sim/sector";

/** Worker bindings, variables and secrets. */
export interface Env {
  HARBOR: DurableObjectNamespace<HarborMaster>;
  VESSEL: DurableObjectNamespace<Vessel>;
  SECTOR: DurableObjectNamespace<Sector>;
  LOADER: WorkerLoader;
  ARTIFACTS: Artifacts;
  AI: Ai;
  ASSETS?: Fetcher;
  /** Artifacts namespace bound to ARTIFACTS (for remotes and logs). */
  ARTIFACTS_NAMESPACE?: string;
  /** Optional shared key for MCP, hooks and write APIs. Unset = open. */
  BEARING_KEY?: string;
  /** Comma-separated models for built-in agents. */
  AGENT_MODELS?: string;
  /** Built-in AI agent starts per hour for the whole deployment (default 40). */
  AI_AGENTS_PER_HOUR?: string;
  /** Optional: verify GitHub webhook signatures (X-Hub-Signature-256). */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Optional: verify Slack request signatures (X-Slack-Signature). */
  SLACK_SIGNING_SECRET?: string;
}
