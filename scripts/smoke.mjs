#!/usr/bin/env node
/**
 * A smoke test for a deployed gitring, or the run on your computer: two scripted agents on the main path.
 * Run: node scripts/smoke.mjs <url> <token>   or   GITRING_URL=<url> GITRING_KEY=<token> npm run smoke
 * It prints PASS or FAIL for each check. The exit code is 0 only when all checks pass. It archives its project at the end.
 * Never print the token. The agents are scripted: this is not a test of a model. Read next: scripts/README.md.
 */
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { endpointOf } from "./load-lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (...l) => `${l.join("\n")}\n`;

export const SMOKE_USAGE = [
  "Usage: node scripts/smoke.mjs <url> <token>",
  "   or: GITRING_URL=<url> GITRING_KEY=<token> npm run smoke",
  "  <url>    the address of your gitring, for example https://gitring.your-name.workers.dev",
  "  <token>  a personal API key, the GITRING_KEY secret, or the key that npm run dev:local prints",
  "The script makes one private project, runs two scripted agents on it, and archives it at the end.",
];

const WORDS = lines(
  "/** The words of a text: runs of letters and digits, in lowercase. */",
  "export function words(text) {",
  '  return String(text ?? "")',
  "    .toLowerCase()",
  "    .split(/[^\\p{L}\\p{N}]+/u)",
  "    .filter(Boolean);",
  "}",
  "",
);
const NOMARKS = 'words(text).map((w) => w.normalize("NFKD").replace(/\\p{M}/gu, ""))';
const SLUG_A = `${WORDS}${lines("export function slugify(text) {", `  return ${NOMARKS}.join("-");`, "}")}`;
const SLUG_B = `${WORDS}${lines('export function slugify(text) {', '  return words(text).join("-").slice(0, 60);', "}")}`;
const SLUG_BOTH = `${WORDS}${lines("export function slugify(text) {", `  return ${NOMARKS}.join("-").slice(0, 60);`, "}")}`;
const test = (name, expr) => lines('import { test, expect } from "../harness/test.js";', 'import { slugify } from "../src/index.js";', "", `test("${name}", () => expect(${expr}));`);
const T_A = test("slugify drops accents", 'slugify("Café au lait")).toBe("cafe-au-lait"');
const T_B = test("slugify cuts a long slug at 60 characters", 'slugify("word ".repeat(40)).length).toBe(60');

/** Read the command line and the environment. A result with `code` means: print `lines` and exit. */
export function prepareSmoke(argv, env) {
  const rest = argv.filter((a) => !a.startsWith("-"));
  if (argv.includes("--help") || argv.includes("-h")) return { code: 0, lines: SMOKE_USAGE };
  try {
    const url = rest[0] ?? env.GITRING_URL;
    const key = String(rest[1] ?? env.GITRING_KEY ?? "");
    if (!key) throw new Error("There is no token. Give it as the second argument or in GITRING_KEY.");
    return { endpoint: endpointOf(url), key };
  } catch (e) {
    return { code: 2, lines: [String(e?.message ?? e), ...SMOKE_USAGE] };
  }
}

