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
import type { CallInfo, HarborMaster } from "../harbor/harbor";
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
  | "news"
  | "wait"
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

/**
 * What the project object must know about the caller of a tool: the person and the role that the Worker
 * checked (absent for the operator key), and the address of this deployment. The project object decides with
 * it who may change a work copy and who gets its change requests.
 */
export function callOf(ctx: ToolContext, h: { role: A.Role }): CallInfo {
  return { origin: ctx.origin, ...(ctx.who.user ? { viewer: { id: ctx.who.user.id, role: h.role } } : {}) };
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

/* ───────────────────────── a project object that restarts ───────────────────────── */

/**
 * The platform can stop a project object between two calls (a new version, a move to another machine, a
 * crash). The call that is on its way then fails, for example with "Connection closed: this Durable Object
 * instance is no longer active. Reconnect or retry the request." The object starts again with its storage,
 * so the same call works a moment later.
 */
export function isObjectReset(err: unknown): boolean {
  const e = err as { message?: unknown; retryable?: unknown; overloaded?: unknown } | null | undefined;
  // An object that has too much to do needs fewer calls, not more.
  if (e?.overloaded === true) return false;
  if (e?.retryable === true) return true;
  return /no longer active|connection closed|object to be reset|was reset|reset because|network connection lost|has moved machine|code (has been|was) updated/i.test(String(e?.message ?? ""));
}

/**
 * The calls that give the same result when they run twice: reads, and writes that repeat without harm (the same
 * file text again, a second submit of the same work, a second ack). A call that makes something new (declare,
 * createIntent) or records a decision of a person (decide) is not here: when the first call did run, a second one
 * would make a second work copy or a second decision. A wait is safe to send twice, but gitring does not send it
 * again by itself: a second wait of up to 50 seconds can be longer than the client waits for the answer.
 */
const AGAIN: ReadonlySet<string> = new Set([
  "ensure", "openIntents", "log", "traffic", "read", "list", "state", "tree", "file", "attemptDiff", "status",
  "write", "submit", "ack", "check", "update", "news",
]);

/** What an agent does after a restart stopped a call that is not safe to send again (gitring tools). */
export const CHECK_HOW = "Call gitring_status or gitring_intents to see if your call took effect before you send it again.";

/** The error of a call that is not safe to send again, after a restart: fail() tells the agent to look first. */
interface NotSentAgain extends Error {
  retryable: true;
  /** What the agent does before it sends the call again. */
  checkFirst: string;
}

function notSentAgain(err: unknown, checkHow: string): NotSentAgain {
  return Object.assign(new Error(String((err as Error)?.message ?? err)), { retryable: true as const, checkFirst: checkHow });
}

/** How many times a call is sent when the project object restarts (the first call counts). */
const RESET_TRIES = 3;

/**
 * A project object for a caller. A call from the AGAIN list that fails because the object restarted is sent
 * again with a new stub (a stub that saw this error can be broken), after 250 and 500 ms. Other errors pass
 * through as they are. The restart error of a call that is not safe to send again carries `checkHow`: what the
 * agent does before it sends the call again (a wait is safe, so its error stays as it is). `make` gives a new
 * stub of the same object.
 */
export function retryAfterReset<T extends object>(make: () => T, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), checkHow = CHECK_HOW): T {
  let stub = make();
  // The target holds only what the caller sets on the object (Object.assign(stub, { role })). The methods and
  // the other properties come from the stub that is current when the call is made.
  return new Proxy({} as T, {
    get(target, prop) {
      if (Object.hasOwn(target, prop)) return Reflect.get(target, prop);
      if (typeof prop !== "string" || prop === "then") return undefined;
      const value = Reflect.get(stub, prop, stub) as unknown;
      if (typeof value !== "function") return value;
      const send = (args: unknown[]) => (stub as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
      if (!AGAIN.has(prop)) {
        return async (...args: unknown[]) => {
          try {
            return await send(args);
          } catch (err) {
            // The first call can have run before the stop. The agent looks before it sends the call again.
            throw isObjectReset(err) && prop !== "wait" ? notSentAgain(err, checkHow) : err;
          }
        };
      }
      return async (...args: unknown[]) => {
        for (let tries = 1; ; tries++) {
          try {
            return await send(args);
          } catch (err) {
            if (tries >= RESET_TRIES || !isObjectReset(err)) throw err;
            await sleep(250 * tries);
            stub = make();
          }
        }
      };
    },
  });
}

export function makeContext(env: Env, who: Principal, opts: { listHow?: string; checkHow?: string; origin?: string; ask?: RequestStateCodec<AskState> } = {}): ToolContext {
  const listHow = opts.listHow ?? LIST_HOW;
  const checkHow = opts.checkHow ?? CHECK_HOW;
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
      const objectId = env.HARBOR.idFromName(id);
      const stub = retryAfterReset(() => env.HARBOR.get(objectId) as unknown as HarborApi, undefined, checkHow);
      return { id, stub, role: found };
    },
  };
}

/* ───────────────────────── answers ───────────────────────── */

export const KIND_WORD: Record<string, string> = { interface: "function change", region: "same lines", duplicate: "same task", upstream: "main moved", "intent-amended": "task changed", review: "sent back by a person" };
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

/**
 * The answer of a tool that reads a file of a work copy (a file text, a list of paths): the text stays clean in
 * the first block, and the new change requests come in a second block that starts with "GITRING CHANGE REQUEST".
 */
export function withNews(res: ToolResult, clr: T.Clearance | null | undefined, opts: { github?: boolean } = {}): ToolResult {
  if (!clr?.corrections.length) return res;
  const news = text(clr, `Conflict check: ${VERDICT_WORD[clr.verdict] ?? clr.verdict}. ${clr.advice}`, clr, opts);
  return { ...res, content: [...res.content, ...news.content] };
}

/** An answer object with the conflict check of the work copy in it, when the caller gets one (see HarborMaster.news). */
export function withClearance<O extends object>(obj: O, clr: T.Clearance | null | undefined): O | (O & { clearance: T.Clearance }) {
  return clr ? { ...obj, clearance: clr } : obj;
}

/**
 * The answer when a tool stops with an error. A restart of the project object gets plain words: the work is
 * kept. When the call was not safe to send again (declare, createIntent, decide), the agent looks first.
 */
export function fail(err: unknown): ToolResult {
  const first = (err as Partial<NotSentAgain> | null | undefined)?.checkFirst;
  const message = !isObjectReset(err)
    ? String((err as Error)?.message ?? err)
    : first
      ? `gitring restarted this project for a moment. ${first}`
      : "gitring restarted this project for a moment. The work you already sent is kept. Send the same call again.";
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}
