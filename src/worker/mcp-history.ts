/**
 * The history tools of the gitring set: why a line is there, file changes, code search and compare.
 *
 * They only read, so the read-only endpoint (/mcp/readonly) has them too.
 * An agent needs no clone for these questions: the project object answers them from derived data (src/harbor/derived.ts).
 */
import { z } from "zod";
import type { HarborMaster } from "../harbor/harbor";
import { defineTool, fail, READS, text, type ToolContext, type ToolDef } from "./mcp-kit";

/** The history methods of a project object. */
type HistoryApi = Pick<HarborMaster, "why" | "pathHistory" | "searchCode" | "compareRefs">;

const project = z.string().describe("Project id (gitring_intents without a project lists your projects).");

/** A viewer may ask: the answers show code that the viewer can already read. */
async function historyOf(ctx: ToolContext, p: string): Promise<HistoryApi> {
  return (await ctx.access(p, "viewer")).stub as unknown as HistoryApi;
}

export const HISTORY_TOOLS: readonly ToolDef[] = [
  defineTool({
    name: "gitring_why",
    title: "Explain a line",
    description:
      "Ask why a line of a file is there. gitring names the merge that last changed the line. " +
      "The answer has the record of that merge: task, plan, change requests, tests and the decision of a person. " +
      "Leave out the line to see the merges of the whole file. Use it before you change code that other work wrote.",
    inputSchema: {
      project,
      path: z.string().describe("Repo-relative path of the file."),
      line: z.number().int().min(1).optional().describe("Line number (1 is the first line). Leave it out for the whole file."),
      ref: z.string().optional().describe("main (default), a commit id of main, or your work copy id."),
    },
    annotations: READS,
    async run(ctx, args) {
      try {
        const res = await (await historyOf(ctx, args.project)).why({ path: args.path, line: args.line, ref: args.ref });
        return text(res, res.summary);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_history",
    title: "See the history",
    description:
      "See the changes of a file or a folder on main, the newest first. Each change names the task, the agent, the commit and the line counts. " +
      "Leave out the path to see all changes of main.",
    inputSchema: {
      project,
      path: z.string().optional().describe("Repo-relative path of a file or a folder. Leave it out for all of main."),
      limit: z.number().int().min(1).max(100).optional().describe("How many changes to show (default 20, at most 100)."),
    },
    annotations: READS,
    async run(ctx, args) {
      try {
        const res = await (await historyOf(ctx, args.project)).pathHistory({ path: args.path, limit: args.limit });
        return text(res, res.summary);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_search",
    title: "Search the code",
    description:
      "Find a text in the files of main. Case does not matter. The answer gives each file and each line with the text. " +
      "Give path to search one folder or one file. You need no clone for this.",
    inputSchema: {
      project,
      query: z.string().describe("The text to find, for example a function name."),
      path: z.string().optional().describe("Repo-relative folder or file. Leave it out for all files of main."),
      limit: z.number().int().min(1).max(50).optional().describe("How many files to show (default 20, at most 50)."),
    },
    annotations: READS,
    async run(ctx, args) {
      try {
        const res = await (await historyOf(ctx, args.project)).searchCode({ query: args.query, path: args.path, limit: args.limit });
        return text(res, res.summary);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_diff",
    title: "Compare two versions",
    description:
      "Compare two versions of the code. Each version is main, a commit id or a work copy id. " +
      "The answer has a unified diff for each changed file, from the first version to the second. " +
      "Give path to compare one folder or one file.",
    inputSchema: {
      project,
      from: z.string().describe("The old version: main, a commit id or a work copy id."),
      to: z.string().describe("The new version: main, a commit id or a work copy id."),
      path: z.string().optional().describe("Repo-relative folder or file. Leave it out for all files."),
    },
    annotations: READS,
    async run(ctx, args) {
      try {
        const res = await (await historyOf(ctx, args.project)).compareRefs(args.from, args.to, args.path);
        return text(res, res.summary);
      } catch (e) {
        return fail(e);
      }
    },
  }),
];
