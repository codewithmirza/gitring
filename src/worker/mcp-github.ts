/**
 * The GitHub-compatible tool set (/mcp/github).
 *
 * An agent or a plugin that works with the GitHub MCP server can use gitring when its owner changes one
 * URL. The tools keep the names and the argument names of the GitHub tools. They map onto gitring:
 *
 *   repo                        the gitring project id (owner is accepted and ignored)
 *   main                        main
 *   any other branch name       a work copy of the caller. The first write to a new name declares it.
 *                               The name is in the approach text of the work copy: GitHub branch "name".
 *   push_files, create_or_update_file, delete_file
 *                               the write of gitring_write. The conflict check runs, and a change request
 *                               comes back in the answer. Nothing writes to main.
 *   create_pull_request         the submit of gitring_submit: the tests run first, then the merge queue. When
 *                               a person must say yes, gitring asks that person (in the chat when the client
 *                               can show a question) and the answer says "waits for a person".
 *   merge_pull_request          reports the state of the merge and waits a short time. It never merges by
 *                               itself and never skips the tests: gitring merges when the tests pass and
 *                               the person said yes (when a person must say it).
 *   update_pull_request_branch  the update of gitring_update
 *   issues                      gitring tasks
 *
 * A pull request number is the place of the work copy in the age order of all branch work copies of the
 * project (a task has its own order). A branch belongs to the caller who made it. Its work copy is the work
 * copy of that person: only that person (or an owner) can change it, and only that person gets its change
 * requests. The read tools bring them too, after the text of a file or above the GitHub-shaped JSON.
 */
import { z } from "zod";
import type * as T from "../core/types";
import type { Role } from "../core/accounts";
import { approvalPath } from "../core/approvals";
import { actorOf, directory, type Principal } from "./auth";
import { ADDS, CHANGES, READS, callOf, defineTool, fail, joinClearance, plain, text, VERDICT_WORD, withNews, writeAnswer, type HarborApi, type ToolContext, type ToolDef, type ToolResult } from "./mcp-kit";
import { answerNote, approvalView, askInChat, statusHeadline, takeAnswer } from "./mcp-approval";

/** Said in the error of a bad project id (the gitring tool for it is not in this set). */
export const GITHUB_LIST_HOW = "Call get_me to list your projects.";

/** Said after a restart stopped a call that is not safe to send again (the gitring tools for it are not in this set). */
export const GITHUB_CHECK_HOW = "Call list_branches or list_issues to see if your call took effect before you send it again.";

export const GITHUB_INSTRUCTIONS =
  "These tools work like the GitHub tools, but they work on gitring. A repo is a gitring project. " +
  "A branch other than main is your own work copy. No tool writes to main. " +
  "Call create_pull_request when your work is ready: gitring runs the tests, then it merges. " +
  "Sometimes a person must say yes first. Then the answer says that the pull request waits for a person. " +
  "Tell the person. Do not change the branch. Call merge_pull_request to see the answer. " +
  'When a result starts with "GITRING CHANGE REQUEST", apply it in your next edits.';

/** How long merge_pull_request waits for a merge to finish, in milliseconds. The tests can change it. */
export const MERGE_WAIT = { ms: 8000, stepMs: 400 };

type Project = { id: string; stub: HarborApi; role: Role };

const MAIN = "main";
const MARK = "GitHub branch ";
const DONE: ReadonlySet<T.AttemptStatus> = new Set<T.AttemptStatus>(["landed", "abandoned", "alternate", "failed", "stale"]);
const OPEN_TASK: ReadonlySet<T.IntentStatus> = new Set<T.IntentStatus>(["draft", "open", "underway", "judging", "landing"]);

const owner = z.string().optional().describe("gitring ignores owner.");
const repo = z.string().describe("The gitring project id. get_me lists your projects.");
const page = z.number().int().optional().describe("Page number, from 1.");
const perPage = z.number().int().optional().describe("Items per page (30 if you leave it out, 100 at most).");

/* ───────────────────────── projects, branches, numbers ───────────────────────── */

