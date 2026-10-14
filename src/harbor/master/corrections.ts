/**
 * Makes change requests for one work copy, asks a person about a pair, and trims the list of pairs.
 * Layer 9 of the chain in master/README.md. Extends HarborClearance (clearance.ts).
 * A change request is made only here, so that its life (pending, sent, confirmed, closed) stays in one place.
 * Read next: course-check.ts.
 */
import type * as T from "../../core/types";
import { escalationFacts, escalationOptions } from "../../core/inbox";
import { decide, draftCorrection, type VesselView } from "../../core/coord";
import { newId } from "../ids";
import { ACTIVE } from "../views";
import { MAX_RADAR_PAIRS, TERMINAL } from "../support/constants";
import { SYSTEM, regionKey, severityOf, sortPair } from "../support/helpers";
import { KIND_WORD } from "../support/words";
import { HarborClearance } from "./clearance";

/** The words and the limits of a change request that the coordination code drafted (see draftCorrection). */
type DraftedCorrection = { kind: T.CorrectionKind; message: string; constraints: T.Correction["constraints"] };

export abstract class HarborCorrections extends HarborClearance {
  // ───── Pairs ─────

  /**
   * The radar keeps far pairs too, so it grows with each check. Above `max` pairs, it forgets each pair with a
   * side that left the traffic for good (merged, stopped, replaced): no check and no view reads those pairs again.
   */
  protected trimRadar(max = MAX_RADAR_PAIRS): void {
    if (this.radar.size <= max) return;
    const gone = (id: string): boolean => {
      const x = this.attempts.get(id);
      return !x || TERMINAL.has(x.status);
    };
    for (const [key, pair] of this.radar) {
      if (!gone(pair.a) && !gone(pair.b)) continue;
      this.radar.delete(key);
      this.db.deleteRadar(...sortPair(pair.a, pair.b));
    }
  }

  /** The change requests of the flagged pairs of a "merge-intents" check (the duplicate pair is not one of them). */
  protected correctOtherPairs(corrections: ReturnType<typeof decide>["corrections"], cands: { view: VesselView; facts: T.PairFacts }[], incoming: VesselView, checkId: string): void {
    for (const c of corrections) {
      const other = cands.find((x) => x.view.attempt.id === c.otherAttemptId);
      if (!other) continue;
      const giveWayView = c.giveWay === "incoming" ? incoming : other.view;
      const standOnView = c.giveWay === "incoming" ? other.view : incoming;
      if (giveWayView.state === "landed") continue;
      const drafted = draftCorrection(giveWayView, standOnView, c.facts, c.rule, c.giveWay);
      this.issueCorrection(giveWayView.attempt.id, standOnView.attempt.id, drafted, c.rule, checkId, severityOf(c.facts));
    }
  }

  // ───── Change requests ─────

  protected issueCorrection(
    attemptId: string,
    standOnAttemptId: string | undefined,
    drafted: DraftedCorrection,
    rule: T.RuleOfTheRoad | "human",
    checkId: string,
    severity = 50,
    /**
     * The change request answers an event: a person changes the task or sends the work back, the work does not
     * merge, GitHub changes main. Each event is news for the agent. The agent gets the new request, even when it
     * did not confirm the earlier request of the same kind (or already did).
     */
    event = false,
  ): T.Correction | undefined {
    const target = this.attempts.get(attemptId);
    if (!target || !ACTIVE.has(target.status)) return undefined;
    // One live correction per (vessel, stand-on vessel, kind). Refresh it in place; send a new one
    // only when the situation gets worse (closer range, more overlapping lines, a new interface).
    // Many work copies can edit the same lines. The agent gets one change request for those lines, not one for
    // each work copy: a work copy that edits lines that a live change request already names joins that request.
    // An event is not a situation that gets worse: a new event always gives a new change request (see `event`).
    const regions = regionKey(drafted);
    for (const id of target.corrections) {
      const old = this.corrections.get(id);
      if (regions && old && standOnAttemptId && old.kind === "region" && old.status !== "superseded" && old.standOnAttemptId && old.standOnAttemptId !== standOnAttemptId && regionKey(old) === regions) {
        if (this.joinRegionRequest(old, standOnAttemptId, drafted)) return undefined;
      }
      if (event && old && old.kind === drafted.kind && old.standOnAttemptId === standOnAttemptId && old.status !== "superseded") {
        // The same words, and the agent did not read them yet: it gets them once.
        if (old.status === "pending" && old.message === drafted.message) return undefined;
        // Else the new request replaces the old one, and it always goes to the agent.
        old.status = "superseded";
        this.putCorrection(old);
        continue;
      }
      if (!old || old.standOnAttemptId !== standOnAttemptId || old.kind !== drafted.kind || old.status === "superseded") continue;
      if (old.message === drafted.message) return undefined;
      if (old.status === "pending") {
        old.message = drafted.message;
        old.constraints = drafted.constraints;
        old.severity = Math.max(old.severity ?? 0, severity);
        old.checkId = checkId;
        this.putCorrection(old);
        return old;
      }
      if (severity <= (old.severity ?? 50)) {
        old.refreshes = (old.refreshes ?? 0) + 1;
        this.corrections.set(old.id, old);
        this.db.putCorrection(old);
        return undefined;
      }
      old.status = "superseded";
      this.putCorrection(old);
    }
    const corr = this.openCorrection(attemptId, standOnAttemptId, drafted, rule, checkId, severity, target);
    this.amendSpecForInterface(drafted, target, corr, attemptId);
    this.logCorrection(drafted, target, corr, attemptId, standOnAttemptId);
    return corr;
  }

