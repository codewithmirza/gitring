#!/usr/bin/env node
/**
 * Claude Code hook demo: corrections reach an agent in the middle of its task.
 *
 * Claude Code sends each PostToolUse event (Write, Edit, MultiEdit) to Gitring's hook endpoint.
 * Gitring records the edit as a shadow edit of the attempt, runs a course check, and answers with
 * `hookSpecificOutput.additionalContext`. Claude Code puts that text into the agent's context.
 *
 * This script plays Claude Code: it declares a course over MCP (with `workdir`), then posts two hook
 * events the way Claude Code does, and prints what the agent would read.
 *
 *   GITRING_URL=https://<your-worker> GITRING_KEY=gk_… node scripts/hook-demo.mjs
 *
 * Real setup (.claude/settings.json in the agent's repository; GITRING_KEY in the environment):
 *   { "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command",
 *     "command": "curl -s -X POST -H 'content-type: application/json' -H \"Authorization: Bearer $GITRING_KEY\" --data-binary @- '<GITRING_URL>/hooks/claude-code?project=<id>'" } ] } ] } }
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { authHeaders, base, projectFor } from "./lib/gitring.mjs";

const headers = authHeaders();
const { id: project } = await projectFor("Hook demo", headers);
const workdir = "/home/dev/saltmarsh-shop";
const session = `cc-${Date.now().toString(36)}`;

const client = new Client({ name: "claude-code", version: "2.x" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers } }));
const res = await client.callTool({
  name: "gitring_declare",
  arguments: {
    project,
    newIntent: { title: "Show prices with the currency code", goal: "Show the price as '$19.99 USD' instead of '$19.99' on the shop page." },
    plan: ["Change formatPrice in src/products.js", "Run the checks"],
    files: ["src/products.js"],
    symbols: ["src/products.js#formatPrice"],
    approach: "Append the currency code inside formatPrice.",
    mode: "git",
    agent: { client: "claude-code", model: "claude" },
    workdir,
  },
});
const text = res.content?.[0]?.text ?? "";
const json = JSON.parse(text.slice(text.lastIndexOf("\n\n") + 2));
console.log(`Claude Code declares: ${json.callsign} on "${json.intent.title}" (${json.attemptId}). Course check: ${json.clearance.verdict}.`);
await client.close();

async function hook(event) {
  const r = await fetch(new URL(`/hooks/claude-code?project=${project}`, base), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(event),
  });
  const out = await r.json();
  return out?.hookSpecificOutput?.additionalContext ?? "(no correction: Claude Code continues)";
}

// 1. Claude Code edits formatPrice in its own working copy. The hook sends the edit to Gitring.
const edit = {
  session_id: session,
  cwd: workdir,
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: {
    file_path: `${workdir}/src/products.js`,
    old_string: "export function formatPrice(",
    new_string: "// Prices show the currency code.\nexport function formatPrice(",
  },
};
console.log("\nPostToolUse Edit src/products.js → Gitring answers (additionalContext):");
console.log(await hook(edit));

// 2. A second edit in the same session (the session id now maps to the attempt).
const write = { ...edit, cwd: `${workdir}/src`, tool_name: "Edit", tool_input: { ...edit.tool_input, old_string: "// Prices show the currency code.", new_string: "// Prices show the ISO currency code." } };
console.log("\nPostToolUse Edit (from a subfolder) → Gitring answers:");
console.log(await hook(write));
