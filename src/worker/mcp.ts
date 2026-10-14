/**
 * The MCP server for external agents (Claude Code, Codex, Cursor and others): the gitring tool set.
 *
 * Stateless (MCP 2026-07-28, createMcpHandler). All state lives in the HarborMaster of the project.
 * Every call carries a personal API key or an OAuth token. Each tool checks the role of the caller on the project.
 * The Worker uses the read-only hint of a tool for the read-only path and scope.
 * Read next: src/worker/mcp-kit.ts (how a tool is defined) and the note below.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "./env";
import { atLeast } from "../core/accounts";
import { noTestRan } from "../core/types";
import { actorOf, directory, type Principal } from "./auth";
import { MCP_PATH, SCOPE_READ, type McpSet } from "../directory/oauth";
import { ADDS, CHANGES, READS, callOf, defineTool, fail, makeContext, newsFor, plain, readOnlyTools, registerTools, text, VERDICT_WORD, withClearance, withNews, writeAnswer, type ToolDef } from "./mcp-kit";
import { GITHUB_CHECK_HOW, GITHUB_INSTRUCTIONS, GITHUB_LIST_HOW, GITHUB_TOOLS } from "./mcp-github";
import { answerNote, answerPlace, askCodec, askInChat, isWaiting, statusReply, takeAnswer } from "./mcp-approval";
import { PROJECT_TOOLS } from "./mcp-projects";
import { HISTORY_TOOLS } from "./mcp-history";

/*
 * Change requests in every answer:
 *
 * Every tool result starts with a one-line status. When gitring has new change requests for the agent,
 * the result starts with "GITRING CHANGE REQUEST" so the model cannot miss it. Every answer about a work copy
 * carries them, also the answers that only read: gitring_read and gitring_list keep the file text clean in the
 * first block and bring the change requests in a second block. gitring_wait waits for them.
 *
 * Only the person who sent the agent of a work copy (or an owner, or the operator key) can change it. Every
 * member can read it, but only that person gets its change requests.
 *
 * Every tool has a title and all four hints (read-only, destructive, idempotent, open-world): MCP
 * directories need them, and the Worker uses the read-only hint for the read-only path and scope.
 */

