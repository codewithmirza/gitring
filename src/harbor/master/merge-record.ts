/**
 * Records a merge after main moved: the why-record, the task, the agent, the webhooks and the derived data.
 * Layer 17 of the chain in master/README.md. Extends HarborGithub (github.ts).
 * Everything that a merge changes is written here, in one place.
 * Read next: main-tests.ts.
 */
import type * as T from "../../core/types";
import { type CommitMeta } from "../../platform/repo/backend";
import { diffSnapshots } from "../../core/git/snapshot";
import { draftUpstreamCorrection, draftReplotCorrection } from "../../core/coord";
import { computeRange, shapeFromFootprint } from "../../core/analysis/range";
import { notCarriedText, type NotCarried } from "../../core/land/carry";
import { newId } from "../ids";
import { ACTIVE, WAITING, vesselView, type MainView } from "../views";
import { TERMINAL } from "../support/constants";
import { errorLine } from "../support/helpers";
import { METHOD_WORD } from "../support/words";
import { HarborGithub } from "./github";

// ───── Types ─────

/** What a finished commit of a merge tells recordLanding. */
interface LandingDone {
  committed: { sha: string; tree: string };
  before: string;
  method: T.LandingMethod;
  applied: T.Correction[];
  run: T.CheckRun;
  message: string;
  note: string;
  touched: string[];
  /** Parts of the work that gitring did not merge. */
  left?: NotCarried[];
  /** The merge rode in a train. */
  train?: T.Landing["train"];
  /** When the tests of main plus the work ran. */
  testsWhen?: T.TestsWhen;
}

export abstract class HarborMergeRecord extends HarborGithub {
  /**
   * A commit on main that gitring did not record becomes gitring's main: a commit from outside gitring, or
   * one that a stopped run made. The agents near its files hear that main moved.
   */
  protected async adoptMainCommit(c: CommitMeta): Promise<void> {
    const p = this.requireProject();
    const old = await this.loadMain();
    p.mainSha = c.hash;
    p.mainTree = c.treeHash;
    this.db.setMeta("project", p);
    this.appendMainSeq(c.hash);
    const main = await this.loadMain();
    const files = diffSnapshots(old.snapshot, main.snapshot).map((ch) => ch.path);
    this.emit({ type: "main", sha: main.sha, tree: main.tree, files: main.files, imports: main.imports });
    this.addLog({
      kind: "system",
      message: `Main has a commit that gitring did not record: ${c.hash.slice(0, 7)} "${c.message.split("\n")[0].slice(0, 80)}". It is main now (${files.length} file${files.length === 1 ? "" : "s"}).`,
      files,
    });
    this.webhook("main", { reason: "outside", mainBefore: old.sha, mainSha: c.hash, files });
    if (files.length) await this.mainMovedUnder(main, { title: `Commit ${c.hash.slice(0, 7)}`, files });
  }

  /**
   * Write what a merge on main means for gitring: the new main, the landing, the statuses, the events.
   * It is safe to run again: a work copy that the record has already counts once. The writes up to the
   * first await are one step, so a stop never leaves half of them.
   */
  protected async recordLanding(a: T.Attempt, done: LandingDone): Promise<void> {
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const agent = this.agents.get(a.agentId)!;
    this.advanceMain(p, done);
    const { landing, counted } = this.saveLanding(a, intent, done);
    this.markLanded(a, intent, agent, done.committed);
    this.settleLanding(done.applied, done.method, counted);
    await this.announceLanding(a, intent, agent, landing, done);
  }

  // ───── The steps of a merge record ─────

  /** Main moves to the new commit, unless the project record already has it. */
  protected advanceMain(p: T.Project, done: LandingDone): void {
    const { committed, before } = done;
    if (p.mainSha === before) {
      p.mainSha = committed.sha;
      p.mainTree = committed.tree;
      this.db.setMeta("project", p);
      this.appendMainSeq(committed.sha);
    }
  }

  /** The landing record, with its why-record. A landing that exists already is not made again, and not counted again. */
  protected saveLanding(a: T.Attempt, intent: T.Intent, done: LandingDone): { landing: T.Landing; counted: boolean } {
    const { committed, before, method, applied, run, message, note, touched, train, testsWhen } = done;
    let landing = this.landings.find((l) => l.attemptId === a.id && l.mainAfter === committed.sha);
    const counted = !!landing;
    if (!landing) {
      landing = {
        id: newId("ld"),
        attemptId: a.id,
        intentId: intent.id,
        agentId: a.agentId,
        method,
        mainBefore: before,
        mainAfter: committed.sha,
        checks: run,
        correctionsApplied: applied.length,
        at: Date.now(),
        message,
        ...(train ? { train } : {}),
        ...(testsWhen ? { testsWhen } : {}),
      };
      this.landings.push(landing);
      this.db.putLanding(landing, note);
      this.countUse("merges");
      // The history of main follows in the background; a fault there never stops the merge record.
      try {
        this.derived.landed(touched.length);
      } catch (e) {
        console.warn("history", errorLine(e));
      }
    }
    return { landing, counted };
  }

