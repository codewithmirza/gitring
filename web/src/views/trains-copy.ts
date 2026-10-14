/**
 * Plain words for trains, the test mode and reverts (Settings and History).
 * The module is pure, so tests can read it.
 */
import type { Landing, LandingMethod, TestsWhen } from "../../../src/core/types";

export const TESTS_WHEN_OPTIONS: { value: TestsWhen; label: string }[] = [
  { value: "before", label: "Before each merge" },
  { value: "after", label: "After merge, with automatic revert" },
];

export function testsWhenHelp(when: TestsWhen): string {
  return when === "after"
    ? "Work whose own tests pass merges at once. gitring tests main in the background. When main fails, gitring finds the merge that broke it and reverts it. The task opens again, and the agent gets a change request with the failed tests. A person who said yes to that work hears about it in the inbox."
    : "gitring tests main plus the work before each merge. Work merges only when the tests pass.";
}

export const TRAIN_HELP = "Ready work copies that touch different files merge in one train. A train has one test run and one commit for each task. Use 1 to 16. Use 1 to turn trains off.";

/** The largest train that a form may send: a whole number from 1 to 16, else undefined. */
export function parseMaxTrain(text: string): number | undefined {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : undefined;
}

/** "Train 2 of 5", or undefined for a merge that rode alone. */
export function trainText(l: Pick<Landing, "train">): string | undefined {
  return l.train && l.train.size > 1 ? `Train ${l.train.place} of ${l.train.size}` : undefined;
}

/** What the history says that the merge did. */
export function methodSentence(method: LandingMethod): string {
  return method === "fast-forward" ? "merged it with a fast-forward" : method === "merge" ? "merged it with a 3-way merge" : method === "revert" ? "work reverted: the tests failed on main after the merge" : "merged it as a redo on the new main";
}

/** The line about the tests of a merge. */
export function testsSentence(l: Pick<Landing, "testsWhen" | "method" | "checks">, total: number): string {
  if (l.method === "revert") return `${l.checks.passed}/${total} tests pass on main after the revert.`;
  return l.testsWhen === "after" ? `${l.checks.passed}/${total} tests of the work pass. gitring tests main after the merge.` : `${l.checks.passed}/${total} tests pass on main.`;
}