/** The version that the server tells to clients. */
export const MCP_VERSION = "0.9.2";

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
            list.length ? `${list.length} projects. Call gitring_intents with one project id.` : "Your key has no project where it can act. Create one with gitring_create_project, or ask an owner to add you.",
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
      "Send your plan BEFORE you write code. Give the steps, the files, the functions that you change, the functions that you call (uses), and the approach. " +
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
      uses: z
        .array(z.string())
        .optional()
        .describe("path#name of the functions that your plan will call but not change. Then gitring finds a conflict with a plan that changes them before code exists."),
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
          uses: args.uses ?? [],
          approach: args.approach ?? "",
          mode: args.mode,
          agent: { ...(args.agent ?? {}), kind: args.mode === "git" ? "git" : "mcp", client: args.agent?.client ?? "mcp" },
          workdir: args.workdir,
          // The person behind the key or the sign-in sent this agent. That person answers the approval.
          by: actorOf(ctx.who),
        });
        // The rules by folder that the plan touches: the agent reads them with the plan, before any work exists.
        const rules = res.rules?.length ? ` ${res.rules.join(" ")}` : "";
        return text(
          res,
          `You are ${res.callsign} on the task "${res.intent.title}" (work copy ${res.attemptId}). Conflict check: ${VERDICT_WORD[res.clearance.verdict] ?? res.clearance.verdict}. ${res.clearance.advice}${rules}`,
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
        const h = await ctx.access(args.project);
        const clr = await h.stub.log({ attemptId: args.attemptId, message: args.message, files: args.files, symbols: args.symbols, headSha: args.headSha }, callOf(ctx, h));
        return text(clr, `Conflict check: ${VERDICT_WORD[clr.verdict] ?? clr.verdict}. ${clr.advice}`, clr);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_traffic",
    title: "See nearby work",
    description:
      "See the active work near yours. Each item shows the task, the plan, the files and the latest reports of one other agent. Also see the tasks that merged after your work copy started. " +
      "When you wait for other agents, call gitring_wait instead of a sleep.",
    inputSchema: { project, attemptId },
    annotations: READS,
    async run(ctx, args) {
      try {
        const h = await ctx.access(args.project);
        const res = await h.stub.traffic(args.attemptId, callOf(ctx, h));
        const clr = await newsFor(ctx, h, args.attemptId);
        const near = res.vessels.length;
        const merged = res.landedSinceBase.length;
        return text(withClearance(res, clr), `${near} ${near === 1 ? "work copy" : "work copies"} near you. ${merged} ${merged === 1 ? "task" : "tasks"} merged after your work copy started.`, clr ?? undefined);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_read",
    title: "Read a file",
    description: "Read one file of your work copy (api mode). The answer is the whole file. New change requests come after the file, in a second part.",
    inputSchema: { project, attemptId, path: z.string() },
    annotations: READS,
    async run(ctx, args) {
      try {
        const h = await ctx.access(args.project);
        const r = await h.stub.read(args.attemptId, args.path, callOf(ctx, h));
        return withNews(plain(r.content ?? `The file ${r.path} does not exist.`), await newsFor(ctx, h, args.attemptId));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_list",
    title: "List files",
    description: "List the files of your work copy (api mode). Give dir to list one folder. New change requests come after the list, in a second part.",
    inputSchema: { project, attemptId, dir: z.string().optional() },
    annotations: READS,
    async run(ctx, args) {
      try {
        const h = await ctx.access(args.project);
        const r = await h.stub.list(args.attemptId, args.dir, callOf(ctx, h));
        return withNews(plain(r.join("\n")), await newsFor(ctx, h, args.attemptId));
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
        const h = await ctx.access(args.project);
        const res = await h.stub.write({ attemptId: args.attemptId, files: args.files, message: args.message }, callOf(ctx, h));
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
        const h = await ctx.access(args.project);
        const run = await h.stub.check(args.attemptId, callOf(ctx, h));
        const clr = await newsFor(ctx, h, args.attemptId);
        const headline = run.wait
          ? run.wait.message
          : noTestRan(run)
            ? "No test ran. A person must decide to merge this work."
            : `${run.passed}/${run.passed + run.failed} tests pass.${run.error ? ` Test runner error: ${run.error}` : ""}`;
        return text(withClearance(run, clr), headline, clr ?? undefined);
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
      "A change of comments, white space or documentation only does not look risky. A rule by folder of the project can ask for the yes of an owner. " +
      "gitring then asks the person. It asks in this chat if the client can show a question and the person allows it. If not, the answer has a link to the gitring app. " +
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
        if (taken) return statusReply(taken.status, { asked: !taken.result, before: answerNote(taken.result), app: taken.app });
        const res = await h.stub.submit(args.attemptId, args.summary, { origin: ctx.origin, viewer: viewer.id ? viewer : undefined });
        if (res.next !== "awaiting-approval") return text(res, `${res.message} Next: ${res.next}.`, res.clearance);
        // A person must say yes. Submit delivered its change requests already: the next answer holds them again.
        const again = res.clearance.corrections.map((c) => c.id);
        const st = await h.stub.status(args.attemptId, { origin: ctx.origin, viewer: viewer.id ? viewer : undefined, again });
        // Ask in this chat when the client can show a question and the person allows it. Else the answer holds the link.
        const place = await answerPlace(ctx, st);
        return (await askInChat(ctx, req, h, st, { place, again })) ?? statusReply(st, { extra: { next: res.next, checks: res.checks }, app: place === "app" });
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
      "Call it after gitring_submit says that a person must say yes. It changes no file. To wait for the answer, call gitring_wait instead of a sleep. " +
      "When a person sent the work back, the answer has a change request. Apply it, call gitring_ack, and submit again.",
    inputSchema: { project, attemptId },
    annotations: READS,
    async run(ctx, args) {
      try {
        const h = await ctx.access(args.project);
        const st = await h.stub.status(args.attemptId, { origin: ctx.origin, viewer: ctx.who.user ? { id: ctx.who.user.id, role: h.role } : undefined });
        return statusReply(st, { app: isWaiting(st) && (await answerPlace(ctx, st)) === "app" });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_ack",
    title: "Confirm a change request",
    description:
      "Confirm that you applied a change request (correctionId). Say in one line what you changed. " +
      "gitring checks your code against the lines and the signatures of the request. When the code still breaks them, the request stays open.",
    inputSchema: { project, attemptId, correctionId: z.string(), note: z.string().optional() },
    annotations: ADDS,
    async run(ctx, args) {
      try {
        const h = await ctx.access(args.project);
        const res = await h.stub.ack(args.attemptId, args.correctionId, args.note, callOf(ctx, h));
        return text(res, res.outcome === "open" ? res.message : `${res.message} ${res.clearance.advice}`, res.clearance);
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
        const h = await ctx.access(args.project);
        const res = await h.stub.update(args.attemptId, callOf(ctx, h));
        const clr = await newsFor(ctx, h, args.attemptId);
        return text(withClearance(res, clr), res.message, clr ?? undefined);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_wait",
    title: "Wait for news",
    description:
      "Wait for news about your work copy. News is a change request, a move of main, the answer of a person, or a new status. " +
      "The answer comes when news arrives, or when the time is over. The time is 25 seconds, or the seconds that you give (50 at most). " +
      "When you wait for a merge, a person, or other agents, call gitring_wait instead of a sleep. " +
      "The answer can hold change requests. Apply them, then call gitring_ack.",
    inputSchema: {
      project,
      attemptId,
      seconds: z.number().int().min(1).max(50).optional().describe("How long to wait at most, in seconds (1 to 50). 25 if you leave it out."),
    },
    // It changes no file. It delivers the change requests of the work copy, so it is not a tool that only reads.
    annotations: ADDS,
    async run(ctx, args) {
      try {
        const h = await ctx.access(args.project);
        const res = await h.stub.wait(args.attemptId, { ...callOf(ctx, h), seconds: args.seconds });
        const news = res.events.filter((e) => e.kind !== "change-request").map((e) => e.message);
        return text(res, [...news, res.message].join(" "), res.clearance);
      } catch (e) {
        return fail(e);
      }
    },
  }),
  ...PROJECT_TOOLS,
  ...HISTORY_TOOLS,
];

const INSTRUCTIONS =
  "gitring lets many agents change one repository at the same time. gitring holds the code: no GitHub account is necessary. " +
  "To start a new project, call gitring_create_project. " +
  "Call gitring_intents first. Then call gitring_declare with a real plan. " +
  "Write your work. Apply each change request and call gitring_ack. " +
  "Then call gitring_check and gitring_submit. " +
  "gitring_submit can answer that a person must say yes. Tell the person that the work waits. Do not change the work copy. " +
  "Call gitring_status to see the answer. " +
  "When you wait for a merge, a person, or other agents, call gitring_wait instead of a sleep.";

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
  // A client that can only read does not take the change requests of a work copy (it cannot confirm them).
  const readOnly = set === "readonly" || (who.via === "oauth" && who.scope === SCOPE_READ);
  registerTools(server, makeContext(env, who, { listHow: set === "github" ? GITHUB_LIST_HOW : undefined, checkHow: set === "github" ? GITHUB_CHECK_HOW : undefined, origin, ask, readOnly }), tools);
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
