/**
 * Turns the result of a test container, or an empty test budget, into a check run.
 * Called by the layers that run tests (../master/checks.ts). A used test budget is not a failure and not a pass.
 */
import type * as T from "../../core/types";
import { type DrydockResult } from "../../drydock/drydock";
import { CHECK_RUN, newId } from "../ids";
import { clock } from "./helpers";

/**
 * The result when the hourly test budget is used: the tests did not run. It is not a failure (no case
 * failed) and not a pass (`ok` is false). `error` has the same sentence for tools that print only the error.
 */
export function budgetWait(key: string, scope: T.CheckRun["scope"], retryAt: number): T.CheckRun {
  const message = `The test budget for this hour is used. gitring tries again at ${clock(retryAt)} UTC.`;
  return { id: newId(CHECK_RUN), subject: key, scope, ok: false, passed: 0, failed: 0, cases: [], ms: 0, at: Date.now(), runner: "container", error: message, wait: { retryAt, message } };
}

/** A check container's result as a check run: one case for the install, one for the tests. */
export function containerRun(res: DrydockResult, o: { key: string; scope: T.CheckRun["scope"]; cs: T.CheckSettings; ms: number }): T.CheckRun {
  const installCmd = o.cs.install || "npm ci (or npm install)";
  const testCmd = o.cs.test || "npm test";
  const tail = (n: number) => (res.log.length > n ? `…${res.log.slice(-n)}` : res.log).trim();
  const installed = res.stage !== "install" && res.stage !== "start";
  const cases: T.CheckCaseResult[] = [];
  if (res.stage !== "start") {
    cases.push({ file: "install", name: installCmd, ok: installed, ms: res.installMs, ...(installed ? {} : { error: tail(3000) }) });
  }
  if (installed && res.stage !== "no-test") {
    cases.push({ file: "test", name: testCmd, ok: res.ok, ms: res.testMs, ...(res.ok ? {} : { error: tail(3000) }) });
  }
  const error =
    res.stage === "start"
      ? res.log.slice(0, 500)
      : res.stage === "no-test"
        ? "No test command. The project has no package.json test script. An owner sets the test command in Settings → Tests."
        : res.stage === "timeout"
          ? `The tests took more than ${o.cs.timeoutSec ?? 600} s. gitring stopped them.`
          : undefined;
  return {
    id: newId(CHECK_RUN),
    subject: o.key,
    scope: o.scope,
    ok: res.ok,
    passed: cases.filter((c) => c.ok).length,
    failed: cases.filter((c) => !c.ok).length + (res.stage === "no-test" || res.stage === "start" ? 1 : 0),
    cases,
    ms: o.ms,
    at: Date.now(),
    runner: "container",
    log: res.log,
    ...(error ? { error } : {}),
  };
}
