/**
 * Approvals in the chat of an agent.
 *
 * An agent asks for a merge (gitring_submit, or create_pull_request in the GitHub-compatible set) and a
 * person must say yes. The agent never answers that question. gitring reaches the person in one of two ways:
 *
 *   1. In the chat of the agent. The client of the agent says that it can show a form to a person (MCP
 *      2026-07-28, client capability "elicitation"). Then the tool does not finish. It answers "input
 *      required" and gives a form: "Yes, merge it" or "No, send it back". The client shows the form to the
 *      person. The person answers. The client calls the tool again and gives the answer. This code passes the
 *      answer to the project object. The project object merges the work, or sends it back.
 *   2. In the gitring app. A client that cannot show a form gets a normal answer, "A PERSON MUST SAY YES",
 *      with a link. The person opens the link, reads the change and answers there.
 *
 * The person chooses (contract C3, approvalsIn): "agent" or "both" use the chat when the client can show a form;
 * "app" never asks in the chat, and an answer from the chat does not count. For a person who chooses "app", no
 * agent can answer for them, also an agent that holds their key.
 *
 * The state of a question travels through the client (requestState). gitring signs it with a key from
 * GITRING_SECRET and binds it to the person: another person cannot use it. The project object checks the
 * rest again: who may answer, that the question is the one that waits, and that the work is the work that
 * the person saw.
 *
 * What this protects: an agent that runs away, a wrong merge, and a person who does not look. What it does
 * not protect: a program that holds the credentials of the person and sends the answer itself. gitring
 * has no tool that approves.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./env";
import type * as T from "../core/types";
import type * as A from "../core/accounts";
import { DEFAULT_PREFS } from "../core/accounts";
import { approvalQuestion, waitingText } from "../core/approvals";
import { hmacSha256Hex } from "../directory/crypto";
import { directory, type Principal } from "./auth";
import { text, type AskState, type HarborApi, type ToolContext, type ToolResult } from "./mcp-kit";

/** The key of the question in the answer of the client. */
export const QUESTION_KEY = "approval";

/** How long a question in chat stays valid, in seconds. */
const QUESTION_SECONDS = 3600;

/** A project object, after a role check. */
export interface Access {
  id: string;
  stub: HarborApi;
  role: A.Role;
}

/** The answer that a form gives back. The client sends it, so gitring checks it. */
const ANSWER_FORM = z.object({ answer: z.enum(["approve", "send-back"]), note: z.string().max(1000).optional() });

/** The signer of questions in chat. Absent when the person is not known, or the secret is not set: then gitring gives a link only. */
export async function askCodec(env: Env, who: Principal): Promise<RequestStateCodec<AskState> | undefined> {
  const secret = env.GITRING_SECRET;
  if (!secret || secret.length < 16 || !who.user) return undefined;
  const key = await hmacSha256Hex(secret, "gitring mcp request state v1");
  const user = who.user.id;
  return createRequestStateCodec<AskState>({ key, ttlSeconds: QUESTION_SECONDS, bind: () => user });
}

/**
 * Can the client of this call show a form to a person? Only a call of the 2026-07-28 revision that declared
 * the capability. The 2025 revision (stateless here) has no way to ask. "elicitation: {}" means forms. A
 * client that lists only "url" cannot show a form.
 */
export function clientCanAsk(req: ServerContext): boolean {
  const envelope = req.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: { form?: unknown; url?: unknown } } | undefined;
  const e = caps?.elicitation;
  if (!e || typeof e !== "object") return false;
  return e.form !== undefined || e.url === undefined;
}

/** An approval for the agent to read: the facts, without the digest. */
export function approvalView(ap: T.Approval) {
  return {
    id: ap.id,
    status: ap.status,
    reason: ap.reason,
    why: ap.why,
    ...(ap.approver ? { approver: ap.approver.name } : {}),
    askedAt: new Date(ap.askedAt).toISOString(),
    ...(ap.answer ? { answer: { by: ap.answer.by.name, how: ap.answer.how, ...(ap.answer.note ? { note: ap.answer.note } : {}), at: new Date(ap.answer.at).toISOString() } } : {}),
    ...(ap.closed ? { closed: ap.closed } : {}),
  };
}

