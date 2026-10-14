/**
 * Pull requests of the GitHub-compatible tools: which work copies count as pull requests, and what state each one shows.
 *
 * A pull request number is the place of the work copy in the age order of all branch work copies of the project.
 * Read next: src/worker/mcp-approval.ts (the question to a person).
 */
import type * as T from "../../core/types";
import { approvalPath } from "../../core/approvals";
import type { Principal } from "../auth";
import { fail, type ToolContext, type ToolResult } from "../mcp-kit";
import { approvalView, statusHeadline } from "../mcp-approval";
import { byAge, data, sha7 } from "./answers";
import { MAIN, agentFor, branchIn, open, type Project } from "./branches";

/** How long merge_pull_request waits for a merge to finish, in milliseconds. The tests can change it. */
export const MERGE_WAIT = { ms: 8000, stepMs: 400 };

/** The work copy asked for was sent to gitring with submit (a failed test run counts: it is a pull request that waits for a fix). */
export const opened = (a: T.Attempt): boolean => a.summary !== undefined || (a.status !== "declared" && a.status !== "underway");

export interface Pull {
  number: number;
  branch: string;
  attempt: T.Attempt;
}

/** The pull requests of this caller. The number is the place among all branch work copies of the project. */
export function myPulls(state: T.ProjectState, who: Principal): Pull[] {
  return byAge(state.attempts)
    .map((attempt) => ({ attempt, branch: branchIn(attempt.course.approach) }))
    .filter((x): x is { attempt: T.Attempt; branch: string } => x.branch !== null)
    .map((x, i) => ({ number: i + 1, ...x }))
    .filter((p) => p.attempt.agentId === agentFor(who, p.branch) && opened(p.attempt));
}

export function pullAt(state: T.ProjectState, who: Principal, n: number): Pull {
  const p = myPulls(state, who).find((x) => x.number === n);
  if (!p) throw new Error(`Pull request ${n} does not exist, or it is not yours. gitring shows only your own pull requests. Call list_pull_requests.`);
  return p;
}

export interface PullInfo {
  state: "open" | "closed";
  merged: boolean;
  /** Short words for the state of the merge. */
  status: string;
  message: string;
  /** The state does not change while you wait. */
  final: boolean;
  /** A question waits for a person: the address in the gitring app where the person answers. */
  approvalUrl?: string;
}

/** The address of the question of a pull request in the gitring app (`origin` is empty: the path only). */
export function approvalUrlOf(p: Pull, state: T.ProjectState, origin: string): string {
  return `${origin}${approvalPath(state.project.id, p.attempt.id)}`;
}

