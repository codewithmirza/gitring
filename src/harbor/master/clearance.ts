/**
 * Builds what an agent sees about the other work: the traffic list and the check result with its change requests.
 * Layer 8 of the chain in master/README.md. Extends HarborImport (import.ts).
 * Reading the check result takes the new change requests of one agent. Call it only for the agent that owns them.
 * Read next: corrections.ts.
 */
import type * as T from "../../core/types";
import { type VesselView } from "../../core/coord";
import { ACTIVE, WAITING, adviceFor, clearance, latestCheck, notices, trafficVessel, vesselView, type AttemptView, type MainView } from "../views";
import { TERMINAL } from "../support/constants";
import { pairKey } from "../support/helpers";
import { HarborImport } from "./import";

export abstract class HarborClearance extends HarborImport {
  // ───── Traffic ─────

  async openIntents(): Promise<{ intents: { id: string; title: string; goal: string; status: T.IntentStatus; attempts: number; checks: string[] }[]; traffic: number }> {
    await this.ensure(this.project?.id);
    const active = [...this.attempts.values()].filter((a) => ACTIVE.has(a.status));
    return {
      intents: [...this.intents.values()]
        .filter((i) => !["landed", "parked", "merged-into"].includes(i.status))
        .map((i) => ({
          id: i.id,
          title: i.title,
          goal: i.goal,
          status: i.status,
          attempts: active.filter((a) => a.intentId === i.id).length,
          checks: i.checks.map((c) => c.path),
        })),
      traffic: active.length,
    };
  }

  protected trafficFor(a: T.Attempt): T.TrafficVessel[] {
    const out: T.TrafficVessel[] = [];
    for (const other of this.attempts.values()) {
      if (other.id === a.id || !ACTIVE.has(other.status)) continue;
      const pair = this.radar.get(pairKey(a.id, other.id));
      const range = (pair?.range ?? 5) as T.Range;
      if (range > 3) continue;
      const logs = this.logs.filter((l) => l.attemptId === other.id && (l.kind === "log" || l.kind === "write" || l.kind === "declare"));
      out.push(trafficVessel(other, this.intents.get(other.intentId), this.agents.get(other.agentId), logs, range, pair?.closing ?? false));
    }
    return out.sort((x, y) => x.range - y.range);
  }

  protected trafficViews(incoming: T.Attempt, main: MainView, signatures: Map<string, AttemptView>): VesselView[] {
    const baseIdx = this.mainPlace(incoming.baseSha);
    const views: VesselView[] = [];
    for (const other of this.attempts.values()) {
      if (other.id === incoming.id) continue;
      const intent = this.intents.get(other.intentId);
      const agent = this.agents.get(other.agentId);
      if (!intent || !agent) continue;
      let state: VesselView["state"] | undefined;
      if (ACTIVE.has(other.status)) state = WAITING.has(other.status) ? "waiting" : "active";
      else if (other.status === "landed") {
        const landing = this.landings.find((l) => l.attemptId === other.id);
        if (landing && this.mainPlace(landing.mainAfter) > baseIdx) state = "landed";
      }
      if (!state) continue;
      views.push(vesselView(other, intent, agent, signatures.get(other.id)?.signatures, main.signatures, state, main.definedIn));
    }
    return views;
  }

  // ───── The check result ─────

  /**
   * Clearance for an agent: deliver pending corrections once (piggyback). `deliver: false` (a caller that did
   * not send the agent): the verdict and the traffic, and the change requests stay for the agent.
   */
  protected clearanceFor(attemptId: string, deliver = true): T.Clearance {
    const a = this.mustAttempt(attemptId);
    const pending = deliver ? a.corrections.map((id) => this.corrections.get(id)).filter((c): c is T.Correction => !!c && c.status === "pending") : [];
    const now = Date.now();
    for (const c of pending) {
      c.status = "delivered";
      c.deliveredAt = now;
      this.putCorrection(c);
    }
    // A check names a pair, and "correct" means that one agent of the pair changes course. The agent that
    // keeps its lines has no change request: its answer says "clear", and not "change request".
    const open = a.corrections.some((id) => {
      const c = this.corrections.get(id);
      return c?.status === "pending" || c?.status === "delivered";
    });
    const checked = latestCheck(this.checks, attemptId)?.verdict;
    const verdict = checked === "correct" && !open ? "clear" : checked;
    return this.withQuestions(a, clearance(verdict, notices(pending, (id) => this.callsign(id)), this.trafficFor(a)));
  }

  /** Both agents of an escalated pair read that a person decides, and that they continue. */
  protected withQuestions(a: T.Attempt, clr: T.Clearance): T.Clearance {
    const q = [...this.questions.values()].find((x) => x.status === "open" && x.kind === "escalation" && x.attemptIds.includes(a.id));
    if (!q) return clr;
    const otherId = q.attemptIds.find((id) => id !== a.id);
    const words = `A person decides how your work and the work of ${this.callsign(otherId) ?? "another agent"} fit together. Continue your work. If your work must change, gitring sends a change request.`;
    return { ...clr, advice: clr.verdict === "escalate" && !clr.corrections.length ? words : `${clr.advice} ${words}` };
  }

  /**
   * The change requests of an earlier answer in the same tool call (see CallInfo.again) that the agent did
   * not confirm yet: the last answer of the call holds them again, so they are never lost.
   */
  protected withAgain(a: T.Attempt, clr: T.Clearance, again?: string[]): T.Clearance {
    if (!again?.length) return clr;
    const have = new Set(clr.corrections.map((c) => c.id));
    const extra = again.map((id) => this.corrections.get(id)).filter((c): c is T.Correction => !!c && c.attemptId === a.id && c.status === "delivered" && !have.has(c.id));
    if (!extra.length) return clr;
    const corrections = [...notices(extra, (id) => this.callsign(id)), ...clr.corrections];
    return this.withQuestions(a, { ...clr, corrections, advice: adviceFor(clr.verdict, corrections.length, clr.traffic) });
  }

  /** "Open change requests of a_1: cr_1, cr_2." or "Work copy a_1 has no open change request." */
  protected openRequestsLine(a: T.Attempt): string {
    const open = a.corrections.filter((id) => {
      const s = this.corrections.get(id)?.status;
      return s === "pending" || s === "delivered";
    });
    return open.length ? `Open change requests of ${a.id}: ${open.join(", ")}.` : `Work copy ${a.id} has no open change request.`;
  }

  /** What an agent reads when its work copy is over without a merge, or merged: what to do next. */
  protected overAdvice(a: T.Attempt): string {
    if (a.status === "landed") return "The work is in main. Send a new plan with gitring_declare for another change.";
    const redo = [...this.attempts.values()].find((x) => x.lineage.rederivedFrom === a.id && !TERMINAL.has(x.status));
    if (redo) return `gitring does the task again as ${redo.id}. Stop work on ${a.id}.`;
    if (a.status === "alternate") return "Another work copy of this task is merged. Stop work on this copy.";
    if (a.status === "stale" && a.stoppedFor) return `${a.stoppedFor} A person decides what happens next. Stop work on ${a.id}.`;
    return "Send a new plan with gitring_declare to continue.";
  }
}
