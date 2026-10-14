/**
 * Merges a train: several independent work copies tested once and merged together.
 * Layer 20 of the chain in master/README.md. Extends HarborMerge (merge.ts).
 * A work copy that does not fit in the train leaves it and merges alone (see merge.ts).
 * Read next: queue.ts.
 */
import type * as T from "../../core/types";
import { noTestRan } from "../../core/types";
import { RepoConflictError } from "../../platform/repo/backend";
import { computeRange, type WorkShape } from "../../core/analysis/range";
import { compose } from "../../core/land/compose";
import { withoutChanges } from "../../core/land/carry";
import { findPassingTrain, selectTrain, type TrainCandidate } from "../../core/land/train";
import { landingMessage, landingNote, intentFile, type TrainInfo } from "../../core/logbook";
import { newId } from "../ids";
import { failureSummary, vesselView } from "../views";
import { GITRING_AUTHOR, LANDING_LEASE_MS } from "../support/constants";
import { errorLine, pairKey } from "../support/helpers";
import { TestsWait } from "../support/types";
import type { LandingRun, TrainOutcome, TrainPiece } from "../support/types";
import { HarborMerge } from "./merge";

export abstract class HarborTrains extends HarborMerge {
  // ───── Choose and run a train ─────

  /**
   * The train that starts with this work copy: the largest set of queued work copies that are pairwise
   * independent (different tasks, no shared file, range ≥ 3 by the conflict-check facts), at most
   * `maxTrain`. The range of a pair comes from the radar when a check measured it, else from the shapes.
   */
  protected async trainFor(head: T.Attempt): Promise<T.Attempt[]> {
    const p = this.requireProject();
    const maxSize = Math.max(1, Math.min(16, Math.round(p.settings.maxTrain || 8)));
    if (maxSize === 1) return [head];
    const now = Date.now();
    const marker = this.db.getMeta<LandingRun>("landing");
    const ready: T.Attempt[] = [];
    for (const id of this.db.queue()) {
      const a = this.attempts.get(id);
      if (!a || a.status !== "ready" || a.approval?.status === "waiting" || !this.mayStartNow(a, marker, now)) continue;
      ready.push(a);
    }
    if (ready.length < 2 || ready[0].id !== head.id) return [head];
    const main = await this.loadMain();
    const shapes = new Map<string, WorkShape>();
    const candidates: TrainCandidate[] = [];
    for (const [order, a] of ready.entries()) {
      const intent = this.intents.get(a.intentId);
      const agent = this.agents.get(a.agentId);
      if (!intent || !agent) continue;
      const view = await this.attemptView(a);
      shapes.set(a.id, vesselView(a, intent, agent, view.signatures, main.signatures, "waiting", main.definedIn).shape);
      candidates.push({ id: a.id, intentId: a.intentId, files: [...new Set([...a.course.files, ...Object.keys(a.footprint.files), ...view.changed.map((c) => c.path), ...view.opaque.map((c) => c.path)])], order });
    }
    const rangeOf = (x: TrainCandidate, y: TrainCandidate): T.Range | undefined => {
      const pair = this.radar.get(pairKey(x.id, y.id));
      if (pair) return pair.range;
      const sx = shapes.get(x.id);
      const sy = shapes.get(y.id);
      return sx && sy ? computeRange(sx, sy, main.graph) : undefined;
    };
    const chosen = selectTrain(candidates, rangeOf, { maxSize });
    return chosen.map((c) => this.attempts.get(c.id)!).filter(Boolean);
  }

