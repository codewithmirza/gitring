/**
 * Shared parts of the MCP tool sets (src/worker/mcp.ts and mcp-github.ts): how a tool is defined, how it
 * is registered, how the caller's role on a project is checked, and how an answer looks.
 *
 * A tool is plain data (a name, a title, a description, a schema, annotations) plus a handler. The Worker
 * reads the same data to know which tools only read (the read-only scope and path).
 */
import { z } from "zod";
import type { InputRequiredResult, McpServer, RequestStateCodec, ServerContext } from "@modelcontextprotocol/server";
import type { Env } from "./env";
import type * as T from "../core/types";
import type * as A from "../core/accounts";
import { atLeast, PROJECT_ID } from "../core/accounts";
import type { HarborMaster } from "../harbor/harbor";
import { adviceFor } from "../harbor/views";
import { directory, type Principal } from "./auth";

/** The methods of a project object that tools call. */
export type HarborApi = Pick<
  HarborMaster,
  | "ensure"
  | "openIntents"
  | "declare"
  | "log"
  | "traffic"
  | "read"
  | "list"
  | "write"
  | "check"
  | "submit"
  | "ack"
  | "update"
  | "state"
  | "tree"
  | "file"
  | "attemptDiff"
  | "createIntent"
  | "status"
  | "decide"
>;

/** The four MCP hints. Every tool sets all four: directories need a read-only or a destructive hint on each tool. */
export interface ToolHints {
  /** The tool does not change anything. */
  readOnlyHint: boolean;
  /** The tool can overwrite or delete data. False: it only adds. */
  destructiveHint: boolean;
  /** The same call twice has no second effect. */
  idempotentHint: boolean;
  /** The tool talks to systems outside gitring (GitHub). */
  openWorldHint: boolean;
}

/** Tools that only read. */
export const READS: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Tools that change state and only add (a work copy, a report, a merge). */
export const ADDS: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Tools that change state and can overwrite or delete (a file of a work copy). */
export const CHANGES: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** The state of a question that gitring asks the person in the chat of an agent (see mcp-approval.ts). */
export interface AskState {
  v: 1;
  project: string;
  attemptId: string;
  approvalId: string;
  /** The person who may answer. Another caller cannot use this state. */
  user: string;
}

/** What a handler gets: the deployment, the caller and the role check. */
export interface ToolContext {
  env: Env;
  who: Principal;
  /** The address of this deployment (https://host), for links in answers. */
  origin: string;
  /** Signs the state of a question in chat. Absent: gitring never asks in chat (it gives a link instead). */
  ask?: RequestStateCodec<AskState>;
  /** The project object, after a role check (member to act, viewer to read). */
  access(raw: string | undefined, need?: A.Role): Promise<{ id: string; stub: HarborApi; role: A.Role }>;
}

/** What a tool answers: a result, or a question for the person (MCP 2026-07-28: the client asks, then calls the tool again). */
export type ToolReturn = ToolResult | InputRequiredResult;

export interface ToolDef {
  name: string;
  /** A short name for people. */
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolHints;
  run(ctx: ToolContext, args: Record<string, unknown>, req: ServerContext): Promise<ToolReturn>;
}

/** Define a tool with typed arguments. */
export function defineTool<S extends z.ZodRawShape>(d: {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolHints;
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>, req: ServerContext) => Promise<ToolReturn>;
}): ToolDef {
  return { ...d, run: (ctx, args, req) => d.run(ctx, args as z.infer<z.ZodObject<S>>, req) };
}

/** Register tools on a server. The title is set twice: on the tool, and in its annotations (older clients read that one). */
export function registerTools(server: McpServer, ctx: ToolContext, tools: readonly ToolDef[]): void {
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: z.object(t.inputSchema), annotations: { title: t.title, ...t.annotations } },
      (async (args: Record<string, unknown>, req: ServerContext) => t.run(ctx, args, req)) as never,
    );
  }
}

/** The tools that only read. */
export function readOnlyTools(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter((t) => t.annotations.readOnlyHint);
}

/** How a person finds the id of a project, for the error of a bad id. Each tool set names its own tool. */
export const LIST_HOW = "Call gitring_intents without a project to list your projects.";

