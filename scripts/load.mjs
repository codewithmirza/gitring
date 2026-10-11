#!/usr/bin/env node
/**
 * Load test for a DEPLOYED gitring. It runs many agents at the same time through the real MCP
 * endpoint: declare, write, check, submit. It applies the change requests that it gets, and it
 * reports the time of each tool, the change requests, the landings and the errors.
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
  /** Count the change requests in an answer and confirm each one. */
  async function obey(attemptId, res) {
    for (const c of changeRequestsIn(res.text)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      metrics.count("changeRequests");
      await tool("gitring_ack", { attemptId, correctionId: c.id, note: "Applied." });
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
      const useShared = rng() < 0.3; // some tasks add a line to one file that all agents edit: the plans meet
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
      for (let round = 1; round <= 4 && end === "failed"; round++) {
        const files = [{ path: own, content: `# ${title}\n\nA sentence about ${words[3]} and ${words[4]}.\n` }];
        if (useShared) {
          // gitring_read answers with the text of the file, or with a sentence when the file does not exist.
          const cur = await tool("gitring_read", { attemptId, path: shared });
          const text = cur.isError || /^The file .* does not exist\.$/.test(cur.text) ? "" : cur.text;
          files.push({ path: shared, content: text.includes(line) ? text : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n` });
        }
        const written = await tool("gitring_write", { attemptId, files, message: title });
        await obey(attemptId, written);
        if (written.json?.refused?.length) continue; // the shared file changed: read it again
        const checked = await tool("gitring_check", { attemptId });
        if (checked.json?.ok === false) break;
        const sent = await tool("gitring_submit", { attemptId, summary: title });
        await obey(attemptId, sent);
        const next = sent.json?.next;
        if (next === "landed") end = "landed";
        else if (next === "awaiting-pick") end = "handed";
        else if (next === "landing-queue") {
          // Wait for the merge. gitring_update answers with an error when the work is merged.
          const until = Date.now() + 120_000;
          for (let poll = 0; Date.now() < until; poll++) {
            await sleep(pollMs + Math.floor(rng() * (pollMs / 2)));
            const u = await tool("gitring_update", { attemptId });
            if (u.isError) {
              end = /is merged/.test(u.text) ? "landed" : "failed";
              break;
            }
            if (poll % 3 === 2) {
              const l = await tool("gitring_log", { attemptId, message: "Waiting for the merge." });
              await obey(attemptId, l);
              if (changeRequestsIn(l.text).length) break; // the work came back: write again
            }
          }
        } else break;
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
