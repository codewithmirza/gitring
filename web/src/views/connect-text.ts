/**
 * Connect: the endpoints, the tool list, the flow text and the short blocks of words.
 *
 * Pure (no React): a unit test keeps the tool list equal to the tools of the Worker and the words in
 * plain style (ASD-STE100). A word in `backticks` shows as code on the page.
 */
import type { ConnectInfo } from "../../../src/core/types";
import { approvalPath } from "../../../src/core/approvals";
import type { IconName } from "../design/icons";

/** The three MCP addresses of this gitring, from the address of the main one (`<origin>/mcp`). */
export function mcpEndpoints(mcpUrl: string): { origin: string; main: string; github: string; readonly: string } {
  const main = mcpUrl.replace(/\/+$/, "");
  return { origin: main.replace(/\/mcp$/, ""), main, github: `${main}/github`, readonly: `${main}/readonly` };
}

/** The tools of the main address (`/mcp`), with one plain line each. Keep it equal to GITRING_TOOLS in src/worker/mcp.ts. */
export const TOOLS: [string, string][] = [
  ["gitring_intents", "List the open tasks of a project. Without a project: list your projects."],
  ["gitring_declare", "Send your plan: steps, files and functions. The answer has the result of the conflict check."],
  ["gitring_log", "Report a step. Other agents see it. In git mode, give headSha after each push."],
  ["gitring_traffic", "Read the active work near your plan, and the tasks that merged after your base."],
  ["gitring_read · gitring_list", "Read the files of your work copy."],
  ["gitring_write", "Write files into your work copy. gitring checks your plan again."],
  ["gitring_check", "Run the tests of your work copy."],
  ["gitring_submit", "Submit your work. gitring merges it when the tests pass. A person says yes first when the project asks."],
  ["gitring_status", "See where your work copy is: with a person, sent back, in the merge queue, or merged. It does not change the work copy."],
  ["gitring_ack", "Confirm that you applied a change request."],
  ["gitring_update", "Bring the new main into your work copy. In git mode, you get a read-only remote for main."],
];

/** The tool names of the list above ("gitring_read · gitring_list" gives two). */
export function toolNames(): string[] {
  return TOOLS.flatMap(([name]) => name.split(" · "));
}

/* ───────────── the flow diagram ───────────── */

export interface FlowStage {
  label: string;
  icon: IconName;
  note: string;
}

/** What gitring does with work, in order. The diagram and its text describe the same steps. */
export const FLOW_STAGES: FlowStage[] = [
  { label: "Conflict check", icon: "range", note: "each plan and each change" },
  { label: "Change requests", icon: "buoy", note: "back to the agents" },
  { label: "Rebase", icon: "compass", note: "onto each new main" },
  { label: "Tests", icon: "check", note: "before each merge" },
  { label: "Approval", icon: "human", note: "a person, if the project asks" },
  { label: "Merge", icon: "anchor", note: "fast-forward · 3-way merge · redo" },
  { label: "History", icon: "logbook", note: "a git note on each merge commit" },
];

/** The words for a screen reader that read the diagram. */
export function flowText(info: Pick<ConnectInfo, "inputs">, githubOn: boolean): string {
  const apps = ["any app sends HTTP requests with an API key", info.inputs.githubIssues && "GitHub issues with the label gitring open tasks", info.inputs.slack && "the Slack command /gitring opens tasks"]
    .filter(Boolean)
    .join("; ");
  return (
    `In: Claude connects as a connector, and Claude Code, Codex and Cursor connect through MCP; any git client pushes into a work copy; ${apps}. ` +
    "gitring runs a conflict check on each plan and each change, sends change requests back to the agents, and rebases active work onto each new main. " +
    "It runs the tests. It merges the work when the tests pass, and a person says yes when the project asks. " +
    "A merge is a fast-forward, a 3-way merge or a redo. gitring writes the history as a git note on each merge commit. " +
    `Out: main in Cloudflare Artifacts${githubOn ? ", GitHub (a pull request or main)" : ""}, webhooks (JSON or Slack messages) and live updates for the web pages.`
  );
}

/* ───────────── the blocks under the connector ───────────── */

/** "Already use the GitHub connector? Replace it." */
export const GITHUB_SWAP = {
  summary: "Already use the GitHub connector? Replace it.",
  label: "URL to use instead of the GitHub connector",
  lines: [
    "Use this URL instead of the GitHub connector.",
    "The tools keep the GitHub names, for example `get_file_contents` and `create_pull_request`.",
    "A branch is a gitring work copy. A pull request is a merge request: the tests run first, and a person says yes when the project asks.",
    "No tool writes to main directly.",
    "The agent signs in again for this URL. A sign-in is good for one URL only.",
  ],
};

/** "Read-only access" */
export const READ_ONLY = {
  summary: "Read-only access",
  label: "URL for read-only access",
  text: "For agents that only look. It has the read tools only. The OAuth scope is `mcp:read`.",
};

/**
 * "When an agent asks for a merge": three short lines. The first one goes on with a link to Settings, and
 * the last one with a link to "Send events out" on the same page.
 */
export const MERGE_QUESTION = {
  title: "When an agent asks for a merge",
  lines: [
    "gitring may ask you to say yes before it merges the work of an agent.",
    "It asks in the chat of the agent when the agent can show a question.",
    "It always shows the question in gitring too: at the bottom of every page, and on its own page.",
  ],
  settings: "You choose when in",
  settingsLink: "Settings",
  slack: "You can also send it to Slack with",
  slackLink: "Send events out",
};

/** The JSON that gitring posts to a webhook when a person must say yes (an example). Same keys, same order as the Worker. */
export function approvalExample(project: string, origin: string): string {
  const attemptId = "at_k3n9x2";
  return JSON.stringify(
    {
      event: "approval",
      project,
      at: "2026-10-10T12:00:00.000Z",
      attemptId,
      approval: { status: "waiting", reason: "looks-risky", why: ["The parameters of price change. Other code can call it."] },
      task: "Add a dark mode",
      agent: "KESTREL-7",
      line: "3 files, +42 -7. 12 of 12 tests pass.",
      link: `${origin}${approvalPath(project, attemptId)}`,
    },
    null,
    2,
  );
}
