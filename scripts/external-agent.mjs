#!/usr/bin/env node
/**
 * An outside agent works with Bearing through MCP only. It is not built into Bearing.
 *
 *   bearing_intents → bearing_declare → (git mode) clone the Artifacts fork, edit, commit, push
 *                                     → (api mode) bearing_read, bearing_write
 *   → bearing_log → bearing_check → bearing_submit → wait for the landing
 *
 * Usage:
 *   BEARING_URL=https://bearing.<you>.workers.dev BEARING_KEY=bk_… node scripts/external-agent.mjs   # git mode
 *   … node scripts/external-agent.mjs --mode api                                                     # api mode
 * Options: --mode git|api   --title "..." --project <id> (default: BEARING_PROJECT, else a new private sample)
 * Env: BEARING_KEY, a personal API key (Bearing → Connect → API keys). The fork token is never printed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, base, projectFor } from "./lib/bearing.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const mode = opt("mode", "git");
const title = opt("title", "Say that gift wrapping is free");
const headers = authHeaders();
if (opt("project", "")) process.env.BEARING_PROJECT = opt("project", "");
const { id: project } = await projectFor("Outside agent", headers);

const t0 = Date.now();
const say = (who, line) => console.log(`${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s  ${who.padEnd(8)} ${line}`);

const client = new Client({ name: "external-agent", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers } }));

/** Call a Bearing tool. The answer is: optional correction lines, a headline, a blank line, JSON. */
async function call(name, args) {
  const r = await client.callTool({ name, arguments: { project, ...args } });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  const cut = text.lastIndexOf("\n\n");
  let json = null;
  try {
    json = JSON.parse(cut >= 0 ? text.slice(cut + 2) : text);
  } catch {
    /* text-only answer */
  }
  const headline = (cut >= 0 ? text.slice(0, cut) : text).split("\n").filter(Boolean);
  if (text.startsWith("BEARING COURSE CORRECTION")) {
    for (const l of headline.slice(1, -1)) say("bearing", `correction ${l.replace(/^- /, "")}`.slice(0, 260));
  }
  return { text, json, headline: headline[headline.length - 1] ?? "" };
}

const { tools } = await client.listTools();
say("agent", `connects to ${new URL("/mcp", base)}: ${tools.length} tools (${tools.map((t) => t.name).join(", ")})`);

const open = await call("bearing_intents", {});
say("bearing", open.headline);

// Bring a new intent. Bearing checks it for duplicates against the open intents.
const NOTE = "Gift wrapping is free.";
const declared = await call("bearing_declare", {
  newIntent: { title, goal: `Add the sentence "${NOTE}" to the footer of every page, after the line about books that are not on the shelf.` },
  plan: ["Read src/render.js", "Add one sentence to renderFooter", "Run the checks", "Submit"],
  files: ["src/render.js"],
  symbols: ["src/render.js#renderFooter"],
  approach: "Change one line of text in renderFooter. Do not change any function signature.",
  mode,
  agent: { client: "external-agent", model: "scripted-outside-agent" },
});
const d = declared.json;
say("bearing", declared.headline);
say("agent", `works as ${d.callsign} on attempt ${d.attemptId}, base ${d.workspace.baseSha.slice(0, 7)}, mode ${d.workspace.mode}`);

const edit = (src) => {
  if (src.includes(NOTE)) return src;
  const anchor = "Ask at the counter for books that are not on the shelf.";
  if (!src.includes(anchor)) throw new Error("The footer line is not in src/render.js.");
  return src.replace(anchor, `${anchor} ${NOTE}`);
};

let logged;
if (d.workspace.mode === "git") {
  const remote = d.workspace.remote;
  const token = d.workspace.token;
  if (!remote || !token) throw new Error("Git mode needs a remote and a token.");
  const auth = `Authorization: Basic ${Buffer.from(`x:${token}`).toString("base64")}`;
  const dir = mkdtempSync(join(tmpdir(), "bearing-agent-"));
  const git = (args, cwd = dir) =>
    execFileSync("git", ["-c", `http.extraHeader=${auth}`, "-c", "user.name=External Agent", "-c", "user.email=agent@example.com", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  try {
    git(["clone", "--quiet", remote, dir], tmpdir());
    say("agent", `clones its Artifacts fork ${remote.replace(/^https:\/\/[^/]+/, "")}`);
    const file = join(dir, "src/render.js");
    writeFileSync(file, edit(readFileSync(file, "utf8")));
    git(["commit", "--quiet", "-am", `${title}\n\nBearing-Attempt: ${d.attemptId}`]);
    git(["push", "--quiet", "origin", "HEAD:main"]);
    const head = git(["rev-parse", "HEAD"]);
    say("agent", `pushes ${head.slice(0, 7)} to the fork`);
    logged = await call("bearing_log", { attemptId: d.attemptId, message: `Footer: ${NOTE}`, files: ["src/render.js"], headSha: head });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  const read = await call("bearing_read", { attemptId: d.attemptId, path: "src/render.js" });
  const content = read.text; // bearing_read answers with the raw file text
  logged = await call("bearing_write", { attemptId: d.attemptId, files: [{ path: "src/render.js", content: edit(content) }], message: `Footer: ${NOTE}` });
  say("agent", `writes src/render.js through bearing_write`);
}
say("bearing", logged.headline);

const checks = await call("bearing_check", { attemptId: d.attemptId });
say("bearing", checks.headline);

const sub = await call("bearing_submit", { attemptId: d.attemptId, summary: `Footer now says: ${NOTE}` });
say("bearing", sub.headline);

// The landing runs in the background. Watch the state until the attempt lands (or needs a human).
for (let i = 0; i < 40; i++) {
  const res = await fetch(new URL(`/api/projects/${project}/state`, base), { headers });
  const st = await res.json();
  const a = st.attempts.find((x) => x.id === d.attemptId);
  const landing = st.landings.find((l) => l.attemptId === d.attemptId);
  if (landing) {
    say("bearing", `lands "${title}" by ${landing.method} as ${landing.mainAfter.slice(0, 7)}. Checks ${landing.checks.passed}/${landing.checks.passed + landing.checks.failed}. Human merge fixes: 0.`);
    break;
  }
  if (a && ["ready", "stale", "rederiving", "failed"].includes(a.status) && i > 3) {
    say("bearing", `attempt status: ${a.status}`);
    if (a.status !== "rederiving") break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}
await client.close();
