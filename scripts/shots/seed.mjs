// Makes one project with real activity, through the real API and the real MCP tools (no mock).
// Used by: scripts/shots.mjs. It must not print the key. The project belongs to the signed-in person,
// so the person can answer its questions. Agents act with the operator key, like scripts/meet.mjs.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runMeet } from "../meet.mjs";
import { endpointOf } from "../load-lib.mjs";

const PROJECT_NAME = "corner-shop";
const LONG_TASK = {
  title: "Show one line for each discount code, gift card and loyalty credit in the order summary",
  goal: "The order summary lists every discount code, every gift card and every loyalty credit as its own line. Each line shows the amount that it takes off. The total at the bottom is the same number that the cart shows. A person who pays with two gift cards and one code must be able to check the sum with a calculator.",
};

// ───── The person's own requests ─────

/** A request that the signed-in page sends as the person (its cookie), not with the key. */
function personRequest(page) {
  return async (method, path, body) => {
    const reply = await page.evaluate(
      async (call) => {
        const res = await fetch(call.path, { method: call.method, headers: call.body ? { "content-type": "application/json" } : {}, body: call.body ? JSON.stringify(call.body) : undefined });
        return { status: res.status, text: await res.text() };
      },
      { method, path, body },
    );
    let json;
    try {
      json = JSON.parse(reply.text);
    } catch {
      json = undefined;
    }
    return { status: reply.status, text: reply.text, json };
  };
}

/**
 * A fetch for scripts/meet.mjs. The story makes its project with the key, and the key makes projects that no
 * person owns. This fetch sends that one request as the person instead, with a better name. Other requests go on.
 */
function meetFetch(asPerson) {
  return async (input, init) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = String(init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    if (method !== "POST" || target.pathname !== "/api/projects") return fetch(input, init);
    const wanted = JSON.parse(String(init.body));
    const reply = await asPerson("POST", "/api/projects", { ...wanted, name: PROJECT_NAME });
    return new Response(reply.text, { status: reply.status, headers: { "content-type": "application/json" } });
  };
}

// ───── Agents ─────

