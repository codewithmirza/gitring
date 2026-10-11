/** The pure parts of scripts/load.mjs: options, cost warning, seeded scheduling, percentiles, report. */
import { describe, expect, it } from "vitest";
import { changeRequestsIn, endpointOf, exitCode, formatReport, lastJson, LIMITS, Metrics, percentile, prepare, seededShuffle, startDelays, streamFor, summarize } from "../../scripts/load-lib.mjs";

const ENV = { GITRING_URL: "https://gitring.example.com", GITRING_KEY: "gk_secret_value_123" };

describe("percentiles", () => {
  it("uses the nearest rank", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });

  it("summarizes a list in any order", () => {
    expect(summarize([30, 10, 20, 40])).toEqual({ count: 4, p50: 20, p95: 40, max: 40 });
    expect(summarize([])).toEqual({ count: 0, p50: 0, p95: 0, max: 0 });
  });
});

describe("seeded scheduling", () => {
  it("gives the same delays for the same seed, and other delays for another seed", () => {
    expect(startDelays(1, 20, 3000)).toEqual(startDelays(1, 20, 3000));
    expect(startDelays(1, 20, 3000)).not.toEqual(startDelays(2, 20, 3000));
    for (const d of startDelays(5, 200, 3000)) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(3000);
    }
  });

  it("gives each agent its own stream, the same on every run", () => {
    const a1 = streamFor(1, "agent-1");
    const a2 = streamFor(1, "agent-1");
    const b = streamFor(1, "agent-2");
    const first = [a1(), a1(), a1()];
    expect([a2(), a2(), a2()]).toEqual(first);
    expect([b(), b(), b()]).not.toEqual(first);
  });

  it("shuffles without a change to the input", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const once = seededShuffle(items, streamFor(3, "x"));
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...once].sort((a, b) => a - b)).toEqual(items);
    expect(seededShuffle(items, streamFor(3, "x"))).toEqual(once);
  });
});

