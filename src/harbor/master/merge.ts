/**
 * Merges one work copy onto main: compose, test, commit, and the cases where the merge stops.
 * Layer 19 of the chain in master/README.md. Extends HarborMainTests (main-tests.ts).
 * Only one merge runs at a time for a project (see queue.ts).
 * Read next: trains.ts.
 */
import type * as T from "../../core/types";
import { noTestRan } from "../../core/types";
import { approvalLine } from "../../core/approvals";
import { RepoConflictError, type CommitMeta } from "../../platform/repo/backend";
import { applyFileChanges } from "../../core/git/snapshot";
import { compose, type ComposeResult } from "../../core/land/compose";
import { withoutChanges, type NotCarried } from "../../core/land/carry";
import { landingMessage, landingNote, intentFile, parseTrailers } from "../../core/logbook";
import { textEligible } from "../../core/repo-rules";
import { CHECK_RUN, newId } from "../ids";
import { failureSummary, type AttemptView, type MainView } from "../views";
import { GITRING_AUTHOR, LANDING_LEASE_MS, MAX_LANDING_STARTS, NO_TEST_RAN } from "../support/constants";
import type { LandingRun, TrainPiece } from "../support/types";
import { HarborMainTests } from "./main-tests";

export abstract class HarborMerge extends HarborMainTests {
  // ───── Merge one work copy ─────

  /**
   * The commit on main that merged this work copy, when a run made it and stopped: the message of the
   * commit names the work copy. gitring merges one work copy at a time, so only the last commits can hold it.
   */
  protected async mainHolds(a: T.Attempt): Promise<CommitMeta | undefined> {
    const recent = await this.backend.log(this.requireProject().repo.name, this.branch, 8);
    return recent.find((c) => parseTrailers(c.message)["Gitring-Attempt"] === a.id);
  }

  /**
   * A commit to main failed because main moved. Read the real main and catch up, oldest commit first: a merge
   * of a work copy that a stopped run made gets its record now (finishFromMain); a commit that gitring did not
   * make becomes main as it is. True when gitring's main moved, so that the merge of `current` can try again.
   */
  protected async catchUpMain(current: T.Attempt): Promise<boolean> {
    const p = this.requireProject();
    const before = p.mainSha;
    const tip = await this.backend.resolve(p.repo.name, this.branch).catch(() => null);
    if (!tip || tip === before) return false;
    const recent = await this.backend.log(p.repo.name, this.branch, 20).catch(() => [] as CommitMeta[]);
    const at = recent.findIndex((c) => c.hash === before);
    // When gitring's main is not among the last commits, only the tip counts.
    const newer = (at >= 0 ? recent.slice(0, at) : recent.slice(0, 1)).reverse();
    for (const c of newer) {
      const id = parseTrailers(c.message)["Gitring-Attempt"];
      // The merge of this work copy itself: the next try finds it on main and writes its record.
      if (id === current.id) break;
      const other = id ? this.attempts.get(id) : undefined;
      if (other && !this.landings.some((l) => l.mainAfter === c.hash)) {
        this.addLog({ kind: "system", attemptId: current.id, message: `Main moved under the merge of the work of ${this.callsign(current.id)}: a stopped run merged the work of ${this.callsign(other.id)} (${c.hash.slice(0, 7)}). gitring writes that record first.` });
        await this.finishFromMain(other, c);
      }
      if (p.mainSha !== c.hash) await this.adoptMainCommit(c);
    }
    return p.mainSha !== before;
  }

  /** Main has the merge of this work copy: a run stopped after the commit. Write the record now, commit nothing. */
  protected async finishFromMain(a: T.Attempt, commit: CommitMeta): Promise<void> {
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    const trailers = parseTrailers(commit.message);
    const word = trailers["Gitring-Method"];
    const method: T.LandingMethod = word === "fast-forward" || word === "rederive" ? word : "merge";
    // A merge that rode in a train, or one in post-merge test mode: the trailers say so.
    const ride = /^(\S+) (\d+)\/(\d+)$/.exec(trailers["Gitring-Train"] ?? "");
    const train = ride ? { id: ride[1], place: Number(ride[2]), size: Number(ride[3]) } : undefined;
    const testsWhen: T.TestsWhen = trailers["Gitring-Tests"] === "after" ? "after" : "before";
    const applied = a.corrections.map((id) => this.corrections.get(id)).filter((c): c is T.Correction => !!c && c.status !== "superseded");
    const run: T.CheckRun = a.composedChecks ?? a.checks ?? { id: newId(CHECK_RUN), subject: commit.treeHash, scope: "composed", ok: true, passed: 0, failed: 0, cases: [], ms: 0, at: Date.now() };
    const decision = [...this.decisions].reverse().find((d) => d.attemptIds[0] === a.id && d.kind === "pick");
    const note =
      (await this.backend.readNote(p.repo.name, commit.hash).catch(() => null)) ??
      landingNote({ intent, attempt: a, agent, method, corrections: applied, courseChecks: this.db.checksFor<T.CourseCheck>(a.id), checks: run, decision });
    this.addLog({
      kind: "system",
      attemptId: a.id,
      message: `Main has the merge of the work of ${this.callsign(a.id)} already (${commit.hash.slice(0, 7)}). gitring writes its record now.`,
    });
    await this.recordLanding(a, {
      committed: { sha: commit.hash, tree: commit.treeHash },
      before: commit.parents[0] ?? p.mainSha,
      method,
      applied,
      run,
      message: commit.message,
      note,
      touched: Object.keys(a.footprint.files),
      train,
      testsWhen,
    });
    if (testsWhen === "after") this.scheduleMainTests();
  }