  /**
   * Write the marker for the whole train, merge it, then clear the marker and the queue entries of the work
   * that is done. A stop in between leaves them: the next run finds each merge on main (mainHolds) and
   * merges the rest one by one.
   */
  protected async runTrain(train: T.Attempt[], tries: number): Promise<void> {
    const head = train[0];
    const startedAt = Date.now();
    this.db.setMeta("landing", { id: head.id, startedAt, boot: this.bootId, tries, train: train.map((a) => a.id) } satisfies LandingRun);
    await this.scheduleBudgetRetry(startedAt + LANDING_LEASE_MS);
    const outcomes = new Map<string, TrainOutcome>();
    try {
      await this.landTrain(train, outcomes);
    } catch (err) {
      console.error("landTrain", head.id, errorLine(err), err);
      for (const a of train) {
        if (outcomes.has(a.id)) continue;
        const now = this.attempts.get(a.id) ?? a;
        outcomes.set(a.id, now.status === "landed" ? "done" : await this.mergeStopped(now, err));
      }
    }
    this.db.setMeta("landing", undefined);
    for (const a of train) if (outcomes.get(a.id) !== "wait" && outcomes.get(a.id) !== "early") this.db.dequeue(a.id);
  }

  /**
   * The work copy ended before the commit (it went back to its agent, or waits for a person). It leaves the queue now:
   * its agent may submit again while the rest of the train still runs, and that new entry must stay.
   */
  protected endEarly(outcomes: Map<string, TrainOutcome>, id: string): void {
    outcomes.set(id, "early");
    this.db.dequeue(id);
  }

  /** A work copy leaves a train before the commit: it stays in the queue and merges on its own in the next round. */
  protected leaveTrain(a: T.Attempt, intentBefore: T.IntentStatus, why: string): void {
    const intent = this.intents.get(a.intentId)!;
    a.status = "ready";
    intent.status = intentBefore === "landing" ? "underway" : intentBefore;
    this.putAttempt(a);
    this.putIntent(intent);
    this.addLog({ kind: "system", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: why });
  }

  // ───── Merge a train ─────