describe("options", () => {
  it("needs a project, an https address and a key from the environment", () => {
    expect(prepare([], ENV).code).toBe(2);
    expect(prepare(["--project", "shop-1"], { ...ENV, GITRING_URL: "http://gitring.example.com" }).lines.join("\n")).toMatch(/https/);
    expect(prepare(["--project", "shop-1"], { ...ENV, GITRING_URL: "not a url" }).code).toBe(2);
    expect(prepare(["--project", "shop-1"], { GITRING_URL: ENV.GITRING_URL }).lines.join("\n")).toMatch(/GITRING_KEY/);
  });

  it("reads the share of tasks on the shared file and the tries of a task", () => {
    const res = prepare(["--project", "p", "--shared", "0", "--rounds", "8", "--yes"], ENV);
    expect(res.options).toMatchObject({ shared: 0, rounds: 8, agents: 10, tasks: 2 });
    expect(prepare(["--project", "p", "--yes"], ENV).options).toMatchObject({ shared: 30, rounds: 4 });
    expect(prepare(["--project", "p", "--shared", "101", "--yes"], ENV).code).toBe(2);
    expect(prepare(["--project", "p", "--rounds", "0", "--yes"], ENV).code).toBe(2);
    expect(prepare(["--project", "p", "--rounds", "21", "--yes"], ENV).code).toBe(2);
  });

  it("reads how long an agent waits for a merge (a project merges one change at a time)", () => {
    expect(prepare(["--project", "p", "--yes"], ENV).options?.wait).toBe(120);
    expect(prepare(["--project", "p", "--wait", "600", "--yes"], ENV).options?.wait).toBe(600);
    expect(prepare(["--project", "p", "--wait", "9", "--yes"], ENV).code).toBe(2);
    expect(prepare(["--project", "p", "--wait", String(LIMITS.wait + 1), "--yes"], ENV).code).toBe(2);
    expect(prepare(["--help"], ENV).lines.join("\n")).toMatch(/--wait S/);
  });

  it("lets the agents give way, unless --ignore-requests", () => {
    expect(prepare(["--project", "p", "--yes"], ENV).options?.giveWay).toBe(true);
    expect(prepare(["--project", "p", "--ignore-requests", "--yes"], ENV).options?.giveWay).toBe(false);
    expect(prepare(["--project", "p", "--yes", "--ignore-requests"], ENV).options?.giveWay).toBe(false);
    expect(prepare(["--help"], ENV).lines.join("\n")).toMatch(/--ignore-requests/);
  });

  it("prints a cost warning and does not run without --yes", () => {
    const res = prepare(["--project", "shop-1", "--agents", "20", "--tasks", "3"], ENV);
    expect(res.code).toBe(2);
    expect(res.options).toBeUndefined();
    const text = res.lines.join("\n");
    expect(text).toMatch(/costs money/);
    expect(text).toMatch(/Artifacts/);
    expect(text).toMatch(/Workers AI/);
    expect(text).toMatch(/test containers/);
    expect(text).toMatch(/--yes/);
    expect(text).toContain("20 agents with 3 tasks each");
  });

  it("never prints the key", () => {
    for (const argv of [[], ["--project", "p"], ["--project", "p", "--agents", "x"], ["--project", "p", "--agents", "5"], ["--help"], ["--bogus"]]) {
      expect(prepare(argv, ENV).lines.join("\n")).not.toContain(ENV.GITRING_KEY);
    }
    expect(prepare(["--project", "p", "--yes"], { ...ENV, GITRING_URL: "http://x.example.com" }).lines.join("\n")).not.toContain(ENV.GITRING_KEY);
  });

  it("runs with --yes and reads the options", () => {
    const res = prepare(["--project", "shop-1", "--agents=20", "--tasks", "3", "--seed", "7", "--yes"], ENV);
    expect(res.code).toBe(0);
    expect(res.options).toEqual({ project: "shop-1", agents: 20, tasks: 3, shared: 30, rounds: 4, wait: 120, giveWay: true, seed: 7 });
    expect(res.key).toBe(ENV.GITRING_KEY);
    expect(res.endpoint?.href).toBe("https://gitring.example.com/mcp");
    expect(prepare(["--project", "shop-1", "--yes"], ENV).options).toEqual({ project: "shop-1", agents: 10, tasks: 2, shared: 30, rounds: 4, wait: 120, giveWay: true, seed: 1 });
  });

  it("refuses numbers that are too large or not whole", () => {
    expect(prepare(["--project", "p", "--agents", String(LIMITS.agents + 1), "--yes"], ENV).code).toBe(2);
    expect(prepare(["--project", "p", "--tasks", "0", "--yes"], ENV).code).toBe(2);
    expect(prepare(["--project", "p", "--agents", "2.5", "--yes"], ENV).code).toBe(2);
    expect(prepare(["--project", "../x", "--yes"], ENV).code).toBe(2);
  });

  it("builds the MCP address from the address of gitring", () => {
    expect(endpointOf("https://a.example.com").href).toBe("https://a.example.com/mcp");
    expect(endpointOf("https://a.example.com/").href).toBe("https://a.example.com/mcp");
    expect(endpointOf("https://a.example.com/mcp").href).toBe("https://a.example.com/mcp");
    expect(endpointOf("https://a.example.com/base/?x=1#y").href).toBe("https://a.example.com/base/mcp");
    expect(() => endpointOf("http://a.example.com")).toThrow(/https/);
    expect(() => endpointOf(undefined)).toThrow(/GITRING_URL/);
  });

  it("allows http only for a copy on this computer", () => {
    expect(endpointOf("http://localhost:8787").href).toBe("http://localhost:8787/mcp");
    expect(endpointOf("http://127.0.0.1:8787/").href).toBe("http://127.0.0.1:8787/mcp");
    expect(endpointOf("http://[::1]:8787").href).toBe("http://[::1]:8787/mcp");
    expect(endpointOf("http://gitring.localhost:8787").href).toBe("http://gitring.localhost:8787/mcp");
    expect(() => endpointOf("http://localhost.example.com")).toThrow(/https/);
    expect(() => endpointOf("http://127.0.0.1.example.com")).toThrow(/https/);
  });
});