async function open(ctx: ToolContext, raw: string, need: "viewer" | "member"): Promise<Project> {
  const id = String(raw ?? "").trim().split("/").pop() ?? "";
  const h = await ctx.access(id, need);
  await h.stub.ensure(h.id);
  return h;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** The agent of one branch of one caller. Each branch is its own line of work, so it is its own agent. */
const agentFor = (who: Principal, branch: string): string => `gh-${who.user?.id ?? "operator"}-${fnv(branch)}`;

const approachOf = (branch: string): string => `${MARK}${JSON.stringify(branch)}`;

function branchIn(approach: string): string | null {
  if (!approach.startsWith(MARK)) return null;
  try {
    const v: unknown = JSON.parse(approach.slice(MARK.length));
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function cleanBranch(raw: unknown): string {
  const name = String(raw ?? "").trim().replace(/^refs\/heads\//, "").replace(/^heads\//, "");
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(name) || name.includes("..") || name.startsWith("/") || name.endsWith("/")) {
    throw new Error(`"${name}" is not a branch name. Use letters, digits, dots, dashes, underscores and slashes.`);
  }
  return name;
}

/** A branch that gitring can write to: any name but main. */
function workBranch(raw: unknown): string {
  const name = cleanBranch(raw);
  if (name === MAIN) throw new Error("gitring does not write to main. Use another branch name. Then call create_pull_request to ask for a merge.");
  return name;
}

const byAge = <A extends { createdAt: number }>(xs: readonly A[]): A[] => [...xs].sort((a, b) => a.createdAt - b.createdAt);

/** The branches of this caller: the latest work copy of each name. */
function myBranches(state: T.ProjectState, who: Principal): Map<string, T.Attempt> {
  const out = new Map<string, T.Attempt>();
  for (const a of byAge(state.attempts)) {
    const name = branchIn(a.course.approach);
    if (name && a.agentId === agentFor(who, name)) out.set(name, a);
  }
  return out;
}

/** The work copy asked for was sent to gitring with submit (a failed test run counts: it is a pull request that waits for a fix). */
const opened = (a: T.Attempt): boolean => a.summary !== undefined || (a.status !== "declared" && a.status !== "underway");

interface Pull {
  number: number;
  branch: string;
  attempt: T.Attempt;
}

/** The pull requests of this caller. The number is the place among all branch work copies of the project. */
function myPulls(state: T.ProjectState, who: Principal): Pull[] {
  return byAge(state.attempts)
    .map((attempt) => ({ attempt, branch: branchIn(attempt.course.approach) }))
    .filter((x): x is { attempt: T.Attempt; branch: string } => x.branch !== null)
    .map((x, i) => ({ number: i + 1, ...x }))
    .filter((p) => p.attempt.agentId === agentFor(who, p.branch) && opened(p.attempt));
}

function pullAt(state: T.ProjectState, who: Principal, n: number): Pull {
  const p = myPulls(state, who).find((x) => x.number === n);
  if (!p) throw new Error(`Pull request ${n} does not exist, or it is not yours. gitring shows only your own pull requests. Call list_pull_requests.`);
  return p;
}

const sha7 = (s: string | undefined): string => String(s ?? "").slice(0, 7);

/** Where a ref points, for a read: main, a commit, or a work copy of the caller. */
async function resolve(h: Project, who: Principal, ref?: string, sha?: string): Promise<{ ref: string; name: string; attemptId?: string }> {
  const want = String(sha || ref || "").trim().replace(/^refs\/heads\//, "").replace(/^heads\//, "");
  if (!want || want === MAIN) return { ref: MAIN, name: MAIN };
  if (/^[0-9a-f]{40}$/.test(want)) return { ref: want, name: sha7(want) };
  const a = myBranches(await h.stub.state(), who).get(want);
  if (!a) throw new Error(`The branch "${want}" does not exist. Use main, a branch that you made, or a full commit id. Call list_branches.`);
  return { ref: a.id, name: want, attemptId: a.id };
}

function page_<A>(items: A[], pageNo?: number, size?: number): A[] {
  const n = Math.min(100, Math.max(1, Math.floor(size ?? 30)));
  const p = Math.max(1, Math.floor(pageNo ?? 1));
  return items.slice((p - 1) * n, p * n);
}

/** The entries of one folder, from the flat list of files. */
function entriesOf(files: T.FileNode[], dir: string): { type: "file" | "dir"; name: string; path: string; size: number }[] {
  const prefix = dir ? `${dir}/` : "";
  const out = new Map<string, { type: "file" | "dir"; name: string; path: string; size: number }>();
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) out.set(rest, { type: "file", name: rest, path: f.path, size: f.size });
    else if (!out.has(rest.slice(0, slash))) out.set(rest.slice(0, slash), { type: "dir", name: rest.slice(0, slash), path: prefix + rest.slice(0, slash), size: 0 });
  }
  return [...out.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

const github = { github: true } as const;
const data = (obj: unknown, headline: string, clr?: T.Clearance): ToolResult => text(obj, headline, clr, github);

/** The new change requests of a branch of the caller, for the answer of a read (none for main or a commit). */
async function newsOf(ctx: ToolContext, h: Project, attemptId: string | undefined): Promise<T.Clearance | undefined> {
  if (!attemptId) return undefined;
  return (await h.stub.news(attemptId, callOf(ctx, h))) ?? undefined;
}

/* ───────────────────────── a work copy for a branch ───────────────────────── */

const titleFrom = (message: string | undefined, branch: string): string => String(message ?? "").split("\n")[0].trim().slice(0, 140) || `Branch ${branch}`;

/**
 * The work copy of a branch. A new name (or a name whose work copy is done) declares a new one from main.
 * The plan comes from the branch name and the paths. gitring_declare gives gitring a better plan.
 * `declared` holds the first conflict check: its change requests must reach the agent.
 */
async function branchCopy(ctx: ToolContext, h: Project, branch: string, seed: { title: string; paths: string[] }): Promise<{ attemptId: string; existed: boolean; declared?: T.DeclareResult }> {
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

async function writeToBranch(ctx: ToolContext, a: { repo: string; branch: string; message?: string }, files: { path: string; content?: string; delete?: boolean }[]): Promise<ToolResult> {
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

/* ───────────────────────── pull requests ───────────────────────── */

interface PullInfo {
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
function approvalUrlOf(p: Pull, state: T.ProjectState, origin: string): string {
  return `${origin}${approvalPath(state.project.id, p.attempt.id)}`;
}

function pullInfo(p: Pull, state: T.ProjectState, origin = ""): PullInfo {
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

function pullJson(p: Pull, state: T.ProjectState, origin = "") {
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The answer about a pull request after a question to a person: what the work copy is now (waits for a person, sent
 * back, queued, merged). The change request of a send-back comes first, as in every answer of gitring.
 */
async function pullReply(ctx: ToolContext, h: Project, attemptId: string, st: T.WorkStatus, opts: { asked?: boolean; before?: string; extra?: Record<string, unknown> } = {}): Promise<ToolResult> {
  const state = await h.stub.state();
  const p = myPulls(state, ctx.who).find((x) => x.attempt.id === attemptId);
  if (!p) throw new Error("This pull request is not yours.");
  const info = pullInfo(p, state, ctx.origin);
  const waiting = st.approval?.status === "waiting" && st.status === "ready";
  const headline = waiting
    ? statusHeadline(st, { check: `To see the answer, call merge_pull_request for pull request ${p.number}.`, asked: opts.asked, before: opts.before, header: `Pull request ${p.number}: ${info.status}. The work is not merged yet.` })
    : `${opts.before ? `${opts.before} ` : ""}Pull request ${p.number}: ${info.status}. ${info.message}`;
  return data(
    { number: p.number, state: info.state, merged: info.merged, status: info.status, message: info.message, ...(st.approval ? { approval: approvalView(st.approval) } : {}), ...(info.approvalUrl ? { approvalUrl: info.approvalUrl } : {}), ...(opts.extra ?? {}) },
    headline,
    st.clearance,
  );
}


/* ───────────────────────── commits and code search ───────────────────────── */

const iso = (ms: number): string => new Date(ms).toISOString();

/** A commit that gitring merged into main: the landing is the record of it. */
function commitJson(l: T.Landing, state: T.ProjectState) {
  const agent = state.agents.find((x) => x.id === l.agentId)?.callsign ?? "agent";
  const task = state.intents.find((i) => i.id === l.intentId)?.title;
  return {
    sha: l.mainAfter,
    commit: { message: l.message, author: { name: agent, date: iso(l.at) }, committer: { name: "gitring", date: iso(l.at) } },
    gitring: { method: l.method, task: task ?? l.intentId },
  };
}

/** Search limits: gitring reads the files itself, so the scan has a size. */
const SCAN = { files: 400, bytes: 200_000 };

/** The qualifiers of GitHub code search. A word with another prefix, such as http:, is a plain word. */
const QUALIFIERS = new Set(["repo", "org", "user", "language", "path", "filename", "extension", "size", "fork", "in", "symbol", "content", "is", "enterprise", "license"]);

/** The query of search_code: words (or "phrases") that must be in the file, and the qualifiers that gitring uses. */
function parseSearch(query: string): { terms: string[]; path: string; ext: string; repo: string } {
  const out = { terms: [] as string[], path: "", ext: "", repo: "" };
  for (const m of String(query ?? "").matchAll(/"([^"]+)"|(\S+)/g)) {
    const word = m[1] ?? m[2];
    const qual = m[2] ? /^([A-Za-z]+):(.*)$/.exec(m[2]) : null;
    if (!qual || !QUALIFIERS.has(qual[1].toLowerCase())) out.terms.push(word.toLowerCase());
    else if (qual[1].toLowerCase() === "path") out.path = qual[2].toLowerCase();
    else if (qual[1].toLowerCase() === "extension") out.ext = `.${qual[2].replace(/^\./, "").toLowerCase()}`;
    else if (qual[1].toLowerCase() === "repo") out.repo = qual[2].split("/").pop() ?? "";
  }
  return out;
}

/* ───────────────────────── tasks (issues) ───────────────────────── */

function issueJson(i: T.Intent, number: number) {
  const isOpen = OPEN_TASK.has(i.status);
  return {
    number,
    id: i.id,
    title: i.title,
    body: i.goal,
    state: isOpen ? "open" : "closed",
    state_reason: isOpen ? null : i.status === "landed" ? "completed" : "not_planned",
    labels: [] as string[],
    assignees: [] as string[],
    created_at: new Date(i.createdAt).toISOString(),
    updated_at: new Date(i.updatedAt).toISOString(),
    gitring: { status: i.status, tests: i.checks.map((c) => c.path), constraints: i.constraints },
  };
}

/* ───────────────────────── the tools ───────────────────────── */

const readMethods = z.enum(["get", "get_diff", "get_status", "get_files", "get_commits", "get_review_comments", "get_reviews", "get_comments", "get_check_runs"]);

export const GITHUB_TOOLS: readonly ToolDef[] = [
  defineTool({
    name: "get_me",
    title: "Show who I am",
    description:
      "GitHub-compatible: show who you are. gitring has no profile page. " +
      "The answer has your name, your id and the projects that you can use. Use a project id as repo in the other tools.",
    inputSchema: {},
    annotations: READS,
    async run(ctx) {
      try {
        const list = await directory(ctx.env).listProjects(ctx.who.user?.id ?? null);
        const me = { login: ctx.who.user?.name ?? "operator", id: ctx.who.user?.id ?? null, projects: list.map((x) => ({ repo: x.id, name: x.name, role: x.role })) };
        return data(me, `You are ${me.login}. You can use ${list.length} projects. Use a project id as repo.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "search_repositories",
    title: "Find projects",
    description:
      "GitHub-compatible: find projects by name. A repository here is a gitring project. " +
      "gitring searches only the projects that you can see. It ignores search qualifiers such as org: and language:.",
    inputSchema: { query: z.string(), page, perPage, sort: z.string().optional(), order: z.string().optional(), minimal_output: z.boolean().optional() },
    annotations: READS,
    async run(ctx, a) {
      try {
        const words = String(a.query ?? "").toLowerCase().split(/\s+/).filter((w) => w && !w.includes(":"));
        const all = await directory(ctx.env).listProjects(ctx.who.user?.id ?? null);
        const hits = all.filter((p) => words.every((w) => p.id.includes(w) || p.name.toLowerCase().includes(w)));
        const items = page_(hits, a.page, a.perPage).map((p) => ({ id: p.id, name: p.id, full_name: p.id, description: p.name, private: p.visibility !== "public", default_branch: MAIN, role: p.role }));
        return data({ total_count: hits.length, incomplete_results: false, items }, `${hits.length} projects match.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "get_file_contents",
    title: "Read a file or folder",
    description:
      "GitHub-compatible: read one file, or list one folder. Set ref to main, to one of your branches, or to a full commit id. " +
      "repo is the project id. gitring ignores owner. Only text files work.",
    inputSchema: { owner, repo, path: z.string().optional().describe('The path. "/" is the top folder.'), ref: z.string().optional(), sha: z.string().optional() },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "viewer");
        const t = await resolve(h, ctx.who, a.ref, a.sha);
        const path = String(a.path ?? "/").replace(/^\/+/, "").replace(/\/+$/, "");
        if (path) {
          const body = t.attemptId ? (await h.stub.read(t.attemptId, path)).content : await h.stub.file(t.ref, path);
          if (body !== null) return withNews(plain(body), await newsOf(ctx, h, t.attemptId), github);
        }
        const entries = entriesOf((await h.stub.tree(t.ref)).files, path);
        if (!entries.length) throw new Error(`There is no text file or folder "${path}" on ${t.name}.`);
        return data(entries, `${entries.length} entries in ${path || "the top folder"} on ${t.name}.`, await newsOf(ctx, h, t.attemptId));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "get_repository_tree",
    title: "List files of a ref",
    description:
      "GitHub-compatible: list the files of main, of one of your branches, or of a full commit id. Set tree_sha to the ref. " +
      "Set path_filter to one folder. Set recursive to true to list all files below it. gitring ignores owner.",
    inputSchema: { owner, repo, tree_sha: z.string().optional(), recursive: z.boolean().optional(), path_filter: z.string().optional() },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "viewer");
        const t = await resolve(h, ctx.who, a.tree_sha);
        const res = await h.stub.tree(t.ref);
        const dir = String(a.path_filter ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
        const tree = a.recursive
          ? res.files.filter((f) => !dir || f.path === dir || f.path.startsWith(`${dir}/`)).map((f) => ({ path: f.path, type: "blob", size: f.size }))
          : entriesOf(res.files, dir).map((e) => ({ path: e.path, type: e.type === "dir" ? "tree" : "blob", size: e.size }));
        return data({ sha: res.sha, truncated: false, tree }, `${tree.length} entries on ${t.name}.`, await newsOf(ctx, h, t.attemptId));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "list_branches",
    title: "List branches",
    description:
      "GitHub-compatible: list main and your own branches. A branch is a work copy of gitring. " +
      "gitring does not show the branches of other agents. gitring ignores owner.",
    inputSchema: { owner, repo, page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "viewer");
        const state = await h.stub.state();
        const mine = [...myBranches(state, ctx.who)].map(([name, at]) => ({ name, commit: { sha: at.headSha ?? at.baseSha }, protected: false, status: DONE.has(at.status) ? at.status : "open" }));
        const all = [{ name: MAIN, commit: { sha: state.project.mainSha }, protected: true, status: "open" }, ...mine];
        return data(page_(all, a.page, a.perPage), `${all.length} branches. Main and ${mine.length} of yours.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "list_commits",
    title: "List merged commits",
    description:
      "GitHub-compatible: list the commits that gitring merged into main, newest first. gitring has no other commit history here. " +
      "It ignores path and author. Set sha to main or leave it out. Use since and until to limit the dates.",
    inputSchema: { owner, repo, sha: z.string().optional(), path: z.string().optional(), author: z.string().optional(), since: z.string().optional(), until: z.string().optional(), page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        if (a.sha && cleanBranch(a.sha) !== MAIN) throw new Error("gitring lists the commits of main only. Set sha to main, or leave it out.");
        const from = a.since ? Date.parse(a.since) : -Infinity;
        const to = a.until ? Date.parse(a.until) : Infinity;
        if (Number.isNaN(from) || Number.isNaN(to)) throw new Error("Give since and until as dates, for example 2026-01-31T00:00:00Z.");
        const h = await open(ctx, a.repo, "viewer");
        const state = await h.stub.state();
        const all = state.landings.filter((l) => l.at >= from && l.at <= to).sort((x, y) => y.at - x.at);
        const items = page_(all, a.page, a.perPage).map((l) => commitJson(l, state));
        return data(items, `${all.length} commits that gitring merged into main.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "get_commit",
    title: "Read a merged commit",
    description:
      "GitHub-compatible: read one commit that gitring merged into main. Give its id in sha. The answer has the message and the changed files. " +
      "gitring has details only for commits that it merged. Set include_diff to false to leave out the patches.",
    inputSchema: { owner, repo, sha: z.string(), include_diff: z.boolean().optional(), page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        const want = String(a.sha ?? "").trim().toLowerCase();
        if (!/^[0-9a-f]{7,40}$/.test(want)) throw new Error("Give the commit id: 7 to 40 hex digits.");
        const h = await open(ctx, a.repo, "viewer");
        const state = await h.stub.state();
        const landing = state.landings.find((l) => l.mainAfter.startsWith(want));
        if (!landing) throw new Error(`gitring has no details for the commit ${want.slice(0, 7)}. It has details only for commits that it merged into main.`);
        const diff = await h.stub.attemptDiff(landing.attemptId);
        const files = page_(diff.files, a.page, a.perPage).map((f) => ({
          filename: f.path,
          status: f.status === "A" ? "added" : f.status === "D" ? "removed" : "modified",
          additions: f.additions,
          deletions: f.deletions,
          changes: f.additions + f.deletions,
          ...(a.include_diff === false ? {} : { patch: f.diff }),
        }));
        return data({ ...commitJson(landing, state), stats: { additions: diff.files.reduce((n, f) => n + f.additions, 0), deletions: diff.files.reduce((n, f) => n + f.deletions, 0) }, files }, `Commit ${sha7(landing.mainAfter)}: ${diff.files.length} files changed.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "search_code",
    title: "Search code",
    description:
      "GitHub-compatible: search the text files of main in one project. Give the project id in repo, or as repo:name in the query. " +
      "Every word of the query must be in the file. gitring ignores case. It ignores other qualifiers, except path: and extension:. " +
      "It reads 400 files at most, and no file above 200 KB.",
    inputSchema: { query: z.string(), repo: z.string().optional().describe("The gitring project id. You can give repo:name in the query instead."), sort: z.string().optional(), order: z.string().optional(), page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        const q = parseSearch(a.query);
        const raw = a.repo ?? q.repo;
        if (!raw) throw new Error("Give repo (the project id), or repo:name in the query.");
        if (!q.terms.length) throw new Error("Give at least one word to search for.");
        const h = await open(ctx, raw, "viewer");
        const files = (await h.stub.tree(MAIN)).files.filter((f) => f.size <= SCAN.bytes && (!q.path || f.path.toLowerCase().includes(q.path)) && (!q.ext || f.path.toLowerCase().endsWith(q.ext)));
        const hits: { name: string; path: string; repository: { full_name: string }; text_matches: { fragment: string }[] }[] = [];
        for (const f of files.slice(0, SCAN.files)) {
          const body = await h.stub.file(MAIN, f.path);
          if (body === null) continue;
          const low = body.toLowerCase();
          if (!q.terms.every((t) => low.includes(t))) continue;
          const at = low.indexOf(q.terms[0]);
          hits.push({ name: f.path.split("/").pop() ?? f.path, path: f.path, repository: { full_name: h.id }, text_matches: [{ fragment: body.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, " ").trim() }] });
        }
        const partial = files.length > SCAN.files;
        return data({ total_count: hits.length, incomplete_results: partial, items: page_(hits, a.page, a.perPage) }, `${hits.length} files match.${partial ? ` gitring read the first ${SCAN.files} files only.` : ""}`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "create_branch",
    title: "Make a branch",
    description:
      "GitHub-compatible: make a branch for your work. gitring makes a work copy from main, and a task for it. " +
      "from_branch must be main. Then call push_files or create_or_update_file. " +
      "A real plan from gitring_declare gives better coordination. That tool is on the full endpoint.",
    inputSchema: { owner, repo, branch: z.string(), from_branch: z.string().optional().describe("Main, or leave it out.") },
    annotations: ADDS,
    async run(ctx, a) {
      try {
        const branch = workBranch(a.branch);
        if (a.from_branch && cleanBranch(a.from_branch) !== MAIN) throw new Error("gitring makes branches from main only. Set from_branch to main, or leave it out.");
        const h = await open(ctx, a.repo, "member");
        const made = await branchCopy(ctx, h, branch, { title: `Branch ${branch}`, paths: [] });
        if (made.existed || !made.declared) throw new Error(`The branch "${branch}" exists already. Write to it with push_files.`);
        const d = made.declared;
        return data(
          { ref: `refs/heads/${branch}`, object: { sha: d.workspace.baseSha } },
          `The branch "${branch}" is ready. It starts from main at ${sha7(d.workspace.baseSha)}. Conflict check: ${VERDICT_WORD[d.clearance.verdict] ?? d.clearance.verdict}. ${d.clearance.advice}`,
          d.clearance,
        );
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "push_files",
    title: "Write many files",
    description:
      "GitHub-compatible: write many files to one branch in one call. gitring writes to your work copy, never to main. " +
      "A new branch name makes a new work copy. gitring checks your work against the 20 nearest active plans after each write. " +
      "The answer can hold change requests. Apply them in your next edits.",
    inputSchema: { owner, repo, branch: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })), message: z.string() },
    // A write replaces the whole text of a file in the work copy.
    annotations: CHANGES,
    async run(ctx, a) {
      try {
        return await writeToBranch(ctx, a, (a.files ?? []).map((f) => ({ path: f.path, content: f.content })));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "create_or_update_file",
    title: "Write one file",
    description:
      "GitHub-compatible: write one whole file to a branch. gitring writes to your work copy, never to main. " +
      "gitring ignores sha and owner. It checks the change against the 20 nearest active plans instead. " +
      "The answer can hold change requests. Apply them in your next edits.",
    inputSchema: { owner, repo, path: z.string(), content: z.string(), message: z.string(), branch: z.string(), sha: z.string().optional() },
    annotations: CHANGES,
    async run(ctx, a) {
      try {
        return await writeToBranch(ctx, a, [{ path: a.path, content: a.content }]);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "delete_file",
    title: "Delete a file",
    description:
      "GitHub-compatible: delete one file from a branch. gitring deletes it in your work copy, never on main. " +
      "gitring checks the change against the 20 nearest active plans. The answer can hold change requests. Apply them in your next edits.",
    inputSchema: { owner, repo, path: z.string(), message: z.string(), branch: z.string() },
    annotations: CHANGES,
    async run(ctx, a) {
      try {
        return await writeToBranch(ctx, a, [{ path: a.path, delete: true }]);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "create_pull_request",
    title: "Ask for a merge",
    description:
      "GitHub-compatible: ask for a merge of your branch into main. base must be main. gitring runs the tests first. " +
      "The answer says: queued, merged, waits for a person, or the tests failed. " +
      "Sometimes a person must say yes first. Then gitring asks the person. It asks in this chat if the client can show a question. If not, the answer has a link to the gitring app. " +
      "Wait for the person. Do not change the branch. Call merge_pull_request to see the answer. " +
      "After a failure, fix the files and call this tool again. gitring has no draft pull requests and no reviewers.",
    inputSchema: {
      owner,
      repo,
      title: z.string(),
      head: z.string().describe("Your branch."),
      base: z.string().describe("Main."),
      body: z.string().optional(),
      draft: z.boolean().optional(),
      maintainer_can_modify: z.boolean().optional(),
      reviewers: z.array(z.string()).optional(),
    },
    // A merge adds a commit to main and keeps the history. It can also send the merge to GitHub.
    annotations: { ...ADDS, openWorldHint: true },
    async run(ctx, a, req) {
      try {
        if (cleanBranch(a.base) !== MAIN) throw new Error("gitring merges into main only. Set base to main.");
        // GitHub can name the head as owner:branch. gitring has no owners.
        const head = workBranch(String(a.head ?? "").replace(/^[^:/]+:/, ""));
        const h = await open(ctx, a.repo, "member");
        const viewer = ctx.who.user ? { id: ctx.who.user.id, role: h.role } : undefined;
        const at = myBranches(await h.stub.state(), ctx.who).get(head);
        if (!at) throw new Error(`The branch "${head}" does not exist. Write to it with push_files first.`);
        // The second call of a question in chat: the person answered, so pass the answer on.
        const taken = await takeAnswer(ctx, req, h, at.id);
        if (taken) return pullReply(ctx, h, at.id, taken.status, { asked: !taken.result, before: answerNote(taken.result) });
        if (a.draft) return plain(`gitring has no draft pull requests. The branch "${head}" stays a work copy. Call create_pull_request again without draft when it is ready.`);
        if (DONE.has(at.status)) {
          throw new Error(
            at.status === "landed"
              ? `The branch "${head}" is merged already. Write to it to start new work. Then call create_pull_request again.`
              : `The work copy of the branch "${head}" is closed. Write to the branch to start a new work copy. Then call create_pull_request again.`,
          );
        }
        if (!(await h.stub.attemptDiff(at.id)).files.length) throw new Error(`The branch "${head}" has no changes. Write files to it first.`);
        const res = await h.stub.submit(at.id, [a.title, a.body].filter(Boolean).join("\n\n"), { origin: ctx.origin, viewer });
        if (res.next === "awaiting-approval") {
          // A person must say yes. Ask in this chat when the client can show a question. Else the answer holds the link.
          const st = await h.stub.status(at.id, { origin: ctx.origin, viewer });
          return (await askInChat(ctx, req, h, st)) ?? (await pullReply(ctx, h, at.id, st, { extra: { checks: res.checks ? { passed: res.checks.passed, failed: res.checks.failed } : undefined } }));
        }
        const state = await h.stub.state();
        const mine = myPulls(state, ctx.who).find((x) => x.attempt.id === at.id);
        const number = mine?.number;
        const words: Record<string, string> = {
          "landing-queue": "queued",
          landed: "merged",
          "fix-checks": "tests failed",
        };
        return data(
          { number, state: "open", head: { ref: head }, base: { ref: MAIN }, merge: words[res.next] ?? res.next, checks: res.checks ? { passed: res.checks.passed, failed: res.checks.failed } : undefined, message: res.message },
          `Pull request ${number ?? "?"}: ${words[res.next] ?? res.next}. ${res.message}`,
          res.clearance,
        );
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "pull_request_read",
    title: "Read a pull request",
    description:
      "GitHub-compatible: read one of your pull requests. Methods: get, get_status, get_files and get_diff. " +
      "gitring has no commits, reviews or comments on a pull request. gitring shows only your own pull requests.",
    inputSchema: { method: readMethods, owner, repo, pullNumber: z.number().int(), page, perPage, after: z.string().optional() },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "member");
        const state = await h.stub.state();
        const p = pullAt(state, ctx.who, a.pullNumber);
        const info = pullInfo(p, state, ctx.origin);
        const clr = a.method.startsWith("get") ? await newsOf(ctx, h, p.attempt.id) : undefined;
        switch (a.method) {
          case "get":
            return data(pullJson(p, state, ctx.origin), `Pull request ${p.number}: ${info.status}. ${info.message}`, clr);
          case "get_status": {
            const runs = [
              { context: "tests of the branch", run: p.attempt.checks },
              { context: "tests with main", run: p.attempt.composedChecks },
            ].filter((x): x is { context: string; run: T.CheckRun } => Boolean(x.run));
            const statuses = runs.map((x) => ({ context: x.context, state: x.run.ok ? "success" : "failure", description: `${x.run.passed}/${x.run.passed + x.run.failed} tests pass.${x.run.error ? ` ${x.run.error}` : ""}` }));
            const overall = statuses.length === 0 ? "pending" : statuses.every((s) => s.state === "success") ? "success" : "failure";
            return data({ state: overall, sha: p.attempt.headSha ?? p.attempt.baseSha, total_count: statuses.length, statuses }, `Pull request ${p.number}: tests ${overall}.`, clr);
          }
          case "get_files": {
            const diff = await h.stub.attemptDiff(p.attempt.id);
            const files = diff.files.map((f) => ({ filename: f.path, status: f.status === "A" ? "added" : f.status === "D" ? "removed" : "modified", additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions, patch: f.diff }));
            return data(page_(files, a.page, a.perPage), `${files.length} files changed in pull request ${p.number}.`, clr);
          }
          case "get_diff": {
            const diff = await h.stub.attemptDiff(p.attempt.id);
            return withNews(plain(diff.files.map((f) => f.diff).join("\n") || "No file changed."), clr, github);
          }
          default:
            throw new Error(`gitring has no ${a.method.replace(/^get_/, "").replace(/_/g, " ")} on a pull request. Use get, get_status, get_files or get_diff.`);
        }
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "list_pull_requests",
    title: "List pull requests",
    description:
      "GitHub-compatible: list your pull requests. A pull request is a branch that you sent with create_pull_request. " +
      "gitring shows only your own pull requests. It ignores head, base, sort and direction.",
    inputSchema: { owner, repo, state: z.enum(["open", "closed", "all"]).optional(), head: z.string().optional(), base: z.string().optional(), sort: z.string().optional(), direction: z.string().optional(), page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "member");
        const state = await h.stub.state();
        const want = a.state ?? "open";
        const all = myPulls(state, ctx.who).filter((p) => want === "all" || pullInfo(p, state, ctx.origin).state === want);
        const items = page_(all, a.page, a.perPage).map((p) => {
          const j = pullJson(p, state, ctx.origin);
          return { number: j.number, title: j.title, state: j.state, merged: j.merged, head: j.head, base: j.base, gitring: j.gitring };
        });
        return data(items, `${all.length} pull requests.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "merge_pull_request",
    title: "Wait for the merge",
    description:
      "GitHub-compatible: report the merge of one of your pull requests, and wait for it for a short time. " +
      "This tool never merges by itself and never skips the tests. gitring merges when the tests pass. " +
      "The answer says: merged, queued, waits for a person, tests failed, or not merged. gitring ignores the merge method.",
    inputSchema: { owner, repo, pullNumber: z.number().int(), commit_title: z.string().optional(), commit_message: z.string().optional(), merge_method: z.enum(["merge", "squash", "rebase"]).optional() },
    // It changes nothing: it reads the state, and it waits.
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "member");
        const until = Date.now() + MERGE_WAIT.ms;
        for (;;) {
          const state = await h.stub.state();
          const p = pullAt(state, ctx.who, a.pullNumber);
          const info = pullInfo(p, state, ctx.origin);
          if (info.final || Date.now() >= until) {
            return data(
              { number: p.number, merged: info.merged, state: info.state, status: info.status, message: info.message },
              `Pull request ${p.number}: ${info.status}. ${info.message}${info.final ? "" : " It is not done yet. Call this tool again."}`,
              await newsOf(ctx, h, p.attempt.id),
            );
          }
          await sleep(MERGE_WAIT.stepMs);
        }
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "update_pull_request_branch",
    title: "Update a branch from main",
    description:
      "GitHub-compatible: move your branch onto the new main. gitring does it and names the files to read again. " +
      "Where your change and main touch the same lines, gitring keeps the main text. Write your change again. " +
      "gitring ignores expectedHeadSha.",
    inputSchema: { owner, repo, pullNumber: z.number().int(), expectedHeadSha: z.string().optional() },
    annotations: CHANGES,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "member");
        const p = pullAt(await h.stub.state(), ctx.who, a.pullNumber);
        const res = await h.stub.update(p.attempt.id, callOf(ctx, h));
        return data(res, res.message, await newsOf(ctx, h, p.attempt.id));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "list_issues",
    title: "List tasks",
    description:
      "GitHub-compatible: list the tasks of a project. A task is an issue of gitring. gitring tasks have no labels. " +
      "gitring ignores labels, since and field filters. Give after to get the next page.",
    inputSchema: {
      owner,
      repo,
      state: z.enum(["OPEN", "CLOSED"]).optional(),
      orderBy: z.enum(["CREATED_AT", "UPDATED_AT", "COMMENTS"]).optional(),
      direction: z.enum(["ASC", "DESC"]).optional(),
      perPage: z.number().int().optional(),
      after: z.string().optional(),
      labels: z.array(z.string()).optional(),
      since: z.string().optional(),
    },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "viewer");
        const state = await h.stub.state();
        const numbered = byAge(state.intents).map((i, n) => issueJson(i, n + 1));
        const wanted = numbered.filter((i) => !a.state || i.state === a.state.toLowerCase());
        const key = a.orderBy === "UPDATED_AT" ? "updated_at" : "created_at";
        const sign = a.direction === "ASC" ? 1 : -1;
        wanted.sort((x, y) => sign * (Date.parse(x[key]) - Date.parse(y[key])) || sign * (x.number - y.number));
        const size = Math.min(100, Math.max(1, Math.floor(a.perPage ?? 30)));
        const from = Math.max(0, Math.floor(Number(a.after) || 0));
        const issues = wanted.slice(from, from + size);
        const more = from + size < wanted.length;
        return data({ issues, totalCount: wanted.length, pageInfo: { hasNextPage: more, endCursor: more ? String(from + size) : null } }, `${wanted.length} tasks.${more ? ` Give after ${from + size} for the next page.` : ""}`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "issue_read",
    title: "Read a task",
    description:
      "GitHub-compatible: read one task of a project. A task is an issue of gitring. Method get gives the task and its goal. " +
      "Method get_labels gives an empty list. gitring tasks have no comments and no sub-issues.",
    inputSchema: { method: z.enum(["get", "get_comments", "get_sub_issues", "get_parent", "get_labels"]), owner, repo, issue_number: z.number().int(), page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "viewer");
        const sorted = byAge((await h.stub.state()).intents);
        const task = sorted[a.issue_number - 1];
        if (!task) throw new Error(`Task ${a.issue_number} does not exist. Call list_issues.`);
        if (a.method === "get") return data(issueJson(task, a.issue_number), `Task ${a.issue_number}: ${task.title}. It is ${OPEN_TASK.has(task.status) ? "open" : "closed"}.`);
        if (a.method === "get_labels") return data([], "gitring tasks have no labels.");
        throw new Error(`gitring tasks have no ${a.method.replace(/^get_/, "").replace(/_/g, " ")}. Use method get.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "issue_write",
    title: "Make a task",
    description:
      "GitHub-compatible: make a new task in a project. Set method to create. Give title and body: the body is the goal. " +
      "gitring ignores labels, assignees and milestones. A person changes or closes a task in gitring.",
    inputSchema: {
      method: z.enum(["create", "update"]),
      owner,
      repo,
      title: z.string().optional(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      milestone: z.number().int().optional(),
      issue_number: z.number().int().optional(),
      state: z.enum(["open", "closed"]).optional(),
    },
    annotations: ADDS,
    async run(ctx, a) {
      try {
        if (a.method !== "create") throw new Error("gitring cannot change a task from here. A person changes or closes a task in gitring. Use method create to make a new task.");
        if (!String(a.title ?? "").trim()) throw new Error("Give a title.");
        const h = await open(ctx, a.repo, "member");
        const who = ctx.who.user?.name ?? "agent";
        const intent = await h.stub.createIntent({ title: a.title!, goal: a.body ?? "", source: { kind: "mcp", ref: "github-compatible" } }, { kind: "agent", id: ctx.who.user?.id ?? "operator", name: who });
        const n = byAge((await h.stub.state()).intents).findIndex((i) => i.id === intent.id) + 1;
        return data(issueJson(intent, n), `Task ${n} is open: ${intent.title}.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),
];
