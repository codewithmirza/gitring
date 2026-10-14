/**
 * Runs the tests of a tree (gitring test runner or a test container) and records the result.
 * Layer 14 of the chain in master/README.md. Extends HarborReads (reads.ts).
 * It never decides whether work merges. The merge layers read the result.
 * Read next: rebase.ts.
 */
import type * as T from "../../core/types";
import { runChecks, contentKey } from "../../platform/checks/runner";
import { packTree, type DrydockResult, type PackFile } from "../../drydock/drydock";
import { budgetWait, containerRun } from "../support/container-run";
import type { CallInfo } from "../support/types";
import { HarborReads } from "./reads";

export abstract class HarborChecks extends HarborReads {
  /**
   * Run the checks on a tree: the gitring harness in a Dynamic Worker (the text files), or the project's
   * install and test commands in the attempt's check container. The container gets the whole tree from
   * `full` (binary files and modes too), so it tests the same tree that merges.
   */
  protected async runTreeChecks(
    files: Map<string, string>,
    scope: T.CheckRun["scope"],
    attemptId: string,
    full?: () => Promise<{ files: Map<string, PackFile>; left: string[] }>,
  ): Promise<T.CheckRun> {
    const cs = this.checkSettings();
    const key = await contentKey(files);
    if (cs.runner !== "container") {
      const run = await runChecks(this.env.LOADER, key, { files, testPaths: this.testPaths(files) }, { scope });
      return { ...run, runner: "worker" };
    }
    const t0 = Date.now();
    const p = this.requireProject();
    // Container runs cost money: an hourly budget per project owner and for the deployment.
    const perOwner = Math.max(1, Math.round(Number(this.env.CHECK_RUNS_PER_OWNER_HOUR) || 240));
    const global = Math.max(1, Math.round(Number(this.env.CHECK_RUNS_PER_HOUR) || 2000));
    const budget = await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"))
      .budgetTake(p.ownerId ?? null, 1, perOwner, global, "checks")
      .catch(() => ({ granted: 1, retryAt: 0 }));
    if (!budget.granted) return budgetWait(key, scope, budget.retryAt);
    this.countUse("testRuns");
    const dock = this.env.DRYDOCK.get(this.env.DRYDOCK.idFromName(`${p.id}:${attemptId}`));
    let res: DrydockResult;
    let left: string[] = [];
    try {
      const tree = full ? await full() : undefined;
      left = tree?.left ?? [];
      res = (await dock.run({ tree: await packTree(tree?.files ?? files), install: cs.install, test: cs.test, timeoutSec: cs.timeoutSec ?? 600 })) as DrydockResult;
    } catch (e) {
      res = { ok: false, stage: "start", exitCode: -1, installMs: 0, testMs: 0, reused: false, log: `The test container did not answer: ${String((e as Error)?.message ?? e)}` };
    }
    if (left.length) {
      const names = `${left.slice(0, 5).join(", ")}${left.length > 5 ? ` and ${left.length - 5} more` : ""}`;
      res = { ...res, log: `gitring did not copy ${left.length} large file${left.length === 1 ? "" : "s"} into the test container: ${names}.\n${res.log}` };
    }
    return containerRun(res, { key, scope, cs, ms: Date.now() - t0 });
  }

  async check(attemptId: string, call: CallInfo = {}): Promise<T.CheckRun> {
    const a = this.mustAttempt(attemptId);
    this.mayChange(a, call.viewer);
    this.heard(a);
    await this.adoptForkTip(a);
    const view = await this.attemptView(a);
    const run = await this.runTreeChecks(view.files, "attempt", a.id, async () => this.fullTree(view.snapshot, await this.workReader(a, view)));
    if (run.wait) {
      // The test budget is used: no test ran. This is not a failure. Keep the last result and say when gitring tries again.
      this.addLog({
        kind: "check",
        attemptId: a.id,
        agentId: a.agentId,
        intentId: a.intentId,
        message: `${this.callsign(a.id)} tests: not run. ${run.wait.message}`,
        data: { checkRunId: run.id, ok: false, retryAt: run.wait.retryAt },
      });
      return run;
    }
    a.checks = run;
    // A real run means the budget has room: the merge does not wait any more.
    a.mergeWait = undefined;
    this.putAttempt(a);
    this.addLog({
      kind: "check",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${this.callsign(a.id)} tests: ${run.passed}/${run.passed + run.failed} pass${run.error ? ` (${run.error.slice(0, 120)})` : ""}.`,
      // The tests that failed, by name: the steward reads the runs of a work copy from the log.
      data: { checkRunId: run.id, ok: run.ok, failed: run.cases.filter((c) => !c.ok).slice(0, 8).map((c) => ({ file: c.file, name: c.name })) },
    });
    return run;
  }
}
