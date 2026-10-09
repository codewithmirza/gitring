/**
 * Workers AI access: the Clef decision model (course checks) and chat models (vessels, correction polish).
 * Every call has a timeout and never throws to the caller: a failure returns null so the
 * caller can fall back to the deterministic rules.
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
  choices?: { message?: ChatMessage & { reasoning_content?: string }; finish_reason?: string }[];
  usage?: ChatResult["usage"];
  response?: string; // legacy shape
}

/** Third-party catalog models go through AI Gateway (Unified Billing). */
export function isGatewayModel(model: string): boolean {
  return !model.startsWith("@cf/") && !model.startsWith("@hf/");
}

/** The last chat error (for diagnostics in vessels and logs). */
export let lastChatError: string | undefined;

/** Model-specific knobs: lower reasoning effort where the model supports it (faster agent turns). */
function modelOptions(model: string): Record<string, unknown> {
  if (model.includes("kimi")) return { reasoning_effort: "low" };
  if (model.includes("gpt-oss")) return { reasoning_effort: "low" };
  return {};
}

export async function chat(
  ai: AiLike | undefined,
  model: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; toolChoice?: "auto" | "required" | "none"; maxTokens?: number; temperature?: number; timeoutMs?: number; json?: boolean } = {},
): Promise<ChatResult | null> {
  if (!ai) return null;
  lastChatError = undefined;
  const t0 = Date.now();
  const input: Record<string, unknown> = {
    messages,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.2,
    ...modelOptions(model),
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
      return {
        message: { role: "assistant", content: m.content ?? null, tool_calls: m.tool_calls },
        finishReason: raw.choices[0].finish_reason ?? "stop",
        usage: raw.usage,
        latencyMs: Date.now() - t0,
      };
    }
    if (typeof raw?.response === "string") {
      return { message: { role: "assistant", content: raw.response }, finishReason: "stop", usage: raw.usage, latencyMs: Date.now() - t0 };
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