describe("answers of the tools", () => {
  it("finds change requests at the start of an answer", () => {
    const text = ["GITRING CHANGE REQUEST — apply it in your next edits, then call gitring_ack. Do not stop.", "- [c_1] (same lines; BOT-2 continues) Do not edit line 7.", "- [c_2] (main moved) Read the file again.", "", "Written: a.js.", "", "{", '  "written": ["a.js"]', "}"].join("\n");
    expect(changeRequestsIn(text)).toEqual([
      { id: "c_1", kind: "same lines; BOT-2 continues" },
      { id: "c_2", kind: "main moved" },
    ]);
    expect(changeRequestsIn("Written: a.js.\n\n- [x] (a) b")).toEqual([]);
    expect(lastJson(text)).toEqual({ written: ["a.js"] });
    expect(lastJson("no json here")).toBeUndefined();
  });
});

describe("report", () => {
  it("shows the counts and the time of each tool", () => {
    const m = new Metrics();
    for (let i = 1; i <= 10; i++) m.record("gitring_declare", i * 10);
    m.record("gitring_submit", 500);
    m.count("landed", 8);
    m.count("handed", 1);
    m.count("failed", 1);
    m.count("changeRequests", 4);
    m.count("rateLimited", 2);
    m.count("toolErrors", 3);
    const lines = formatReport(m, { totalMs: 12_345, project: "shop-1", agents: 5, tasks: 2, seed: 1 });
    const text = lines.join("\n");
    expect(text).toContain("Load test finished in 12.3 s.");
    expect(text).toContain("Tasks: 8 landed, 1 handed to a person, 1 failed.");
    expect(text).toContain("Change requests: 4.");
    expect(text).toContain("An agent waits at most 120 s for a merge.");
    expect(text, "no word about giving way when the run did not say").not.toMatch(/gave way|give way/);
    expect(text).toContain("Tool errors: 3. Protocol errors: 0. Answers with status 429: 2.");
    expect(lines.find((l) => l.startsWith("gitring_declare"))!.trim().split(/\s+/)).toEqual(["gitring_declare", "10", "50", "100", "100"]);
    expect(lines.find((l) => l.startsWith("gitring_submit"))!.trim().split(/\s+/)).toEqual(["gitring_submit", "1", "500", "500", "500"]);
    expect(text).not.toContain("protocol errors. The exit code");
  });

  it("tells the tasks that a built-in agent took over", () => {
    const m = new Metrics();
    m.count("landed", 5);
    m.count("redone", 2);
    m.count("failed", 1);
    const text = formatReport(m, { totalMs: 1000, project: "p", agents: 2, tasks: 4, seed: 1 }).join("\n");
    expect(text).toContain("Tasks: 5 landed, 0 handed to a person, 2 given to a built-in agent after the tries of the agent were used, 1 failed.");
  });

  it("says whether the agents gave way", () => {
    const m = new Metrics();
    m.count("changeRequests", 9);
    m.count("gaveWay", 3);
    const info = { totalMs: 1000, project: "p", agents: 2, tasks: 1, seed: 1 };
    expect(formatReport(m, { ...info, giveWay: true }).join("\n")).toContain("Change requests: 9. Agents gave way 3 times: they waited for the agent that continues.");
    expect(formatReport(m, { ...info, giveWay: false }).join("\n")).toContain("The agents did not give way: they confirmed the change requests and went on.");
  });

  it("exits with 1 after any protocol error, and with 0 otherwise", () => {
    const m = new Metrics();
    expect(exitCode(m.counts)).toBe(0);
    m.count("toolErrors", 5);
    m.count("rateLimited", 5);
    expect(exitCode(m.counts)).toBe(0);
    m.count("protocolErrors");
    m.note("gitring_declare: connection reset");
    expect(exitCode(m.counts)).toBe(1);
    const text = formatReport(m, { totalMs: 1000, project: "p", agents: 1, tasks: 1, seed: 1 }).join("\n");
    expect(text).toContain("connection reset");
    expect(text).toContain("The exit code is 1.");
  });
});
