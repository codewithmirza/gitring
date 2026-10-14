/**
 * Runs the conflict check of one plan against the nearest other plans and acts on the answer.
 * Layer 10 of the chain in master/README.md. Extends HarborCorrections (corrections.ts).
 * It never rejects a plan: the answer is a check result with change requests.
 * Read next: protocol.ts.
 */
import type * as T from "../../core/types";
import {
  measureTraffic,
  pickCandidates,
  hasHardFacts,
  modelConfidence,
  buildPairFacts,
  assessWithRules,
  parseClefResponse,
  decide,
  draftCorrection,
  draftDuplicateCorrection,
  DUPLICATE_MIN_SIMILARITY,
  DUPLICATE_UNSHARED_CAP,
  modelCannotChangeVerdict,
} from "../../core/coord";
import { buildBriefClefRequest } from "../../core/coord/clef-brief";
import { callClef } from "../../platform/ai/models";
import { newId } from "../ids";
import { ACTIVE, WAITING, checkGraph, vesselView, type AttemptView } from "../views";
import { MAX_CHECKS } from "../support/constants";
import { anchor, decisiveness, pairKey, severityOf, sortPair } from "../support/helpers";
import { TRIGGER_WORD, VERDICT_WORD } from "../support/words";
import { HarborCorrections } from "./corrections";