  /** "wait": the test budget is used. The work copy stays queued and gitring tries again later. */
  protected async landOne(a: T.Attempt, attempt = 0): Promise<"done" | "wait"> {
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    if (await this.stopsBeforeMerge(a)) return "done";
    const intentBefore = intent.status;
    a.status = "landing";
    intent.status = "landing";
    this.putAttempt(a);
    this.putIntent(intent);
    const { main, view, result, left } = await this.composeWork(a, p);
    if (!result.clean) {
      await this.markStale(a, `${result.conflicts.length} conflict${result.conflicts.length > 1 ? "s" : ""} on the new main: ${result.conflicts.map((c) => `${c.path} (${c.reason})`).join(", ")}`);
      return "done";
    }
    // Post-merge test mode: the tests of the work passed at submit, so the work merges now, and main is tested
    // after the merge (see testMain). Work whose tests did not run goes the usual way: tests first.
    const testsAfter = this.testsAfterMerge(a);
    const run = await this.testBeforeMerge({ a, p, main, view, result, left, intentBefore, testsAfter });
    if (run === "wait" || run === "done") return run;
    const { method, applied, message, note, changes } = this.landingParts({ a, p, intent, agent, result, run, testsAfter });
    let committed: { sha: string; tree: string };
    try {
      committed = await this.backend.commit({ repo: p.repo.name, branch: this.branch, parent: main.sha, changes, message, note, author: GITRING_AUTHOR });
    } catch (err) {
      // Main is not where gitring thinks: a run that stopped after its commit, or a commit from outside gitring.
      // A second try on the same main fails the same way. Catch up with the real main, then compose and test again.
      if ((err instanceof RepoConflictError || String(err).includes("RepoConflict")) && attempt < 1 && (await this.catchUpMain(a))) {
        return this.landOne(a, attempt + 1);
      }
      throw err;
    }
    await this.recordLanding(a, { committed, before: main.sha, method, applied, run, message, note, touched: result.touched, left, testsWhen: testsAfter ? "after" : "before" });
    if (testsAfter) this.scheduleMainTests();
    return "done";
  }

  // ───── The steps of one merge ─────

