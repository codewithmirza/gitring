/**
 * Branches of the GitHub-compatible tools: a branch name is a work copy of the caller, and writes go to it.
 *
 * A branch belongs to the caller who made it. Nothing here writes to main.
 * Read next: src/worker/github-tools/pulls.ts (the pull requests that branches become).
 */
import type * as T from "../../core/types";
import type { Role } from "../../core/accounts";
import { actorOf, type Principal } from "../auth";
import { callOf, joinClearance, writeAnswer, type HarborApi, type ToolContext, type ToolResult } from "../mcp-kit";
import { byAge, sha7 } from "./shared";

export type Project = { id: string; stub: HarborApi; role: Role };

export const MAIN = "main";
export const MARK = "GitHub branch ";
export const DONE: ReadonlySet<T.AttemptStatus> = new Set<T.AttemptStatus>(["landed", "abandoned", "alternate", "failed", "stale"]);
export const OPEN_TASK: ReadonlySet<T.IntentStatus> = new Set<T.IntentStatus>(["draft", "open", "underway", "judging", "landing"]);

// ───── Projects and branch names ─────

export async function open(ctx: ToolContext, raw: string, need: "viewer" | "member"): Promise<Project> {
  const id = String(raw ?? "").trim().split("/").pop() ?? "";
  const h = await ctx.access(id, need);
  await h.stub.ensure(h.id);
  return h;
}

export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** The agent of one branch of one caller. Each branch is its own line of work, so it is its own agent. */
export const agentFor = (who: Principal, branch: string): string => `gh-${who.user?.id ?? "operator"}-${fnv(branch)}`;

export const approachOf = (branch: string): string => `${MARK}${JSON.stringify(branch)}`;

export function branchIn(approach: string): string | null {
  if (!approach.startsWith(MARK)) return null;
  try {
    const v: unknown = JSON.parse(approach.slice(MARK.length));
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function cleanBranch(raw: unknown): string {
  const name = String(raw ?? "").trim().replace(/^refs\/heads\//, "").replace(/^heads\//, "");
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(name) || name.includes("..") || name.startsWith("/") || name.endsWith("/")) {
    throw new Error(`"${name}" is not a branch name. Use letters, digits, dots, dashes, underscores and slashes.`);
  }
  return name;
}

/** A branch that gitring can write to: any name but main. */
export function workBranch(raw: unknown): string {
  const name = cleanBranch(raw);
  if (name === MAIN) throw new Error("gitring does not write to main. Use another branch name. Then call create_pull_request to ask for a merge.");
  return name;
}

/** The branches of this caller: the latest work copy of each name. */
export function myBranches(state: T.ProjectState, who: Principal): Map<string, T.Attempt> {
  const out = new Map<string, T.Attempt>();
  for (const a of byAge(state.attempts)) {
    const name = branchIn(a.course.approach);
    if (name && a.agentId === agentFor(who, name)) out.set(name, a);
  }
  return out;
}

/** Where a ref points, for a read: main, a commit, or a work copy of the caller. */
export async function resolve(h: Project, who: Principal, ref?: string, sha?: string): Promise<{ ref: string; name: string; attemptId?: string }> {
  const want = String(sha || ref || "").trim().replace(/^refs\/heads\//, "").replace(/^heads\//, "");
  if (!want || want === MAIN) return { ref: MAIN, name: MAIN };
  if (/^[0-9a-f]{40}$/.test(want)) return { ref: want, name: sha7(want) };
  const a = myBranches(await h.stub.state(), who).get(want);
  if (!a) throw new Error(`The branch "${want}" does not exist. Use main, a branch that you made, or a full commit id. Call list_branches.`);
  return { ref: a.id, name: want, attemptId: a.id };
}

// ───── A work copy for a branch ─────

export const titleFrom = (message: string | undefined, branch: string): string => String(message ?? "").split("\n")[0].trim().slice(0, 140) || `Branch ${branch}`;

/**
 * The work copy of a branch. A new name (or a name whose work copy is done) declares a new one from main.
 * The plan comes from the branch name and the paths. gitring_declare gives gitring a better plan.
 * `declared` holds the first conflict check: its change requests must reach the agent.
 */
export async function branchCopy(ctx: ToolContext, h: Project, branch: string, seed: { title: string; paths: string[] }): Promise<{ attemptId: string; existed: boolean; declared?: T.DeclareResult }> {
  const found = myBranches(await h.stub.state(), ctx.who).get(branch);
  if (found && !DONE.has(found.status)) return { attemptId: found.id, existed: true };
  const declared = await h.stub.declare({
    projectId: h.id,
    agent: { id: agentFor(ctx.who, branch), kind: "mcp", client: "github-compatible" },
    newIntent: { title: seed.title, goal: `Work on the branch "${branch}", made with the GitHub-compatible tools.` },
    plan: [seed.paths.length ? `Change ${seed.paths.slice(0, 8).join(", ")} on the branch "${branch}".` : `Make the branch "${branch}" from main.`],
    files: seed.paths,
    symbols: [],
    approach: approachOf(branch),
    mode: "api",
    // The person behind the sign-in sent this agent. That person answers the approval.
    by: actorOf(ctx.who),
  });
  return { attemptId: declared.attemptId, existed: false, declared };
}

export async function writeToBranch(ctx: ToolContext, a: { repo: string; branch: string; message?: string }, files: { path: string; content?: string; delete?: boolean }[]): Promise<ToolResult> {
  const branch = workBranch(a.branch);
  if (!files.length) throw new Error("Give at least one file.");
  const h = await open(ctx, a.repo, "member");
  const { attemptId, declared } = await branchCopy(ctx, h, branch, { title: titleFrom(a.message, branch), paths: files.map((f) => f.path) });
  const res = await h.stub.write({ attemptId, files, message: a.message }, callOf(ctx, h));
  return writeAnswer(res, {
    github: true,
    clr: declared ? joinClearance(declared.clearance, res.clearance) : res.clearance,
    before: declared ? `The branch "${branch}" is a new work copy of main. ` : "",
  });
}
