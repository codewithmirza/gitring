#!/usr/bin/env node
/**
 * Load test for a DEPLOYED gitring. It runs many agents at the same time through the real MCP
 * endpoint: declare, write, check, submit, status. It confirms the change requests that it gets. When a change
 * request says that another agent continues on the same lines, the agent waits for that agent (like a good agent;
 * --ignore-requests turns this off). It reports the time of each tool, the change requests, the landings and the errors.
 *
 *   GITRING_URL=https://your-gitring.example.com GITRING_KEY=<key> npm run load -- --project <id> --agents 20 --tasks 3 --yes
 *
 * The calls cost money (Artifacts operations, Workers AI, test containers). Without --yes the script
 * prints a warning and stops. It never creates a project. It does not print the key, and it does not
 * log request headers. The pure parts are in scripts/load-lib.mjs and have tests.
 */
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { changeRequestsIn, exitCode, formatReport, lastJson, Metrics, prepare, startDelays, streamFor } from "./load-lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORDS = "amber birch cedar delta ember fjord grove harbor island juniper kestrel lagoon meadow nectar orchid prairie quartz ridge saffron tundra umber valley willow yarrow zephyr anchor beacon canyon dune estuary forest glacier hollow inlet jetty knoll lantern marsh narrows oasis pebble quarry reef summit thicket upland vista wharf".split(" ");

class Stop extends Error {}

