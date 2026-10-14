/**
 * Tests main after merges (post-merge test mode) and reverts a merge that broke main.
 * Layer 18 of the chain in master/README.md. Extends HarborMergeRecord (merge-record.ts).
 * A revert is a merge too: it runs in the same serial chain as other merges.
 * Read next: merge.ts.
 */
import type * as T from "../../core/types";
import { REVERT_OPTIONS, revertFacts } from "../../core/inbox";
import { RepoConflictError } from "../../platform/repo/backend";
import { applyFileChanges, type Snapshot } from "../../core/git/snapshot";
import { compose } from "../../core/land/compose";
import { firstPassingUndo } from "../../core/land/train";
import { revertMessage, revertNote } from "../../core/logbook";
import { textEligible } from "../../core/repo-rules";
import { newId } from "../ids";
import { failureSummary, type MainView, type TreeText } from "../views";
import { GITRING_AUTHOR } from "../support/constants";
import { SYSTEM, errorLine } from "../support/helpers";
import { TestsWait } from "../support/types";
import type { MainTests } from "../support/types";
import { HarborMergeRecord } from "./merge-record";

export abstract class HarborMainTests extends HarborMergeRecord {
  // ───── Tests of main ─────

  /** Post-merge test mode, and main has a merge that its tests did not see yet. */
  protected mainTestsDue(): boolean {
    const p = this.project;
    if (!p || p.importing || p.settings.testsWhen !== "after") return false;
    const st = this.db.getMeta<MainTests>("mainTests");
    return st?.tested !== p.mainSha && !(st?.retryAt && st.retryAt > Date.now());
  }

  /** Test main in the background, after the run that tests it now (one run at a time). */
  protected scheduleMainTests(): void {
    const job = this.mainTestChain.then(() => this.testMain());
    this.mainTestChain = job.catch((e) => console.error("main tests", errorLine(e), e));
    this.ctx.waitUntil(this.mainTestChain);
  }

  /**
   * The tests of main after merges. A main that passes is the new "last green main". When main fails, gitring
   * looks for the merge that broke it among the merges since the last green main (see revertBrokenMerge),
   * reverts it, and tests main again.
   */
  protected async testMain(): Promise<void> {
    const p = this.project;
    if (!p || p.importing || p.settings.testsWhen !== "after") return;
    const state = this.db.getMeta<MainTests>("mainTests") ?? {};
    const main = await this.loadMain();
    if (state.tested === main.sha) return;
    const run = await this.runTreeChecks(main.text, "main", "main", async () => this.fullTree(main.snapshot, this.blobReader({ trees: [main], repos: [p.repo.name] })));
    if (run.wait) {
      this.db.setMeta("mainTests", { ...state, retryAt: run.wait.retryAt } satisfies MainTests);
      await this.scheduleBudgetRetry(run.wait.retryAt);
      this.addLog({ kind: "system", message: `The tests of main ${main.sha.slice(0, 7)} wait. ${run.wait.message}` });
      return;
    }
    const next: MainTests = { ...state, tested: main.sha, retryAt: undefined, last: { sha: main.sha, ok: run.ok, at: Date.now(), passed: run.passed, failed: run.failed } };
    if (run.ok) {
      next.lastGreen = main.sha;
      this.db.setMeta("mainTests", next);
      this.addLog({ kind: "check", message: `Main ${main.sha.slice(0, 7)} passes its tests after the merge: ${run.passed}/${run.passed + run.failed} pass.`, data: { checkRunId: run.id, ok: true, mainSha: main.sha } });
      return;
    }
    this.db.setMeta("mainTests", next);
    this.addLog({ kind: "check", message: `Tests fail on main ${main.sha.slice(0, 7)} after a merge. ${failureSummary(run.cases, 3)} gitring looks for the merge that broke them.`, data: { checkRunId: run.id, ok: false, mainSha: main.sha } });
    await this.revertBrokenMerge(main, run, next);
    // The revert moved main: its tests run next (the chain goes on).
    if (this.mainTestsDue()) this.scheduleMainTests();
  }

  /** The tree of a commit of main, with its text. */
  protected async commitTree(sha: string): Promise<TreeText> {
    const p = this.requireProject();
    const c = await this.backend.readCommit(p.repo.name, sha);
    if (!c) throw new Error(`Main does not have commit ${sha.slice(0, 7)} any more.`);
    return this.treeText(p.repo.name, c.treeHash);
  }

  /** The merges that may have broken main: since the last green main, newest last, not reverted. */
  protected suspectMerges(state: MainTests): T.Landing[] {
    const since = state.lastGreen ? this.mainPlace(state.lastGreen) : -1;
    const reverted = new Set(this.landings.filter((l) => l.method === "revert" && l.revert).map((l) => l.revert!.of));
    return this.landings
      .filter((l) => l.method !== "revert" && !reverted.has(l.id) && this.mainPlace(l.mainAfter) > since)
      .sort((x, y) => this.mainPlace(x.mainAfter) - this.mainPlace(y.mainAfter))
      .slice(-32);
  }