  /**
   * Merge a train: compose each work copy onto main, run the tests ONCE on main plus all of them, then
   * commit them one after the other (one commit per task, each with its own why-record; the repository
   * backend writes one commit at a time, so the commits follow each other on one tested tree). A train
   * whose tests fail is split (see findPassingTrain): the work that fails goes to its agent, the rest merges.
   * `outcomes` fills as the work copies settle, so a stop in the middle leaves no work copy in a wrong state.
   */
  protected async landTrain(train: T.Attempt[], outcomes: Map<string, TrainOutcome>): Promise<void> {
    const p = this.requireProject();
    const members: T.Attempt[] = [];
    for (const a of train) {
      // The same gates as a single merge: a merge that a stopped run made, a question without an answer, a yes that does not count.
      const held = await this.mainHolds(a);
      if (held) {
        await this.finishFromMain(a, held);
        outcomes.set(a.id, "done");
        continue;
      }
      if (a.approval?.status === "waiting") {
        this.endEarly(outcomes, a.id);
        continue;
      }
      if (a.approval?.status === "approved" && a.approval.digest && (await this.digestOf(a)) !== a.approval.digest) {
        outcomes.set(a.id, await this.landOne(a));
        continue;
      }
      members.push(a);
    }
    if (members.length <= 1) {
      for (const a of members) outcomes.set(a.id, await this.landOne(a));
      return;
    }
    const intentBefore = new Map<string, T.IntentStatus>();
    for (const a of members) {
      const intent = this.intents.get(a.intentId)!;
      intentBefore.set(a.id, intent.status);
      a.status = "landing";
      intent.status = "landing";
      this.putAttempt(a);
      this.putIntent(intent);
    }
    const main = await this.loadMain();
    // Each work copy composes onto main itself: independent work touches different files, so the union is the train.
    const pieces: TrainPiece[] = [];
    const taken = new Set<string>();
    for (const a of members) {
      const base = await this.treeText(p.repo.name, a.baseTree);
      const view = await this.attemptView(a);
      const reader = await this.workReader(a, view, [main]);
      const large = await this.largeChanges(view, reader);
      const left = [...view.notCarried, ...large];
      const work = large.length ? withoutChanges(base.snapshot, view.snapshot, large.map((n) => n.path)) : view.snapshot;
      const result = await compose({ base: base.snapshot, main: main.snapshot, attempt: work, readText: reader.readText, readBytes: reader.readBytes });
      if (!result.clean) {
        await this.markStale(a, `${result.conflicts.length} conflict${result.conflicts.length > 1 ? "s" : ""} on the new main: ${result.conflicts.map((c) => `${c.path} (${c.reason})`).join(", ")}`);
        this.endEarly(outcomes, a.id);
        continue;
      }
      const clash = result.changes.find((c) => taken.has(c.path));
      if (clash) {
        // The facts said independent, the real changes meet: this work merges on its own in the next round.
        this.leaveTrain(a, intentBefore.get(a.id)!, `The work of ${this.callsign(a.id)} changes ${clash.path}, as other work of the train does. It merges on its own next.`);
        outcomes.set(a.id, "wait");
        continue;
      }
      for (const c of result.changes) taken.add(c.path);
      pieces.push({ a, view, result, left });
    }
    if (!pieces.length) return;
    if (pieces.length === 1) {
      outcomes.set(pieces[0].a.id, await this.landOne(pieces[0].a));
      return;
    }
    const head = pieces[0].a;
    const trainId = newId("tr");
    const names = () => pieces.map((x) => this.callsign(x.a.id)).join(", ");
    let merge = pieces;
    let run: T.CheckRun | undefined;
    // Post-merge test mode: every work copy of the train passed its own tests at submit, so the train merges now.
    const testsAfter = pieces.every((x) => this.testsAfterMerge(x.a));
    if (!testsAfter) {
      this.addLog({ kind: "system", attemptId: head.id, message: `A train of ${pieces.length} work copies merges: ${names()}. The tests run once on main plus all of them.` });
      const runs = new Map<string, T.CheckRun>();
      const failedIn = new Map<string, { size: number; run: T.CheckRun }>();
      const keyOf = (set: readonly TrainPiece[]) => set.map((x) => x.a.id).sort().join(",");
      const test = async (set: readonly TrainPiece[]): Promise<T.CheckRun> => {
        const r = await this.testPieces(main, set, head.id);
        if (r.wait) throw new TestsWait(r.wait);
        runs.set(keyOf(set), r);
        if (!r.ok) for (const x of set) if ((failedIn.get(x.a.id)?.size ?? Infinity) > set.length) failedIn.set(x.a.id, { size: set.length, run: r });
        return r;
      };
      try {
        run = await test(pieces);
        if (!run.ok) {
          // The train failed: split it, find the work that fails, keep the rest (tested together before it merges).
          const found = await findPassingTrain(pieces, async (set) => (await test(set)).ok);
          for (const x of found.bad) {
            await this.markStale(x.a, `Tests fail on main plus this work. ${failureSummary(failedIn.get(x.a.id)!.run.cases, 3)}`);
            this.endEarly(outcomes, x.a.id);
          }
          for (const x of found.later) {
            this.leaveTrain(x.a, intentBefore.get(x.a.id)!, `The work of ${this.callsign(x.a.id)} passes its tests alone and fails with the other work of the train. It merges on its own next.`);
            outcomes.set(x.a.id, "wait");
          }
          merge = found.good;
          this.addLog({
            kind: "system",
            attemptId: head.id,
            message: `The train split after ${found.runs + 1} test runs. Fails: ${found.bad.map((x) => this.callsign(x.a.id)).join(", ") || "none"}. Merges: ${merge.map((x) => this.callsign(x.a.id)).join(", ") || "none"}.`,
          });
          if (!merge.length) return;
          run = runs.get(keyOf(merge))!;
        }
      } catch (err) {
        if (!(err instanceof TestsWait)) throw err;
        for (const x of pieces) {
          if (outcomes.has(x.a.id)) continue;
          this.waitForTests(x.a, err.wait, intentBefore.get(x.a.id)!);
          outcomes.set(x.a.id, "wait");
        }
        return;
      }
      if (noTestRan(run) && !p.settings.allowUntested) {
        for (const x of merge) {
          if (this.pickedLineage(x.a)) continue;
          await this.askBecauseNoTestRan(x.a);
          this.endEarly(outcomes, x.a.id);
        }
        merge = merge.filter((x) => !outcomes.has(x.a.id));
        if (!merge.length) return;
      }
      for (const x of merge) {
        x.a.mergeWait = undefined;
        x.a.composedChecks = run;
        this.putAttempt(x.a);
      }
    } else {
      this.addLog({ kind: "system", attemptId: head.id, message: `A train of ${pieces.length} work copies merges: ${names()}. Main is tested after the merge.` });
    }
    // One commit per task, each on the one before, each with its own why-record.
    let parent = main.sha;
    const ids = merge.map((x) => x.a.id);
    for (let i = 0; i < merge.length; i++) {
      const x = merge[i];
      const a = x.a;
      const intent = this.intents.get(a.intentId)!;
      const agent = this.agents.get(a.agentId)!;
      const method: T.LandingMethod = a.lineage.generation > 1 ? "rederive" : x.result.method;
      const applied = a.corrections.map((id) => this.corrections.get(id)).filter((c): c is T.Correction => !!c && c.status !== "superseded");
      const courseChecks = this.db.checksFor<T.CourseCheck>(a.id);
      const decision = [...this.decisions].reverse().find((d) => d.attemptIds[0] === a.id && d.kind === "pick");
      const changes = [...x.result.changes];
      if (p.settings.intentsInRepo) {
        const f = intentFile({ ...intent, status: "landed" }, { attemptId: a.id, agent, method });
        changes.push({ path: f.path, content: f.content });
      }
      const checks = testsAfter ? a.checks! : run!;
      const train: TrainInfo = { id: trainId, place: i + 1, size: merge.length, attemptIds: ids };
      const message = landingMessage({ intent, attempt: a, agent, method, corrections: applied, checks, train, testsAfter });
      const note = landingNote({ intent, attempt: a, agent, method, corrections: applied, courseChecks, checks, decision, train, testsAfter });
      let committed: { sha: string; tree: string };
      try {
        committed = await this.backend.commit({ repo: p.repo.name, branch: this.branch, parent, changes, message, note, author: GITRING_AUTHOR });
      } catch (err) {
        if (!(err instanceof RepoConflictError || String(err).includes("RepoConflict"))) {
          // An error of the repository: this merge stops and waits (as a single merge does). The rest of the train does not wait for it.
          console.error("landTrain", a.id, errorLine(err), err);
          outcomes.set(a.id, await this.mergeStopped(a, err));
          for (const y of merge.slice(i + 1)) {
            this.leaveTrain(y.a, intentBefore.get(y.a.id)!, `The merge of the work of ${this.callsign(a.id)} stopped. The work of ${this.callsign(y.a.id)} merges on its own next.`);
            outcomes.set(y.a.id, "wait");
          }
          return;
        }
        // Main is not where gitring thinks. Catch up with it now, so the next round composes on the real main.
        // The rest of the train stays queued and merges one by one.
        await this.catchUpMain(a);
        for (const y of merge.slice(i)) {
          this.leaveTrain(y.a, intentBefore.get(y.a.id)!, `Main moved under the train. The work of ${this.callsign(y.a.id)} merges on its own next.`);
          outcomes.set(y.a.id, "wait");
        }
        return;
      }
      await this.recordLanding(a, { committed, before: parent, method, applied, run: checks, message, note, touched: x.result.touched, left: x.left, train: { id: trainId, place: i + 1, size: merge.length }, testsWhen: testsAfter ? "after" : "before" });
      outcomes.set(a.id, "done");
      parent = committed.sha;
    }
    this.stats.trains = (this.stats.trains ?? 0) + 1;
    this.persistStats();
    if (testsAfter) this.scheduleMainTests();
  }
}
