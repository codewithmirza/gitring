/**
 * The helpers of the shop story: API calls, the MCP agents that talk, and the waits for the project.
 * Called by scripts/meet.mjs and scripts/meet-steps.mjs. makeStory gives the steps everything that they share.
 * Never print the key: every line goes through `out`, which hides it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { lastJson } from "./load-lib.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The error that stops the story with a plain reason. */
export class Stop extends Error {}

/** The server and the lines of the report: `out` hides the key, `api` is one REST call with the key. */
export function makeTalk({ endpoint, key, say, fetchImpl }) {
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
  return { origin, out, api };
}

/** What the steps of the story share: the agents, the titles, the waits and the readings of the state. */
export function makeStory({ endpoint, key, fetchImpl, pollMs, out, api, project }) {
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
  /** The change requests of a work copy that wait for the agent to confirm them. */
  const openOf = async (id) => ((await state()).corrections ?? []).filter((c) => c.attemptId === id && (c.status === "pending" || c.status === "delivered")).map((c) => c.id);
  return { out, project, clients, state, agent, title, waitFor, attemptOf, status, merged, openOf, pollMs };
}
