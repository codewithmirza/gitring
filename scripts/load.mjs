#!/usr/bin/env node
/**
 * Load test for a deployed gitring: many scripted agents work at the same time through the real MCP endpoint.
 * Run: GITRING_URL=<url> GITRING_KEY=<key> npm run load -- --project <id> --agents 20 --tasks 3 --yes
 * The calls cost money. Without --yes the script prints a warning and stops. It never creates a project.
 * Never print the key or a request header. Read next: load-agent.mjs (one agent), load-lib.mjs (options and report).
 */
import { pathToFileURL } from "node:url";
import { exitCode, formatReport, Metrics, prepare, startDelays } from "./load-lib.mjs";
import { runAgent } from "./load-agent.mjs";

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
