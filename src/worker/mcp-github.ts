/**
 * The GitHub-compatible tool set (/mcp/github): the names and arguments of the GitHub tools, on top of gitring.
 *
 * An agent that works with the GitHub MCP server uses gitring when its owner changes one URL.
 * The tools are in src/worker/github-tools/. This file joins them and keeps the texts that src/worker/mcp.ts uses.
 * Read next: src/worker/github-tools/README.md (how each GitHub tool maps onto gitring).
 */
import type { ToolDef } from "./mcp-kit";
import { issueTools } from "./github-tools/tools-issues";
import { pullTools } from "./github-tools/tools-pulls";
import { readTools } from "./github-tools/tools-read";
import { writeTools } from "./github-tools/tools-write";

export { MERGE_WAIT } from "./github-tools/pulls";

/** Said in the error of a bad project id (the gitring tool for it is not in this set). */
export const GITHUB_LIST_HOW = "Call get_me to list your projects.";

/** Said after a restart stopped a call that is not safe to send again (the gitring tools for it are not in this set). */
export const GITHUB_CHECK_HOW = "Call list_branches or list_issues to see if your call took effect before you send it again.";

export const GITHUB_INSTRUCTIONS =
  "These tools work like the GitHub tools, but they work on gitring. A repo is a gitring project. " +
  "A branch other than main is your own work copy. No tool writes to main. " +
  "Call create_pull_request when your work is ready: gitring runs the tests, then it merges. " +
  "Sometimes a person must say yes first. Then the answer says that the pull request waits for a person. " +
  "Tell the person. Do not change the branch. Call merge_pull_request to see the answer. " +
  'When a result starts with "GITRING CHANGE REQUEST", apply it in your next edits.';

export const GITHUB_TOOLS: readonly ToolDef[] = [...readTools, ...writeTools, ...pullTools, ...issueTools];