/** One agent: its own MCP connection with the key. `call` returns the text that a real agent reads. */
async function connectAgent(endpoint, key, project) {
  const client = new Client({ name: "gitring-shots", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return {
    client,
    async call(name, args) {
      const res = await client.callTool({ name, arguments: { project, ...args } });
      const text = String(res.content?.find((part) => part.type === "text")?.text ?? "");
      if (res.isError) throw new Error(`${name} answered with an error: ${text.slice(0, 200)}`);
      return text;
    },
  };
}

const workCopyOf = (text) => /work copy (a_\w+)/.exec(text)?.[1];

/** Three agents with work in progress: one has a change request, one has written code, one has only a plan. */
async function startAgents(endpoint, key, project, taskId, say) {
  const opened = [];
  const open = async () => {
    const agent = await connectAgent(endpoint, key, project);
    opened.push(agent.client);
    return agent;
  };
  try {
    // Agent D plans to change formatPrice. The agent that waits for a person changes it too, so D gets a change request.
    const d = await open();
    const planD = await d.call("gitring_declare", {
      newIntent: { title: "Round prices up to the next 5 cents", goal: "A price of 1999 cents shows as $20.00 when the shop rounds up to 5 cents." },
      plan: ["Round the cents in formatPrice", "Add a test"],
      files: ["src/price.js", "tests/price.test.js"],
      symbols: ["src/price.js#formatPrice"],
      approach: "Round the cents before they are formatted.",
      agent: { id: "shots-windsurf", client: "windsurf", model: "claude" },
    });
    const idD = workCopyOf(planD);
    const rounded = 'export function formatPrice(cents) {\n  const rounded = Math.ceil(cents / 5) * 5;\n  return "$" + (rounded / 100).toFixed(2);\n}\n';
    if (idD) await d.call("gitring_write", { attemptId: idD, files: [{ path: "src/price.js", content: rounded }] });

    // Agent E works on the long task of the person: it has written code, and it has not sent it yet.
    const e = await open();
    const planE = await e.call("gitring_declare", {
      intentId: taskId,
      plan: ["Add a function that lists the lines of the order summary", "Use it in cartTotal"],
      files: ["src/summary.js", "tests/cart.test.js"],
      symbols: [],
      approach: "A new summaryLines function, and cartTotal reads from it.",
      agent: { id: "shots-claude-code", client: "claude-code", model: "claude" },
    });
    const idE = workCopyOf(planE);
    const lines =
      "export function summaryLines(items, credits = []) {\n  return [...items.map((item) => ({ label: item.name, cents: item.cents })), ...credits.map((credit) => ({ label: credit.label, cents: -credit.cents }))];\n}\n";
    if (idE) await e.call("gitring_write", { attemptId: idE, files: [{ path: "src/summary.js", content: lines }] });

    // Agent F has a plan and no code yet. The plan is far from the others: only the README.
    const f = await open();
    await f.call("gitring_declare", {
      newIntent: { title: "Explain the price rules in the README", goal: "The README says how prices are rounded and when a price shows as Free." },
      plan: ["Add a section to the README"],
      files: ["README.md"],
      symbols: [],
      approach: "One new section.",
      agent: { id: "shots-cursor", client: "cursor", model: "gpt" },
    });
    say("Three more agents have work in progress.");
  } finally {
    for (const client of opened) await client.close().catch(() => undefined);
  }
}

// ───── A project with many tasks ─────

const VERBS = ["Add", "Fix", "Rename", "Document", "Test", "Remove", "Speed up", "Validate", "Log", "Cache"];
const THINGS = ["the notes list", "note search", "the tag filter", "the share link", "note export", "the trash bin", "pinned notes", "the sign-in check"];

/** Writes many tasks in a project, ten requests at a time, so that the list shows what 80 rows look like. */
async function writeManyTasks(asPerson, project, count) {
  const titles = Array.from({ length: count }, (_, i) => `${VERBS[i % VERBS.length]} ${THINGS[Math.floor(i / VERBS.length) % THINGS.length]}${i >= VERBS.length * THINGS.length ? ` (${i})` : ""}`);
  for (let start = 0; start < titles.length; start += 10) {
    await Promise.all(titles.slice(start, start + 10).map((title) => asPerson("POST", `/api/projects/${project}/intents`, { title, goal: `${title}, and prove it with a test.` })));
  }
}

// ───── The whole seed ─────

/**
 * Makes the project. Steps: the story of scripts/meet.mjs with a waiting question; two tasks of the person;
 * three agents with work in progress; two more projects for the list. Returns the id of the busy project, the id of
 * the project that has no activity and a long name, the id of the project with 80 tasks, and the state of the busy project.
 */
export async function seedProject({ baseUrl, key, page, say = () => undefined }) {
  const asPerson = personRequest(page);
  const endpoint = endpointOf(baseUrl);
  const lines = [];
  const story = await runMeet({
    endpoint,
    key,
    options: { approval: true, waitSec: 0, keep: true },
    say: (line) => lines.push(line),
    fetchImpl: meetFetch(asPerson),
    pollMs: 200,
  });
  if (!story.ok) throw new Error(`The story of the agents did not finish:\n${lines.slice(-12).join("\n")}`);
  const project = story.project;
  say(`The story ran: ${story.merges} merges, ${story.changeRequests} change requests, one question for the person.`);

  // The person writes two tasks. The first is long, to show how long text looks. The second has no agent.
  const long = await asPerson("POST", `/api/projects/${project}/intents`, LONG_TASK);
  await asPerson("POST", `/api/projects/${project}/intents`, { title: "Add a refund option to the cart", goal: "A person can remove an order line and get the money back." });
  if (long.status !== 200) throw new Error(`gitring did not make the task of the person (${long.status}): ${long.text.slice(0, 200)}`);
  await startAgents(endpoint, key, project, long.json.id, say);

  // More projects, so that the list is not one row. One has a very long name.
  const notes = await asPerson("POST", "/api/projects", { name: "notes-api", visibility: "private", source: { kind: "template", template: "worker-api" } });
  if (notes.json?.project?.id) await writeManyTasks(asPerson, notes.json.project.id, 80);
  const quiet = await asPerson("POST", "/api/projects", { name: "storefront-and-checkout-service-for-the-european-market", visibility: "private", source: { kind: "empty" } });

  const state = (await asPerson("GET", `/api/projects/${project}/state`)).json ?? {};
  return { project, quiet: quiet.json?.project?.id ?? null, many: notes.json?.project?.id ?? null, state, lines };
}
