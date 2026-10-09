/**
 * MCP server for external agents (Claude Code, Codex, Cursor, …).
 * Stateless (MCP 2026-07-28 via createMcpHandler); all state lives in the project's HarborMaster.
 *
 * Every tool result starts with a one-line status. When Bearing has new corrections for the agent,
 * the result starts with "BEARING COURSE CORRECTION" so the model cannot miss it.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "./env";
import type * as T from "../core/types";
import type { HarborMaster } from "../harbor/harbor";

type HarborApi = Pick<HarborMaster, "ensure" | "openIntents" | "declare" | "log" | "traffic" | "read" | "list" | "write" | "check" | "submit" | "ack">;

function harbor(project?: string): { id: string; stub: HarborApi } {
  const e = env as unknown as Env;
  const id = project || "demo";
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("Use a project id of lowercase letters, digits and dashes (at most 40).");
  return { id, stub: e.HARBOR.get(e.HARBOR.idFromName(id)) as unknown as HarborApi };
}

function text(obj: unknown, headline: string, clr?: T.Clearance) {
  const lines: string[] = [];
  if (clr?.corrections?.length) {
    lines.push("BEARING COURSE CORRECTION — apply it in your next edits, then call bearing_ack. Do not stop.");
    for (const c of clr.corrections) lines.push(`- [${c.id}] (${c.kind}${c.from ? `, ${c.from} stands on` : ""}) ${c.message}`);
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

const project = z.string().optional().describe('Project id. Default "demo".');
const attemptId = z.string().describe("Your attempt id from bearing_declare.");

function createServer() {
  const server = new McpServer({ name: "bearing", version: "0.1.0" });

  server.registerTool(
    "bearing_intents",
    {
      description:
        "List the open intents (goal + checks) and the traffic size. Call this first. Then call bearing_declare for one intent, or bring a new intent.",
      inputSchema: { project },
    },
    async ({ project: p }) => {
      try {
        const h = harbor(p);
        await h.stub.ensure(h.id);
        const res = await h.stub.openIntents();
        return text(res, `${res.intents.length} open intents. ${res.traffic} vessels are underway.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "bearing_declare",
    {
      description:
        "Declare your course BEFORE you write code: plan, files, symbols, approach. Bearing checks it against all traffic and answers clear or sends corrections. " +
        "Bearing never blocks you. mode 'git' gives you an Artifacts fork remote + token to clone and push. mode 'api' (default) uses bearing_read / bearing_write. " +
        "Give workdir (your repository root) so the Claude Code hook can deliver corrections mid-task.",
      inputSchema: {
        project,
        intentId: z.string().optional().describe("An intent id from bearing_intents."),
        newIntent: z.object({ title: z.string(), goal: z.string() }).optional().describe("Bring a new intent instead. Bearing checks it for duplicates."),
        plan: z.array(z.string()).describe("Short steps, in order."),
        files: z.array(z.string()).describe("Repo-relative paths you will change."),
        symbols: z.array(z.string()).optional().describe("path#name of functions you will add or change. Add (params) if you change a signature."),
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
        const h = harbor(args.project);
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
          `You are ${res.callsign} on "${res.intent.title}" (attempt ${res.attemptId}). Course check: ${res.clearance.verdict}. ${res.clearance.advice}`,
          res.clearance,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "bearing_log",
    {
      description:
        "Log progress like a commit: what you did and which files you touched. Other agents see it as traffic. In git mode, give headSha after each push. The answer can hold corrections.",
      inputSchema: { project, attemptId, message: z.string(), files: z.array(z.string()).optional(), symbols: z.array(z.string()).optional(), headSha: z.string().optional() },
    },
    async (args) => {
      try {
        const clr = await harbor(args.project).stub.log({ attemptId: args.attemptId, message: args.message, files: args.files, symbols: args.symbols, headSha: args.headSha });
        return text(clr, `Course check: ${clr.verdict}. ${clr.advice}`, clr);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "bearing_traffic",
    {
      description: "See the vessels near your work: their intents, courses, files and latest logs (their live context), plus intents that landed after your base.",
      inputSchema: { project, attemptId },
    },
    async (args) => {
      try {
        const res = await harbor(args.project).stub.traffic(args.attemptId);
        return text(res, `${res.vessels.length} vessels near you. ${res.landedSinceBase.length} intents landed after your base.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "bearing_read",
    { description: "Read one file of your attempt (api mode).", inputSchema: { project, attemptId, path: z.string() } },
    async (args) => {
      try {
        const r = await harbor(args.project).stub.read(args.attemptId, args.path);
        return { content: [{ type: "text" as const, text: r.content ?? `The file ${r.path} does not exist.` }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "bearing_list",
    { description: "List the files of your attempt (api mode).", inputSchema: { project, attemptId, dir: z.string().optional() } },
    async (args) => {
      try {
        const r = await harbor(args.project).stub.list(args.attemptId, args.dir);
        return { content: [{ type: "text" as const, text: r.join("\n") }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "bearing_write",
    {
      description: "Write complete file contents into your attempt (api mode). Bearing re-checks your course after each write. The answer can hold corrections.",
      inputSchema: {
        project,
        attemptId,
        files: z.array(z.object({ path: z.string(), content: z.string().optional(), delete: z.boolean().optional() })),
        message: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const res = await harbor(args.project).stub.write({ attemptId: args.attemptId, files: args.files, message: args.message });
        const extra = [
          res.merged?.length ? `Main moved after your last read: Bearing merged your write with the landed changes in ${res.merged.join(", ")}. Read these files again.` : "",
          ...(res.refused ?? []).map((r) => `Not written: ${r.reason}`),
        ].filter(Boolean);
        return text(res, `Written: ${res.written.join(", ") || "nothing"}. ${extra.length ? `${extra.join(" ")} ` : ""}Course check: ${res.clearance.verdict}. ${res.clearance.advice}`, res.clearance);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "bearing_check",
    { description: "Run all checks of your attempt in a Cloudflare Dynamic Worker isolate. Takes milliseconds.", inputSchema: { project, attemptId } },
    async (args) => {
      try {
        const run = await harbor(args.project).stub.check(args.attemptId);
        return text(run, `${run.passed}/${run.passed + run.failed} checks pass.${run.error ? ` Runner error: ${run.error}` : ""}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "bearing_submit",
    {
      description: "Submit when your checks pass. Bearing lands the work (fast-forward, merge, or re-derive from intent), or asks a human to pick between attempts.",
      inputSchema: { project, attemptId, summary: z.string() },
    },
    async (args) => {
      try {
        const res = await harbor(args.project).stub.submit(args.attemptId, args.summary);
        return text(res, `${res.message} Next: ${res.next}.`, res.clearance);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "bearing_ack",
    { description: "Acknowledge a correction after you apply it. Say in one line what you changed.", inputSchema: { project, attemptId, correctionId: z.string(), note: z.string().optional() } },
    async (args) => {
      try {
        const clr = await harbor(args.project).stub.ack(args.attemptId, args.correctionId, args.note);
        return text(clr, `Acknowledged. ${clr.advice}`, clr);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

export const mcpHandler = createMcpHandler(createServer, {
  route: "/mcp",
  allowedOriginHostnames: "*",
});
