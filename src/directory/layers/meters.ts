/**
 * Counters of use for each project and month, and the rolling one-hour budgets of built-in agents and test runs.
 *
 * A counter never throws: a counter must not stop a merge or a test. Nothing here charges anyone.
 */
import { HOUR } from "../constants";
import { DirectoryStore } from "./store";

export abstract class DirectoryMeters extends DirectoryStore {
  // ───── Counters of use ─────

  /** Add to a counter of a project for this month. Never throws: a counter must not stop a merge or a test. */
  usageAdd(projectId: string, kind: "merges" | "testRuns" | "agentTokens", n = 1): void {
    try {
      const amount = Math.max(0, Math.min(1e9, Math.round(Number(n) || 0)));
      if (!amount || !projectId) return;
      const col = kind === "merges" ? "merges" : kind === "testRuns" ? "test_runs" : "agent_tokens";
      const month = new Date().toISOString().slice(0, 7);
      this.sql.exec(`INSERT INTO usage (project_id, month, ${col}) VALUES (?, ?, ?) ON CONFLICT (project_id, month) DO UPDATE SET ${col} = ${col} + excluded.${col}`, projectId, month, amount);
    } catch {
      /* a counter is never worth a failure */
    }
  }

  usageOf(projectId: string, month = new Date().toISOString().slice(0, 7)): { month: string; merges: number; testRuns: number; agentTokens: number } {
    const r = this.sql.exec<{ merges: number; test_runs: number; agent_tokens: number }>("SELECT merges, test_runs, agent_tokens FROM usage WHERE project_id = ? AND month = ?", projectId, month).toArray()[0];
    return { month, merges: r?.merges ?? 0, testRuns: r?.test_runs ?? 0, agentTokens: r?.agent_tokens ?? 0 };
  }

  // ───── Budgets of one hour ─────

  /**
   * Take up to n units from rolling one-hour windows: one per person (perUser) and one for the
   * deployment (global). Pools: "ai" (built-in agent starts) and "checks" (container check runs).
   * Returns how many it granted and when the next slot frees.
   */
  async budgetTake(owner: string | null, n: number, perUser: number, global: number, pool: "ai" | "checks" = "ai"): Promise<{ granted: number; retryAt: number }> {
    const now = Date.now();
    const key = (k: string) => (pool === "ai" ? k : `${pool}:${k}`);
    const read = (k: string) =>
      (JSON.parse(this.sql.exec<{ starts: string }>("SELECT starts FROM budgets WHERE owner = ?", key(k)).toArray()[0]?.starts ?? "[]") as number[])
        .filter((t) => now - t < HOUR)
        .sort((a, b) => a - b);
    const g = read("*");
    const u = owner ? read(owner) : [];
    const count = Math.max(0, Math.min(16, Math.round(Number(n) || 0)));
    const room = Math.min(global - g.length, owner ? perUser - u.length : Number.POSITIVE_INFINITY);
    const granted = Math.max(0, Math.min(count, room));
    const stamps = Array.from({ length: granted }, () => now);
    const g2 = [...g, ...stamps];
    const u2 = [...u, ...stamps];
    this.sql.exec("INSERT OR REPLACE INTO budgets (owner, starts) VALUES (?, ?)", key("*"), JSON.stringify(g2));
    if (owner) this.sql.exec("INSERT OR REPLACE INTO budgets (owner, starts) VALUES (?, ?)", key(owner), JSON.stringify(u2));
    const frees = [g2.length >= global ? g2[0] + HOUR : 0, owner && u2.length >= perUser ? u2[0] + HOUR : 0];
    const retryAt = Math.max(now + 1000, ...frees) + 1000;
    return { granted, retryAt };
  }
}