export abstract class HarborCourseCheck extends HarborCorrections {
  async courseCheck(attemptId: string, trigger: T.CourseCheck["trigger"]): Promise<T.CourseCheck | undefined> {
    const a = this.attempts.get(attemptId);
    if (!a || !ACTIVE.has(a.status)) return undefined;
    const p = this.requireProject();
    const main = await this.loadMain();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    const t0 = Date.now();

    const views = new Map<string, AttemptView>();
    views.set(a.id, await this.attemptView(a));
    for (const other of this.attempts.values()) {
      if (other.id !== a.id && (ACTIVE.has(other.status) || other.status === "landed")) {
        try {
          views.set(other.id, await this.attemptView(other));
        } catch {
          /* a fork may still be on its way */
        }
      }
    }
    const incoming = vesselView(a, intent, agent, views.get(a.id)?.signatures, main.signatures, WAITING.has(a.status) ? "waiting" : "active", main.definedIn);
    const traffic = this.trafficViews(a, main, views);
    const previous = new Map<string, T.Range>();
    for (const v of traffic) {
      const pr = this.radar.get(pairKey(a.id, v.attempt.id));
      if (pr) previous.set(v.attempt.id, pr.range);
    }
    // Main plus the imports that the work copies of this check add (new files included).
    const graph = checkGraph(main, views.values(), this.checkPaths());
    const measured = measureTraffic(incoming, traffic, graph, previous);
    const cands = pickCandidates(measured, 3).map((c) => ({
      view: c.view,
      facts: buildPairFacts(incoming, c.view, graph, previous.get(c.view.attempt.id)),
    }));

    let source: T.CourseCheck["source"] = "rules";
    let assessments: T.CourseAssessment[] = [];
    let confidence = 1;
    let duplicate = 0;
    let raw: Record<string, unknown> | undefined;

    if (cands.length) {
      const rules = assessWithRules(incoming, cands);
      const model = p.settings.decisionModel;
      // Soft pairs (one import apart or more) cannot reach a correction, so the model cannot change the verdict.
      // The fixed rules decide then, and no model call is made.
      if (model !== "rules" && !modelCannotChangeVerdict(cands.map((c) => c.facts), p.settings.thresholds)) {
        // "clef" asks the large model first (the fast model answers when it does not). "clef-flash" asks the
        // fast model, and the large model only for ambiguous pairs.
        const large = model === "clef";
        let first = await callClef(this.env.AI as never, buildBriefClefRequest(large ? "clef" : "clef-flash", incoming, cands), large ? 6000 : undefined);
        if (!first && large) first = await callClef(this.env.AI as never, buildBriefClefRequest("clef-flash", incoming, cands));
        if (first) {
          let parsed = parseClefResponse(first.res, incoming, cands);
          let used = first;
          raw = { clef: first.res.answers, model: first.model, latencyMs: first.latencyMs, missing: parsed.missing };
          // Escalate to the 27B model only for ambiguous pairs: no hard facts, close range, a coin-flip answer.
          const ambiguous = !large && cands.some((c) => {
            const as = parsed.assessments.find((x) => x.otherAttemptId === c.view.attempt.id);
            return as && !hasHardFacts(c.facts) && c.facts.range <= 2 && as.collision >= 0.35 && as.collision <= 0.65;
          });
          if (ambiguous) {
            const second = await callClef(this.env.AI as never, buildBriefClefRequest("clef", incoming, cands), 6000);
            if (second) {
              raw = { ...raw, escalatedFrom: { source: "clef-flash", confidence: decisiveness(parsed.assessments), latencyMs: first.latencyMs }, clef27b: second.res.answers };
              parsed = parseClefResponse(second.res, incoming, cands);
              used = second;
            }
          }
          source = used.model;
          // Facts are facts: hard evidence sets a floor, absence of evidence sets a ceiling. Clef judges the rest.
          assessments = parsed.assessments.map((as) => {
            const facts = cands.find((c) => c.view.attempt.id === as.otherAttemptId)?.facts;
            const r = rules.assessments.find((x) => x.otherAttemptId === as.otherAttemptId);
            return facts && r ? anchor(as, r, facts) : as;
          });
          // Only the pairs that need a change request count: a doubt about an unrelated pair cannot send the check to a person.
          confidence = modelConfidence(
            cands.map((c) => ({ facts: c.facts, assessment: assessments.find((x) => x.otherAttemptId === c.view.attempt.id) })),
            p.settings.thresholds,
          );
          const maxSim = Math.max(0, ...cands.map((c) => c.facts.intentSimilarity));
          const clefDup = parsed.duplicate >= 0.7 && maxSim >= DUPLICATE_MIN_SIMILARITY ? parsed.duplicate : Math.min(parsed.duplicate, DUPLICATE_UNSHARED_CAP);
          duplicate = Math.max(clefDup, rules.duplicate >= 0.8 ? rules.duplicate : 0);
          if (duplicate < p.settings.thresholds.duplicate) {
            for (const as of assessments) as.duplicate = Math.min(as.duplicate, duplicate);
          }
        }
      }
      if (!assessments.length) {
        source = "rules";
        assessments = rules.assessments;
        confidence = rules.confidence;
        duplicate = rules.duplicate;
      }
    }

    const outcome = decide(
      assessments,
      cands.map((c) => c.facts),
      p.settings.thresholds,
      duplicate,
      cands.length ? confidence : 1,
    );
    const latencyMs = Date.now() - t0;
    const check: T.CourseCheck = {
      id: newId("cc"),
      attemptId: a.id,
      trigger,
      verdict: cands.length ? outcome.verdict : "clear",
      assessments,
      facts: cands.map((c) => c.facts),
      source,
      confidence: cands.length ? outcome.confidence : 1,
      latencyMs,
      at: Date.now(),
      raw,
    };
    this.checks.push(check);
    if (this.checks.length > MAX_CHECKS) this.checks.splice(0, this.checks.length - MAX_CHECKS);
    this.db.putCheck(check);
    this.emit({ type: "check", check });

    // Radar: record range and closing for every measured pair, near or far, so that the next check sees a far
    // pair come closer. A candidate pair gets the verdict of this check. A far pair is too far apart to collide:
    // "clear". A near pair after the 20 candidates keeps its last verdict. A pair that is not a candidate is
    // written only when it changes.
    const pairs: T.RadarPair[] = [];
    const candidateIds = new Set(cands.map((c) => c.view.attempt.id));
    for (const m of measured) {
      const id = m.view.attempt.id;
      const before = this.radar.get(pairKey(a.id, id));
      const candidate = candidateIds.has(id);
      const far = m.range > 3 && !m.closing;
      const verdict = candidate ? check.verdict : far ? "clear" : before?.verdict;
      if (!candidate && before && before.range === m.range && before.closing === m.closing && before.verdict === verdict) continue;
      const pair: T.RadarPair = { a: a.id, b: id, range: m.range, closing: m.closing, updatedAt: Date.now() };
      if (verdict) pair.verdict = verdict;
      this.radar.set(pairKey(pair.a, pair.b), pair);
      this.db.putRadar(...sortPair(pair.a, pair.b), pair);
      pairs.push(pair);
    }
    if (pairs.length) this.emit({ type: "radar", pairs });
    this.trimRadar();

    this.stats.courseChecks += 1;
    if (check.verdict === "clear") this.stats.clear += 1;
    if (check.verdict === "escalate") this.stats.escalations += 1;
    this.checkLatencies.push(latencyMs);
    if (this.checkLatencies.length > 400) this.checkLatencies.splice(0, 200);

    const closest = cands.length ? Math.min(...cands.map((c) => c.facts.range)) : 5;
    const closing = cands.filter((c) => c.facts.closing).map((c) => this.callsign(c.view.attempt.id));
    this.addLog({
      kind: "check",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message:
        `Conflict check (${TRIGGER_WORD[trigger] ?? trigger}): ${VERDICT_WORD[check.verdict] ?? check.verdict}. ` +
        (cands.length ? `${cands.length} other work ${cands.length > 1 ? "copies" : "copy"} near, closest at distance ${closest}` : "No other work near") +
        (closing.length ? `, closer now: ${closing.join(", ")}` : "") +
        ` · ${source === "rules" ? "rules" : "AI model"} ${latencyMs} ms`,
      data: { checkId: check.id, source, latencyMs },
    });

    if (check.verdict === "correct" || check.verdict === "escalate") {
      for (const c of outcome.corrections) {
        const other = cands.find((x) => x.view.attempt.id === c.otherAttemptId);
        if (!other) continue;
        const giveWayView = c.giveWay === "incoming" ? incoming : other.view;
        const standOnView = c.giveWay === "incoming" ? other.view : incoming;
        if (giveWayView.state === "landed") continue;
        if (check.verdict === "escalate") {
          // A person decides first: gitring asks which work adapts. Both agents continue while they wait.
          if (other.view.state !== "landed") this.askAboutPair(incoming, other.view, c.facts, check.id);
          continue;
        }
        const drafted = draftCorrection(giveWayView, standOnView, c.facts, c.rule, c.giveWay);
        this.issueCorrection(giveWayView.attempt.id, standOnView.attempt.id, drafted, c.rule, check.id, severityOf(c.facts));
      }
    } else if (check.verdict === "merge-intents" && outcome.duplicateOf) {
      const other = cands.find((x) => x.view.attempt.id === outcome.duplicateOf);
      if (other) {
        const drafted = draftDuplicateCorrection(incoming, other.view);
        this.issueCorrection(a.id, other.view.attempt.id, drafted, "R4-first-declared-stands-on", check.id, 100);
      }
      // The same task as other work does not end the check: the other pairs that collide get their change requests too.
      this.correctOtherPairs(outcome.corrections, cands, incoming, check.id);
    }
    this.persistStats();
    return check;
  }

