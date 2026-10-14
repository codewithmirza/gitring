/**
 * Moves work copies onto a new main: rebase by gitring, send work back to the agent, and redo.
 * Layer 15 of the chain in master/README.md. Extends HarborChecks (checks.ts).
 * Work that gitring cannot move by itself goes back to the agent as a change request, or to a person.
 * Read next: github.ts.
 */
import type * as T from "../../core/types";
import { REDO_OPTIONS } from "../../core/inbox";
import { unifiedDiff } from "../../core/text/diff";
import { draftUpstreamCorrection, draftReplotCorrection } from "../../core/coord";
import { compose } from "../../core/land/compose";
import { newId, repoSafe } from "../ids";
import { ACTIVE, WAITING, vesselView, type MainView } from "../views";
import { gitPullCommand } from "../support/access";
import { TERMINAL } from "../support/constants";
import { HUMAN, SYSTEM, emptyFootprint, personOf } from "../support/helpers";
import type { CallInfo } from "../support/types";
import { copyStatusWord } from "../support/words";
import { HarborChecks } from "./checks";

export abstract class HarborRebase extends HarborChecks {
  // ───── Rebase by gitring ─────

  /**
   * Move an API-mode attempt onto the new main (3-way, per file). Clean files carry both changes.
   * A file where the changes overlap goes back to the main version, and the agent makes its change
   * again (only while it works; an attempt that waits to land moves only when all files merge).
   * Git-mode attempts keep their base: the landing ladder merges them.
   */
  protected async replot(a: T.Attempt, main: MainView): Promise<{ merged: string[]; reapply: { path: string; diff: string }[] } | undefined> {
    if (a.mode !== "api" || a.baseSha === main.sha) return undefined;
    const working = a.status === "declared" || a.status === "underway" || a.status === "rederiving";
    if (!working && a.status !== "ready") return undefined;
    const p = this.requireProject();
    const base = await this.treeText(p.repo.name, a.baseTree);
    const view = await this.attemptView(a);
    const reader = await this.workReader(a, view, [main]);
    // Without readBytes: a binary file that the work changes is no text to move. It stays for the landing ladder.
    const result = await compose({ base: base.snapshot, main: main.snapshot, attempt: view.snapshot, readText: reader.readText });
    if (result.conflicts.some((c) => c.reason === "binary")) return undefined; // binary: leave it to the landing ladder
    if (result.changes.some((c) => c.content !== null && typeof c.content !== "string")) return undefined;
    const conflicts = new Set(result.conflicts.map((c) => c.path));
    if (conflicts.size && !working) {
      // A waiting attempt does not move. Show the human why its landing will re-derive.
      a.drift = { mainSha: main.sha, overlaps: [...conflicts] };
      this.putAttempt(a);
      return undefined;
    }
    a.drift = undefined;
    const mainMoved = (path: string) => (base.snapshot.get(path)?.sha ?? null) !== (main.snapshot.get(path)?.sha ?? null);
    const merged = result.touched.filter((path) => !conflicts.has(path) && mainMoved(path) && main.snapshot.has(path));
    const reapply = [...conflicts].map((path) => {
      const c = view.changed.find((x) => x.path === path);
      const diff = unifiedDiff(path, c?.base ?? null, c?.head ?? null);
      return { path, diff: diff.length > 3500 ? `${diff.slice(0, 3500)}\n… (diff cut)` : diff };
    });
    // The agent's copies: remember what it could know (null = it saw no file), so a later write from
    // that copy merges with the landed change, or is refused when it would remove it.
    for (const path of new Set([...result.touched, ...[...main.snapshot.keys(), ...base.snapshot.keys()].filter(mainMoved)])) {
      if (this.db.seen(a.id, path) === undefined) this.db.setSeen(a.id, path, view.files.get(path) ?? null);
    }
    // Files that go back to the main version: the agent reads them before it writes them again.
    for (const path of conflicts) this.db.setMustRead(a.id, path, true);
    this.db.clearWorktree(a.id);
    for (const ch of result.changes) this.db.writeWorktree(a.id, ch.path, ch.content === null ? null : (ch.content as string));
    const from = a.baseSha;
    a.baseSha = main.sha;
    a.baseTree = main.tree;
    this.attemptViews.delete(a.id);
    await this.refreshFootprint(a);
    this.putAttempt(a);
    this.stats.replots = (this.stats.replots ?? 0) + 1;
    const callsign = this.callsign(a.id);
    if (merged.length || reapply.length) {
      this.addLog({
        kind: "replot",
        attemptId: a.id,
        agentId: a.agentId,
        intentId: a.intentId,
        message:
          `gitring rebases the work of ${callsign} from ${from.slice(0, 7)} onto main ${main.sha.slice(0, 7)}.` +
          (merged.length ? ` Merged: ${merged.join(", ")}.` : "") +
          (reapply.length ? ` ${callsign} makes its change to ${reapply.map((r) => r.path).join(", ")} again.` : ""),
        files: result.touched,
      });
    }
    return { merged, reapply };
  }

