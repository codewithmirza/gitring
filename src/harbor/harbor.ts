/**
 * The project coordinator (HarborMaster): one Durable Object for each project, and the front door of master/.
 * HarborMaster is the last layer of the chain in master/README.md. It holds the entry points that Cloudflare calls.
 * It is the single writer of main, the conflict-check authority, the merge queue and the live event source.
 * Agents use one protocol: declare a plan, write, check, submit. Change requests ride in every answer.
 * Never add logic here. Add a method to the layer that has its job. Keep the export name: wrangler.jsonc binds it.
 * Read next: master/README.md.
 */
import type * as T from "../core/types";
import { forViewer } from "./support/access";
import { BUILD_ID, TERMINAL } from "./support/constants";
import { HarborAgentChannel } from "./master/agent-channel";

export { gitPullCommand, hookKey, viewerState } from "./support/access";
export { rankForBrief } from "./support/brief-rank";
export { BUILD_ID } from "./support/constants";
export { budgetWait, containerRun } from "./support/container-run";
export { seedChanges } from "./support/seed";
export type { SeedFile } from "./support/seed";
export type { Brief, CallInfo, LaunchInput } from "./support/types";

export class HarborMaster extends HarborAgentChannel {
  // ───── Entry points that Cloudflare calls ─────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const projectId = url.searchParams.get("project") ?? "";
      await this.ensure(projectId);
      // The Worker checked the role and says it here (only the Worker can reach this object). The tags
      // name the role and the person, so that a change of access closes the right sockets.
      const viewer = url.searchParams.get("role") === "viewer";
      const user = url.searchParams.get("user") ?? "";
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, [viewer ? "viewer" : "member", user ? `u:${user}` : "anon"]);
      const snapshot: T.GitringEvent = { type: "snapshot", state: await this.state() };
      server.send(JSON.stringify(viewer ? forViewer(snapshot) : snapshot));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "bye");
    } catch {
      /* already closed */
    }
  }

  /** Alarm: finish an import, start the built-in agents that waited for the AI budget, then run the merge queue. */
  async alarm(): Promise<void> {
    if (!this.project) return;
    if (this.project.importing) {
      await this.continueImport();
      if (this.project.importing) return;
    }
    const waiting = () => [...this.attempts.values()].filter((a) => a.waitsForBudget && !TERMINAL.has(a.status)).sort((a, b) => a.createdAt - b.createdAt);
    const due = waiting().filter((a) => (a.waitsForBudget ?? 0) <= Date.now());
    if (due.length) {
      const budget = await this.takeLlmBudget(due.length);
      for (let i = 0; i < due.length; i++) {
        const a = due[i];
        const agent = this.agents.get(a.agentId);
        if (i < budget.granted && agent) {
          a.waitsForBudget = undefined;
          this.putAttempt(a);
          agent.status = "underway";
          this.putAgent(agent);
          await this.startVessel(a, agent, a.lineage.rederivedFrom);
          this.addLog({ kind: "system", attemptId: a.id, agentId: agent.id, intentId: a.intentId, message: `${agent.callsign} starts: the AI budget has room again.` });
        } else {
          a.waitsForBudget = budget.retryAt;
          this.putAttempt(a);
        }
      }
    }
    for (const a of [...this.attempts.values()]) {
      if (a.returned && a.returned.until <= Date.now() && !TERMINAL.has(a.status)) await this.returnTimedOut(a);
    }
    // The merge queue: queued work copies run, and a merge that a stopped object began starts again.
    await this.driveQueue();
    // The steward: every few minutes while agents work, count the facts and put a new finding in the inbox.
    await this.stewardSweep();
    // Post-merge test mode: a main that its tests did not see yet (the test budget was used) is tested now.
    if (this.mainTestsDue()) this.scheduleMainTests();
    const next = this.nextWake();
    if (next !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }

  async version(): Promise<string> {
    return BUILD_ID;
  }
}
