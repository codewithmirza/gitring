/** A check container's result becomes a CheckRun that agents and the UI read. */
import { describe, expect, it } from "vitest";
import { containerRun, rankForBrief } from "../../src/harbor/harbor";
import type { DrydockResult } from "../../src/drydock/drydock";
import type { Intent } from "../../src/core/types";

const base: DrydockResult = { ok: true, stage: "done", exitCode: 0, installMs: 1200, testMs: 800, reused: false, log: "ok 1 - adds\n" };
const o = { key: "k1", scope: "attempt" as const, cs: { runner: "container" as const }, ms: 2100 };

describe("containerRun", () => {
  it("passes with an install case and a test case", () => {
    const run = containerRun(base, o);
    expect(run).toMatchObject({ ok: true, passed: 2, failed: 0, runner: "container", scope: "attempt", subject: "k1" });
    expect(run.cases.map((c) => [c.file, c.name, c.ok])).toEqual([
      ["install", "npm ci (or npm install)", true],
      ["test", "npm test", true],
    ]);
  });

  it("puts the end of the output into the failing case", () => {
    const run = containerRun({ ...base, ok: false, stage: "test", exitCode: 1, log: `${"x".repeat(5000)}\nnot ok 2 - divides by zero` }, { ...o, cs: { runner: "container", test: "node --test" } });
    expect(run.ok).toBe(false);
    expect(run.failed).toBe(1);
    const t = run.cases.find((c) => c.file === "test")!;
    expect(t.name).toBe("node --test");
    expect(t.error).toContain("not ok 2 - divides by zero");
    expect(t.error!.length).toBeLessThanOrEqual(3001);
  });

  it("reports install failures, a missing test command and timeouts", () => {
    const inst = containerRun({ ...base, ok: false, stage: "install", exitCode: 91, log: "npm ERR! 404 left-pad" }, o);
    expect(inst.cases).toHaveLength(1);
    expect(inst.cases[0]).toMatchObject({ file: "install", ok: false });
    const none = containerRun({ ...base, ok: false, stage: "no-test", exitCode: 92 }, o);
    expect(none.error).toMatch(/No test command/);
    expect(none.failed).toBe(1);
    const slow = containerRun({ ...base, ok: false, stage: "timeout", exitCode: 124 }, { ...o, cs: { runner: "container", timeoutSec: 90 } });
    expect(slow.error).toMatch(/more than 90 s/);
    const dead = containerRun({ ...base, ok: false, stage: "start", exitCode: -1, log: "no capacity" }, o);
    expect(dead.cases).toHaveLength(0);
    expect(dead.error).toContain("no capacity");
  });
});

describe("rankForBrief", () => {
  it("puts course files, the manifest and files named like the intent first", () => {
    const files = new Map([
      ["a/zzz.js", "x"],
      ["dist/app.min.js", "x"],
      ["package.json", "{}"],
      ["src/cart/checkout.ts", "x"],
      ["src/search/index.ts", "x"],
      ["docs/intro.md", "x"],
    ]);
    const intent = { title: "Search by author", goal: "Find books by author in the search box." } as Intent;
    const order = rankForBrief(files, intent, new Set(["src/cart/checkout.ts"])).map(([p]) => p);
    expect(order[0]).toBe("src/cart/checkout.ts");
    expect(order.indexOf("package.json")).toBeLessThan(order.indexOf("docs/intro.md"));
    expect(order.indexOf("src/search/index.ts")).toBeLessThan(order.indexOf("a/zzz.js"));
    expect(order.at(-1)).toBe("dist/app.min.js");
  });
});