  // ───── Send work back to the agent ─────

  /** Give work that cannot merge back to its outside agent, on the new main. */
  protected async returnToAgent(a: T.Attempt, reason: string, policy: "agent-first" | "agent-only"): Promise<void> {
    const p = this.requireProject();
    const intent = this.intents.get(a.intentId)!;
    const main = await this.loadMain();
    const now = Date.now();
    const minutes = Math.max(5, Math.min(120, Math.round(p.settings.redoWaitMinutes || 15)));
    const name = this.callsign(a.id) ?? a.agentId;
    a.status = "underway";
    a.returns = (a.returns ?? 0) + 1;
    a.returned = { at: now, until: now + minutes * 60_000, reason, policy };
    this.putAttempt(a);
    if (intent.status !== "underway") {
      intent.status = "underway";
      this.putIntent(intent);
    }
    let steps: string;
    if (a.mode === "api") {
      const moved = await this.replot(a, main).catch((e) => {
        console.warn("replot failed", a.id, String(e));
        return undefined;
      });
      const again = moved?.reapply.map((r) => r.path) ?? [];
      steps =
        (moved ? `gitring moved your work copy onto the new main.` : `Your work copy is on main ${main.sha.slice(0, 7)}.`) +
        (again.length ? ` Read ${again.join(", ")} again, and make your change on the new text.` : " Fix the code so that the tests pass.") +
        ` Then call gitring_check and gitring_submit again.`;
    } else {
      steps = `Call gitring_update to get the new main. Merge it into your work, fix the conflicts, run the tests, push, then call gitring_submit again.`;
    }
    const after = policy === "agent-first" ? `If you do not answer in ${minutes} minutes, a built-in agent does the task again.` : `If you do not answer in ${minutes} minutes, a person decides.`;
    this.issueCorrection(
      a.id,
      undefined,
      { kind: "upstream", message: `Your work on "${intent.title}" cannot merge into main ${main.sha.slice(0, 7)}: ${reason} ${steps} ${after}`, constraints: {} },
      "R1-landed-has-way",
      "redo",
      95,
      true, // each time the work comes back is news: the agent must read it, also the second and the third time
    );
    this.addLog({
      kind: "stale",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${name} cannot merge "${intent.title}": ${reason} gitring gives the work back to ${name} (try ${a.returns} of 3).`,
    });
    // Not a.returned.until: a call of the agent can clear a.returned (heard) while this method waits.
    await this.scheduleBudgetRetry(now + minutes * 60_000);
  }

  /** The outside agent did not answer in time: a built-in agent (agent-first) or a person (agent-only) takes over. */
  protected async returnTimedOut(a: T.Attempt): Promise<void> {
    const r = a.returned;
    if (!r) return;
    a.returned = undefined;
    this.putAttempt(a);
    const intent = this.intents.get(a.intentId);
    const name = this.callsign(a.id) ?? a.agentId;
    const minutes = Math.round((r.until - r.at) / 60_000);
    if (r.policy === "agent-first") {
      this.addLog({ kind: "stale", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${name} did not answer in ${minutes} minutes. A built-in agent does "${intent?.title}" again on the new main.` });
      await this.rederive(a.id, `${name} did not answer after the merge failed. ${r.reason}`, SYSTEM);
      return;
    }
    await this.askPersonToDecide(
      a,
      `${name} did not answer in ${minutes} minutes after the work came back. ${r.reason}`.trim(),
      `${name} did not answer in ${minutes} minutes. A person must decide on "${intent?.title}".`,
    );
  }

  /**
   * Bring the new main into a work copy (MCP gitring_update).
   *   api  gitring moves the work copy onto main; files where both sides changed go back to main, and the agent writes its change again
   *   git  a read-only remote and token for main (6 hours), to merge main with git
   */
  async update(attemptId: string, call: CallInfo = {}): Promise<T.UpdateResult> {
    const a = this.mustAttempt(attemptId);
    this.mayChange(a, call.viewer);
    if (TERMINAL.has(a.status)) throw new Error(`Work copy ${a.id} is ${copyStatusWord(a.status)}. ${this.overAdvice(a)}`);
    this.heard(a);
    const p = this.requireProject();
    const main = await this.loadMain();
    if (a.mode === "api") {
      if (a.baseSha === main.sha) return { mode: "api", mainSha: main.sha, merged: [], readAgain: [], message: "Your work copy is on the current main." };
      const moved = await this.replot(a, main);
      const readAgain = moved?.reapply.map((r) => r.path) ?? [];
      return {
        mode: "api",
        mainSha: main.sha,
        merged: moved?.merged ?? [],
        readAgain,
        message: moved
          ? `Your work copy is on main ${main.sha.slice(0, 7)}.${readAgain.length ? ` Read ${readAgain.join(", ")} again, and make your change on the new text.` : ""}`
          : "gitring could not move this work copy now (it waits to merge). Submit again after the merge queue.",
      };
    }
    const tok = await this.backend.createToken(p.repo.name, "read", 6 * 3600);
    const remote = p.repo.remote ?? (await this.backend.remoteUrl(p.repo.name));
    if (!tok || !remote) throw new Error("gitring cannot give a remote for main now. Try again.");
    return {
      mode: "git",
      mainSha: main.sha,
      branch: this.branch,
      remote,
      token: tok.token,
      tokenExpiresAt: tok.expiresAt,
      commands: [gitPullCommand(remote, tok.token, this.branch), "# fix conflicts, run the tests, commit", "git push", "# then call gitring_submit"],
      message: `Main is at ${main.sha.slice(0, 7)}. The token is read-only and lasts 6 hours.`,
    };
  }

  // ───── Work that is out of date ─────

  protected async markStale(a: T.Attempt, reason: string): Promise<void> {
    const agent = this.agents.get(a.agentId);
    const policy = this.requireProject().settings.redo;
    // Work of an outside agent goes back to that agent first (redo policy), at most 3 times.
    if (agent && agent.kind !== "builtin" && policy !== "builtin") {
      if ((a.returns ?? 0) < 3) {
        await this.returnToAgent(a, reason, policy);
        return;
      }
      if (policy === "agent-only") {
        // Three tries by the agent failed, and no built-in agent may take the task: a person decides.
        const it = this.intents.get(a.intentId)!;
        await this.askPersonToDecide(
          a,
          `The work did not merge after 3 tries by ${this.callsign(a.id)}: ${reason}`,
          `The work of ${this.callsign(a.id)} did not merge after 3 tries. A person must decide on "${it.title}".`,
        );
        return;
      }
    }
    const intent = this.intents.get(a.intentId)!;
    if (a.lineage.generation >= 3) {
      await this.askPersonToDecide(a, `Two redos failed: ${reason}`, `Two redos failed for "${intent.title}". A person must decide.`);
      return;
    }
    a.status = "stale";
    this.putAttempt(a);
    intent.status = "underway";
    this.putIntent(intent);
    this.addLog({ kind: "stale", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The work of ${this.callsign(a.id)} cannot merge: ${reason} gitring does the task again on the new main.` });
    await this.rederive(a.id, reason, SYSTEM);
  }

  /**
   * The one way for "a person decides" when work did not merge and no agent tries again: the work copy stops
   * (stale, with the reason), the task waits for a person, and a redo question goes to the inbox of the
   * people who may answer, to the webhooks and to the push notifications. The answer starts a redo on the
   * new main or pauses the task (answerQuestion).
   */
  protected async askPersonToDecide(a: T.Attempt, why: string, logMessage: string): Promise<T.Question> {
    a.status = "stale";
    a.stoppedFor = why;
    a.returned = undefined;
    this.putAttempt(a);
    const intent = this.intents.get(a.intentId)!;
    const now = Date.now();
    const facts = [why, "No agent tries again. A person decides what happens next."];
    const old = [...this.questions.values()].find((q) => q.status === "open" && q.kind === "redo" && q.intentId === a.intentId);
    const q: T.Question = old
      ? { ...old, attemptIds: [a.id], facts, askedAt: now }
      : { id: newId("q"), kind: "redo", status: "open", intentId: a.intentId, attemptIds: [a.id], facts, options: [...REDO_OPTIONS], askedAt: now, updatedAt: now };
    this.putQuestion(q);
    intent.status = "judging";
    this.putIntent(intent);
    this.stats.escalations += 1;
    this.persistStats();
    this.addLog({ kind: "decision", attemptId: a.id, intentId: a.intentId, message: logMessage });
    this.questionAsked(q);
    return q;
  }

  // ───── Redo ─────

  async rederive(attemptId: string, reason: string, by: T.Actor = HUMAN): Promise<{ attempt: T.Attempt }> {
    const old = this.mustAttempt(attemptId);
    const p = this.requireProject();
    const main = await this.loadMain();
    if (old.status !== "stale") {
      old.status = "stale";
      this.putAttempt(old);
    }
    const oldAgent = this.agents.get(old.agentId);
    const builtin = oldAgent?.kind === "builtin";
    const agent = builtin ? oldAgent! : this.upsertAgent({ kind: "builtin", model: this.projectModels(p)[0] });
    const budget = await this.takeLlmBudget(1, by);
    const id = newId("a");
    const now = Date.now();
    const a: T.Attempt = {
      id,
      intentId: old.intentId,
      agentId: agent.id,
      fork: { repo: repoSafe(`${p.repo.name}-${id}`) },
      mode: "api",
      baseSha: main.sha,
      baseTree: main.tree,
      status: "rederiving",
      // The redo keeps the time of the plan that it redoes, so R4 stays fair to it.
      course: { ...old.course, declaredAt: old.course.declaredAt ?? now },
      footprint: emptyFootprint(),
      corrections: [],
      lineage: { generation: old.lineage.generation + 1, rederivedFrom: old.id },
      stats: { filesChanged: 0, additions: 0, deletions: 0, steps: 0 },
      ...((old.sender ?? personOf(by)) ? { sender: old.sender ?? personOf(by) } : {}),
      createdAt: now,
      updatedAt: now,
      waitsForBudget: budget.granted ? undefined : budget.retryAt,
    };
    this.putAttempt(a);
    agent.status = a.waitsForBudget ? "waiting" : "underway";
    agent.attemptId = a.id;
    this.putAgent(agent);
    this.stats.rederives += 1;
    this.persistStats();
    if (by.kind === "human") {
      this.recordDecision({ kind: "rederive", intentId: a.intentId, attemptIds: [old.id, a.id], by, rationale: reason });
      // A person started the redo: the task does not wait for a person any more (unless other work waits).
      this.closeRedoQuestions(a.intentId, `${by.name} started a redo.`);
      this.refreshJudging(a.intentId);
    }
    this.addLog({ kind: "rederive", attemptId: a.id, agentId: agent.id, intentId: a.intentId, message: `Redo "${this.intents.get(a.intentId)?.title}" on main ${main.sha.slice(0, 7)} (try ${a.lineage.generation}). Reason: ${reason}` });
    // The outside agent of the old work copy reads "stop work" in the answer of its next call (see overAdvice).
    if (a.waitsForBudget) await this.scheduleBudgetRetry(a.waitsForBudget);
    else await this.startVessel(a, agent, old.id);
    return { attempt: a };
  }

  /** Main moved without a merged task (GitHub changes): move API-mode work along and tell the agents. */
  protected async mainMovedUnder(main: MainView, change: { title: string; files: string[] }): Promise<void> {
    const landedInfo = { intentTitle: change.title, files: change.files, signatureChanges: [] };
    for (const other of this.attempts.values()) {
      if (!ACTIVE.has(other.status) || other.status === "landing") continue;
      const oIntent = this.intents.get(other.intentId);
      const oAgent = this.agents.get(other.agentId);
      if (!oIntent || !oAgent) continue;
      const moved = await this.replot(other, main).catch(() => undefined);
      const v = vesselView(other, oIntent, oAgent, (await this.attemptView(other)).signatures, main.signatures, WAITING.has(other.status) ? "waiting" : "active");
      if (moved && (moved.merged.length || moved.reapply.length)) {
        this.issueCorrection(other.id, undefined, draftReplotCorrection(v, landedInfo, { mainSha: main.sha, merged: moved.merged, reapply: moved.reapply }), "R1-landed-has-way", "github", moved.reapply.length ? 90 : 70, true);
        continue;
      }
      if (other.footprint && Object.keys(other.footprint.files).some((f) => change.files.includes(f))) {
        this.issueCorrection(other.id, undefined, draftUpstreamCorrection(v, landedInfo), "R1-landed-has-way", "github", 50, true);
      }
    }
    this.wakeAll({ kind: "main-moved", at: Date.now(), mainSha: main.sha, message: `Main moved to ${main.sha.slice(0, 7)}: ${change.title}.` });
  }
}
