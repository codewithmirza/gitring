/**
 * The issue tools of the GitHub-compatible set: a gitring task is an issue.
 *
 * A person changes or closes a task in gitring. These tools list, read and make tasks.
 */
import { z } from "zod";
import type * as T from "../../core/types";
import { ADDS, READS, defineTool, fail, type ToolDef } from "../mcp-kit";
import { byAge, data, owner, page, perPage, repo } from "./shared";
import { OPEN_TASK, open } from "./branches";

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

export const issueTools: readonly ToolDef[] = [
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
