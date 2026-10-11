#!/usr/bin/env node
/**
 * Three scripted agents meet on one small project, on any gitring: a deployed one, or the run on your
 * computer (npm run dev:local). The script uses the real MCP address and the real tools, and it prints each
 * real answer, so you can read what a real agent reads.
 *
 *   1. One agent starts the shop (the files of examples/shop).
 *   2. Two agents change the same function. The second agent gets a change request and applies it.
 *      Both changes merge.
 *   3. With --approval, a third agent changes the parameters of a function. A person must say yes.
 *      The script prints the link and waits for the answer.
 *
 *   GITRING_URL=https://your-gitring.example.com GITRING_KEY=<key> npm run meet
 *   (the run on your computer: GITRING_URL=http://localhost:8787 and the key that dev:local prints)
 *
 * The script makes one private project and archives it at the end (--keep keeps it, so you can look at it
 * in the browser). It does not print the key. The agents are scripted: this is not a test of a real model.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { endpointOf, lastJson } from "./load-lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOP = new URL("../examples/shop/", import.meta.url);
const read = (path) => readFileSync(new URL(path, SHOP), "utf8");
const lines = (...l) => `${l.join("\n")}\n`;

export const MEET_USAGE = [
  "Usage: GITRING_URL=https://your-gitring.example.com GITRING_KEY=<key> npm run meet -- [--approval] [--wait SECONDS] [--keep]",
  "  --approval      add a third agent whose change needs a person. The script prints the link and waits.",
  "  --wait SECONDS  how long to wait for the person (default 180, with --approval only)",
  "  --keep          keep the project, to look at it in the browser (default: archive it at the end)",
  "GITRING_URL must start with https://. For the run on your computer, http://localhost works too. GITRING_KEY is read from the environment only. The script never prints it.",
];

/** Read the command line and the environment. A result with `lines` and a `code` means: print and exit. */
export function prepareMeet(argv, env) {
  const options = { approval: false, waitSec: 180, keep: false };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--help" || a === "-h") return { code: 0, lines: MEET_USAGE };
      if (a === "--approval") options.approval = true;
      else if (a === "--keep") options.keep = true;
      else if (a === "--wait" || a.startsWith("--wait=")) {
        const raw = a.includes("=") ? a.slice(7) : argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 3600) throw new Error("--wait needs a whole number of seconds, from 0 to 3600.");
        options.waitSec = n;
      } else throw new Error(`Unknown option ${a}.`);
    }
    const key = String(env.GITRING_KEY ?? "");
    if (!key) throw new Error("GITRING_KEY is not set. Make a key in gitring (Account → API keys), or use the key that npm run dev:local prints.");
    const endpoint = endpointOf(env.GITRING_URL);
    return { options, endpoint, key };
  } catch (e) {
    return { code: 2, lines: [String(e?.message ?? e), ...MEET_USAGE] };
  }
}

/* ───────────── the files of the story ───────────── */

const PRICE = () => read("src/price.js");
const PRICE_TEST = () => read("tests/price.test.js");
const COMMAS_LINE = '  return "$" + dollars.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");';
const COMMAS = lines("export function formatPrice(cents) {", "  const dollars = (cents / 100).toFixed(2);", COMMAS_LINE, "}");
const FREE = lines("export function formatPrice(cents) {", '  if (cents === 0) return "Free";', '  return "$" + (cents / 100).toFixed(2);', "}");
const BOTH = lines("export function formatPrice(cents) {", '  if (cents === 0) return "Free";', "  const dollars = (cents / 100).toFixed(2);", COMMAS_LINE, "}");
const EUROS = lines(
  'const SIGNS = { USD: "$", EUR: "€" };',
  "",
  'export function formatPrice(cents, currency = "USD") {',
  '  if (cents === 0) return "Free";',
  "  const dollars = (cents / 100).toFixed(2);",
  `  return SIGNS[currency] + dollars.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");`,
  "}",
);
const CART_EUROS = lines(
  'import { formatPrice } from "./price.js";',
  "",
  'export function cartTotal(items, currency = "USD") {',
  "  return formatPrice(items.reduce((sum, item) => sum + item.cents, 0), currency);",
  "}",
);
const T_COMMAS = 'test("adds commas", () => expect(formatPrice(123456)).toBe("$1,234.56"));\n';
const T_FREE = 'test("shows Free", () => expect(formatPrice(0)).toBe("Free"));\n';
const T_EUROS = 'test("shows euros", () => expect(formatPrice(1999, "EUR")).toBe("€19.99"));\n';