  // ───── The steps of a change request ─────

  /** A work copy that edits lines which a live "same lines" request names joins that request. True: it joined, and no new request is made. */
  protected joinRegionRequest(old: T.Correction, standOnAttemptId: string, drafted: DraftedCorrection): boolean {
    const first = this.attempts.get(old.standOnAttemptId!);
    if (first && ACTIVE.has(first.status)) {
      if (!old.alsoStandOn?.includes(standOnAttemptId)) {
        // The request names the work copy that was declared last. The agent waits for that one, so the agents in a row
        // go one after the other (each waits for the one before it). If it named the first one, all would wake together.
        const joined = this.attempts.get(standOnAttemptId);
        if (joined && joined.course.declaredAt > first.course.declaredAt) {
          old.alsoStandOn = [...(old.alsoStandOn ?? []), old.standOnAttemptId!];
          old.standOnAttemptId = standOnAttemptId;
          old.message = drafted.message;
          old.constraints = drafted.constraints;
        } else {
          old.alsoStandOn = [...(old.alsoStandOn ?? []), standOnAttemptId];
        }
        this.putCorrection(old);
      }
      return true;
    }
    return false;
  }

  /** The new change request, saved and counted. It goes to the agent with its next answer. */
  protected openCorrection(attemptId: string, standOnAttemptId: string | undefined, drafted: DraftedCorrection, rule: T.RuleOfTheRoad | "human", checkId: string, severity: number, target: T.Attempt): T.Correction {
    const corr: T.Correction = {
      id: newId("cr"),
      attemptId,
      standOnAttemptId,
      kind: drafted.kind,
      rule,
      message: drafted.message,
      constraints: drafted.constraints,
      checkId,
      status: "pending",
      severity,
      createdAt: Date.now(),
    };
    target.corrections = [...target.corrections, corr.id];
    this.putAttempt(target);
    this.putCorrection(corr);
    this.stats.corrections += 1;
    return corr;
  }

  protected amendSpecForInterface(drafted: DraftedCorrection, target: T.Attempt, corr: T.Correction, attemptId: string): void {
    // An interface change binds every attempt of the intent: amend the living spec with the new signature.
    if (drafted.kind === "interface" && drafted.constraints.useSignatures?.length) {
      const intent = this.intents.get(target.intentId);
      const lines = drafted.constraints.useSignatures.map((s) => `Use ${s.signature} (${s.symbol.split("#")[0]}).`);
      if (intent && lines.some((l) => !intent.constraints.includes(l))) {
        intent.constraints = [...new Set([...intent.constraints, ...lines])];
        intent.version += 1;
        intent.amendments = [
          ...intent.amendments,
          {
            version: intent.version,
            at: Date.now(),
            by: SYSTEM,
            reason: `Change request ${corr.id} (${KIND_WORD[drafted.kind] ?? drafted.kind}) for ${this.callsign(attemptId)}`,
            text: lines.join(" "),
          },
        ];
        this.putIntent(intent);
      }
    }
  }

  protected logCorrection(drafted: DraftedCorrection, target: T.Attempt, corr: T.Correction, attemptId: string, standOnAttemptId: string | undefined): void {
    this.addLog({
      kind: "correction",
      attemptId,
      agentId: target.agentId,
      intentId: target.intentId,
      // The activity feed keeps the sentences; the earlier diffs stay on the change request itself.
      message: `Change request for ${this.callsign(attemptId)} (${KIND_WORD[drafted.kind] ?? drafted.kind}${standOnAttemptId ? `; ${this.callsign(standOnAttemptId)} continues` : ""}): ${drafted.message.split("\n\n")[0]}`,
      files: [...new Set([...(drafted.constraints.avoidRegions ?? []).map((r) => r.path), ...(drafted.constraints.reapply ?? []).map((r) => r.path)])],
      data: { correctionId: corr.id },
    });
    this.webhook("correction", { correction: corr, callsign: this.callsign(attemptId) });
  }