  // ───── Revert a merge that broke main ─────

  /**
   * Main fails. Undo the newest merges one by one (a 3-way merge of each merge's parent onto the current
   * tree), test the trees in a binary search (firstPassingUndo), and name the merge that broke main: the
   * newest one whose undo makes main pass. Then revert it with its own commit and why-record.
   */
  protected async revertBrokenMerge(main: MainView, run: T.CheckRun, state: MainTests): Promise<void> {
    const p = this.requireProject();
    const suspects = this.suspectMerges(state);
    if (!suspects.length) {
      this.addLog({ kind: "system", message: `Tests fail on main ${main.sha.slice(0, 7)}, and no merge since the last main that passed can be the cause. A person must look.` });
      this.webhook("main", { reason: "tests-fail", mainSha: main.sha, failed: run.failed });
      return;
    }
    type Undone = { snapshot: Snapshot; text: Map<string, string>; known: Map<string, string | Uint8Array> };
    const undone: Undone[] = [{ snapshot: main.snapshot, text: main.text, known: new Map() }];
    let stuck: T.Landing | undefined;
    // The chain of undone trees, newest merge first. An undo that is not clean ends the chain.
    for (let n = 1; n <= suspects.length; n++) {
      const l = suspects[suspects.length - n];
      const cur = undone[n - 1];
      const before = await this.commitTree(l.mainBefore);
      const after = await this.commitTree(l.mainAfter);
      const reader = this.blobReader({ trees: [main, before, after], repos: [p.repo.name], known: cur.known });
      const res = await compose({ base: after.snapshot, main: cur.snapshot, attempt: before.snapshot, readText: reader.readText, readBytes: reader.readBytes });
      if (!res.clean) {
        stuck = l;
        break;
      }
      const applied = await applyFileChanges(cur.snapshot, res.changes);
      const text = new Map(cur.text);
      for (const ch of res.changes) {
        if (typeof ch.content === "string" && textEligible(ch.path)) text.set(ch.path, ch.content);
        else text.delete(ch.path);
      }
      undone.push({ snapshot: applied.snapshot, text, known: new Map([...cur.known, ...applied.blobs]) });
    }
    const depth = undone.length - 1;
    let k: number | undefined;
    try {
      k = await firstPassingUndo(depth, async (n) => {
        const t = undone[n];
        const r = await this.runTreeChecks(t.text, "main", "main", async () => this.fullTree(t.snapshot, this.blobReader({ trees: [main], repos: [p.repo.name], known: t.known })));
        if (r.wait) throw new TestsWait(r.wait);
        return r.ok;
      });
    } catch (err) {
      if (!(err instanceof TestsWait)) throw err;
      this.db.setMeta("mainTests", { ...state, tested: undefined, retryAt: err.wait.retryAt } satisfies MainTests);
      await this.scheduleBudgetRetry(err.wait.retryAt);
      this.addLog({ kind: "system", message: `The search for the merge that broke main waits. ${err.wait.message}` });
      return;
    }
    if (k === undefined) {
      if (stuck) {
        await this.askAboutBrokenMain(stuck, run, `gitring cannot undo "${this.intents.get(stuck.intentId)?.title ?? "an older merge"}" alone: later merges changed the same lines.`);
        return;
      }
      this.addLog({ kind: "system", message: `Tests fail on main ${main.sha.slice(0, 7)} with every merge since the last main that passed undone. No merge is the cause. A person must look.` });
      this.webhook("main", { reason: "tests-fail", mainSha: main.sha, failed: run.failed });
      return;
    }
    const culprit = suspects[suspects.length - k];
    await this.serialWithMerges(() => this.commitRevert(culprit, run));
  }

  /** Run after the merges that run now, and before the next one: the queue waits for it. */
  protected serialWithMerges<X>(fn: () => Promise<X>): Promise<X> {
    const job = this.landingChain.then(fn);
    this.landingChain = job.catch((e) => console.error("after merges", errorLine(e), e));
    this.ctx.waitUntil(this.landingChain);
    return job;
  }

