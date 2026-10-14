/**
 * What people decide: merge work, send it back, answer a question, change the goal, and send a change request.
 * Layer 23 of the chain in master/README.md. Extends HarborSubmit (submit.ts).
 * A person answers each question once. The same answer again changes nothing.
 * Read next: settings.ts.
 */
import type * as T from "../../core/types";
import { approvalLine, canDecide } from "../../core/approvals";
import { canAnswerQuestion, inboxOf, type InboxItem } from "../../core/inbox";
import { atLeast, type Role } from "../../core/accounts";
import { draftIntentAmendedCorrection } from "../../core/coord";
import { ACTIVE, failureSummary, vesselView } from "../views";
import { TERMINAL } from "../support/constants";
import { HUMAN } from "../support/helpers";
import { METHOD_WORD, copyStatusWord } from "../support/words";
import { HarborSubmit } from "./submit";

// ───── Types ─────

/** The person who answers, with the role that the Worker checked. */
type Who = { id: string; name: string; role: Role };

/** The result of an answer to a question about a work copy. */
type ApprovalOut = (outcome: T.ApprovalResult["outcome"], message: string, extra?: Partial<T.ApprovalResult>) => T.ApprovalResult;

/** What an answer to the approval of a work copy knows, for the steps that follow the checks. */
interface Answering {
  a: T.Attempt;
  ap: T.Approval;
  intent: T.Intent;
  who: Who;
  by: T.Actor;
  note: string;
  answer: NonNullable<T.Approval["answer"]>;
  where: string;
  sign: { attemptId: string; task: string; agent: string | undefined; line: string; link: string };
  out: ApprovalOut;
}

export abstract class HarborDecisions extends HarborSubmit {
  // ───── Merge ─────

  /**
   * A person merges a work copy ("pick"). When the work copy waits for an answer, this is the yes of that
   * approval: the rules of canDecide apply (`role`: the role that the Worker checked; callers inside gitring
   * are owners). `waits`: the merge waits for the hourly test budget (not a failure).
   */
  async land(attemptId: string, rationale: string, by: T.Actor = HUMAN, role: Role = "owner"): Promise<{ status: T.AttemptStatus; message: string; landing?: T.Landing; waits?: { until: number }; refused?: true }> {
    const asked = this.mustAttempt(attemptId);
    if (asked.approval?.status === "waiting") {
      const res = await this.decide(attemptId, { answer: "approve", note: rationale }, { id: by.id, name: by.name, role }, "app");
      return { status: res.status, message: res.message, ...(res.landing ? { landing: res.landing } : {}), ...(res.waits ? { waits: res.waits } : {}), ...(res.outcome === "refused" ? { refused: true as const } : {}) };
    }
    // Work that was never asked about can have a rule by folder too: only an owner merges it.
    if (!atLeast(role, "owner") && (await this.approvalFor(asked, { untested: false, competing: 0, picked: true }))?.ownerOnly) {
      return { status: asked.status, message: "A rule by folder needs the yes of an owner for this work. An owner must merge it.", refused: true as const };
    }
    return this.landWork(attemptId, rationale, by);
  }

  /** The merge of a work copy that a person chose, or said yes to. */
  protected async landWork(attemptId: string, rationale: string, by: T.Actor): Promise<{ status: T.AttemptStatus; message: string; landing?: T.Landing; waits?: { until: number } }> {
    const a = this.mustAttempt(attemptId);
    if (a.status === "landed") return { status: a.status, message: "This work copy is already on main." };
    if (TERMINAL.has(a.status)) return { status: a.status, message: `The work copy is ${copyStatusWord(a.status)}. Redo it on the new main first.` };
    let deferred: T.CheckRun["wait"];
    if (!a.checks?.ok) {
      const run = await this.check(a.id);
      // The test budget is used: no test ran, and that is not a failure. The tests of main plus this work decide at the merge.
      if (run.wait) deferred = run.wait;
      else if (!run.ok) return { status: a.status, message: `${failureSummary(run.cases)} gitring does not merge work whose tests fail.` };
    }
    this.recordDecision({ kind: "pick", intentId: a.intentId, attemptIds: [a.id], by, rationale });
    a.status = "ready";
    if (deferred) a.mergeWait = { until: deferred.retryAt, message: deferred.message };
    this.putAttempt(a);
    this.enqueueLanding(a);
    await this.landingChain;
    const landing = this.landings.find((l) => l.attemptId === a.id);
    const now = this.attempts.get(a.id)!;
    return {
      status: now.status,
      landing,
      ...(!landing && now.mergeWait ? { waits: { until: now.mergeWait.until } } : {}),
      message: landing
        ? `Merged by ${METHOD_WORD[landing.method]} at ${landing.mainAfter.slice(0, 7)}.`
        : now.mergeWait
          ? `${now.mergeWait.message} The work copy waits in the merge queue.`
          : `The work did not merge (${copyStatusWord(now.status)}). gitring does the task again on the new main.`,
    };
  }

