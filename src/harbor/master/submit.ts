/**
 * Takes the submit of an agent: runs the tests, asks for approval when needed, and puts the work in the queue.
 * Layer 22 of the chain in master/README.md. Extends HarborQueue (queue.ts).
 * A submit never merges by itself. It only puts work in the queue (see queue.ts).
 * Read next: decisions.ts.
 */
import type * as T from "../../core/types";
import { noTestRan } from "../../core/types";
import { approvalLine } from "../../core/approvals";
import { type FileChange } from "../../platform/repo/backend";
import { diffSnapshots } from "../../core/git/snapshot";
import { notCarriedText } from "../../core/land/carry";
import { ACTIVE, failureSummary } from "../views";
import { TERMINAL } from "../support/constants";
import type { CallInfo } from "../support/types";
import { copyStatusWord } from "../support/words";
import { HarborQueue } from "./queue";

export abstract class HarborSubmit extends HarborQueue {
  // ───── Submit ─────

  async submit(attemptId: string, summary?: string, call: CallInfo = {}): Promise<T.SubmitResult> {
    this.rememberOrigin(call.origin);
    const a = this.mustAttempt(attemptId);
    this.mayChange(a, call.viewer);
    if (TERMINAL.has(a.status)) {
      return { attemptId, status: a.status, next: a.status === "landed" ? "landed" : "fix-checks", message: `The work copy is ${copyStatusWord(a.status)}.`, clearance: this.clearanceFor(a.id) };
    }
    this.heard(a);
    await this.adoptForkTip(a);
    if (a.status === "ready" && a.approval?.status === "waiting" && (!a.approval.digest || (await this.digestOf(a)) === a.approval.digest)) {
      // The agent asks again, and a person has not answered: the same work, the same question.
      return { attemptId, status: a.status, checks: a.composedChecks ?? a.checks, next: "awaiting-approval", approval: a.approval, ...this.mayAnswerOf(a, call.viewer), message: this.waitingMessage(a), clearance: this.clearanceFor(a.id) };
    }
    a.summary = summary ? String(summary).slice(0, 600) : a.summary;
    a.status = "submitted";
    this.putAttempt(a);
    const run = await this.check(a.id);
    // Parts of the work that gitring does not merge: the agent hears it now, not after the merge.
    const left = await this.leftOut(a);
    if (a.status !== "submitted") {
      // Another submit of this work copy was faster: it already queued or merged the work while these tests ran.
      return { attemptId, status: a.status, checks: run, next: a.status === "landed" ? "landed" : a.status === "underway" ? "fix-checks" : "landing-queue", message: `The work copy is ${copyStatusWord(a.status)}.`, clearance: this.clearanceFor(a.id) };
    }
    const intent = this.intents.get(a.intentId)!;
    let next: T.SubmitResult["next"];
    let message: string;
    let approvalAsked: T.Approval | undefined;
    if (!run.ok && !run.wait) {
      a.status = "underway";
      next = "fix-checks";
      message = `${failureSummary(run.cases)} Fix the code, then submit again.`;
    } else {
      a.status = "ready";
      // The test budget is used: the tests did not run, and that is not a failure. The work copy goes on,
      // and the tests of main plus this work run at the merge, when the budget has room.
      const lead = run.wait ? run.wait.message : "All tests pass.";
      if (run.wait) a.mergeWait = { until: run.wait.retryAt, message: run.wait.message };
      const siblings = [...this.attempts.values()].filter((x) => x.intentId === a.intentId && x.id !== a.id && ACTIVE.has(x.status));
      // A re-derive of the attempt a person picked keeps that pick: it lands without a second question about rivals or missing tests.
      const picked = this.pickedLineage(a);
      // No test ran (the gitring test harness): nothing is verified, so a person decides, unless the owner allows it.
      const untested = noTestRan(run) && !this.requireProject().settings.allowUntested;
      const need = await this.approvalFor(a, { untested, competing: siblings.length, picked });
      if (need) {
        const approval = await this.askApproval(a, need);
        next = "awaiting-approval";
        const compete = siblings.length ? ` ${siblings.length + 1} work copies compete on this task.` : "";
        message = `${untested ? "No test ran. The work is not verified." : lead}${compete} ${this.approverWords(approval)} must say yes before this merges.`;
        if (siblings.every((x) => x.status === "ready")) {
          intent.status = "judging";
          this.putIntent(intent);
        }
        approvalAsked = approval;
      } else {
        next = "landing-queue";
        message = run.wait ? `${lead} The work copy waits in the merge queue.` : "All tests pass. The work copy is in the merge queue.";
        this.enqueueLanding(a);
      }
    }
    if (left.length) message = `${message} ${notCarriedText(left)}`;
    this.putAttempt(a);
    this.addLog({
      kind: "submit",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${this.callsign(a.id)} submits "${intent.title}": ${message}`,
    });
    if (approvalAsked) {
      this.webhook("approval", { attemptId: a.id, approval: approvalAsked, task: intent.title, agent: this.callsign(a.id), line: approvalLine(a), link: this.approvalLink(a) });
      this.notifyPeople(approvalAsked.approver ? [approvalAsked.approver.id] : [], "approval", Boolean(approvalAsked.ownerOnly));
    }
    return { attemptId, status: a.status, checks: run, next, message, ...(approvalAsked ? { approval: approvalAsked, ...this.mayAnswerOf(a, call.viewer) } : {}), clearance: this.clearanceFor(a.id) };
  }

  /**
   * The remote of a work copy for a person or a tool that needs real git (a clone of the work, a branch read).
   * Api-mode work copies have no fork until now: this makes the fork and puts the work into it as one commit.
   */
  async workCopyRemote(attemptId: string): Promise<{ repo: string; remote: string; headSha?: string }> {
    const a = this.mustAttempt(attemptId);
    await this.flushToFork(a);
    const remote = a.fork.remote ?? (await this.backend.remoteUrl(a.fork.repo)) ?? "";
    return { repo: a.fork.repo, remote, ...(a.headSha ? { headSha: a.headSha } : {}) };
  }

  // ───── The fork of a work copy ─────

  /** API-mode work becomes a real commit in the attempt's Artifacts fork (made when it is needed, not at submit). */
  protected async flushToFork(a: T.Attempt): Promise<void> {
    if (a.mode !== "api") return;
    const intent = this.intents.get(a.intentId)!;
    await this.ensureFork(a, intent);
    const overlay = this.db.worktree(a.id);
    if (!overlay.size) return;
    const tip = (await this.backend.resolve(a.fork.repo, this.branch)) ?? a.baseSha;
    const view = await this.attemptView(a);
    const forkTip = tip === a.baseSha ? undefined : await this.backend.readCommit(a.fork.repo, tip);
    const forkTree = forkTip ? await this.treeText(a.fork.repo, forkTip.treeHash) : await this.treeText(this.requireProject().repo.name, a.baseTree);
    // The fork is made when it is needed, from the main of that time, which can be newer than the base of the work.
    // So the commit carries what the work changed since its own base, never the difference to the fork tip:
    // that difference would undo the merges that main got after the base. Binary files and deletes count too.
    const baseTree = await this.treeText(this.requireProject().repo.name, a.baseTree);
    const reader = await this.workReader(a, view, [forkTree, baseTree]);
    const changes: FileChange[] = [];
    const own = diffSnapshots(baseTree.snapshot, view.snapshot);
    const write = async (path: string, e: { sha: string; mode: string } | undefined) => {
      if (!e) {
        changes.push({ path, content: null });
        return;
      }
      if (e.mode === "160000") return; // a submodule entry cannot be written
      const content = (await reader.readText(e.sha)) ?? (await reader.readBytes(e.sha));
      if (content !== null) changes.push({ path, content, mode: e.mode });
    };
    for (const ch of own) await write(ch.path, view.snapshot.get(ch.path));
    // A fork from before the lazy fork was made at an older base, and the work was planned again onto a newer main.
    // Its tip lacks what main got since: write those paths too, where the work did not change them.
    if (forkTip && (await this.forkLagsBase(a, tip))) {
      const touched = new Set(own.map((c) => c.path));
      for (const path of new Set([...forkTree.snapshot.keys(), ...baseTree.snapshot.keys()])) {
        if (touched.has(path)) continue;
        const b = baseTree.snapshot.get(path);
        const f = forkTree.snapshot.get(path);
        if (b?.sha === f?.sha && b?.mode === f?.mode) continue;
        await write(path, b);
      }
    }
    if (!changes.length) return;
    const agent = this.agents.get(a.agentId);
    const res = await this.backend.commit({
      repo: a.fork.repo,
      branch: this.branch,
      parent: tip,
      changes,
      message: `${intent.title}\n\nWork by ${agent?.callsign ?? a.agentId} (${agent?.model ?? agent?.client ?? "agent"}).\n\nGitring-Intent: ${intent.id}\nGitring-Attempt: ${a.id}\nGitring-Base: ${a.baseSha}`,
      author: { name: agent?.callsign ?? "agent", email: `${(agent?.callsign ?? "agent").toLowerCase()}@agents.gitring.invalid` },
    });
    a.headSha = res.sha;
    this.putAttempt(a);
    this.addLog({ kind: "push", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `The work of ${agent?.callsign} is in its work copy ${a.fork.repo} at ${res.sha.slice(0, 7)}.`, files: changes.map((c) => c.path) });
  }

  /**
   * True when the fork tip is older than the base of the work: walking back from the tip reaches an ancestor of the
   * base before it reaches the base. A fork that main moved past (the lazy fork) has the base in its history.
   */
  protected async forkLagsBase(a: T.Attempt, tip: string): Promise<boolean> {
    const main = this.requireProject().repo.name;
    const older = new Set<string>();
    try {
      for (let sha: string | undefined = a.baseSha, n = 0; sha && n < 500; n++) {
        older.add(sha);
        sha = (await this.backend.readCommit(main, sha))?.parents[0];
      }
      for (let sha: string | undefined = tip, n = 0; sha && n < 500; n++) {
        if (sha === a.baseSha) return false;
        if (older.has(sha)) return true;
        sha = (await this.backend.readCommit(a.fork.repo, sha))?.parents[0];
      }
    } catch {
      return false;
    }
    return false;
  }
}
