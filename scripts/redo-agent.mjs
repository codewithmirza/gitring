#!/usr/bin/env node
/**
 * Two outside agents (git mode) change the same line. The first one merges. The work of the second one
 * cannot merge, so gitring gives it back to the same agent (redo policy "agent-first"). The second agent
 * calls gitring_update, merges the new main with git, fixes the conflict, pushes and submits again.
 *
 * Usage:
 *   GITRING_URL=https://gitring.<you>.workers.dev GITRING_KEY=gk_… node scripts/redo-agent.mjs
 * Env: GITRING_PROJECT (optional; default: a new private sample project). Tokens are never printed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, base, projectFor } from "./lib/gitring.mjs";

const headers = authHeaders();
const { id: project } = await projectFor("Redo agents", headers);
const t0 = Date.now();
const say = (who, line) => console.log(`${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s  ${who.padEnd(8)} ${line}`);
let failed = 0;
const ok = (cond, line) => {
  say(cond ? "ok" : "FAIL", line);
  if (!cond) failed += 1;
};

async function agent(name) {
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers } }));
  return async function call(tool, args) {
    const r = await client.callTool({ name: tool, arguments: { project, ...args } });
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) throw new Error(`${tool}: ${text}`);
    const cut = text.lastIndexOf("\n\n");
    let json = null;
    try {
      json = JSON.parse(cut >= 0 ? text.slice(cut + 2) : text);
    } catch {
      /* text only */
    }
    return { text, json, headline: (cut >= 0 ? text.slice(0, cut) : text).split("\n").filter(Boolean).at(-1) ?? "" };
  };
}

const ANCHOR = "Ask at the counter for books that are not on the shelf.";

function gitIn(dir, token) {
  const auth = `Authorization: Basic ${Buffer.from(`x:${token}`).toString("base64")}`;
  return (args, opts = {}) =>
    execFileSync("git", ["-c", `http.extraHeader=${auth}`, "-c", "user.name=Redo Agent", "-c", "user.email=agent@example.com", ...args], {
      cwd: opts.cwd ?? dir,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
}

async function declare(call, title, sentence) {
  const d = (
    await call("gitring_declare", {
      newIntent: { title, goal: `Add the sentence "${sentence}" after the line about books that are not on the shelf.` },
      plan: ["Edit the footer line in src/render.js", "Submit"],
      files: ["src/render.js"],
      symbols: ["src/render.js#renderFooter"],
      approach: "Change one line of text.",
      mode: "git",
      agent: { client: "redo-agent", model: "scripted" },
    })
  ).json;
  const dir = mkdtempSync(join(tmpdir(), "gitring-redo-"));
  const git = gitIn(dir, d.workspace.token);
  git(["clone", "--quiet", d.workspace.remote, dir], { cwd: tmpdir() });
  const file = join(dir, "src/render.js");
  writeFileSync(file, readFileSync(file, "utf8").replace(ANCHOR, `${ANCHOR} ${sentence}`));
  git(["commit", "--quiet", "-am", title]);
  git(["push", "--quiet", "origin", "HEAD:main"]);
  return { d, dir, git, file };
}

async function waitFor(pred, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const st = await (await fetch(new URL(`/api/projects/${project}/state`, base), { headers })).json();
    const v = pred(st);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timed out: ${label}`);
}

const callA = await agent("agent-a");
const callB = await agent("agent-b");
const a = await declare(callA, "Say that gift wrapping is free", "Gift wrapping is free.");
say("agent A", `works as ${a.d.callsign} (${a.d.attemptId}) and pushes`);
const b = await declare(callB, "Say that returns are free", "Returns are free.");
say("agent B", `works as ${b.d.callsign} (${b.d.attemptId}) and pushes the same line`);

const subA = await callA("gitring_submit", { attemptId: a.d.attemptId, summary: "Gift wrapping line" });
say("gitring", `A: ${subA.headline}`);
await waitFor((st) => st.landings.find((l) => l.attemptId === a.d.attemptId), "A merges");
say("gitring", "A merged");

const subB = await callB("gitring_submit", { attemptId: b.d.attemptId, summary: "Free returns line" });
say("gitring", `B: ${subB.headline}`);
const returned = await waitFor((st) => {
  const x = st.attempts.find((t) => t.id === b.d.attemptId);
  return x && (x.returned || ["stale", "rederiving", "landed"].includes(x.status)) ? x : null;
}, "B comes back");
ok(Boolean(returned.returned) && returned.status === "underway", `B's work came back to B (status ${returned.status}, try ${returned.returns})`);

// B reads its change request, then brings main in with gitring_update.
const traffic = await callB("gitring_traffic", { attemptId: b.d.attemptId });
say("agent B", traffic.headline);
const up = await callB("gitring_update", { attemptId: b.d.attemptId });
ok(up.json?.mode === "git" && up.json?.remote && up.json?.token, `gitring_update gives a read-only remote for main (${up.headline})`);
const mainGit = gitIn(b.dir, up.json.token);
try {
  mainGit(["pull", "--no-rebase", "--no-edit", up.json.remote, up.json.branch]);
} catch {
  /* conflict expected */
}
const text = readFileSync(b.file, "utf8");
ok(/<<<<<<<|>>>>>>>/.test(text), "git shows the conflict on the footer line");
// Keep the main side of the conflict and add B's sentence to it.
const out = [];
let side = null;
let theirs = [];
for (const l of text.split("\n")) {
  if (l.startsWith("<<<<<<<")) {
    side = "ours";
    theirs = [];
  } else if (l.startsWith("=======") && side) side = "theirs";
  else if (l.startsWith(">>>>>>>") && side) {
    out.push(...theirs.map((t) => t.replace("Gift wrapping is free.", "Gift wrapping is free. Returns are free.")));
    side = null;
  } else if (side === "theirs") theirs.push(l);
  else if (side !== "ours") out.push(l);
}
writeFileSync(b.file, out.join("\n"));
b.git(["commit", "--quiet", "-am", "Merge main; keep both sentences"]);
b.git(["push", "--quiet", "origin", "HEAD:main"]);
say("agent B", "merged main, kept both sentences, pushed");

const sub2 = await callB("gitring_submit", { attemptId: b.d.attemptId, summary: "Free returns line, on the new main" });
say("gitring", `B: ${sub2.headline}`);
const landingB = await waitFor((st) => st.landings.find((l) => l.attemptId === b.d.attemptId) ?? (st.attempts.find((x) => x.id === b.d.attemptId)?.status === "stale" ? { stale: true } : null), "B merges");
ok(!landingB.stale, `B merged by ${landingB.method ?? "—"}`);
const main = await (await fetch(new URL(`/api/projects/${project}/file?ref=main&path=src/render.js`, base), { headers })).text();
ok(main.includes("Gift wrapping is free.") && main.includes("Returns are free."), "main has both sentences");

for (const x of [a, b]) rmSync(x.dir, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed. Project: ${project}` : `All checks pass. Project: ${project}`);
process.exit(failed ? 1 : 0);