  /**
   * Revert one merge on the current main: a 3-way merge of the merge's parent onto main, with the merge as the
   * base. A clean undo becomes the revert commit; one that is not clean goes to a person.
   */
  protected async commitRevert(culprit: T.Landing, run: T.CheckRun): Promise<void> {
    const p = this.requireProject();
    const a = this.attempts.get(culprit.attemptId);
    const intent = this.intents.get(culprit.intentId);
    const agent = a ? this.agents.get(a.agentId) : undefined;
    if (!a || !intent || !agent) throw new Error(`The records of merge ${culprit.mainAfter.slice(0, 7)} are gone.`);
    if (this.landings.some((l) => l.method === "revert" && l.revert?.of === culprit.id)) return;
    const main = await this.loadMain();
    const before = await this.commitTree(culprit.mainBefore);
    const after = await this.commitTree(culprit.mainAfter);
    const reader = this.blobReader({ trees: [main, before, after], repos: [p.repo.name] });
    const res = await compose({ base: after.snapshot, main: main.snapshot, attempt: before.snapshot, readText: reader.readText, readBytes: reader.readBytes });
    if (!res.clean) {
      await this.askAboutBrokenMain(culprit, run, `gitring cannot undo "${intent.title}" alone: later merges changed the same lines.`);
      return;
    }
    const failed = run.cases.filter((c) => !c.ok).map((c) => `${c.file}: ${c.name}`);
    const approvedBy = a.approval?.status === "approved" ? a.approval.answer?.by.name : undefined;
    const message = revertMessage({ intent, attempt: a, agent, mergeSha: culprit.mainAfter, failed, checks: run });
    const note = revertNote({ intent, attempt: a, agent, mergeSha: culprit.mainAfter, landingId: culprit.id, checks: run, approvedBy });
    let committed: { sha: string; tree: string };
    try {
      committed = await this.backend.commit({ repo: p.repo.name, branch: this.branch, parent: main.sha, changes: res.changes, message, note, author: GITRING_AUTHOR });
    } catch (err) {
      if (!(err instanceof RepoConflictError || String(err).includes("RepoConflict"))) throw err;
      // Main moved under the revert: the next test of main looks again.
      this.addLog({ kind: "system", message: `Main moved while gitring reverted "${intent.title}". gitring tests the new main first.` });
      return;
    }
    await this.recordRevert(culprit, a, { committed, before: main.sha, run, message, note, failed, touched: res.touched });
    await this.reopenAfterRevert(a, culprit, run, failed, committed.sha, approvedBy);
  }

  /** The record of a revert: the new main, a landing with method "revert", the events. */
  protected async recordRevert(culprit: T.Landing, a: T.Attempt, done: { committed: { sha: string; tree: string }; before: string; run: T.CheckRun; message: string; note: string; failed: string[]; touched: string[] }): Promise<void> {
    const { committed, before, run, message, note, failed, touched } = done;
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    if (p.mainSha === before) {
      p.mainSha = committed.sha;
      p.mainTree = committed.tree;
      this.db.setMeta("project", p);
      this.appendMainSeq(committed.sha);
    }
    const landing: T.Landing = {
      id: newId("ld"),
      attemptId: a.id,
      intentId: intent.id,
      agentId: a.agentId,
      method: "revert",
      mainBefore: before,
      mainAfter: committed.sha,
      checks: run,
      correctionsApplied: 0,
      at: Date.now(),
      message,
      testsWhen: "after",
      revert: { of: culprit.id, mainSha: culprit.mainAfter, reason: "reverted: tests failed on main", failed },
    };
    this.landings.push(landing);
    this.db.putLanding(landing, note);
    try {
      this.derived.landed(touched.length);
    } catch (e) {
      console.warn("history", errorLine(e));
    }
    this.stats.landedByMethod.revert = (this.stats.landedByMethod.revert ?? 0) + 1;
    this.stats.reverts = (this.stats.reverts ?? 0) + 1;
    this.persistStats();
    const newMain = await this.loadMain();
    this.emit({ type: "landing", landing });
    this.emit({ type: "main", sha: newMain.sha, tree: newMain.tree, files: newMain.files, imports: newMain.imports });
    this.addLog({
      kind: "land",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: intent.id,
      message: `gitring reverts "${intent.title}" (${culprit.mainAfter.slice(0, 7)}) with commit ${committed.sha.slice(0, 7)}: tests failed on main after the merge. ${failureSummary(run.cases, 3)}`,
      files: touched,
    });
    this.webhook("landing", { landing, intent: { id: intent.id, title: intent.title }, callsign: agent.callsign, mainSha: committed.sha, revert: landing.revert });
    this.wakeAll({ kind: "main-moved", at: Date.now(), mainSha: committed.sha, message: `Main moved to ${committed.sha.slice(0, 7)}: "${intent.title}" reverted.` });
  }