/** One agent: its own MCP connection, and a few tasks one after the other. */
async function runAgent(ctx, index) {
  const { options, metrics, endpoint, key, delays, fetchImpl = fetch, pollMs = 1000 } = ctx;
  const rng = streamFor(options.seed, `agent-${index}`);
  const safe = (text) => String(text).split(key).join("[key]");
  const countingFetch = async (url, init) => {
    const res = await fetchImpl(url, init);
    if (res.status === 429) metrics.count("rateLimited");
    return res;
  };
  const client = new Client({ name: "gitring-load", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${key}` } }, fetch: countingFetch });

  /** One tool call. A 429 answer waits and tries again. Any other failure of the protocol stops this agent. */
  async function tool(name, args = {}) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const t0 = performance.now();
      try {
        const res = await client.callTool({ name, arguments: { project: options.project, ...args } });
        metrics.record(name, performance.now() - t0);
        const text = String(res.content?.find((c) => c.type === "text")?.text ?? "");
        if (res.isError) metrics.count("toolErrors");
        // GITRING_LOAD_TRACE=1 prints each call of each agent (no key, no header) to the error output, to find out why a task did not merge.
        if (process.env.GITRING_LOAD_TRACE) console.error(`[agent ${index}] ${name} ${Math.round(performance.now() - t0)} ms${res.isError ? " ERROR" : ""} :: ${safe(text.split("\n")[0].slice(0, 140))}`);
        return { text, json: lastJson(text), isError: Boolean(res.isError) };
      } catch (e) {
        metrics.record(name, performance.now() - t0);
        if (e?.code === 429 || /\b429\b/.test(String(e?.message))) {
          await sleep(400 * 2 ** attempt + Math.floor(rng() * 300));
          continue;
        }
        metrics.count("protocolErrors");
        metrics.note(`${name}: ${safe(e?.message ?? e)}`);
        throw new Stop(name);
      }
    }
    metrics.count("protocolErrors");
    metrics.note(`${name}: still 429 after 6 tries`);
    throw new Stop(name);
  }

  const seen = new Set();
  /** The agents that continue where this agent edits the same lines. This agent waits for them (see yieldTo). */
  const waitFor = new Set();
  /** Count the change requests in an answer and confirm each one. */
  async function obey(attemptId, res) {
    const clr = res.json?.clearance ?? res.json;
    const known = new Map((Array.isArray(clr?.corrections) ? clr.corrections : []).map((c) => [c.id, c]));
    for (const c of changeRequestsIn(res.text)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      metrics.count("changeRequests");
      const info = known.get(c.id);
      if (options.giveWay && (info?.kind === "region" || info?.kind === "interface") && info.from) waitFor.add(info.from);
      await tool("gitring_ack", { attemptId, correctionId: c.id, note: "Applied." });
    }
  }
  /** Wait until the agents that continue have left the traffic (they merged or stopped), at most 30 s. */
  async function yieldTo(attemptId) {
    const names = [...waitFor];
    waitFor.clear();
    if (!names.length) return;
    metrics.count("gaveWay");
    const until = Date.now() + 30_000;
    for (let poll = 0; Date.now() < until; poll++) {
      const t = await tool("gitring_traffic", { attemptId });
      const near = Array.isArray(t.json?.vessels) ? t.json.vessels : [];
      if (!names.some((n) => near.some((v) => v.callsign === n))) return;
      await sleep(pollMs * Math.min(4, 1 + Math.floor(poll / 3)) + Math.floor(rng() * (pollMs / 2)));
    }
  }

  try {
    await sleep(delays[index]);
    await client.connect(transport);
    for (let t = 0; t < options.tasks; t++) {
      const words = Array.from({ length: 5 }, () => WORDS[Math.floor(rng() * WORDS.length)]);
      const title = `Note about ${words.slice(0, 3).join(" ")}`;
      const own = `load-test/${options.seed}/note-${index}-${t}.md`;
      const shared = `load-test/${options.seed}/shared.md`;
      const useShared = rng() < options.shared / 100; // some tasks add a line to one file that all agents edit: the plans meet
      const line = `- ${words.join(" ")} (agent ${index}, task ${t})`;
      const declared = await tool("gitring_declare", {
        newIntent: { title, goal: `Add the file ${own} with one sentence about ${words[3]} and ${words[4]}.${useShared ? ` Add one line to ${shared}.` : ""}` },
        plan: [`Write ${own}.`, ...(useShared ? [`Add a line to ${shared}.`] : [])],
        files: useShared ? [own, shared] : [own],
        symbols: [],
        approach: "Write a small text file.",
        agent: { id: `load-${options.seed}-${index}`, client: "gitring-load", model: "script" },
      });
      const attemptId = declared.json?.attemptId;
      if (!attemptId) {
        metrics.count("failed");
        metrics.note(`gitring_declare: ${safe(declared.text.slice(0, 160))}`);
        continue;
      }
      await obey(attemptId, declared);
      let end = "failed";
      let over = false; // the work copy is closed: another round would only give errors
      for (let round = 1; round <= options.rounds && end === "failed" && !over; round++) {
        // A write is refused when the shared file changed after the read. A change request can say that another agent
        // continues on the same lines: this agent waits until that agent has left, then reads the file again and writes
        // again. That is not a new try: a try ends with a merge that did not happen.
        let written;
        for (let reads = 0; reads < 10; reads++) {
          await yieldTo(attemptId);
          const files = [{ path: own, content: `# ${title}\n\nA sentence about ${words[3]} and ${words[4]}.\n` }];
          if (useShared) {
            // gitring_read answers with the text of the file, or with a sentence when the file does not exist.
            const cur = await tool("gitring_read", { attemptId, path: shared });
            const text = cur.isError || /^The file .* does not exist\.$/.test(cur.text) ? "" : cur.text;
            files.push({ path: shared, content: text.includes(line) ? text : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n` });
          }
          written = await tool("gitring_write", { attemptId, files, message: title });
          await obey(attemptId, written);
          if (!written.json?.refused?.length && !waitFor.size) break;
        }
        if (written.json?.refused?.length) continue; // refused ten times: a try is used
        const checked = await tool("gitring_check", { attemptId });
        if (checked.json?.ok === false) continue; // the tests fail: a try is used
        const sent = await tool("gitring_submit", { attemptId, summary: title });
        await obey(attemptId, sent);
        const next = sent.json?.next;
        if (next === "landed") end = "landed";
        else if (next === "awaiting-approval") end = "handed";
        else if (next === "landing-queue") {
          // Wait for the merge. gitring_status tells the state of the work copy. The agent does not change a work copy that waits.
          const until = Date.now() + 120_000;
          for (let poll = 0; Date.now() < until; poll++) {
            // An agent does not ask every second for long: the wait grows from 1 s to 4 s.
            await sleep(pollMs * Math.min(4, 1 + Math.floor(poll / 3)) + Math.floor(rng() * (pollMs / 2)));
            const u = await tool("gitring_status", { attemptId });
            await obey(attemptId, u);
            const state = u.json?.status;
            if (state === "landed") {
              end = "landed";
              break;
            }
            if (u.json?.approval?.status === "waiting") {
              end = "handed";
              break;
            }
            if (state === "stale") {
              end = "redone"; // the tries of the agent are used: a built-in agent does the task again
              break;
            }
            if (u.isError || state === "failed" || state === "abandoned" || state === "alternate") {
              over = true;
              break;
            }
            // After a submit the work copy waits in the queue. "In work" again means that the work came back: write again.
            if (state === "underway" || state === "declared") break;
          }
        } else continue; // for example "fix-checks": the work came back, or the tests fail. A try is used.
      }
      metrics.count(end);
    }
  } catch (e) {
    if (!(e instanceof Stop)) {
      metrics.count("protocolErrors");
      metrics.note(safe(e?.message ?? e));
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Run all agents at the same time. `fetchImpl` (a test double) and the waits are options for the tests.
 * It returns the metrics and the total time in milliseconds.
 */
export async function runLoad({ options, endpoint, key, fetchImpl, pollMs = 1000, spreadMs = 3000 }) {
  const metrics = new Metrics();
  const delays = startDelays(options.seed, options.agents, spreadMs);
  const t0 = performance.now();
  await Promise.all(Array.from({ length: options.agents }, (_, i) => runAgent({ options, metrics, endpoint, key, delays, fetchImpl, pollMs }, i)));
  return { metrics, totalMs: performance.now() - t0 };
}

async function main() {
  const prep = prepare(process.argv.slice(2), process.env);
  if (!prep.options) {
    for (const line of prep.lines) (prep.code === 0 ? console.log : console.error)(line);
    process.exitCode = prep.code;
    return;
  }
  const { options, endpoint, key } = prep;
  console.log(`Load test on ${endpoint.origin}: project ${options.project}, ${options.agents} agents, ${options.tasks} tasks each, seed ${options.seed}.`);
  const { metrics, totalMs } = await runLoad({ options, endpoint, key });
  for (const line of formatReport(metrics, { totalMs, ...options })) console.log(line);
  process.exitCode = exitCode(metrics.counts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(String(e?.message ?? e).split(process.env.GITRING_KEY ?? "\u0000").join("[key]"));
    process.exitCode = 1;
  });
}
