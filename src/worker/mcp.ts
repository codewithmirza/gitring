/**
 * MCP server for external agents (Claude Code, Codex, Cursor, …).
 * Stateless (MCP 2026-07-28 via createMcpHandler); all state lives in the project's HarborMaster.
 * Every call carries a personal API key or an OAuth token; each tool checks the caller's role on the project.
 *
 * Every tool result starts with a one-line status. When gitring has new change requests for the agent,
 * the result starts with "GITRING CHANGE REQUEST" so the model cannot miss it.
 *
 * Every tool has a title and all four hints (read-only, destructive, idempotent, open-world): MCP
 * directories need them, and the Worker uses the read-only hint for the read-only path and scope.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "./env";
import { atLeast } from "../core/accounts";
import { noTestRan } from "../core/types";
import { actorOf, directory, type Principal } from "./auth";
import { MCP_PATH, type McpSet } from "../directory/oauth";
import { ADDS, CHANGES, READS, defineTool, fail, makeContext, plain, readOnlyTools, registerTools, text, VERDICT_WORD, writeAnswer, type ToolDef } from "./mcp-kit";
import { GITHUB_INSTRUCTIONS, GITHUB_LIST_HOW, GITHUB_TOOLS } from "./mcp-github";
import { answerNote, askCodec, askInChat, statusReply, takeAnswer } from "./mcp-approval";

/** The version that the server tells to clients. */
export const MCP_VERSION = "0.9.1";

const project = z.string().describe("Project id (gitring_intents without a project lists your projects).");
const attemptId = z.string().describe("Your work copy id (attemptId) from gitring_declare.");