  // ───── Answers of people ─────

  /**
   * A person answers the approval of a work copy: "approve" sends the work to the merge queue, "send-back"
   * gives the agent the note as a change request. The first valid answer counts. The same answer again
   * changes nothing. `who` carries the role that the Worker checked; the rules of canDecide apply here too.
   * `expect.approvalId` is the question that the person saw: an old question never takes a new answer.
   */
  async decide(
    attemptId: string,
    input: T.ApprovalAnswer,
    who: { id: string; name: string; role: Role },
    how: "app" | "chat" | "cli" = "app",
    expect: { approvalId?: string } = {},
    origin?: string,
  ): Promise<T.ApprovalResult> {
    this.rememberOrigin(origin);
    const p = this.requireProject();
    const a = this.mustAttempt(attemptId);
    const ap = a.approval;
    if (!ap) throw new Error("This work copy has no question to answer.");
    const out = (outcome: T.ApprovalResult["outcome"], message: string, extra: Partial<T.ApprovalResult> = {}): T.ApprovalResult => ({ attemptId, outcome, approval: a.approval ?? ap, status: a.status, message, ...extra });
    const blocked = await this.refuseAnswer(a, ap, p, who, expect, out);
    if (blocked) return blocked;
    // Another answer can come in while the work is read: the first one counts.
    if (a.approval !== ap || ap.status !== "waiting") return this.decide(attemptId, input, who, how, expect, origin);
    const intent = this.intents.get(a.intentId)!;
    const by: T.Actor = { kind: "human", id: who.id, name: who.name };
    const note = String(input.note ?? "").trim().slice(0, 1000);
    const answer = { by: { id: who.id, name: who.name }, how, ...(note ? { note } : {}), at: Date.now() };
    const where = how === "chat" ? " in the chat of the agent" : how === "cli" ? " with the gitring command line" : "";
    const sign = { attemptId: a.id, task: intent.title, agent: this.callsign(a.id), line: approvalLine(a), link: this.approvalLink(a) };
    const turn: Answering = { a, ap, intent, who, by, note, answer, where, sign, out };
    if (input.answer === "approve") return this.approveWork(turn);
    return this.sendWorkBack(turn);
  }

  // ───── The steps of an answer ─────

  /** Checks that this person may answer this question now. Answers the refusal, or undefined when the answer may go on. */
  protected async refuseAnswer(a: T.Attempt, ap: T.Approval, p: T.Project, who: Who, expect: { approvalId?: string }, out: ApprovalOut): Promise<T.ApprovalResult | undefined> {
    if (!canDecide(ap, who, p.settings.approver)) {
      const rule = p.settings.approver;
      return out(
        "refused",
        !atLeast(who.role, "member")
          ? "You need the member role to answer."
          : rule === "owner" || ap.ownerOnly || !ap.approver
            ? "Only an owner of the project can answer this."
            : `Only ${ap.approver.name} (who sent the agent) or an owner of the project can answer this.`,
      );
    }
    if (expect.approvalId && expect.approvalId !== ap.id) return out("withdrawn", "This question is old. The work changed, and gitring asked again. Open the new question.");
    if (ap.status === "withdrawn") return out("withdrawn", `This question is closed. ${ap.closed ?? ""}`.trim());
    if (ap.status !== "waiting") return out("already", `${ap.answer?.by.name ?? "A person"} ${ap.status === "approved" ? "said yes to" : "sent back"} this work already.`);
    if (a.status !== "ready") return out("withdrawn", "This work does not wait for an answer any more.");
    // The work must be what the question showed.
    if (ap.digest && (await this.digestOf(a)) !== ap.digest) {
      if (a.approval === ap && ap.status === "waiting") {
        a.status = "underway";
        this.putAttempt(a);
      }
      return out("withdrawn", "The agent changed the work after the question. gitring asks again when the agent submits.");
    }
    return undefined;
  }