  /**
   * After a revert, the task is open again. An outside agent gets its work copy back on the new main with a
   * change request that names the failed tests (and the redo clock runs, as when work does not merge). A
   * built-in agent does the task again on the new main. A person who said yes to the work hears it in the inbox.
   */
  protected async reopenAfterRevert(a: T.Attempt, culprit: T.Landing, run: T.CheckRun, failed: string[], revertSha: string, approvedBy?: string): Promise<void> {
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    const name = this.callsign(a.id) ?? a.agentId;
    const failedText = failureSummary(run.cases, 3);
    const why = `Tests failed on main after the merge. ${failedText}`;
    intent.status = "underway";
    intent.landedSha = undefined;
    intent.chosenAttemptId = undefined;
    this.putIntent(intent);
    const outside = agent.kind !== "builtin" && p.settings.redo !== "builtin";
    if (outside) {
      const now = Date.now();
      const minutes = Math.max(5, Math.min(120, Math.round(p.settings.redoWaitMinutes || 15)));
      a.status = "underway";
      a.landedAt = undefined;
      a.composedChecks = undefined;
      a.returns = (a.returns ?? 0) + 1;
      a.returned = { at: now, until: now + minutes * 60_000, reason: why, policy: p.settings.redo === "agent-only" ? "agent-only" : "agent-first" };
      this.putAttempt(a);
      if (!agent.attemptId || agent.attemptId === a.id) {
        agent.status = "underway";
        agent.attemptId = a.id;
        this.putAgent(agent);
      }
      const main = await this.loadMain();
      let steps: string;
      if (a.mode === "api") {
        const moved = await this.replot(a, main).catch((e) => {
          console.warn("replot failed", a.id, String(e));
          return undefined;
        });
        const again = moved?.reapply.map((r) => r.path) ?? [];
        steps = `Your work copy is on the new main.${again.length ? ` Read ${again.join(", ")} again, and make your change on the new text.` : ""} Fix the code so that the tests pass. Then call gitring_check and gitring_submit again.`;
      } else {
        steps = "Call gitring_update to get the new main. Fix the code so that the tests pass, push, then call gitring_submit again.";
      }
      const after = p.settings.redo === "agent-first" ? `If you do not answer in ${minutes} minutes, a built-in agent does the task again.` : `If you do not answer in ${minutes} minutes, a person decides.`;
      this.issueCorrection(
        a.id,
        undefined,
        { kind: "reverted", message: `gitring reverted the merge of your work on "${intent.title}" (${culprit.mainAfter.slice(0, 7)}): tests failed on main. ${failedText} ${steps} ${after}`, constraints: { notes: failed.slice(0, 5) } },
        "R1-landed-has-way",
        "revert",
        95,
        true,
      );
      await this.scheduleBudgetRetry(now + minutes * 60_000);
      this.addLog({ kind: "stale", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${name} gets its work on "${intent.title}" back with a change request: ${failedText}` });
    } else {
      a.status = "stale";
      a.stoppedFor = why;
      this.putAttempt(a);
      await this.rederive(a.id, why, SYSTEM);
    }
    if (approvedBy) {
      // Work that a person approved: that person hears about the revert in the inbox.
      const now = Date.now();
      const q: T.Question = {
        id: newId("q"),
        kind: "revert",
        status: "open",
        intentId: a.intentId,
        attemptIds: [a.id],
        facts: revertFacts({ title: intent.title, agent: name, approvedBy, mergeSha: culprit.mainAfter, revertSha, failed }),
        options: [...REVERT_OPTIONS],
        askedAt: now,
        updatedAt: now,
      };
      this.putQuestion(q);
      this.addLog({ kind: "decision", attemptId: a.id, intentId: a.intentId, message: `${approvedBy} said yes to the work of ${name}. gitring tells ${approvedBy} about the revert in the inbox.` });
      this.questionAsked(q);
    }
  }

  /** Main fails and gitring cannot revert the merge alone: a person decides on the task of that merge. */
  protected async askAboutBrokenMain(l: T.Landing, run: T.CheckRun, reason: string): Promise<void> {
    const a = this.attempts.get(l.attemptId);
    const intent = this.intents.get(l.intentId);
    if (!a || !intent) return;
    const open = [...this.questions.values()].some((q) => q.status === "open" && q.kind === "revert" && q.attemptIds[0] === a.id);
    if (open) return;
    const now = Date.now();
    const q: T.Question = {
      id: newId("q"),
      kind: "revert",
      status: "open",
      intentId: intent.id,
      attemptIds: [a.id],
      facts: [`Tests fail on main after the merge of "${intent.title}" (${l.mainAfter.slice(0, 7)}). ${failureSummary(run.cases, 3)}`, reason, "A person decides: a redo of the task on the new main, a pause, or a fix by hand."],
      options: [...REVERT_OPTIONS],
      askedAt: now,
      updatedAt: now,
    };
    this.putQuestion(q);
    this.stats.escalations += 1;
    this.persistStats();
    this.addLog({ kind: "decision", attemptId: a.id, intentId: intent.id, message: `Tests fail on main, and gitring cannot revert "${intent.title}" alone. A person decides.` });
    this.questionAsked(q);
  }
}
