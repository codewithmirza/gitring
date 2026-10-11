/** Smoke test of the coordination benchmark (bench/coordination.ts): a small world, quick. */
import { describe, expect, it } from "vitest";
import { ADAPT_P, formatGrowth, formatRow, growth, HEADLINE, parseArgs, runBench } from "../../bench/coordination";

const counts = (r: ReturnType<typeof runBench>) => ({ landings: r.landings, without: r.conflictsWithout, with: r.conflictsWith, checks: r.checks, corrections: r.corrections, replots: r.replots });

describe("coordination benchmark", () => {
  it("says what it measures in its first line", () => {
    expect(HEADLINE).toBe("Coordination logic only. No network, no Artifacts, no AI. It shows how many landing conflicts the plan check avoids and how long the pure check takes.");
  });

  it("lands every agent, and the plan check avoids landing conflicts", () => {
    const row = runBench({ agents: 600, sectors: 3, seed: 5 });
    expect(row.landings).toBe(600);
    expect(row.conflictsWithout).toBeGreaterThan(20);
    expect(row.conflictsWith).toBeLessThan(row.conflictsWithout / 2);
    expect(row.checks).toBeGreaterThan(0);
    expect(row.corrections).toBeGreaterThan(0);
    expect(row.checksPerSecond).toBeGreaterThan(0);
  });

  it("gives the same counts for the same seed, and other counts for another seed", () => {
    const opts = { agents: 400, sectors: 2, seed: 9 };
    expect(counts(runBench(opts))).toEqual(counts(runBench(opts)));
    expect(counts(runBench({ ...opts, seed: 10 }))).not.toEqual(counts(runBench(opts)));
  });

  it("shares the agents among the sectors", () => {
    const row = runBench({ agents: 7, sectors: 3, seed: 1 });
    expect(row.landings).toBe(7);
  });

  it("shows that one course check costs more when more plans are active", () => {
    const rows = growth([100, 800], 1, 6);
    expect(rows.map((r) => r.others)).toEqual([100, 800]);
    expect(rows[1].allPlansUs).toBeGreaterThan(rows[0].allPlansUs);
    for (const r of rows) {
      expect(r.allPlansUs).toBeGreaterThan(0);
      expect(r.indexedUs).toBeGreaterThan(0);
    }
    expect(formatGrowth(rows)).toHaveLength(3);
  });

  it("reads the options and prints a small table", () => {
    expect(parseArgs([])).toEqual({ agents: 100_000, sectors: 100, seed: 1 });
    expect(parseArgs(["--agents", "500", "--seed=3", "--sectors", "5"])).toEqual({ agents: 500, sectors: 5, seed: 3 });
    expect(parseArgs(["--agents", "3", "--sectors", "10"]).sectors).toBe(3);
    expect(() => parseArgs(["--agents", "many"])).toThrow(/whole number/);
    expect(() => parseArgs(["--speed", "3"])).toThrow(/Unknown option/);
    const lines = formatRow(runBench({ agents: 50, sectors: 1, seed: 1 }));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("conflicts without");
    expect(ADAPT_P).toBeGreaterThan(0.9);
  });
});
