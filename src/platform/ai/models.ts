/**
 * Workers AI access: the conflict-check model, and the chat models of built-in agents and the test-command guess.
 *
 * Every call has a timeout and never throws to the caller: a failure returns null, so the caller can fall back to the rules.
 */
import type { ClefRequest, ClefResponse } from "../../core/coord/clef";

export interface AiLike {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
}

export const CLEF_MODELS = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
} as const;

export interface ClefCall {
  res: ClefResponse;
  latencyMs: number;
  model: "clef" | "clef-flash";
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Ask Clef. Returns null when AI is unavailable or the call fails. */
export async function callClef(ai: AiLike | undefined, req: ClefRequest, timeoutMs = 4000): Promise<ClefCall | null> {
  if (!ai) return null;
  const t0 = Date.now();
  try {
    const raw = (await withTimeout(ai.run(CLEF_MODELS[req.model], req), timeoutMs, "clef")) as ClefResponse | { result?: ClefResponse };
    const res = (raw && "answers" in (raw as object) ? raw : (raw as { result?: ClefResponse }).result) as ClefResponse | undefined;
    if (!res || typeof res !== "object" || !res.answers) return null;
    return { res, latencyMs: Date.now() - t0, model: req.model };
  } catch (err) {
    console.warn("clef call failed", String(err));
    return null;
  }
}

/* ───────────────────────── chat ───────────────────────── */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latencyMs: number;
}

interface ChatCompletion {
  choices?: { message?: ChatMessage & { reasoning_content?: string; reasoning?: string }; finish_reason?: string }[];
  usage?: ChatResult["usage"];
  response?: string; // legacy shape
}

/** Third-party catalog models go through AI Gateway (Unified Billing). */
export function isGatewayModel(model: string): boolean {
  return !model.startsWith("@cf/") && !model.startsWith("@hf/");
}

/** The last chat error (for diagnostics in vessels and logs). */
export let lastChatError: string | undefined;

/**
 * How hard a reasoning model thinks before it answers. GLM 5.3 cannot turn reasoning off, and its default is
 * "max" (slow and costly), so each call names one: "high" for a plan, "low" for a routine tool turn.
 */
export type ReasoningEffort = "low" | "high" | "max";

/** The model for short jobs outside the agents (the guess of the test command of a repository). */
export const SHORT_JOB_MODEL = "@cf/zai-org/glm-5.3-flash";

/** GLM 5.3 and GLM 5.3 Flash on Workers AI: 1,048,576 tokens of context; `reasoning_effort` is mandatory. */
export function isGlm53(model: string): boolean {
  return /\/glm-5\.3(?:-flash)?$/.test(model);
}

/**
 * Reasoning tokens count against the completion limit. Room for them on top of the answer, so that a model
 * that thinks long still has tokens left for the answer.
 */
const REASONING_ROOM: Record<ReasoningEffort, number> = { low: 4096, high: 16_384, max: 32_768 };

/** Model-specific knobs: the reasoning effort and the completion limit, where the model supports them. */
function modelOptions(model: string, maxTokens: number, effort: ReasoningEffort | undefined): Record<string, unknown> {
  if (isGlm53(model)) {
    const e = effort ?? "low";
    return { reasoning_effort: e, max_completion_tokens: maxTokens + REASONING_ROOM[e] };
  }
  // Lower reasoning effort where the model supports it (faster agent turns).
  if (model.includes("kimi")) return { max_tokens: maxTokens, reasoning_effort: "low" };
  if (model.includes("gpt-oss")) return { max_tokens: maxTokens, reasoning_effort: "low" };
  return { max_tokens: maxTokens };
}

/**
 * Tool calls as the conversation needs them: function calls only, each with an id (the tool answer names
 * it) and its arguments as a JSON string. Some models leave out the id or send the arguments as an object.
 */
export function cleanToolCalls(calls: unknown): ToolCall[] | undefined {
  if (!Array.isArray(calls)) return undefined;
  const out: ToolCall[] = [];
  for (const raw of calls) {
    const c = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
    const name = c?.function?.name;
    if (typeof name !== "string" || !name) continue;
    const args = c!.function!.arguments;
    out.push({
      id: typeof c!.id === "string" && c!.id ? c!.id : `call_${out.length + 1}`,
      type: "function",
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
    });
  }
  return out.length ? out : undefined;
}

