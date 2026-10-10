/**
 * MCP server for external agents (Claude Code, Codex, Cursor, …).
 * Stateless (MCP 2026-07-28 via createMcpHandler); all state lives in the project's HarborMaster.
 * Every call carries a personal API key; each tool checks the caller's role on the project.
 *
 * Every tool result starts with a one-line status. When gitring has new change requests for the agent,
 * the result starts with "GITRING CHANGE REQUEST" so the model cannot miss it.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "./env";
import type * as T from "../core/types";
import type * as A from "../core/accounts";
import { atLeast, PROJECT_ID } from "../core/accounts";
import type { HarborMaster } from "../harbor/harbor";
import { directory, type Principal } from "./auth";

type HarborApi = Pick<HarborMaster, "ensure" | "openIntents" | "declare" | "log" | "traffic" | "read" | "list" | "write" | "check" | "submit" | "ack" | "update">;

function text(obj: unknown, headline: string, clr?: T.Clearance) {
  const lines: string[] = [];
  if (clr?.corrections?.length) {
    lines.push("GITRING CHANGE REQUEST — apply it in your next edits, then call gitring_ack. Do not stop.");
    for (const c of clr.corrections) lines.push(`- [${c.id}] (${KIND_WORD[c.kind] ?? c.kind}${c.from ? `; ${c.from} continues` : ""}) ${c.message}`);
    lines.push("");
  }
  lines.push(headline);
  lines.push("");
  lines.push(JSON.stringify(obj, null, 2));
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function fail(err: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${String((err as Error)?.message ?? err)}` }], isError: true };
}

const KIND_WORD: Record<string, string> = { interface: "function change", region: "same lines", duplicate: "same task", upstream: "main moved", "intent-amended": "task changed" };
const VERDICT_WORD: Record<string, string> = { clear: "clear", correct: "change request", "merge-intents": "same task as other work", escalate: "a person decides" };

const project = z.string().describe("Project id (gitring_intents without a project lists your projects).");
const attemptId = z.string().describe("Your work copy id (attemptId) from gitring_declare.");

function createServer(env: Env, who: Principal) {
  const server = new McpServer({ name: "gitring", version: "0.6.0" });

  /** The project's HarborMaster, after a role check (member to act, viewer to read). */
  async function harbor(raw: string | undefined, need: A.Role = "member"): Promise<{ id: string; stub: HarborApi }> {
    const id = String(raw ?? "").trim();
    if (!PROJECT_ID.test(id)) throw new Error("Give the project id (lowercase letters, digits and dashes). Call gitring_intents without a project to list your projects.");
    if (who.via !== "operator") {
      const role = await directory(env).role(id, who.user?.id ?? null);
      if (!role) throw new Error(`Unknown project "${id}", or your key has no access to it.`);
      if (!atLeast(role, need)) throw new Error(`Your key needs the ${need} role on "${id}". Ask an owner of the project.`);
    }
    const stub = env.HARBOR.get(env.HARBOR.idFromName(id)) as unknown as HarborApi;
    return { id, stub };
  }

  server.registerTool(
    "gitring_intents",
    {
      description:
        "List the open tasks of a project (goal and test files) and how much work is active. Call this first. Then call gitring_declare for one task, or bring a new task.",
      inputSchema: { project: z.string().optional().describe("Project id. Leave it out to list the projects your key can use.") },
    },
    async ({ project: p }) => {
      try {
        if (!p) {
          const list = (await directory(env).listProjects(who.user?.id ?? null)).filter((x) => atLeast(x.role, "member"));
          return text(
            list.map((x) => ({ project: x.id, name: x.name, role: x.role })),
            list.length ? `${list.length} projects. Call gitring_intents with one project id.` : "Your key has no project where it can act. Create one in gitring, or ask an owner to add you.",
          );
        }
        const h = await harbor(p, "viewer");
        await h.stub.ensure(h.id);
        const res = await h.stub.openIntents();
        return text(res, `${res.intents.length} open tasks. ${res.traffic} work copies are active.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gitring_declare",
    {
      description:
        "Send your plan BEFORE you write code: steps, files, functions and approach. gitring checks the plan against all active work and answers clear, or with change requests. " +
        "gitring never blocks you. mode 'git' (best for an agent on a computer) gives a git remote and a token for your work copy: clone it, commit, push. mode 'api' (default) uses gitring_read and gitring_write. " +
        "Give workdir (your repository folder) so that the Claude Code hook can bring change requests during the task.",
      inputSchema: {
        project,
        intentId: z.string().optional().describe("A task id (intentId) from gitring_intents."),
        newIntent: z.object({ title: z.string(), goal: z.string() }).optional().describe("Bring a new task instead. gitring checks that no other task is the same."),
        plan: z.array(z.string()).describe("Short steps, in order."),
        files: z.array(z.string()).describe("Repo-relative paths you will change."),
        symbols: z.array(z.string()).optional().describe("path#name of the functions you will add or change. Add (params) if you change a signature."),
        approach: z.string().describe("One sentence."),
        mode: z.enum(["api", "git"]).optional(),
        agent: z
          .object({ id: z.string().optional(), name: z.string().optional(), client: z.string().optional(), model: z.string().optional() })
          .optional()
          .describe('Who you are, e.g. {"client":"claude-code","model":"claude-sonnet-5"}. Reuse the agentId you got before.'),
        workdir: z.string().optional().describe("Absolute path of your working copy (for the Claude Code hook)."),
      },
    },
    async (args) => {
      try {
        const h = await harbor(args.project);
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
  );

  server.registerTool(
    "gitring_log",
    {
      description:
        "Report progress like a commit message: what you did and which files you touched. Other agents see it. In git mode, give headSha after a push to get a conflict check at once. The answer can hold change requests.",
      inputSchema: { project, attemptId, message: z.string(), files: z.array(z.string()).optional(), symbols: z.array(z.string()).optional(), headSha: z.string().optional() },
    },
    async (args) => {
      try {
        const clr = await (await harbor(args.project)).stub.log({ attemptId: args.attemptId, message: args.message, files: args.files, symbols: args.symbols, headSha: args.headSha });
        return text(clr, `Conflict check: ${VERDICT_WORD[clr.verdict] ?? clr.verdict}. ${clr.advice}`, clr);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gitring_traffic",
    {
      description: "See the active work near yours: the tasks, plans, files and latest reports of other agents, and the tasks that merged after your work copy started.",
      inputSchema: { project, attemptId },
    },
    async (args) => {
      try {
        const res = await (await harbor(args.project)).stub.traffic(args.attemptId);
        return text(res, `${res.vessels.length} work copies near you. ${res.landedSinceBase.length} tasks merged after your work copy started.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gitring_read",
    { description: "Read one file of your work copy (api mode).", inputSchema: { project, attemptId, path: z.string() } },
    async (args) => {
      try {
        const r = await (await harbor(args.project)).stub.read(args.attemptId, args.path);
        return { content: [{ type: "text" as const, text: r.content ?? `The file ${r.path} does not exist.` }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gitring_list",
    { description: "List the files of your work copy (api mode).", inputSchema: { project, attemptId, dir: z.string().optional() } },
    async (args) => {
      try {
        const r = await (await harbor(args.project)).stub.list(args.attemptId, args.dir);
        return { content: [{ type: "text" as const, text: r.join("\n") }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gitring_write",
    {
      description: "Write whole files into your work copy (api mode). gitring checks your plan again after each write. The answer can hold change requests.",
      inputSchema: {
        project,
        attemptId,
        files: z.array(z.object({ path: z.string(), content: z.string().optional(), delete: z.boolean().optional() })),
        message: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const res = await (await harbor(args.project)).stub.write({ attemptId: args.attemptId, files: args.files, message: args.message });
        const extra = [
          res.merged?.length ? `Main moved after your last read: gitring merged your write with the landed changes in ${res.merged.join(", ")}. Read these files again.` : "",
          ...(res.refused ?? []).map((r) => `Not written: ${r.reason}`),
        ].filter(Boolean);
        return text(res, `Written: ${res.written.join(", ") || "nothing"}. ${extra.length ? `${extra.join(" ")} ` : ""}Conflict check: ${VERDICT_WORD[res.clearance.verdict] ?? res.clearance.verdict}. ${res.clearance.advice}`, res.clearance);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gitring_check",
    { description: "Run the tests of your work copy and get each failure. In git mode, gitring tests your latest push.", inputSchema: { project, attemptId } },
    async (args) => {
      try {
        const run = await (await harbor(args.project)).stub.check(args.attemptId);
        return text(run, `${run.passed}/${run.passed + run.failed} tests pass.${run.error ? ` Test runner error: ${run.error}` : ""}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gitring_submit",
    {
      description: "Ask for a merge when your tests pass. gitring tests again, then merges the work (fast-forward, 3-way merge, or a redo on the new main), or asks a person to choose between work copies.",
      inputSchema: { project, attemptId, summary: z.string() },
    },
    async (args) => {
      try {
        const res = await (await harbor(args.project)).stub.submit(args.attemptId, args.summary);
        return text(res, `${res.message} Next: ${res.next}.`, res.clearance);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gitring_ack",
    { description: "Confirm that you applied a change request (correctionId). Say in one line what you changed.", inputSchema: { project, attemptId, correctionId: z.string(), note: z.string().optional() } },
    async (args) => {
      try {
        const clr = await (await harbor(args.project)).stub.ack(args.attemptId, args.correctionId, args.note);
        return text(clr, `Confirmed. ${clr.advice}`, clr);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gitring_update",
    {
      description:
        "Bring the new main into your work copy. api mode: gitring moves your work copy onto main and names the files to read again. " +
        "git mode: you get a read-only remote and token for main, and the git commands to merge it. Use it after a change request that says main moved.",
      inputSchema: { project, attemptId },
    },
    async (args) => {
      try {
        const res = await (await harbor(args.project)).stub.update(args.attemptId);
        return text(res, res.message);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

/** An MCP handler bound to the caller (one per request: the tools check this caller's roles). */
export function createMcp(env: Env, who: Principal) {
  return createMcpHandler(() => createServer(env, who), {
    route: "/mcp",
    allowedOriginHostnames: "*",
    corsOptions: { exposeHeaders: "mcp-session-id, WWW-Authenticate" },
  });
}