/** Run the checks. `say` gets each line. Returns { ok, results }. */
export async function runSmoke({ endpoint, key, say = console.log, fetchImpl = fetch, pollMs = 500, timeoutSec = 90 }) {
  const origin = new URL(endpoint.origin);
  const out = (t = "") => say(String(t).split(key).join("[key]"));
  const results = [];
  const check = (name, pass, detail = "") => {
    results.push({ name, pass });
    out(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `  (${detail})` : ""}`);
    return pass;
  };
  const api = async (method, path, body) => {
    const res = await fetchImpl(new URL(path, origin), {
      method,
      headers: { ...(path === "/api/health" ? {} : { authorization: `Bearer ${key}` }), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {}
    return { status: res.status, json, raw };
  };

  out(`gitring smoke test on ${origin.origin}`);
  let project;
  const clients = [];
  try {
    const health = await api("GET", "/api/health").catch((e) => ({ status: 0, raw: String(e?.message ?? e) }));
    if (!check("health check answers", health.status === 200 && health.json?.ok === true, `HTTP ${health.status}`)) return { ok: false, results };
    out(`      build ${health.json.build}, backend ${health.json.backend}, Workers AI ${health.json.ai ? "on" : "off"}, GitHub sign-in ${health.json.signIn?.github ? "on" : "off"}, Google sign-in ${health.json.signIn?.google ? "on" : "off"}`);

    const made = await api("POST", "/api/projects", { name: `smoke-${Date.now().toString(36)}`, visibility: "private", source: { kind: "template", template: "js-library" }, settings: { checks: { runner: "worker" } } });
    project = made.json?.project?.id;
    if (!check("project starts from the js-library template", made.status === 201 && Boolean(project), `HTTP ${made.status}${made.status === 201 ? "" : ` ${made.raw.slice(0, 160)}`}`)) return { ok: false, results };

    return await checkTwoAgents({ endpoint, key, fetchImpl, pollMs, timeoutSec, api, check, clients, results, project });
  } catch (e) {
    check("the run finished without an error", false, String(e?.message ?? e).slice(0, 200));
    return { ok: false, results };
  } finally {
    for (const c of clients) await c.close().catch(() => undefined);
    if (project) {
      const gone = await api("DELETE", `/api/projects/${project}`).catch(() => undefined);
      check("the test project is archived", gone?.status === 204, gone ? `HTTP ${gone.status}` : "no answer");
    }
    out(results.every((r) => r.pass) ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  }
}

/**
 * The checks after the project exists: two agents change the same function, the second one gets a change
 * request, and both merge. Answers the result of the run.
 */
async function checkTwoAgents({ endpoint, key, fetchImpl, pollMs, timeoutSec, api, check, clients, results, project }) {
  const state = async () => (await api("GET", `/api/projects/${project}/state`)).json ?? {};
  const waitFor = async (pred) => {
    const until = Date.now() + timeoutSec * 1000;
    while (Date.now() < until) {
      const st = await state();
      if (pred(st)) return st;
      await sleep(pollMs);
    }
    return undefined;
  };
  const agent = async (id, client) => {
    const c = new Client({ name: "gitring-smoke", version: "0.1.0" });
    await c.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${key}` } }, fetch: fetchImpl }));
    clients.push(c);
    const call = async (name, args) => {
      const res = await c.callTool({ name, arguments: { project, ...args } });
      return { text: String(res.content?.find((x) => x.type === "text")?.text ?? ""), error: Boolean(res.isError) };
    };
    return { id, client, call };
  };
  const declare = (ag, title, goal, plan, approach) =>
    ag.call("gitring_declare", { newIntent: { title, goal }, plan, files: ["src/index.js", "tests/index.test.js"], symbols: ["src/index.js#slugify"], approach, agent: { id: ag.id, client: ag.client, model: "script" } });
  const attemptOf = (r) => /work copy (a_\w+)/.exec(r.text)?.[1];
  const landed = (id) => (st) => (st.attempts ?? []).find((a) => a.id === id)?.status === "landed";

  const A = await agent("smoke-a", "claude-code");
  const B = await agent("smoke-b", "cursor");
  const planA = await declare(A, "slugify drops accents", "slugify(\"Café\") gives cafe.", ["Remove accents in slugify"], "Edit the return line of slugify.");
  const planB = await declare(B, "slugify cuts long slugs", "slugify returns at most 60 characters.", ["Cut the slug at 60 characters"], "Edit the return line of slugify.");
  const idA = attemptOf(planA);
  const idB = attemptOf(planB);
  if (!check("two agents get a work copy each", Boolean(idA && idB && idA !== idB), planA.error || planB.error ? "a declare call failed" : "")) return { ok: false, results };

  await A.call("gitring_write", { attemptId: idA, files: [{ path: "src/index.js", content: SLUG_A }, { path: "tests/sep.test.js", content: T_A }] });
  const wroteB = await B.call("gitring_write", { attemptId: idB, files: [{ path: "src/index.js", content: SLUG_B }, { path: "tests/cut.test.js", content: T_B }] });
  const st1 = await state();
  const sent = /CHANGE REQUEST/i.test(planB.text + wroteB.text) || (st1.corrections ?? []).some((c) => c.attemptId === idB);
  check("the second agent gets a change request, not a rejection", sent);

  const subA = await A.call("gitring_submit", { attemptId: idA, summary: "slugify drops accents" });
  check("agent A lands on main", Boolean(await waitFor(landed(idA))), subA.text.split(/\n/).slice(0, 3).join(" ").slice(0, 200));

  const upd = await B.call("gitring_update", { attemptId: idB });
  await B.call("gitring_read", { attemptId: idB, path: "src/index.js" });
  const w2 = await B.call("gitring_write", { attemptId: idB, files: [{ path: "src/index.js", content: SLUG_BOTH }, { path: "tests/cut.test.js", content: T_B }, { path: "tests/sep.test.js", content: T_A }] });
  const open = ((await state()).corrections ?? []).filter((c) => c.attemptId === idB && (c.status === "pending" || c.status === "delivered"));
  for (const c of open) await B.call("gitring_ack", { attemptId: idB, correctionId: c.id, note: "Applied on the new main." });
  const chk = await B.call("gitring_check", { attemptId: idB });
  check("the tests of agent B pass", !chk.error && /(\d+)\/\1 tests pass/.test(chk.text), chk.text.replace(/\s+/g, " ").slice(0, 300));
  const subB = await B.call("gitring_submit", { attemptId: idB, summary: "slugify cuts long slugs" });
  const doneB = await waitFor(landed(idB));
  check("agent B lands on main after agent A", Boolean(doneB), subB.error ? subB.text.slice(0, 120) : "");

  const st = await state();
  check("main has two merges, one after the other", (st.landings ?? []).length >= 2, `${(st.landings ?? []).length} merges`);
  return { ok: results.every((r) => r.pass), results, project };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const prepared = prepareSmoke(process.argv.slice(2), process.env);
  if (!prepared.endpoint) {
    for (const l of prepared.lines) console.log(l);
    process.exit(prepared.code ?? 2);
  }
  const r = await runSmoke(prepared);
  process.exit(r.ok ? 0 : 1);
}