  /** The gates of a merge that no queue can open. True: the merge stops here and the work copy is done for this round. */
  protected async stopsBeforeMerge(a: T.Attempt): Promise<boolean> {
    // A run that stopped after its commit: main has the merge. Finish the record, do not commit twice.
    const held = await this.mainHolds(a);
    if (held) {
      await this.finishFromMain(a, held);
      return true;
    }
    // A question that a person has not answered: nothing merges. This is the rule, whatever put the work in the queue.
    if (a.approval?.status === "waiting") return true;
    // A yes counts for the work that the person saw. If the work changed since, the yes does not count.
    if (a.approval?.status === "approved" && a.approval.digest && (await this.digestOf(a)) !== a.approval.digest) {
      a.approval = { ...a.approval, status: "withdrawn", closed: "The agent changed the work after the yes." };
      a.status = "underway";
      this.putAttempt(a);
      this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The merge of the work of ${this.callsign(a.id)} stops: the work changed after the yes. The agent must submit again.` });
      this.refreshJudging(a.intentId);
      return true;
    }
    return false;
  }

  /** Composes the work onto the new main. The work that cannot go in is the "left" part. */
  protected async composeWork(a: T.Attempt, p: T.Project): Promise<{ main: MainView; view: AttemptView; result: ComposeResult; left: NotCarried[] }> {
    const main = await this.loadMain();
    const base = await this.treeText(p.repo.name, a.baseTree);
    const view = await this.attemptView(a);
    const reader = await this.workReader(a, view, [main]);
    // The real tree of the work: binary and large files, modes and symlinks merge too. A file too large to carry stays out.
    const large = await this.largeChanges(view, reader);
    const left = [...view.notCarried, ...large];
    const work = large.length ? withoutChanges(base.snapshot, view.snapshot, large.map((n) => n.path)) : view.snapshot;
    const result = await compose({ base: base.snapshot, main: main.snapshot, attempt: work, readText: reader.readText, readBytes: reader.readBytes });
    return { main, view, result, left };
  }

  /** The tests of main plus the work, before the merge. A string: the merge ends here ("wait": the test budget is used). */
  protected async testBeforeMerge(f: { a: T.Attempt; p: T.Project; main: MainView; view: AttemptView; result: ComposeResult; left: NotCarried[]; intentBefore: T.IntentStatus; testsAfter: boolean }): Promise<T.CheckRun | "wait" | "done"> {
    const { a, p, main, view, result, left, intentBefore, testsAfter } = f;
    let run: T.CheckRun;
    if (testsAfter) run = a.checks!;
    else {
      run = await this.testPieces(main, [{ a, view, result, left }], a.id);
      if (run.wait) {
        // The test budget is used: no test ran. This is not a failure. The work copy stays queued,
        // it does not go back to its agent, and the alarm starts the merge again at the next window.
        this.waitForTests(a, run.wait, intentBefore);
        return "wait";
      }
      a.mergeWait = undefined;
      a.composedChecks = run;
      this.putAttempt(a);
      if (!run.ok) {
        await this.markStale(a, `Tests fail on main plus this work. ${failureSummary(run.cases, 3)}`);
        return "done";
      }
      if (noTestRan(run) && !p.settings.allowUntested && !this.pickedLineage(a)) {
        await this.askBecauseNoTestRan(a);
        return "done";
      }
    }
    return run;
  }

  /** The words of the commit and of the why-record, and the change list. */
  protected landingParts(f: { a: T.Attempt; p: T.Project; intent: T.Intent; agent: T.AgentInfo; result: ComposeResult; run: T.CheckRun; testsAfter: boolean }): { method: T.LandingMethod; applied: T.Correction[]; message: string; note: string; changes: ComposeResult["changes"] } {
    const { a, p, intent, agent, result, run, testsAfter } = f;
    const method: T.LandingMethod = a.lineage.generation > 1 ? "rederive" : result.method;
    const applied = a.corrections.map((id) => this.corrections.get(id)).filter((c): c is T.Correction => !!c && c.status !== "superseded");
    const courseChecks = this.db.checksFor<T.CourseCheck>(a.id);
    const decision = [...this.decisions].reverse().find((d) => d.attemptIds[0] === a.id && d.kind === "pick");
    const changes = [...result.changes];
    if (p.settings.intentsInRepo) {
      const f = intentFile({ ...intent, status: "landed" }, { attemptId: a.id, agent, method });
      changes.push({ path: f.path, content: f.content });
    }
    const message = landingMessage({ intent, attempt: a, agent, method, corrections: applied, checks: run, testsAfter });
    const note = landingNote({ intent, attempt: a, agent, method, corrections: applied, courseChecks, checks: run, decision, testsAfter });
    return { method, applied, message, note, changes };
  }

  /** Post-merge test mode, and the tests of the work passed at submit: the work merges now, main is tested after. */
  protected testsAfterMerge(a: T.Attempt): boolean {
    return this.requireProject().settings.testsWhen === "after" && !!a.checks?.ok && !a.checks.wait;
  }

  /**
   * The tests of main plus the given work: the text tree for the gitring harness, the whole tree for the test
   * container. Several pieces make one tree (a train: independent work touches different files).
   */
  protected async testPieces(main: MainView, pieces: readonly TrainPiece[], attemptId: string): Promise<T.CheckRun> {
    const p = this.requireProject();
    const changes = pieces.flatMap((x) => x.result.changes);
    const composed = new Map(main.text);
    for (const ch of changes) {
      if (typeof ch.content === "string" && textEligible(ch.path)) composed.set(ch.path, ch.content);
      else composed.delete(ch.path);
    }
    return this.runTreeChecks(composed, "composed", attemptId, async () => {
      const { snapshot, blobs } = await applyFileChanges(main.snapshot, changes);
      return this.fullTree(snapshot, this.blobReader({ trees: [main], repos: [p.repo.name, ...pieces.map((x) => x.view.repo)], known: blobs }));
    });
  }

  /** The test budget is used: the work copy waits in the queue, and the alarm starts its merge again at the next window. */
  protected waitForTests(a: T.Attempt, wait: NonNullable<T.CheckRun["wait"]>, intentBefore: T.IntentStatus): void {
    const intent = this.intents.get(a.intentId)!;
    a.status = "ready";
    a.mergeWait = { until: wait.retryAt, message: wait.message };
    intent.status = intentBefore === "landing" ? "underway" : intentBefore;
    this.putAttempt(a);
    this.putIntent(intent);
    this.addLog({ kind: "system", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The merge of the work of ${this.callsign(a.id)} waits. ${wait.message}` });
  }

  /** No test ran on main plus this work: nothing is verified. A person must say yes first. */
  protected async askBecauseNoTestRan(a: T.Attempt): Promise<void> {
    const intent = this.intents.get(a.intentId)!;
    a.status = "ready";
    const approval = await this.askApproval(a, { reason: "no-test-ran", why: ["No test ran on main plus this work. The work is not verified."] });
    intent.status = "judging";
    this.putAttempt(a);
    this.putIntent(intent);
    this.addLog({ kind: "decision", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The merge of the work of ${this.callsign(a.id)} stops. ${NO_TEST_RAN}` });
    this.webhook("approval", { attemptId: a.id, approval, task: intent.title, agent: this.callsign(a.id), line: approvalLine(a), link: this.approvalLink(a) });
    this.notifyPeople(approval.approver ? [approval.approver.id] : [], "approval");
  }

  // ───── When a merge stops ─────

  /** True when this queued work copy may start its merge now (see pickLanding). */
  protected mayStartNow(a: T.Attempt, marker: LandingRun | undefined, now: number): boolean {
    if (a.status !== "ready" && a.status !== "landing") return false;
    // The test budget is used: this merge waits for the time that gitring gave. The alarm wakes the queue then.
    if (a.mergeWait && a.mergeWait.until > now) return false;
    const held = marker && (marker.id === a.id || marker.train?.includes(a.id)) ? marker : undefined;
    // Another object began this merge: it may still run until the lease ends.
    return !(held && held.boot !== this.bootId && held.startedAt + LANDING_LEASE_MS > now);
  }

  /**
   * The merge stopped with an error: the repository did not answer, for example. The work is fine, so the work
   * copy stays in the queue and gitring tries the merge again after a short wait (1, 2 and 4 seconds). A merge
   * that stops a fourth time goes to a person. gitring never drops a queued work copy without saying so.
   */
  protected async mergeStopped(a: T.Attempt, err: unknown): Promise<"done" | "wait"> {
    const intent = this.intents.get(a.intentId);
    const name = this.callsign(a.id);
    const reason = String(err).slice(0, 200);
    a.status = "ready";
    a.mergeStops = (a.mergeStops ?? 0) + 1;
    if (intent?.status === "landing") {
      intent.status = "underway";
      this.putIntent(intent);
    }
    if (a.mergeStops >= MAX_LANDING_STARTS) {
      a.mergeWait = undefined;
      await this.askAboutStoppedMerge(
        a,
        `The merge stopped ${a.mergeStops} times with an error: ${reason}. A yes starts it again.`,
        `The merge of the work of ${name} stopped ${a.mergeStops} times: ${reason}. A person must decide on "${intent?.title ?? "this task"}".`,
      );
      return "done";
    }
    const seconds = 2 ** (a.mergeStops - 1);
    a.mergeWait = { until: Date.now() + seconds * 1000, message: `The merge stopped: ${reason}. gitring tries it again in ${seconds} second${seconds === 1 ? "" : "s"}.` };
    this.putAttempt(a);
    this.addLog({ kind: "system", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The merge of the work of ${name} stopped: ${reason}. gitring tries it again in ${seconds} second${seconds === 1 ? "" : "s"}.` });
    return "wait";
  }

  /** A merge that cannot finish goes to a person. A yes starts it again. */
  protected async askAboutStoppedMerge(a: T.Attempt, why: string, logMessage: string): Promise<void> {
    this.db.setMeta("landing", undefined);
    this.db.dequeue(a.id);
    const intent = this.intents.get(a.intentId);
    a.status = "ready";
    const approval = await this.askApproval(a, { reason: "merge-stopped", why: [why] });
    this.putAttempt(a);
    if (intent) {
      intent.status = "judging";
      this.putIntent(intent);
    }
    this.webhook("approval", { attemptId: a.id, approval, task: intent?.title ?? "", agent: this.callsign(a.id), line: approvalLine(a), link: this.approvalLink(a) });
    this.notifyPeople(approval.approver ? [approval.approver.id] : [], "approval");
    this.stats.escalations += 1;
    this.persistStats();
    this.addLog({ kind: "decision", attemptId: a.id, intentId: a.intentId, message: logMessage });
  }
}