/** The work waits for a person's answer. */
export function isWaiting(st: Pick<T.WorkStatus, "approval" | "status">): boolean {
  return st.approval?.status === "waiting" && st.status === "ready";
}

/** The preference of one person; the default when the Directory cannot say. */
async function prefsOf(ctx: ToolContext, userId: string): Promise<A.PersonPrefs> {
  try {
    return await directory(ctx.env).prefs(userId);
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * Where the question of this work copy is answered (contract C3): the preference of the person who answers (the
 * sender of the work) and of the caller (a form in this chat goes to the caller). "app" of either one wins.
 */
export async function answerPlace(ctx: ToolContext, st: Pick<T.WorkStatus, "approval">): Promise<A.ApprovalsIn> {
  const ids = [...new Set([st.approval?.approver?.id, ctx.who.user?.id].filter((x): x is string => Boolean(x)))];
  if (!ids.length) return DEFAULT_PREFS.approvalsIn;
  const prefs = await Promise.all(ids.map((id) => prefsOf(ctx, id)));
  return prefs.some((p) => p.approvalsIn === "app") ? "app" : prefs[0].approvalsIn;
}

/** What the agent reads about a work copy: the words first, then the facts. Each tool set names its own tool to check the answer. */
export function statusHeadline(st: T.WorkStatus, opts: { check: string; asked?: boolean; before?: string; header?: string; app?: boolean }): string {
  const main = isWaiting(st)
    ? waitingText({ title: st.task.title, approval: st.approval!, line: st.line, link: st.link, check: opts.check, asked: opts.asked, header: opts.header, app: opts.app })
    : st.message;
  return opts.before ? `${opts.before} ${main}` : main;
}

/** The facts of a work copy, for the agent. */
export function statusFacts(st: T.WorkStatus) {
  return {
    attemptId: st.attemptId,
    status: st.status,
    task: st.task,
    ...(st.approval ? { approval: approvalView(st.approval) } : {}),
    ...(isWaiting(st) ? { link: st.link } : {}),
    line: st.line,
    mainSha: st.mainSha,
    ...(st.landing ? { landing: st.landing } : {}),
    ...(st.mergeWait ? { mergeWait: st.mergeWait } : {}),
  };
}

/** The sentence that names the tool of the gitring set that shows the answer. */
export const CHECK_WITH_STATUS = (attemptId: string): string => `To see the answer, call gitring_status with the work copy id ${attemptId}.`;

/** The same, when the person answers in the gitring app only: the agent waits with gitring_wait (contract C1). */
export const WAIT_FOR_APP = (attemptId: string): string => `To wait for the answer, call gitring_wait with the work copy id ${attemptId}. gitring_status also shows the answer.`;

/** The answer of gitring_status, and of a tool of the gitring set that reports a work copy. `app`: the person answers in the gitring app only. */
export function statusReply(st: T.WorkStatus, opts: { asked?: boolean; before?: string; extra?: Record<string, unknown>; app?: boolean } = {}): ToolResult {
  const check = opts.app ? WAIT_FOR_APP(st.attemptId) : CHECK_WITH_STATUS(st.attemptId);
  return text({ ...statusFacts(st), ...(opts.extra ?? {}) }, statusHeadline(st, { check, asked: opts.asked, before: opts.before, app: opts.app }), st.clearance);
}

/** One sentence for the person when the agent got change requests with this answer: the work can still change. */
function requestsNote(n: number): string {
  return n ? ` gitring also sent ${n} change ${n === 1 ? "request" : "requests"} to the agent. The work can change.` : "";
}

/**
 * The question for the person, as a form in the chat of the agent. Absent when gitring cannot ask here (the client
 * cannot show a form, the person is not known, the person may not answer, or the person answers in the gitring app
 * only): the caller then gives the link. `again`: the change requests that the first answer delivered. The state
 * carries them, so the answer of the second call holds them again (the agent reads only that answer).
 */
export async function askInChat(ctx: ToolContext, req: ServerContext, h: Access, st: T.WorkStatus, opts: { place?: A.ApprovalsIn; again?: string[] } = {}): Promise<InputRequiredResult | undefined> {
  const me = ctx.who.user;
  const ap = st.approval;
  if (opts.place === "app" || !ctx.ask || !me || !ap || !isWaiting(st) || st.mayAnswer === false || !clientCanAsk(req)) return undefined;
  const state: AskState = { v: 1, project: h.id, attemptId: st.attemptId, approvalId: ap.id, user: me.id, ...(opts.again?.length ? { cr: opts.again.slice(0, 20) } : {}) };
  const requestState = await ctx.ask.mint(state, req);
  return inputRequired({
    inputRequests: {
      [QUESTION_KEY]: inputRequired.elicit({
        message: `${approvalQuestion(st.task.title, st.line, ap)}${requestsNote(st.clearance.corrections.length)}`,
        requestedSchema: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              title: "Your answer",
              oneOf: [
                { const: "approve", title: "Yes, merge it" },
                { const: "send-back", title: "No, send it back to the agent" },
              ],
            },
            note: { type: "string", title: "A note for the agent. Say what to change.", maxLength: 500 },
          },
          required: ["answer"],
        },
      }),
    },
    requestState,
  });
}

