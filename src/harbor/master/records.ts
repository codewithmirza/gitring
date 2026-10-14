/**
 * Saves tasks, work copies, change requests and questions, and tells people, webhooks and waiting agents.
 * Layer 2 of the chain in master/README.md. Extends HarborState (state.ts).
 * Every change of a record goes through a put method of this layer. Never write to the database around it.
 * Read next: files.ts.
 */
import type * as T from "../../core/types";
import { unseal } from "../../directory/crypto";
import { pushKeys } from "../../worker/push";
import { taskPath } from "../../core/inbox";
import { newId } from "../ids";
import { deliverWebhook, SECRET_SEAL } from "../webhooks";
import { ACTIVE, median } from "../views";
import { forViewer } from "../support/access";
import { MAX_LOGS, TERMINAL } from "../support/constants";
import { closedBecause, errorLine } from "../support/helpers";
import { approvalWord, requestEvent, slackText, statusEvent } from "../support/words";
import { HarborState } from "./state";

export abstract class HarborRecords extends HarborState {
  // ───── Events, logs and stats ─────

  protected emit(ev: T.GitringEvent): void {
    this.outbox.push(ev);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => this.flush(), 0);
  }

  protected flush(): void {
    this.flushScheduled = false;
    if (!this.outbox.length) return;
    const batch = this.outbox;
    this.outbox = [];
    const data = JSON.stringify(batch.length === 1 ? batch[0] : batch);
    // Viewers (people who only watch a public project) do not get member-only data: every event goes
    // through forViewer, the one place that decides what they see.
    const viewerBatch = batch.map(forViewer);
    const viewerData = viewerBatch.every((e, i) => e === batch[i]) ? data : JSON.stringify(viewerBatch.length === 1 ? viewerBatch[0] : viewerBatch);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(this.ctx.getTags(ws).includes("viewer") ? viewerData : data);
      } catch {
        /* closed socket */
      }
    }
  }

  protected addLog(entry: Omit<T.LogEntry, "id" | "at"> & { at?: number }): T.LogEntry {
    const log: T.LogEntry = { id: `lg_${++this.seq}`, at: entry.at ?? Date.now(), ...entry } as T.LogEntry;
    this.logs.push(log);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.db.appendLog(log);
    this.db.setMeta("seq", this.seq);
    this.emit({ type: "log", log });
    return log;
  }

  protected persistStats(): void {
    this.stats.medianCheckLatencyMs = median(this.checkLatencies);
    this.db.setMeta("stats", this.stats);
    this.db.setMeta("latencies", this.checkLatencies.slice(-200));
    this.emit({ type: "stats", stats: { ...this.stats } });
  }

  // ───── Saving records ─────

  protected putIntent(i: T.Intent): void {
    i.updatedAt = Date.now();
    this.intents.set(i.id, i);
    this.db.putIntent(i);
    this.emit({ type: "intent", intent: i });
    // A task that does not wait for a person any more: its open redo question has no use.
    if (i.status !== "judging") this.closeRedoQuestions(i.id, "A person or an agent acted on the task.");
  }

  protected putAttempt(a: T.Attempt): void {
    // An approval waits only while the work copy is "ready". In any other state no answer can come.
    if (a.approval?.status === "waiting" && a.status !== "ready") this.closeApproval(a, closedBecause(a.status));
    a.updatedAt = Date.now();
    this.attempts.set(a.id, a);
    this.db.putAttempt(a);
    this.emit({ type: "attempt", attempt: a });
    this.wakeOnChange(a);
    if (TERMINAL.has(a.status)) this.closeQuestionsOf(a);
  }

  protected putAgent(g: T.AgentInfo): void {
    this.agents.set(g.id, g);
    this.db.putAgent(g);
    this.emit({ type: "agent", agent: g });
  }

  protected putCorrection(c: T.Correction): void {
    this.corrections.set(c.id, c);
    this.db.putCorrection(c);
    this.emit({ type: "correction", correction: c });
    if (c.status === "pending") this.wake(c.attemptId, requestEvent(c.id, c.kind));
  }

  protected putQuestion(q: T.Question): void {
    q.updatedAt = Date.now();
    this.questions.set(q.id, q);
    this.db.putQuestion(q);
    this.emit({ type: "question", question: q });
  }

  protected recordDecision(d: Omit<T.Decision, "id" | "at">): T.Decision {
    const decision: T.Decision = { id: newId("dc"), at: Date.now(), ...d };
    this.decisions.push(decision);
    this.db.putDecision(decision);
    this.emit({ type: "decision", decision });
    if (d.by.kind === "human") this.webhook("decision", { decision });
    return decision;
  }

  /** Open questions, and the latest 50 answered or closed ones. Oldest first. */
  protected questionList(): T.Question[] {
    const all = [...this.questions.values()].sort((a, b) => a.askedAt - b.askedAt);
    const done = new Set(all.filter((q) => q.status !== "open").slice(-50));
    return all.filter((q) => q.status === "open" || done.has(q));
  }

  // ───── Reactions to a change ─────

  /** A question that cannot be answered any more: the agent changed the work, or the work copy closed. */
  protected closeApproval(a: T.Attempt, why: string): void {
    const ap = a.approval;
    if (!ap || ap.status !== "waiting") return;
    a.approval = { ...ap, status: "withdrawn", closed: why };
    this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The question about the work of ${this.callsign(a.id)} closes. ${why}` });
    this.refreshJudging(a.intentId);
  }

  /** A task that waits for a decision, but has no work left that waits: it is in work (or open) again. */
  protected refreshJudging(intentId: string): void {
    const intent = this.intents.get(intentId);
    if (!intent || intent.status !== "judging") return;
    const mine = [...this.attempts.values()].filter((x) => x.intentId === intentId);
    if (mine.some((x) => x.status === "ready")) return;
    intent.status = mine.some((x) => ACTIVE.has(x.status)) ? "underway" : "open";
    this.putIntent(intent);
  }

  /**
   * The escalation questions of a work copy that closed have no use: nobody can adapt now. A note of the
   * steward closes when every work copy it names closed: the anomaly is over.
   */
  protected closeQuestionsOf(a: T.Attempt): void {
    for (const q of this.questions.values()) {
      if (q.status !== "open" || !q.attemptIds.includes(a.id)) continue;
      if (q.kind === "escalation") this.putQuestion({ ...q, status: "closed", closed: `The work of ${this.callsign(a.id) ?? "an agent"} closed. ${closedBecause(a.status)}` });
      else if (q.kind === "steward" && q.attemptIds.every((id) => id === a.id || TERMINAL.has(this.attempts.get(id)?.status as T.AttemptStatus))) {
        this.putQuestion({ ...q, status: "closed", closed: "The work of this note closed." });
      }
    }
  }

  protected closeRedoQuestions(intentId: string, why: string): void {
    for (const q of this.questions.values()) {
      if (q.status === "open" && (q.kind === "redo" || q.kind === "revert") && q.intentId === intentId) this.putQuestion({ ...q, status: "closed", closed: why });
    }
  }

  /** Any tool call of the agent on its work copy is an answer: the work no longer waits for it. */
  protected heard(a: T.Attempt): void {
    if (!a.returned) return;
    a.returned = undefined;
    this.putAttempt(a);
  }

  // ───── Waking the agents that wait ─────

  protected wake(attemptId: string, ev: T.WaitEvent): void {
    for (const on of [...(this.waiters.get(attemptId) ?? [])]) on(ev);
  }

  protected wakeAll(ev: T.WaitEvent): void {
    for (const id of [...this.waiters.keys()]) this.wake(id, ev);
  }

  /** A new status or a new state of the approval wakes the agents that wait on the work copy. */
  protected wakeOnChange(a: T.Attempt): void {
    const seen = this.waitSeen.get(a.id);
    if (!seen) return;
    const approval = a.approval?.status;
    if (seen.status !== a.status) this.wake(a.id, statusEvent(a.status));
    if (approval && seen.approval !== approval) this.wake(a.id, { kind: "approval", at: Date.now(), approval, message: approvalWord(a) });
    seen.status = a.status;
    seen.approval = approval;
  }

  // ───── Webhooks, push and usage counters ─────

  /**
   * Send an event to the webhooks that want it. Each request is signed with the secret of its webhook
   * (gitring-signature) and gets 3 more tries on a server or network error. The delivery runs in the
   * background: a slow webhook never holds a merge.
   */
  protected webhook(event: string, payload: Record<string, unknown>): void {
    const targets = this.project?.settings.webhooks.filter((w) => w.enabled && (w.events as string[]).includes(event)) ?? [];
    for (const w of targets) {
      const body =
        w.format === "slack"
          ? { text: slackText(event, payload) }
          : { event, project: this.project?.id, at: new Date().toISOString(), ...payload };
      this.ctx.waitUntil(
        (async () => {
          const res = await deliverWebhook(w.url, JSON.stringify(body), await this.webhookSecret(w.id));
          if (!res.ok) console.warn("webhook failed", w.url, res.status ?? res.error, `${res.tries} tries`);
        })().catch((e) => console.warn("webhook failed", w.url, String(e))),
      );
    }
  }

  /** The signing secret of a webhook (undefined: a webhook from before signatures, or no key to open it). */
  protected async webhookSecret(id: string): Promise<string | undefined> {
    const sealed = this.db.getMeta<Record<string, string>>("webhookSecrets")?.[id];
    const key = this.env.GITRING_SECRET;
    if (!sealed || !key) return undefined;
    return unseal<string>(key, sealed, SECRET_SEAL).catch(() => undefined);
  }

  /** The address of a question in the gitring app: the task, where the decision list shows it. */
  protected questionLink(q: T.Question): string {
    const path = taskPath(this.requireProject().id, q.intentId);
    const origin = this.db.getMeta<string>("origin");
    return origin ? `${origin}${path}` : path;
  }

  /** A new question is in the inbox of the people who may answer: tell the webhooks and the devices of those people. */
  protected questionAsked(q: T.Question): void {
    const intent = this.intents.get(q.intentId);
    this.webhook("question", { question: q, task: intent?.title ?? "", link: this.questionLink(q) });
    const senders = q.attemptIds.map((id) => this.attempts.get(id)?.sender?.id).filter((x): x is string => Boolean(x));
    this.notifyPeople([...new Set(senders)], "question");
  }

  /**
   * A push notification (without content) to the devices of the people who answer: the senders, or every person
   * who may answer when no person sent the work. The Directory knows the people and their devices. Without
   * the push keys of the deployment, nothing goes out.
   */
  protected notifyPeople(users: string[], kind: "approval" | "question", ownerOnly = false): void {
    const p = this.project;
    // Push is off without the keys of the deployment: no call to the Directory then.
    if (!p || !this.env.DIRECTORY || !pushKeys(this.env)) return;
    const need = p.settings.approver === "owner" || ownerOnly ? "owner" : "member";
    const send = (async () => this.directory().pushInbox(p.id, { users: need === "owner" ? [] : users, need, kind }))();
    this.ctx.waitUntil(send.then(() => undefined).catch((e) => console.warn("push failed", errorLine(e))));
  }

  /** Metering hook: add to a counter of use of this project (merges, container test runs). A counter never stops work. */
  protected countUse(kind: "merges" | "testRuns" | "agentTokens", n = 1): void {
    const id = this.project?.id;
    if (!id) return;
    try {
      void Promise.resolve(this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory")).usageAdd(id, kind, n)).catch(() => undefined);
    } catch {
      /* a counter that fails never stops the work */
    }
  }
}