  // ───── Questions about a pair ─────

  /**
   * A conflict check escalated a pair: ask a person which work adapts. The question holds the change request
   * for each side (drafted now, from the facts that the person reads). A new escalation of the same pair
   * updates the open question: the person sees one question for one pair.
   */
  protected askAboutPair(inc: VesselView, oth: VesselView, facts: T.PairFacts, checkId: string): void {
    const draft = (giveWay: VesselView, standOn: VesselView, side: "incoming" | "other") => {
      const d = draftCorrection(giveWay, standOn, facts, "R4-first-declared-stands-on", side);
      return { attemptId: giveWay.attempt.id, standOnAttemptId: standOn.attempt.id, kind: d.kind, message: d.message, constraints: d.constraints };
    };
    const a = inc.attempt.id;
    const b = oth.attempt.id;
    // The decision model can take a while: a work copy that closed in the meantime has nothing to adapt.
    if (![a, b].every((id) => ACTIVE.has(this.attempts.get(id)?.status as T.AttemptStatus))) return;
    const pair = (q: T.Question) => q.kind === "escalation" && q.attemptIds.includes(a) && q.attemptIds.includes(b);
    const old = [...this.questions.values()].find((q) => q.status === "open" && pair(q));
    // A person answered for this pair already: the answer stands, and gitring does not ask again.
    const answered = old ? undefined : [...this.questions.values()].filter((q) => q.status === "answered" && pair(q)).sort((x, y) => x.updatedAt - y.updatedAt).at(-1);
    if (answered) {
      const chosen = answered.drafts?.[answered.answer?.option ?? ""];
      // "No conflict: both continue": nothing to do. Else the side that the person chose adapts again (a new request only when the conflict grows).
      if (!chosen) return;
      const [giveWay, standOn] = chosen.attemptId === a ? [inc, oth] : [oth, inc];
      const d = draftCorrection(giveWay, standOn, facts, "R4-first-declared-stands-on", giveWay === inc ? "incoming" : "other");
      this.personDecided({ attemptId: giveWay.attempt.id, standOnAttemptId: standOn.attempt.id, kind: d.kind, message: d.message, constraints: d.constraints }, answered.answer?.note, checkId, severityOf(facts), false);
      return;
    }
    // An open question keeps its order: its first work copy stays "first".
    const incomingFirst = !old || old.attemptIds[0] === a;
    const [first, second] = incomingFirst ? [inc, oth] : [oth, inc];
    const now = Date.now();
    const words = escalationFacts(facts, { a: inc.agent.callsign, b: oth.agent.callsign, taskA: inc.intent.title, taskB: oth.intent.title });
    const drafts = incomingFirst
      ? { first: draft(oth, inc, "other"), second: draft(inc, oth, "incoming") }
      : { first: draft(inc, oth, "incoming"), second: draft(oth, inc, "other") };
    const q: T.Question = {
      ...(old ?? { id: newId("q"), kind: "escalation" as const, status: "open" as const, askedAt: now, updatedAt: now }),
      intentId: first.attempt.intentId,
      attemptIds: [first.attempt.id, second.attempt.id],
      checkId,
      facts: words,
      options: escalationOptions(first.agent.callsign, second.agent.callsign),
      drafts,
    };
    this.putQuestion(q);
    if (old) return;
    this.addLog({
      kind: "decision",
      attemptId: a,
      intentId: inc.attempt.intentId,
      message: `gitring asks a person which work adapts: ${inc.agent.callsign} or ${oth.agent.callsign}. Both continue until the answer.`,
    });
    this.questionAsked(q);
  }

  /**
   * The change request after a person chose which work adapts (rule "human"). `d` is the drafted request for the
   * side that adapts; the note of the person goes with it. `event`: the answer itself (always news for the agent);
   * a later check of the same pair sends the request again only when the conflict grows.
   */
  protected personDecided(d: NonNullable<T.Question["drafts"]>[string], note: string | undefined, checkId: string, severity: number, event: boolean): T.Correction | undefined {
    return this.issueCorrection(
      d.attemptId,
      d.standOnAttemptId,
      {
        kind: d.kind,
        message: `A person decided: ${this.callsign(d.standOnAttemptId) ?? "the other agent"} continues, and your work adapts.${note ? ` Note: ${note}` : ""} ${d.message}`,
        constraints: note ? { ...d.constraints, notes: [...(d.constraints.notes ?? []), note] } : d.constraints,
      },
      "human",
      checkId,
      severity,
      event,
    );
  }
}