export function makeContext(env: Env, who: Principal, opts: { listHow?: string; origin?: string; ask?: RequestStateCodec<AskState> } = {}): ToolContext {
  const listHow = opts.listHow ?? LIST_HOW;
  return {
    env,
    who,
    origin: opts.origin ?? "",
    ask: opts.ask,
    async access(raw, need = "member") {
      const id = String(raw ?? "").trim();
      if (!PROJECT_ID.test(id)) throw new Error(`Give the project id (lowercase letters, digits and dashes). ${listHow}`);
      let found: A.Role = "owner";
      if (who.via !== "operator") {
        const role = await directory(env).role(id, who.user?.id ?? null);
        if (!role) throw new Error(`Unknown project "${id}", or your key has no access to it.`);
        if (!atLeast(role, need)) throw new Error(`Your key needs the ${need} role on "${id}". Ask an owner of the project.`);
        found = role;
      }
      const stub = env.HARBOR.get(env.HARBOR.idFromName(id)) as unknown as HarborApi;
      return { id, stub, role: found };
    },
  };
}

/* ───────────────────────── answers ───────────────────────── */

export const KIND_WORD: Record<string, string> = { interface: "function change", region: "same lines", duplicate: "same task", upstream: "main moved", "intent-amended": "task changed" };
export const VERDICT_WORD: Record<string, string> = { clear: "clear", correct: "change request", "merge-intents": "same task as other work", escalate: "a person decides" };

/**
 * An answer: change requests first (the model cannot miss them), then a one-line status, then the data.
 * When gitring has new change requests for the agent, the answer starts with "GITRING CHANGE REQUEST".
 */
export function text(obj: unknown, headline: string, clr?: T.Clearance, opts: { github?: boolean } = {}): ToolResult {
  const lines: string[] = [];
  if (clr?.corrections?.length) {
    lines.push("GITRING CHANGE REQUEST — apply it in your next edits, then call gitring_ack. Do not stop.");
    for (const c of clr.corrections) lines.push(`- [${c.id}] (${KIND_WORD[c.kind] ?? c.kind}${c.from ? `; ${c.from}${c.more ? ` and ${c.more} more continue` : " continues"}` : ""}) ${c.message}`);
    lines.push("");
  }
  lines.push(headline);
  lines.push("");
  lines.push(JSON.stringify(obj, null, 2));
  const out = lines.join("\n");
  return { content: [{ type: "text" as const, text: opts.github ? forGithub(out) : out }] };
}

/**
 * The project object names gitring tools in its advice (gitring_ack, gitring_traffic). The GitHub-compatible
 * set has no such tools: say the same in other words, so that an agent does not call a tool that is not there.
 */
export function forGithub(s: string): string {
  return s
    .replaceAll(", then call gitring_ack", "")
    .replaceAll("Read their context with gitring_traffic before you edit shared files.", "Their plans are in the traffic list below. Read them before you edit shared files.");
}

/**
 * The answer of a write: what gitring wrote, what it merged or refused, and the conflict check. The tool
 * gitring_write and the GitHub-compatible write tools use this one function, so both give the same
 * change requests. `clr` can hold more change requests than the write itself gave (a work copy that the
 * same call declared).
 */
export function writeAnswer(res: T.WriteResult, opts: { clr?: T.Clearance; before?: string; github?: boolean } = {}): ToolResult {
  const extra = [
    res.merged?.length ? `Main moved after your last read: gitring merged your write with the landed changes in ${res.merged.join(", ")}. Read these files again.` : "",
    ...(res.refused ?? []).map((r) => `Not written: ${r.reason}`),
  ].filter(Boolean);
  const clr = opts.clr ?? res.clearance;
  const headline = `${opts.before ?? ""}Written: ${res.written.join(", ") || "nothing"}. ${extra.length ? `${extra.join(" ")} ` : ""}Conflict check: ${VERDICT_WORD[clr.verdict] ?? clr.verdict}. ${clr.advice}`;
  return text(res, headline, clr, { github: opts.github });
}

/**
 * The change requests of two clearances in one (the plan check of a new work copy, then the check of its
 * first write). The change requests of both reach the agent. The second clearance gives the traffic.
 */
export function joinClearance(first: T.Clearance, second: T.Clearance): T.Clearance {
  const seen = new Set<string>();
  const corrections = [...first.corrections, ...second.corrections].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  const verdict = corrections.length && second.verdict === "clear" ? first.verdict : second.verdict;
  return { ...second, verdict, corrections, advice: adviceFor(verdict, corrections.length, second.traffic) };
}

export function plain(message: string): ToolResult {
  return { content: [{ type: "text" as const, text: message }] };
}

export function fail(err: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: `Error: ${String((err as Error)?.message ?? err)}` }], isError: true };
}
