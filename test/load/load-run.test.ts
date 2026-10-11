/**
 * The agents of scripts/load.mjs, run against the real Worker routes in this process (no network): the
 * MCP client of the script connects, and runs declare, write, check, submit, update and ack.
 */
import { afterEach, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { shop } from "../harbor/shop";
import { World } from "../harbor/world";
import { Metrics } from "../../scripts/load-lib.mjs";
import { runLoad } from "../../scripts/load.mjs";

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

it("runs the agents of the load script through the real routes: every task lands, no protocol error", async () => {
  const world = new World();
  worlds.push(world);
  await world.init();
  const { key } = await world.signIn("robin", 1);
  const project = await world.createProject(key, "load", shop(1, 0).files);

  // The script sends its requests to the Worker of this process.
  const seen: { url: string; hasKey: boolean }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, hasKey: req.headers.get("authorization") === `Bearer ${key}` });
    const ctx = { waitUntil: (p: Promise<unknown>) => void world.pending.push(p.catch(() => undefined)), passThroughOnException() {}, props: {} };
    return worker.fetch(req, world.env as never, ctx as never);
  };

  const options = { project: project.id, agents: 6, tasks: 2, seed: 3 };
  const { metrics, totalMs } = await runLoad({ options, endpoint: new URL("https://gitring.test/mcp"), key, fetchImpl, pollMs: 40, spreadMs: 60 });
  await world.settle();

  const c = metrics.counts;
  expect(metrics.notes, "problems that the script noted").toEqual([]);
  expect(c.protocolErrors).toBe(0);
  expect(c.rateLimited).toBe(0);
  expect(c.landed + c.handed + c.failed, "every task has an end").toBe(options.agents * options.tasks);
  expect(c.landed, `landed ${c.landed} of ${options.agents * options.tasks}`).toBe(options.agents * options.tasks);
  expect(totalMs).toBeLessThan(60_000);

  // Every call went to /mcp with the key, and the script used the tools of an outside agent.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((s) => s.url === "https://gitring.test/mcp" && s.hasKey)).toBe(true);
  const tools = new Set((metrics as Metrics).perTool().map((t) => t.tool));
  for (const name of ["gitring_declare", "gitring_write", "gitring_check", "gitring_submit", "gitring_update"]) expect(tools.has(name), name).toBe(true);

  // The project holds one file for each task, and the shared file holds the lines of the tasks that used it.
  const state = await world.harbor(project.id).state();
  expect(state.landings).toHaveLength(options.agents * options.tasks);
  const files = await world.filesAt(project.mainRepo, state.project.mainSha);
  expect(Object.keys(files).filter((p) => /^load-test\/3\/note-\d+-\d+\.md$/.test(p))).toHaveLength(options.agents * options.tasks);
  const shared = files["load-test/3/shared.md"] ?? "";
  expect(shared.split("\n").filter(Boolean).every((l) => /^- \w+( \w+){4} \(agent \d+, task \d+\)$/.test(l))).toBe(true);
  expect(new Set(shared.split("\n").filter(Boolean)).size, "no line twice").toBe(shared.split("\n").filter(Boolean).length);
}, 90_000);
