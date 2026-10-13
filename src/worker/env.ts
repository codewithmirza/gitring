import type { HarborMaster } from "../harbor/harbor";
import type { Vessel } from "../vessel/vessel";
import type { Directory } from "../directory/directory";
import type { Drydock } from "../drydock/drydock";

/** Worker bindings, variables and secrets. */
export interface Env {
  HARBOR: DurableObjectNamespace<HarborMaster>;
  VESSEL: DurableObjectNamespace<Vessel>;
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
  /** Container check runs per hour for the deployment (default 2000) and per project owner (default 240). */
  CHECK_RUNS_PER_HOUR?: string;
  CHECK_RUNS_PER_OWNER_HOUR?: string;
  /** Secret: 32 random bytes (base64). Seals provider credentials in the Directory. */
  GITRING_SECRET?: string;
  /** Secret: opens /setup before any owner can sign in (add the optional Google and GitHub sign-ins). */
  GITRING_SETUP_TOKEN?: string;
  /**
   * Secret: deployment owners, comma-separated. "user:<account id>" names any person, also one who signs
   * in with passkeys only (the id, for example u_0123456789, is on the Account page). Also accepted:
   * "google:<email>", "<email>", "github:<login>" and "github-id:<number>".
   */
  GITRING_OWNERS?: string;
  /** Optional operator key for scripts: `Authorization: Bearer <GITRING_KEY>` acts as the deployment. */
  GITRING_KEY?: string;
  /** Optional contact (email address) on the privacy and terms pages. */
  GITRING_CONTACT?: string;
  /** Optional: verify signatures of a plain GitHub repository webhook (X-Hub-Signature-256) on /hooks/github. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Optional: verify Slack request signatures (X-Slack-Signature). */
  SLACK_SIGNING_SECRET?: string;
  /** Rate limits (src/worker/limits.ts). Absent in local development and tests. */
  RL_AUTH?: RateLimit;
  RL_TOKEN?: RateLimit;
  RL_MCP?: RateLimit;
  RL_API?: RateLimit;
  RL_CRED?: RateLimit;
}