/** What the second call of a question brings: the work copy after the answer, and what the answer did. */
export interface Taken {
  status: T.WorkStatus;
  /** Set when the person answered. Absent: the person closed the question without an answer. */
  result?: T.ApprovalResult;
  /** The person answers in the gitring app only: the answer from the chat did not count. */
  app?: boolean;
}

/**
 * The second call of a question in chat. The client gives the answer of the person and the signed state.
 * Absent: this call is not the second call of a question (or it is not a call that gitring can trust), and the
 * caller works as for a first call. A call that the person closed without an answer changes nothing.
 */
export async function takeAnswer(ctx: ToolContext, req: ServerContext, h: Access, attemptId: string): Promise<Taken | undefined> {
  const responses = req.mcpReq.inputResponses;
  const me = ctx.who.user;
  if (!responses || !(QUESTION_KEY in responses) || !me) return undefined;
  // The state is signed (the server checked the signature before this code ran). It must also be for this person, this project and this work copy.
  const state = req.mcpReq.requestState<AskState>();
  if (!state || state.v !== 1 || state.user !== me.id || state.project !== h.id || state.attemptId !== attemptId) return undefined;
  const viewer = { id: me.id, role: h.role };
  const call = { origin: ctx.origin, viewer, ...(state.cr?.length ? { again: state.cr } : {}) };
  const answered = inputResponse(responses, QUESTION_KEY);
  if (answered.kind !== "elicit") return undefined;
  if (answered.action !== "accept") return { status: await h.stub.status(attemptId, call) };
  const form = ANSWER_FORM.safeParse(answered.content);
  if (!form.success) return undefined;
  // A person who answers in the gitring app only: an answer from a chat does not count (an agent can hold their key).
  if ((await prefsOf(ctx, me.id)).approvalsIn === "app") {
    const status = await h.stub.status(attemptId, call);
    const message = "You chose to answer merge questions in the gitring app only. gitring did not use the answer from this chat. Answer in the app.";
    return { status, app: true, ...(status.approval ? { result: { attemptId, outcome: "refused" as const, approval: status.approval, status: status.status, message } } : {}) };
  }
  const result = await h.stub.decide(attemptId, form.data, { id: me.id, name: me.name, role: h.role }, "chat", { approvalId: state.approvalId }, ctx.origin);
  return { status: await h.stub.status(attemptId, call), result };
}

/**
 * Words for the agent when the answer of the person did not count: it was refused, or it came twice, or the question
 * was old. The answer of the tool says the rest (what the work copy is now).
 */
export function answerNote(result: T.ApprovalResult | undefined): string | undefined {
  if (!result) return undefined;
  if (result.outcome === "refused" || result.outcome === "already") return result.message;
  return result.outcome === "withdrawn" ? "The answer did not count." : undefined;
}