/**
 * The answer text of a reply, without a reasoning block that some models put at the start ("<think>…</think>").
 * A block with no end (the model stopped while it thought) is all reasoning: the answer is empty.
 */
export function answerText(content: unknown): string | null {
  if (typeof content !== "string") return null;
  if (/^\s*<think>/.test(content) && !content.includes("</think>")) return "";
  return content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
}

export async function chat(
  ai: AiLike | undefined,
  model: string,
  messages: ChatMessage[],
  opts: {
    tools?: ToolDef[];
    toolChoice?: "auto" | "required" | "none";
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    json?: boolean;
    /** For reasoning models (GLM 5.3 needs one): "high" to plan, "low" (the default) for routine turns. */
    reasoning?: ReasoningEffort;
  } = {},
): Promise<ChatResult | null> {
  if (!ai) return null;
  lastChatError = undefined;
  const t0 = Date.now();
  const input: Record<string, unknown> = {
    messages,
    temperature: opts.temperature ?? 0.2,
    ...modelOptions(model, opts.maxTokens ?? 4096, opts.reasoning),
  };
  if (opts.tools?.length) {
    input.tools = opts.tools;
    input.tool_choice = opts.toolChoice ?? "auto";
  }
  if (opts.json) input.response_format = { type: "json_object" };
  const options = isGatewayModel(model) ? { gateway: { id: "default" } } : undefined;
  try {
    const raw = (await withTimeout(ai.run(model, input, options), opts.timeoutMs ?? 90_000, `chat ${model}`)) as ChatCompletion;
    if (raw?.choices?.[0]?.message) {
      const m = raw.choices[0].message;
      // Reasoning text (reasoning_content, reasoning, a <think> block) never goes into the conversation: only the answer does.
      const toolCalls = cleanToolCalls(m.tool_calls);
      return {
        message: { role: "assistant", content: answerText(m.content), ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finishReason: raw.choices[0].finish_reason ?? "stop",
        usage: raw.usage,
        latencyMs: Date.now() - t0,
      };
    }
    if (typeof raw?.response === "string") {
      return { message: { role: "assistant", content: answerText(raw.response) }, finishReason: "stop", usage: raw.usage, latencyMs: Date.now() - t0 };
    }
    lastChatError = `unexpected response: ${JSON.stringify(raw).slice(0, 300)}`;
    console.warn("chat:", lastChatError);
    return null;
  } catch (err) {
    lastChatError = String((err as Error)?.message ?? err).slice(0, 400);
    console.warn("chat call failed", model, lastChatError);
    return null;
  }
}

/* ───────────────────────── context budget ───────────────────────── */

/** How much text an agent turn may carry. */
export interface ContextBudget {
  /** File text in the brief (the first prompt), in characters. */
  briefChars: number;
  /** A larger file stays out of the brief (the agent reads it with a tool). */
  fileChars: number;
  /** All the messages of one turn together, in characters (older turns go first). */
  turnChars: number;
  /** One tool answer (a file that the agent reads, a test result), in characters. */
  toolChars: number;
  /** All the tool answers of one turn together, in characters (a model can read many files in one turn). */
  turnToolChars: number;
}

/**
 * The budget of a model. GLM 5.3 reads 1,048,576 tokens (about 4 characters each): the brief may hold far
 * more of the repository. Other models keep the old budget. The turn limit keeps the cost of a turn sensible.
 * It also keeps the history of a built-in agent in one value of Durable Object storage (at most 2 MB: 800,000
 * characters take 1.6 MB when a text has characters above U+00FF).
 */
export function contextBudget(model: string | undefined): ContextBudget {
  if (model && isGlm53(model)) return { briefChars: 400_000, fileChars: 100_000, turnChars: 800_000, toolChars: 100_000, turnToolChars: 200_000 };
  return { briefChars: 60_000, fileChars: 20_000, turnChars: 240_000, toolChars: 14_000, turnToolChars: 140_000 };
}

/** Extract the first JSON object from a model reply (fenced or bare). */
export function parseJsonLoose<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