/* ───────────── the run ───────────── */

class Stop extends Error {}

/**
 * Run the story. `say` gets each line of the report. `fetchImpl` and `pollMs` are for tests.
 * Returns what happened; it throws when the story cannot go on (the project is archived first).
 */
export async function runMeet({ endpoint, key, options = {}, say = console.log, fetchImpl = fetch, pollMs = 500 }) {
  const { approval = false, waitSec = 180, keep = false } = options;
  const origin = new URL(endpoint.origin);
  const out = (text = "") => say(String(text).split(key).join("[key]"));
  const api = async (method, path, body) => {
    const res = await fetchImpl(new URL(path, origin), {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, raw };
  };

  const made = await api("POST", "/api/projects", { name: `meet-${Date.now().toString(36)}`, visibility: "private", source: { kind: "empty" }, settings: { checks: { runner: "worker" } } });
  if (made.status !== 201 || !made.json?.project?.id) {
    throw new Error(`gitring did not make the project (${made.status}): ${made.raw.slice(0, 200)}. The key needs the right to make projects.`);
  }
  const project = made.json.project.id;
  const clients = [];
  let step = 0;
  const state = async () => (await api("GET", `/api/projects/${project}/state`)).json ?? {};

  /** One agent: its own MCP connection, like an agent of another product. */
  async function agent(label) {
    const client = new Client({ name: "gitring-meet", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${key}` } }, fetch: fetchImpl });
    await client.connect(transport);
    clients.push(client);
    return {
      label,
      /** One tool call. `note` is the line that tells a reader what the agent does. */
      async call(name, args, note) {
        out(`${label} calls ${name}${note ? `: ${note}` : ""}`);
        const res = await client.callTool({ name, arguments: { project, ...args } });
        const text = String(res.content?.find((c) => c.type === "text")?.text ?? "");
        const shown = text.split("\n");
        const cut = shown.findIndex((l) => l === "{" || l === "[");
        const body = (cut === -1 ? shown : shown.slice(0, cut)).join("\n").trim().split("\n");
        const head = body.slice(0, 14);
        for (const l of head) out(`  │ ${l}`);
        if (body.length > head.length) out(`  │ … (${body.length - head.length} more lines)`);
        if (res.isError) throw new Stop(`${name} answered with an error.`);
        out();
        return { text, json: lastJson(text) };
      },
    };
  }

  const title = (text) => out(`\n── ${++step}. ${text} ${"─".repeat(Math.max(4, 62 - text.length))}\n`);
  const waitFor = async (test, what, tries = 120) => {
    for (let i = 0; i < tries; i++) {
      const st = await state();
      if (test(st)) return st;
      await sleep(pollMs);
    }
    throw new Stop(`Waited too long for ${what}.`);
  };
  const attemptOf = (res) => /work copy (a_\w+)/.exec(res.text)?.[1] ?? res.json?.attemptId;
  const status = (st, id) => (st.attempts ?? []).find((a) => a.id === id)?.status;
  const merged = (id) => (st) => status(st, id) === "landed";
  const lower = (text) => text.charAt(0).toLowerCase() + text.slice(1);

  let result = { ok: false, project, merges: 0, changeRequests: 0, waiting: false };
  try {
    out("gitring meet: three scripted agents and one small shop project");
    out(`Project: ${project}  (private; ${keep ? "kept" : "archived at the end"})`);

    // 1. One agent starts the shop.
    title("One agent starts the shop");
    const starter = await agent("Agent S");
    const seed = await starter.call(
      "gitring_declare",
      {
        newIntent: { title: "Start the shop", goal: "The shop has a price function and a cart, with tests." },
        plan: ["Add price.js and cart.js with their tests"],
        files: ["src/price.js", "src/cart.js", "tests/price.test.js", "tests/cart.test.js"],
        symbols: [],
        approach: "New files.",
        agent: { id: "meet-starter", client: "script", model: "script" },
      },
      "the plan",
    );
    const seedId = attemptOf(seed);
    await starter.call("gitring_write", { attemptId: seedId, files: ["src/price.js", "src/cart.js", "tests/price.test.js", "tests/cart.test.js"].map((path) => ({ path, content: read(path) })) }, "four files");
    await starter.call("gitring_submit", { attemptId: seedId, summary: "Start the shop" }, "the work is ready");
    await waitFor(merged(seedId), "the first merge");

    // 2. Two agents, one function.
    title("Two agents change the same function");
    const a = await agent("Agent A (Claude Code)");
    const b = await agent("Agent B (Cursor)");
    const planA = await a.call(
      "gitring_declare",
      {
        newIntent: { title: "Show thousands separators in prices", goal: "A price of 123456 cents shows as $1,234.56." },
        plan: ["Change formatPrice to add commas to the dollars", "Add a test"],
        files: ["src/price.js", "tests/price.test.js"],
        symbols: ["src/price.js#formatPrice"],
        approach: "Edit the return line of formatPrice.",
        agent: { id: "meet-claude-code", client: "claude-code", model: "claude" },
      },
      "the plan names formatPrice",
    );
    const idA = attemptOf(planA);
    const planB = await b.call(
      "gitring_declare",
      {
        newIntent: { title: "Show Free for a price of zero", goal: "formatPrice(0) shows Free." },
        plan: ["Change formatPrice: when the price is 0, return Free", "Add a test"],
        files: ["src/price.js", "tests/price.test.js"],
        symbols: ["src/price.js#formatPrice"],
        approach: "Add a check at the top of formatPrice.",
        agent: { id: "meet-cursor", client: "cursor", model: "gpt" },
      },
      "the plan names the same function",
    );
    const idB = attemptOf(planB);
    await a.call("gitring_write", { attemptId: idA, files: [{ path: "src/price.js", content: COMMAS }, { path: "tests/price.test.js", content: PRICE_TEST() + T_COMMAS }] }, "the commas");
    const wroteB = await b.call("gitring_write", { attemptId: idB, files: [{ path: "src/price.js", content: FREE }, { path: "tests/price.test.js", content: PRICE_TEST() + T_FREE }] }, "the Free check, on the same lines");
    for (const id of new Set([...(planB.text.matchAll(/\[(cr_\w+)\]/g) ?? []), ...(wroteB.text.matchAll(/\[(cr_\w+)\]/g) ?? [])].map((m) => m[1]))) {
      await b.call("gitring_ack", { attemptId: idB, correctionId: id, note: "Applied. I wait for Agent A, then I change formatPrice again on the new main." }, `confirm ${id}`);
    }
    await b.call("gitring_traffic", { attemptId: idB }, "who works near me?");
    await a.call("gitring_check", { attemptId: idA }, "the tests");
    await a.call("gitring_submit", { attemptId: idA, summary: "Prices show commas: $1,234.56" }, "the work is ready");
    await waitFor(merged(idA), "the merge of Agent A");

    title("The second agent works on the new main");
    await b.call("gitring_status", { attemptId: idB }, "where is my work copy?");
    await b.call("gitring_update", { attemptId: idB }, "take the new main");
    await b.call("gitring_read", { attemptId: idB, path: "src/price.js" }, "read the new text");
    await b.call("gitring_read", { attemptId: idB, path: "tests/price.test.js" }, "read the new test");
    await b.call("gitring_write", { attemptId: idB, files: [{ path: "src/price.js", content: BOTH }, { path: "tests/price.test.js", content: PRICE_TEST() + T_COMMAS + T_FREE }] }, "both changes, on the new text");
    await b.call("gitring_check", { attemptId: idB }, "the tests");
    await b.call("gitring_submit", { attemptId: idB, summary: "formatPrice(0) shows Free" }, "the work is ready");
    await waitFor(merged(idB), "the merge of Agent B");

    // 3. A change that needs a person.
    if (approval) {
      title("A change that needs a person");
      const c = await agent("Agent C (Codex)");
      const planC = await c.call(
        "gitring_declare",
        {
          newIntent: { title: "Show euros in the EU", goal: "formatPrice takes a currency." },
          plan: ["Change formatPrice to take a currency", "Change cartTotal to pass the currency", "Add a test"],
          files: ["src/price.js", "src/cart.js", "tests/price.test.js"],
          symbols: ["src/price.js#formatPrice(cents, currency)", "src/cart.js#cartTotal(items, currency)"],
          approach: "Add a second parameter with a default.",
          agent: { id: "meet-codex", client: "codex", model: "gpt" },
        },
        "the plan changes two signatures",
      );
      const idC = attemptOf(planC);
      await c.call(
        "gitring_write",
        { attemptId: idC, files: [{ path: "src/price.js", content: EUROS }, { path: "src/cart.js", content: CART_EUROS }, { path: "tests/price.test.js", content: PRICE_TEST() + T_COMMAS + T_FREE + T_EUROS }] },
        "the currency",
      );
      const sent = await c.call("gitring_submit", { attemptId: idC, summary: "formatPrice takes a currency" }, "the work is ready");
      if (!/A PERSON MUST SAY YES/.test(sent.text)) throw new Stop("gitring did not ask for a person. The project may allow work without a question (Settings → Merging).");
      out("A person must say yes. Open the link above in your browser, sign in, and choose Yes, merge.");
      out("A key cannot say yes. Only a person who is signed in can.");
      result.waiting = true;
      const until = Date.now() + waitSec * 1000;
      let answered = waitSec === 0 ? false : null;
      while (answered === null) {
        const st = await state();
        const s = status(st, idC);
        if (s === "landed") answered = "yes";
        else if (s && !["judging", "ready", "landing"].includes(s)) answered = s;
        else if (Date.now() > until) answered = false;
        else await sleep(Math.max(pollMs, 1500));
      }
      if (answered === "yes") {
        result.waiting = false;
        const done = await c.call("gitring_status", { attemptId: idC }, "what did the person say?");
        out(done.text.includes("merged") ? "The person said yes. The work merged." : "The person answered.");
      } else if (answered === false) {
        out(waitSec === 0 ? "The script does not wait (--wait 0). The work still waits for a person." : `Nobody answered in ${waitSec} seconds. The work still waits for a person.`);
      } else {
        result.waiting = false;
        out(`The work is now ${answered}.`);
      }
    }

    const st = await state();
    result = { ...result, ok: true, merges: (st.landings ?? []).length, changeRequests: (st.corrections ?? []).length };
    out(`\n── Result ${"─".repeat(56)}`);
    out(`main has ${result.merges} ${result.merges === 1 ? "merge" : "merges"}, one after the other. gitring sent ${result.changeRequests} ${result.changeRequests === 1 ? "change request" : "change requests"}.`);
    out("Both changes to formatPrice are in main: commas, and Free for zero. Nobody had to solve a conflict.");
    if (result.waiting) out("The change of Agent C is not in main. It waits for a person.");
    if (keep || result.waiting) out(`Look at it: ${origin.origin}/overview?project=${project}  (sign in first)`);
  } catch (e) {
    out(`\nThe story stopped: ${lower(String(e?.message ?? e))}`);
    throw e;
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    if (result.waiting) out(`The project ${project} stays, because a person still has to answer. Archive it in Settings when you are done.`);
    else if (!keep) {
      const gone = await api("DELETE", `/api/projects/${project}`).catch(() => undefined);
      out(gone?.status === 204 ? `The project ${project} is archived.` : `The project ${project} stays. Archive it in Settings.`);
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const prepared = prepareMeet(process.argv.slice(2), process.env);
  if (!prepared.options) {
    for (const l of prepared.lines) console.log(l);
    process.exit(prepared.code ?? 2);
  }
  try {
    const r = await runMeet({ endpoint: prepared.endpoint, key: prepared.key, options: prepared.options });
    process.exit(r.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