  /** A newly created intent that duplicates traffic joins the existing intent. */
  protected async mergeDuplicate(a: T.Attempt, newIntent: T.Intent, check: T.CourseCheck): Promise<T.CourseCheck> {
    const dupCorr = a.corrections.map((id) => this.corrections.get(id)).find((c) => c?.kind === "duplicate");
    const other = dupCorr?.standOnAttemptId ? this.attempts.get(dupCorr.standOnAttemptId) : undefined;
    const target = other ? this.intents.get(other.intentId) : undefined;
    if (!target || target.id === newIntent.id) return check;
    newIntent.status = "merged-into";
    newIntent.mergedInto = target.id;
    this.putIntent(newIntent);
    a.intentId = target.id;
    for (const c of target.checks) this.db.writeWorktree(a.id, c.path, c.content);
    this.bump(a.id);
    this.putAttempt(a);
    const msg =
      `Your task "${newIntent.title}" is the same as "${target.title}". gitring joins your work copy to that task. ` +
      `Follow its goal and tests. gitring compares your work with the other work copies. Continue your work.`;
    if (dupCorr) {
      dupCorr.message = msg;
      this.putCorrection(dupCorr);
    }
    this.addLog({ kind: "intent", intentId: target.id, attemptId: a.id, message: `"${newIntent.title}" is the same task as "${target.title}". ${this.callsign(a.id)} becomes another work copy on it.` });
    await this.refreshFootprint(a);
    return (await this.courseCheck(a.id, "declare")) ?? check;
  }
}
