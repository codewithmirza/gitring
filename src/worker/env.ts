import type { HarborMaster } from "../harbor/harbor";
import type { Vessel } from "../vessel/vessel";
import type { Sector } from "../sim/sector";
import type { Directory } from "../directory/directory";
import type { Drydock } from "../drydock/drydock";

/** Worker bindings, variables and secrets. */
export interface Env {
  HARBOR: DurableObjectNamespace<HarborMaster>;
  VESSEL: DurableObjectNamespace<Vessel>;
  SECTOR: DurableObjectNamespace<Sector>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  /** Check containers (Cloudflare Containers): one per attempt. */
  DRYDOCK: DurableObjectNamespace<Drydock>;
  LOADER: WorkerLoader;
  ARTIFACTS: Artifacts;
  AI: Ai;
  ASSETS?: Fetcher;
  /** Artifacts namespace bound to ARTIFACTS (for remotes and logs). */
  ARTIFACTS_NAMESPACE?: string;
  /** Comma-separated models for built-in agents. */
  AGENT_MODELS?: string;
  /** Built-in AI agent starts per hour for the whole deployment (default 40). */
  AI_AGENTS_PER_HOUR?: string;
  /** Built-in AI agent starts per hour and person (default 12). */
  AI_AGENTS_PER_USER_HOUR?: string;
  /** Secret: 32 random bytes (base64). Seals provider credentials in the Directory. */
  BEARING_SECRET?: string;
  /** Secret: opens /setup before any owner can sign in (create the GitHub App, add Google). */
  BEARING_SETUP_TOKEN?: string;
  /** Secret: deployment owners, comma-separated: "github:<login>", "google:<email>" or "<email>". */
  BEARING_OWNERS?: string;
  /** Optional operator key for scripts: `Authorization: Bearer <BEARING_KEY>` acts as the deployment. */
  BEARING_KEY?: string;
  /** Optional: verify signatures of a plain GitHub repository webhook (X-Hub-Signature-256) on /hooks/github. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Optional: verify Slack request signatures (X-Slack-Signature). */
  SLACK_SIGNING_SECRET?: string;
}
