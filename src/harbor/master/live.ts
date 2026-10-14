/**
 * Gives the whole state of the project to the app and closes live connections when access changes.
 * Layer 5 of the chain in master/README.md. Extends HarborWorkViews (work-views.ts).
 * The WebSocket entry points that Cloudflare calls are on HarborMaster in harbor.ts.
 * Read next: tasks.ts.
 */
import type * as T from "../../core/types";
import { median } from "../views";
import { HarborWorkViews } from "./work-views";

export abstract class HarborLive extends HarborWorkViews {
  async state(): Promise<T.ProjectState> {
    const project = this.requireProject();
    const main = project.mainTree ? await this.loadMain() : { files: [], imports: [] as [string, string][] };
    return {
      project,
      intents: [...this.intents.values()],
      attempts: [...this.attempts.values()],
      agents: [...this.agents.values()],
      corrections: [...this.corrections.values()],
      checks: this.checks.slice(-200),
      landings: this.landings,
      decisions: this.decisions,
      questions: this.questionList(),
      logs: this.logs.slice(-400),
      radar: [...this.radar.values()],
      files: main.files,
      imports: main.imports,
      stats: { ...this.stats, medianCheckLatencyMs: median(this.checkLatencies) },
    };
  }

  /**
   * Access changed: close the live connections that it concerns, so that each one connects again and
   * gets its role checked (a removed member, a signed-out person, a project that became private or
   * archived). The close code tells the browser what to do: 4401 sign in, 4403 the access changed.
   */
  async closeSockets(who: { userId?: string; viewers?: boolean; all?: boolean }, code: 4401 | 4403 = 4403): Promise<number> {
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      const hit = who.all || (who.userId && tags.includes(`u:${who.userId}`)) || (who.viewers && tags.includes("viewer"));
      if (!hit) continue;
      try {
        ws.close(code, code === 4401 ? "Sign in again." : "Your access to this project changed.");
        n++;
      } catch {
        /* already closed */
      }
    }
    return n;
  }
}
