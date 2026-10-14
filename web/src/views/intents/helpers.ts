/**
 * Small helpers of the tasks page: the source of a task, the diff loader, merge button words, a reason.
 */
import { noTestRan, type Attempt, type Intent } from "../../../../src/core/types";
import { harbor, type DiffResult } from "../../state/api";
import { plural } from "../../state/format";
import { useStore } from "../../state/store";

const SOURCE_TEXT: Record<Intent["source"]["kind"], string> = {
  ui: "the web app",
  mcp: "MCP",
  webhook: "a webhook",
  seed: "the first code",
};

export function sourceText(i: Intent): string {
  const ref = i.source.ref ?? "";
  if (ref.startsWith("github")) return `GitHub issue ${ref.split("#")[1] ? "#" + ref.split("#")[1] : ""}`.trim();
  if (ref.startsWith("slack")) return "Slack /gitring";
  return SOURCE_TEXT[i.source.kind] ?? i.source.kind;
}

/* ───────────── diffs: one request per work copy version, shared ───────────── */

const diffCache = new Map<string, Promise<DiffResult>>();

export function loadDiff(a: Attempt): Promise<DiffResult> {
  const key = `${a.id}@${a.updatedAt}`;
  let p = diffCache.get(key);
  if (!p) {
    p = harbor().attemptDiff(a.id);
    diffCache.set(key, p);
    p.catch(() => diffCache.delete(key));
    // Keep the cache small: the oldest answers go first.
    while (diffCache.size > 24) diffCache.delete(diffCache.keys().next().value!);
  }
  return p;
}

/* ───────────── merge and GitHub ───────────── */

/** The merge button says what happens: into main, and to GitHub when the project syncs. */
export function useMergeResult(): string {
  const github = useStore((s) => s.state?.project.settings.github);
  const status = useStore((s) => s.state?.project.github);
  if (!github?.repo || github.mode === "off") return "Merge into main";
  if (github.mode === "main") return "Merge into main and push to GitHub";
  return status?.prUrl ? "Merge into main and update the pull request" : "Merge into main and open a pull request on GitHub";
}

/** A reason for the merge record from the facts: the tests, the size, and how it compares. */
export function suggestedReason(a: Attempt, all: Attempt[]): string {
  const run = a.composedChecks ?? a.checks;
  const tests = run ? (noTestRan(run) ? "No test ran" : `${run.passed} of ${run.passed + run.failed} tests pass`) : "The tests pass";
  const size = (x: Attempt) => x.stats.additions + x.stats.deletions;
  const others = all.filter((x) => x.id !== a.id && x.status === "ready");
  const smallest = others.length > 0 && others.every((o) => size(o) >= size(a));
  return `${tests}. +${a.stats.additions} −${a.stats.deletions} in ${plural(a.stats.filesChanged, "file")}${smallest ? ", the smallest change" : ""}.`;
}