/** The tools of the gitring set (/mcp). */
export const GITRING_TOOLS: readonly ToolDef[] = [
  defineTool({
    name: "gitring_intents",
    title: "List tasks",
    description:
      "List the open tasks of a project, with the goal and the test files of each task. Show how many work copies are active. " +
      "Call this first. Leave out the project to list your projects. Then call gitring_declare for one task, or send a new task.",
    inputSchema: { project: z.string().optional().describe("Project id. Leave it out to list the projects your key can use.") },
    annotations: READS,
    async run(ctx, { project: p }) {
      try {
        if (!p) {
          const list = (await directory(ctx.env).listProjects(ctx.who.user?.id ?? null)).filter((x) => atLeast(x.role, "member"));
          return text(
            list.map((x) => ({ project: x.id, name: x.name, role: x.role })),
            list.length ? `${list.length} projects. Call gitring_intents with one project id.` : "Your key has no project where it can act. Create one in gitring, or ask an owner to add you.",
          );
        }
        const h = await ctx.access(p, "viewer");
        await h.stub.ensure(h.id);
        const res = await h.stub.openIntents();
        return text(res, `${res.intents.length} open tasks. ${res.traffic} work copies are active.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_declare",
    title: "Send a plan",
    description:
      "Send your plan BEFORE you write code. Give the steps, the files, the functions and the approach. " +
      "gitring checks the plan against the 20 nearest active plans and against main. It answers clear, or sends change requests. gitring never blocks you. " +
      "Mode 'api' (default) uses gitring_read and gitring_write. Mode 'git' gives a git remote and a token for your work copy. " +
      "Use git mode on a computer: clone, commit, push. " +
      "Give workdir (your repository folder). Then the Claude Code hook can send change requests while you work.",
    inputSchema: {
      project,
      intentId: z.string().optional().describe("A task id (intentId) from gitring_intents."),
      newIntent: z.object({ title: z.string(), goal: z.string() }).optional().describe("Send a new task instead. gitring checks that no other task is the same."),
      plan: z.array(z.string()).describe("Short steps, in order."),
      files: z.array(z.string()).describe("Repo-relative paths you will change."),
      symbols: z.array(z.string()).optional().describe("path#name of the functions you will add or change. Add (params) if you change a signature."),
      approach: z.string().describe("One sentence."),
      mode: z.enum(["api", "git"]).optional(),
      agent: z
        .object({ id: z.string().optional(), name: z.string().optional(), client: z.string().optional(), model: z.string().optional() })
        .optional()
        .describe('Who you are, e.g. {"client":"claude-code","model":"claude-sonnet-5"}. Reuse the agentId you got before.'),
      workdir: z.string().optional().describe("Absolute path of your repository folder (for the Claude Code hook)."),
    },
    annotations: ADDS,
    async run(ctx, args) {
      try {
        const h = await ctx.access(args.project);
        const res = await h.stub.declare({
          projectId: h.id,
          intentId: args.intentId,
          newIntent: args.newIntent,
          plan: args.plan ?? [],
          files: args.files ?? [],
          symbols: args.symbols ?? [],
          approach: args.approach ?? "",
          mode: args.mode,
          agent: { ...(args.agent ?? {}), kind: args.mode === "git" ? "git" : "mcp", client: args.agent?.client ?? "mcp" },
          workdir: args.workdir,
          // The person behind the key or the sign-in sent this agent. That person answers the approval.
          by: actorOf(ctx.who),
        });
        return text(
          res,
          `You are ${res.callsign} on the task "${res.intent.title}" (work copy ${res.attemptId}). Conflict check: ${VERDICT_WORD[res.clearance.verdict] ?? res.clearance.verdict}. ${res.clearance.advice}`,
          res.clearance,
        );
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_log",
    title: "Report progress",
    description:
      "Report progress like a commit message. Say what you did and which files you touched. Other agents see it. " +
      "In git mode, give headSha after a push to get a conflict check at once. The answer can hold change requests.",
    inputSchema: { project, attemptId, message: z.string(), files: z.array(z.string()).optional(), symbols: z.array(z.string()).optional(), headSha: z.string().optional() },
    annotations: ADDS,
    async run(ctx, args) {
      try {
        const clr = await (await ctx.access(args.project)).stub.log({ attemptId: args.attemptId, message: args.message, files: args.files, symbols: args.symbols, headSha: args.headSha });
        return text(clr, `Conflict check: ${VERDICT_WORD[clr.verdict] ?? clr.verdict}. ${clr.advice}`, clr);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_traffic",
    title: "See nearby work",
    description: "See the active work near yours. Each item shows the task, the plan, the files and the latest reports of one other agent. Also see the tasks that merged after your work copy started.",
    inputSchema: { project, attemptId },
    annotations: READS,
    async run(ctx, args) {
      try {
        const res = await (await ctx.access(args.project)).stub.traffic(args.attemptId);
        const near = res.vessels.length;
        const merged = res.landedSinceBase.length;
        return text(res, `${near} ${near === 1 ? "work copy" : "work copies"} near you. ${merged} ${merged === 1 ? "task" : "tasks"} merged after your work copy started.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_read",
    title: "Read a file",
    description: "Read one file of your work copy (api mode). The answer is the whole file.",
    inputSchema: { project, attemptId, path: z.string() },
    annotations: READS,
    async run(ctx, args) {
      try {
        const r = await (await ctx.access(args.project)).stub.read(args.attemptId, args.path);
        return plain(r.content ?? `The file ${r.path} does not exist.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_list",
    title: "List files",
    description: "List the files of your work copy (api mode). Give dir to list one folder.",
    inputSchema: { project, attemptId, dir: z.string().optional() },
    annotations: READS,
    async run(ctx, args) {
      try {
        const r = await (await ctx.access(args.project)).stub.list(args.attemptId, args.dir);
        return plain(r.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_write",
    title: "Write files",
    description:
      "Write whole files into your work copy (api mode). Set delete to true to remove a file. " +
      "gitring checks your plan again after each write. The answer can hold change requests. Apply them, then call gitring_ack.",
    inputSchema: {
      project,
      attemptId,
      files: z.array(z.object({ path: z.string(), content: z.string().optional(), delete: z.boolean().optional() })),
      message: z.string().optional(),
    },
    // A write replaces the text of a file in the work copy, and a delete removes it: it can destroy earlier work.
    annotations: CHANGES,
    async run(ctx, args) {
      try {
        const res = await (await ctx.access(args.project)).stub.write({ attemptId: args.attemptId, files: args.files, message: args.message });
        return writeAnswer(res);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_check",
    title: "Run tests",
    description: "Run the tests of your work copy and get each failure. In git mode, gitring tests your latest push.",
    inputSchema: { project, attemptId },
    annotations: ADDS,
    async run(ctx, args) {
      try {
        const run = await (await ctx.access(args.project)).stub.check(args.attemptId);
        const headline = run.wait
          ? run.wait.message
          : noTestRan(run)
            ? "No test ran. A person must decide to merge this work."
            : `${run.passed}/${run.passed + run.failed} tests pass.${run.error ? ` Test runner error: ${run.error}` : ""}`;
        return text(run, headline);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_submit",
    title: "Ask for a merge",
    description:
      "Ask for a merge when your tests pass. gitring tests again. " +
      "Then it merges the work (fast-forward, 3-way merge, or a redo on the new main). " +
      "Sometimes a person must say yes first. The project can ask for it. It is also needed when the change looks risky, when no test ran, or when work copies compete. " +
      "gitring then asks the person. It asks in this chat if the client can show a question. If not, the answer has a link to the gitring app. " +
      "Wait for the person. Do not change the work copy. Call gitring_status to see the answer. " +
      "When the project sends merges to GitHub, the merge goes there too.",
    inputSchema: { project, attemptId, summary: z.string() },
    // A merge adds a commit to main and keeps the history: it destroys nothing. It can also send the merge to GitHub.
    annotations: { ...ADDS, openWorldHint: true },
    async run(ctx, args, req) {
      try {
        const h = await ctx.access(args.project);
        const viewer = { id: ctx.who.user?.id ?? "", role: h.role };
        // The second call of a question in chat: the person answered, so pass the answer on.
        const taken = await takeAnswer(ctx, req, h, args.attemptId);
        if (taken) return statusReply(taken.status, { asked: !taken.result, before: answerNote(taken.result) });
        const res = await h.stub.submit(args.attemptId, args.summary, { origin: ctx.origin, viewer: viewer.id ? viewer : undefined });
        if (res.next !== "awaiting-approval") return text(res, `${res.message} Next: ${res.next}.`, res.clearance);
        // A person must say yes. Ask in this chat when the client can show a question. Else the answer holds the link.
        const st = await h.stub.status(args.attemptId, { origin: ctx.origin, viewer: viewer.id ? viewer : undefined });
        return (await askInChat(ctx, req, h, st)) ?? statusReply(st, { extra: { next: res.next, checks: res.checks } });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_status",
    title: "See the merge state",
    description:
      "See where your work copy is: with a person, sent back, in the merge queue, or merged. " +
      "Call it after gitring_submit says that a person must say yes. It changes no file. " +
      "When a person sent the work back, the answer has a change request. Apply it, call gitring_ack, and submit again.",
    inputSchema: { project, attemptId },
    annotations: READS,
    async run(ctx, args) {
      try {
        const h = await ctx.access(args.project);
        const st = await h.stub.status(args.attemptId, { origin: ctx.origin, viewer: ctx.who.user ? { id: ctx.who.user.id, role: h.role } : undefined });
        return statusReply(st);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_ack",
    title: "Confirm a change request",
    description: "Confirm that you applied a change request (correctionId). Say in one line what you changed.",
    inputSchema: { project, attemptId, correctionId: z.string(), note: z.string().optional() },
    annotations: ADDS,
    async run(ctx, args) {
      try {
        const clr = await (await ctx.access(args.project)).stub.ack(args.attemptId, args.correctionId, args.note);
        return text(clr, `Confirmed. ${clr.advice}`, clr);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_update",
    title: "Update from main",
    description:
      "Move your work copy onto the new main. In api mode, gitring does it and names the files to read again. " +
      "In git mode, you get a read-only remote and a token for main, and the git commands to merge it. " +
      "Use it after a change request that says main moved.",
    inputSchema: { project, attemptId },
    // Where your change and main touch the same lines, gitring keeps the main version. You write your change again.
    annotations: CHANGES,
    async run(ctx, args) {
      try {
        const res = await (await ctx.access(args.project)).stub.update(args.attemptId);
        return text(res, res.message);
      } catch (e) {
        return fail(e);
      }
    },
  }),
];

const INSTRUCTIONS =
  "gitring lets many agents change one repository at the same time. " +
  "Call gitring_intents first. Then call gitring_declare with a real plan. " +
  "Write your work. Apply each change request and call gitring_ack. " +
  "Then call gitring_check and gitring_submit. " +
  "gitring_submit can answer that a person must say yes. Tell the person that the work waits. Do not change the work copy. " +
  "Call gitring_status to see the answer.";

const READONLY_INSTRUCTIONS =
  "This is the read-only endpoint of gitring. You can list tasks, see the work near yours and read files. " +
  "You cannot send a plan, write, run tests or merge here. Use the full endpoint for that.";

/** The tools, and the server instructions, of each endpoint: the full set, the GitHub-compatible set and the read-only set. */
export function toolSet(set: McpSet): { tools: readonly ToolDef[]; instructions: string } {
  if (set === "github") return { tools: GITHUB_TOOLS, instructions: GITHUB_INSTRUCTIONS };
  if (set === "readonly") return { tools: readOnlyTools(GITRING_TOOLS), instructions: READONLY_INSTRUCTIONS };
  return { tools: GITRING_TOOLS, instructions: INSTRUCTIONS };
}

async function createServer(env: Env, who: Principal, set: McpSet, origin: string) {
  const { tools, instructions } = toolSet(set);
  // The key of the questions in chat comes from GITRING_SECRET: every instance of the Worker has the same key.
  const ask = await askCodec(env, who);
  const server = new McpServer({ name: "gitring", version: MCP_VERSION }, { instructions, ...(ask ? { requestState: { verify: ask.verify } } : {}) });
  registerTools(server, makeContext(env, who, { listHow: set === "github" ? GITHUB_LIST_HOW : undefined, origin, ask }), tools);
  return server;
}

/**
 * An MCP handler bound to the caller and to one endpoint (one per request: the tools check this caller's roles).
 * `origin` is the address of this deployment (https://host), for the links that answers give.
 */
export function createMcp(env: Env, who: Principal, set: McpSet = "gitring", origin = "") {
  return createMcpHandler(() => createServer(env, who, set, origin), {
    route: MCP_PATH[set],
    allowedOriginHostnames: "*",
    corsOptions: { exposeHeaders: "mcp-session-id, WWW-Authenticate" },
  });
}