export function pullInfo(p: Pull, state: T.ProjectState, origin = ""): PullInfo {
  const a = p.attempt;
  const intent = state.intents.find((i) => i.id === a.intentId);
  const landing = state.landings.find((l) => l.attemptId === a.id);
  switch (a.status) {
    case "landed":
      return { state: "closed", merged: true, status: "merged", message: `The work is on main${landing ? ` at ${sha7(landing.mainAfter)}` : ""}.`, final: true };
    case "landing":
      return { state: "open", merged: false, status: "merging", message: "gitring merges the work now.", final: false };
    case "submitted":
    case "checking":
      return { state: "open", merged: false, status: "tests run", message: "gitring runs the tests.", final: false };
    case "rederiving":
      return { state: "open", merged: false, status: "redo", message: "gitring does the work again on the new main.", final: false };
    case "ready": {
      const ap = a.approval;
      if (ap?.status === "waiting") {
        const who = ap.approver?.name ?? "A person of the project";
        const link = approvalUrlOf(p, state, origin);
        return {
          state: "open",
          merged: false,
          status: "waits for a person",
          message: `${ap.why[0] ?? "A person must decide."} ${who} must say yes. gitring does not merge before that. The person answers here: ${link}`,
          final: true,
          approvalUrl: link,
        };
      }
      return intent?.status === "judging"
        ? { state: "open", merged: false, status: "waits for a person", message: "All tests pass. A person chooses between the work copies of this task. gitring does not merge before that.", final: true }
        : { state: "open", merged: false, status: "in the merge queue", message: "All tests pass. The work copy is in the merge queue.", final: false };
    }
    case "stale":
      return { state: "closed", merged: false, status: "not merged", message: "gitring could not merge the work on the new main. A person or gitring does the task again.", final: true };
    case "alternate":
      return { state: "closed", merged: false, status: "not merged", message: "Another work copy of the same task merged. This one stays as an alternate.", final: true };
    case "abandoned":
      return { state: "closed", merged: false, status: "closed", message: "A person closed this work copy.", final: true };
    case "failed":
      return { state: "closed", merged: false, status: "failed", message: "This work copy failed.", final: true };
    default:
      if (a.approval?.status === "sent-back") {
        const note = a.approval.answer?.note;
        return { state: "open", merged: false, status: "sent back", message: `${a.approval.answer?.by.name ?? "A person"} sent the work back${note ? `: ${note}` : "."} Change the files. Then call create_pull_request again.`, final: true };
      }
      return a.checks && !a.checks.ok
        ? { state: "open", merged: false, status: "tests fail", message: "The last test run failed. Fix the files. Then call create_pull_request again.", final: true }
        : { state: "open", merged: false, status: "not submitted", message: "Call create_pull_request to ask for a merge.", final: true };
  }
}

export function pullJson(p: Pull, state: T.ProjectState, origin = "") {
  const a = p.attempt;
  const intent = state.intents.find((i) => i.id === a.intentId);
  const info = pullInfo(p, state, origin);
  return {
    number: p.number,
    title: (a.summary ?? "").split("\n")[0] || intent?.title || p.branch,
    body: (a.summary ?? "").split("\n").slice(1).join("\n").trim(),
    state: info.state,
    merged: info.merged,
    draft: false,
    head: { ref: p.branch, sha: a.headSha ?? a.baseSha },
    base: { ref: MAIN, sha: a.baseSha },
    changed_files: a.stats.filesChanged,
    additions: a.stats.additions,
    deletions: a.stats.deletions,
    gitring: { status: info.status, message: info.message, attemptId: a.id, task: intent?.id, ...(a.approval ? { approval: approvalView(a.approval) } : {}), ...(info.approvalUrl ? { approvalUrl: info.approvalUrl } : {}) },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The answer about a pull request after a question to a person: what the work copy is now (waits for a person, sent
 * back, queued, merged). The change request of a send-back comes first, as in every answer of gitring.
 */
export async function pullReply(ctx: ToolContext, h: Project, attemptId: string, st: T.WorkStatus, opts: { asked?: boolean; before?: string; extra?: Record<string, unknown>; app?: boolean } = {}): Promise<ToolResult> {
  const state = await h.stub.state();
  const p = myPulls(state, ctx.who).find((x) => x.attempt.id === attemptId);
  if (!p) throw new Error("This pull request is not yours.");
  const info = pullInfo(p, state, ctx.origin);
  const waiting = st.approval?.status === "waiting" && st.status === "ready";
  const headline = waiting
    ? statusHeadline(st, { check: `To see the answer, call merge_pull_request for pull request ${p.number}.`, asked: opts.asked, before: opts.before, header: `Pull request ${p.number}: ${info.status}. The work is not merged yet.`, app: opts.app })
    : `${opts.before ? `${opts.before} ` : ""}Pull request ${p.number}: ${info.status}. ${info.message}`;
  return data(
    { number: p.number, state: info.state, merged: info.merged, status: info.status, message: info.message, ...(st.approval ? { approval: approvalView(st.approval) } : {}), ...(info.approvalUrl ? { approvalUrl: info.approvalUrl } : {}), ...(opts.extra ?? {}) },
    headline,
    st.clearance,
  );
}