  /** The work copy, the task and the agent are over. The other work copies of the task stay as alternatives. */
  protected markLanded(a: T.Attempt, intent: T.Intent, agent: T.AgentInfo, committed: { sha: string; tree: string }): void {
    a.status = "landed";
    a.mergeWait = undefined;
    a.landedAt = Date.now();
    intent.status = "landed";
    intent.landedSha = committed.sha;
    intent.chosenAttemptId = a.id;
    this.putAttempt(a);
    this.putIntent(intent);
    agent.status = "idle";
    agent.attemptId = undefined;
    this.putAgent(agent);
    // Siblings stay visible as alternates (the road not taken).
    for (const s of this.attempts.values()) {
      if (s.intentId === intent.id && s.id !== a.id && !TERMINAL.has(s.status)) {
        s.status = "alternate";
        this.putAttempt(s);
        this.stopVessel(s.id).catch(() => {});
      }
    }
  }

  protected settleLanding(applied: T.Correction[], method: T.LandingMethod, counted: boolean): void {
    // The agent did not confirm these change requests before the merge: they close, they are not "acknowledged".
    for (const c of applied) {
      if (c.status === "pending" || c.status === "delivered") {
        c.status = "closed";
        this.putCorrection(c);
      }
    }
    if (!counted) {
      this.stats.landings += 1;
      this.stats.landedByMethod[method] = (this.stats.landedByMethod[method] ?? 0) + 1;
    }
    if (method === "rederive") this.stats.rederives += 0; // counted when the re-derive starts
    this.persistStats();
  }

  /** The events, the log, the webhook, the GitHub sync, the change requests for the work nearby, and the wake of waiting agents. */
  protected async announceLanding(a: T.Attempt, intent: T.Intent, agent: T.AgentInfo, landing: T.Landing, done: LandingDone): Promise<void> {
    const { committed, method, run, touched, left = [] } = done;
    const p = this.requireProject();
    const newMain = await this.loadMain();
    this.emit({ type: "landing", landing });
    this.emit({ type: "main", sha: newMain.sha, tree: newMain.tree, files: newMain.files, imports: newMain.imports });
    this.addLog({
      kind: "land",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: intent.id,
      message: `"${intent.title}" merged into main by ${METHOD_WORD[method]} (${committed.sha.slice(0, 7)}). Tests ${run.passed}/${run.passed + run.failed} pass.${left.length ? ` ${notCarriedText(left, false)}` : ""}`,
      files: touched,
    });
    this.webhook("landing", { landing, intent: { id: intent.id, title: intent.title }, callsign: agent.callsign, mainSha: committed.sha });
    if (p.settings.github.mode !== "off" && p.settings.github.repo) {
      this.ctx.waitUntil(this.githubSync().catch((e) => console.warn("github sync failed", String(e))));
    }
    // The task that merged GitHub's conflicting changes is in: bring the rest of the GitHub changes in.
    if (p.settings.github.repo && this.gh(p.settings.github.repo).conflict?.intentId === intent.id) {
      this.ctx.waitUntil(this.githubPull({ reason: "task" }).catch((e) => console.warn("github pull failed", String(e))));
    }
    await this.upstreamCorrections(a, newMain);
    this.wakeAll({ kind: "main-moved", at: Date.now(), mainSha: committed.sha, message: `Main moved to ${committed.sha.slice(0, 7)}: "${intent.title}" merged.` });
  }

  /** Tell vessels near the landed change that main moved under them. */
  protected async upstreamCorrections(landed: T.Attempt, main: MainView): Promise<void> {
    const intent = this.intents.get(landed.intentId)!;
    const landedView = await this.attemptView(landed);
    const landedShape = shapeFromFootprint(landed.footprint, landedView.signatures);
    const sigChanges = Object.entries(landedView.signatures)
      .filter(([, s]) => s.before && s.after && s.before !== s.after)
      .map(([symbol, s]) => ({ symbol, signature: s.after! }));
    const landedInfo = { intentTitle: intent.title, files: Object.keys(landed.footprint.files), signatureChanges: sigChanges };
    const quiet: string[] = [];
    for (const other of this.attempts.values()) {
      if (other.id === landed.id || !ACTIVE.has(other.status) || other.status === "landing") continue;
      const oIntent = this.intents.get(other.intentId);
      const oAgent = this.agents.get(other.agentId);
      if (!oIntent || !oAgent) continue;
      // Re-plot: move API-mode work onto the new main now, while the agent works, not at landing time.
      const moved = await this.replot(other, main).catch((e) => {
        console.warn("replot failed", other.id, String(e));
        return undefined;
      });
      const v = vesselView(other, oIntent, oAgent, (await this.attemptView(other)).signatures, main.signatures, WAITING.has(other.status) ? "waiting" : "active");
      if (moved && (moved.merged.length || moved.reapply.length)) {
        const drafted = draftReplotCorrection(v, landedInfo, { mainSha: main.sha, merged: moved.merged, reapply: moved.reapply });
        this.issueCorrection(other.id, landed.id, drafted, "R1-landed-has-way", "landing", moved.reapply.length ? 90 : 70);
        continue;
      }
      if (moved) quiet.push(oAgent.callsign);
      const range = computeRange(v.shape, landedShape, main.graph);
      if (range > 2) continue;
      const drafted = draftUpstreamCorrection(v, landedInfo);
      this.issueCorrection(other.id, landed.id, drafted, "R1-landed-has-way", "landing");
    }
    if (quiet.length) {
      this.addLog({
        kind: "replot",
        message: `gitring rebases the work of ${quiet.join(", ")} onto main ${main.sha.slice(0, 7)}. Their files do not overlap the merged change.`,
      });
    }
  }
}