  /** "approve": the yes is stored first, then the work goes to the merge queue. */
  protected async approveWork(t: Answering): Promise<T.ApprovalResult> {
    const { a, ap, intent, who, by, note, answer, where, sign, out } = t;
    a.approval = { ...ap, status: "approved", answer };
    this.putAttempt(a); // the answer is stored before the merge starts
    this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${who.name} says yes to the work of ${this.callsign(a.id)} on "${intent.title}"${where}.` });
    this.webhook("approval", { ...sign, approval: a.approval });
    const res = await this.landWork(a.id, note || "Approved.", by);
    return out("approved", res.message, { ...(res.landing ? { landing: res.landing } : {}), ...(res.waits ? { waits: res.waits } : {}) });
  }

  /** "send-back": a built-in agent does the task again with the note. An outside agent gets the note as a change request. */
  protected async sendWorkBack(t: Answering): Promise<T.ApprovalResult> {
    const { a, ap, intent, who, by, note, answer, where, sign, out } = t;
    a.approval = { ...ap, status: "sent-back", answer };
    const decision = this.recordDecision({ kind: "send-back", intentId: a.intentId, attemptIds: [a.id], by, rationale: note || "Sent back without a note." });
    this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${who.name} sends the work of ${this.callsign(a.id)} on "${intent.title}" back${where}${note ? `: ${note}` : "."}` });
    this.webhook("approval", { ...sign, approval: a.approval });
    const agent = this.agents.get(a.agentId);
    if (agent?.kind === "builtin") {
      // A built-in agent is done with this work copy: another built-in agent does the task again, and the note is part of the task.
      if (note) {
        intent.constraints = [...intent.constraints, `A person sent the work back: ${note}`];
        intent.version += 1;
        intent.amendments = [...intent.amendments, { version: intent.version, at: Date.now(), by, reason: "A person sent the work back.", text: note }];
        this.putIntent(intent);
      }
      this.putAttempt(a);
      await this.rederive(a.id, note ? `A person sent the work back: ${note}` : "A person sent the work back.", by);
      this.refreshJudging(a.intentId);
      return out("sent-back", "The work went back. A built-in agent does the task again and reads your note.");
    }
    a.status = "underway";
    this.putAttempt(a);
    this.issueCorrection(
      a.id,
      undefined,
      {
        kind: "review",
        message: `${who.name} sends your work back${note ? `: ${note}` : " without a note."} Change the work, run the tests, and submit again.`,
        constraints: note ? { notes: [note] } : {},
      },
      "human",
      decision.id,
      90,
      true,
    );
    this.refreshJudging(a.intentId);
    return out("sent-back", "The work went back to the agent with your note. The agent changes it and submits again.");
  }

  /**
   * A person answers a question. The first valid answer counts; the same answer again changes nothing.
   *   escalation  "first" or "second": the side that adapts gets the change request ("a person decided").
   *               "both": nothing changes, and the question closes.
   *   redo        "redo": a built-in agent does the task again on the new main. "park": the task pauses.
   * `who` carries the role that the Worker checked; the rules of canAnswerQuestion apply here too.
   */
  async answerQuestion(questionId: string, input: T.QuestionAnswer, who: { id: string; name: string; role: Role }, origin?: string): Promise<T.QuestionResult> {
    this.rememberOrigin(origin);
    const p = this.requireProject();
    const q = this.questions.get(questionId);
    if (!q) throw new Error("Unknown question.");
    const out = (outcome: T.QuestionResult["outcome"], message: string): T.QuestionResult => ({ outcome, question: this.questions.get(questionId) ?? q, message });
    const senders = q.attemptIds.map((id) => this.attempts.get(id)?.sender);
    if (!canAnswerQuestion(senders, who, p.settings.approver)) {
      return out("refused", !atLeast(who.role, "member") ? "You need the member role to answer." : "Only a person who sent one of the agents, or an owner of the project, can answer this.");
    }
    if (q.status === "answered") return out("already", `${q.answer?.by.name ?? "A person"} answered this question already.`);
    if (q.status === "closed") return out("closed", `This question is closed. ${q.closed ?? ""}`.trim());
    const option = q.options.find((o) => o.id === input.option);
    if (!option) throw new Error(`Give one of these answers: ${q.options.map((o) => o.id).join(", ")}.`);
    const note = String(input.note ?? "").trim().slice(0, 1000);
    const by: T.Actor = { kind: "human", id: who.id, name: who.name };
    // The answer is stored first: a second answer that comes while this one works finds it.
    this.putQuestion({ ...q, status: "answered", answer: { by: { id: who.id, name: who.name }, option: option.id, ...(note ? { note } : {}), at: Date.now() } });
    const rationale = `${option.label}.${note ? ` ${note}` : ""}`;
    const intent = this.intents.get(q.intentId);
    let message: string;
    if (q.kind === "escalation") {
      const decision = this.recordDecision({ kind: "resolve-escalation", intentId: q.intentId, attemptIds: q.attemptIds, by, rationale });
      const d = q.drafts?.[option.id];
      const sent = d ? this.personDecided(d, note, decision.id, 90, true) : undefined;
      message = d ? (sent ? `${option.label}. ${this.callsign(d.attemptId) ?? "The agent"} gets a change request.` : `${option.label}. The work that adapts is closed, so no change request went out.`) : "Both agents continue. Nothing changes.";
    } else if (q.kind === "steward") {
      // A note of the steward: "Seen" closes it, and nothing else changes.
      message = "The note is closed.";
    } else {
      try {
        if (option.id === "park") {
          await this.park(q.intentId, note || "A person paused the task after the work did not merge.", by);
          message = "The task is paused.";
        } else if (option.id === "ok") {
          // A revert that the person heard about: the agent fixes the work and submits again.
          message = `Understood. ${this.callsign(q.attemptIds[0]) ?? "The agent"} fixes the work and submits it again.`;
        } else {
          const a = this.attempts.get(q.attemptIds[0]);
          if (!a) throw new Error("The work copy of this question is gone.");
          const res = await this.rederive(a.id, note ? `A person asked for a redo: ${note}` : "A person asked for a redo on the new main.", by);
          message = `A built-in agent does "${intent?.title ?? "the task"}" again on the new main.${res.attempt.waitsForBudget ? " It starts when the hourly AI budget has room." : ""}`;
        }
      } catch (err) {
        // When nothing happened (no redo started), the question waits again, and the person sees why.
        const started = [...this.attempts.values()].some((x) => x.lineage.rederivedFrom === q.attemptIds[0]);
        if (!started && this.questions.get(questionId)?.status === "answered") this.putQuestion({ ...q, status: "open" });
        throw err;
      }
    }
    this.addLog({ kind: "decision", intentId: q.intentId, attemptId: q.attemptIds[0], message: `${who.name} answers the question about "${intent?.title ?? "a task"}": ${rationale}` });
    this.webhook("question", { question: this.questions.get(questionId), task: intent?.title ?? "", link: this.questionLink(q) });
    return out("answered", message);
  }

  /** What waits for this person in this project (the inbox; GET /api/me/inbox joins the projects). */
  async inbox(viewer: { id: string; role: Role }): Promise<InboxItem[]> {
    const p = this.requireProject();
    return inboxOf(
      { project: p.id, rule: p.settings.approver, intents: [...this.intents.values()], attempts: [...this.attempts.values()], agents: [...this.agents.values()], questions: [...this.questions.values()] },
      viewer,
    );
  }

  // ───── Changes that a person asks for ─────

  async amendIntent(id: string, patch: { goal?: string; constraints?: string[]; reason: string }, by: T.Actor = HUMAN): Promise<T.Intent> {
    const intent = this.intents.get(id);
    if (!intent) throw new Error("Unknown task.");
    const parts: string[] = [];
    if (patch.goal && patch.goal !== intent.goal) {
      intent.goal = patch.goal;
      parts.push(patch.goal);
    }
    if (patch.constraints) {
      const added = patch.constraints.filter((c) => !intent.constraints.includes(c));
      intent.constraints = [...patch.constraints];
      parts.push(...added);
    }
    if (!parts.length) return intent;
    intent.version += 1;
    const amendment: T.Amendment = { version: intent.version, at: Date.now(), by, reason: patch.reason || "Goal changed", text: parts.join(" ") };
    intent.amendments = [...intent.amendments, amendment];
    this.putIntent(intent);
    this.addLog({ kind: "intent", intentId: id, message: `${by.name} changes the goal of "${intent.title}" (version ${intent.version}): ${patch.reason || "no reason given"}.` });
    // Every vessel on this intent gets the change as a correction.
    const main = await this.loadMain();
    for (const a of this.attempts.values()) {
      if (a.intentId !== id || !ACTIVE.has(a.status)) continue;
      const agent = this.agents.get(a.agentId)!;
      const v = vesselView(a, intent, agent, (await this.attemptView(a)).signatures, main.signatures, "active");
      this.issueCorrection(a.id, undefined, draftIntentAmendedCorrection(v, amendment), "human", "amend", 50, true);
    }
    this.recordDecision({ kind: "amend", intentId: id, attemptIds: [], by, rationale: patch.reason || "Goal changed" });
    return intent;
  }

  /**
   * A person asks the agent to change some lines of its work (a line comment in the app). The agent gets a
   * change request, like any other: in the answer of its next call.
   */
  async requestChange(attemptId: string, input: { path: string; from: number; to: number; text: string }, who: { id: string; name: string; role?: Role }): Promise<T.Correction> {
    const a = this.mustAttempt(attemptId);
    // Only the person who sent the agent, or an owner, steers it. Another member cannot put text into this agent.
    if (who.role && !this.mayAct(a, { id: who.id, role: who.role })) throw new Error(`The agent of ${a.sender?.name ?? "another person"} works on this. Only that person or an owner of the project can send it a change request.`);
    if (TERMINAL.has(a.status)) throw new Error(`The work copy is ${copyStatusWord(a.status)}. The agent does not work on it any more.`);
    const path = String(input.path ?? "").trim().replace(/^\/+/, "");
    const from = Math.floor(Number(input.from));
    const to = Math.floor(Number(input.to));
    const text = String(input.text ?? "").trim().slice(0, 1000);
    if (!path || path.length > 500) throw new Error("Give the path of the file.");
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) throw new Error("Give the lines: from and to. From is 1 or more, and to is not before from.");
    if (!text) throw new Error("Write what the agent must change.");
    const lines = from === to ? `line ${from}` : `lines ${from}–${to}`;
    const corr = this.issueCorrection(
      a.id,
      undefined,
      { kind: "review", message: `${who.name} asks you to change ${path} ${lines}: ${text} Change it, run the tests, and call gitring_ack.`, constraints: { notes: [`${path} ${lines}: ${text}`] } },
      "human",
      "person",
      80,
      true,
    );
    if (!corr) throw new Error("gitring sent this request already. The agent did not read it yet.");
    this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${who.name} asks ${this.callsign(a.id)} to change ${path} ${lines}.`, files: [path] });
    return corr;
  }

  /**
   * gitring asks a person in the chat of the agent (a form), so the agent does not read that answer: its change
   * requests wait again. The answer of the second call holds them, or the next call of the agent when the person
   * never answers the form.
   */
  async holdCorrections(attemptId: string, ids: string[]): Promise<void> {
    for (const id of new Set(ids)) {
      const c = this.corrections.get(id);
      if (!c || c.attemptId !== attemptId || c.status !== "delivered") continue;
      c.status = "pending";
      c.deliveredAt = undefined;
      this.putCorrection(c);
    }
  }
}
