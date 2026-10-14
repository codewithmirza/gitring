/** Workers AI chat: GLM 5.3 gets a reasoning effort on each call, and the answer holds no reasoning text. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { answerText, chat, cleanToolCalls, contextBudget, isGlm53, SHORT_JOB_MODEL } from "../../src/platform/ai/models";
import { DEFAULT_SETTINGS } from "../../src/core/types";

/** A Workers AI binding that records the input and answers `reply`. */
function ai(reply: unknown) {
  const inputs: Record<string, unknown>[] = [];
  return { inputs, run: async (_model: string, input: unknown) => (inputs.push(input as Record<string, unknown>), reply) };
}

const OK = { choices: [{ message: { role: "assistant", content: "Fine." }, finish_reason: "stop" }] };

describe("chat models", () => {
  it("built-in agents default to GLM 5.3 Flash and GLM 5.3 (contract C7)", () => {
    expect(DEFAULT_SETTINGS.agentModels).toEqual(["@cf/zai-org/glm-5.3-flash", "@cf/zai-org/glm-5.3"]);
    for (const file of ["wrangler.jsonc", "wrangler.local.jsonc"]) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      expect(/"AGENT_MODELS":\s*"([^"]*)"/.exec(text)?.[1].split(",").slice(0, 2), file).toEqual(DEFAULT_SETTINGS.agentModels);
    }
    expect(SHORT_JOB_MODEL).toBe("@cf/zai-org/glm-5.3-flash");
    expect(isGlm53("@cf/zai-org/glm-5.3")).toBe(true);
    expect(isGlm53("@cf/zai-org/glm-5.3-flash")).toBe(true);
    expect(isGlm53("@cf/zai-org/glm-4.7-flash")).toBe(false);
  });

  it("names a reasoning effort for GLM 5.3 on every call: low by default, high when asked", async () => {
    const a = ai(OK);
    await chat(a, "@cf/zai-org/glm-5.3-flash", [{ role: "user", content: "Hi" }], { maxTokens: 1000 });
    await chat(a, "@cf/zai-org/glm-5.3", [{ role: "user", content: "Plan" }], { maxTokens: 1000, reasoning: "high" });
    expect(a.inputs[0]).toMatchObject({ reasoning_effort: "low", max_completion_tokens: 1000 + 4096 });
    expect(a.inputs[1]).toMatchObject({ reasoning_effort: "high", max_completion_tokens: 1000 + 16_384 });
    // max_tokens is the old name of the limit for these models.
    expect(a.inputs[0].max_tokens).toBeUndefined();
  });

  it("keeps the knobs of the other models", async () => {
    const a = ai(OK);
    await chat(a, "@cf/moonshotai/kimi-k2.7-code", [{ role: "user", content: "Hi" }], { maxTokens: 500 });
    await chat(a, "@cf/openai/gpt-oss-120b", [{ role: "user", content: "Hi" }], { maxTokens: 500 });
    await chat(a, "@cf/qwen/qwen3.8-27b", [{ role: "user", content: "Hi" }], { maxTokens: 500 });
    expect(a.inputs[0]).toMatchObject({ reasoning_effort: "low", max_tokens: 500 });
    expect(a.inputs[1]).toMatchObject({ reasoning_effort: "low", max_tokens: 500 });
    expect(a.inputs[2]).toMatchObject({ max_tokens: 500 });
    expect(a.inputs[2].reasoning_effort).toBeUndefined();
  });

  it("keeps reasoning text out of the answer, and cleans the tool calls", async () => {
    const a = ai({
      choices: [
        {
          message: {
            role: "assistant",
            content: "<think>The user wants X.</think>\nI call the tool.",
            reasoning_content: "long thoughts",
            reasoning: "more thoughts",
            tool_calls: [
              { type: "function", function: { name: "read_file", arguments: { path: "a.js" } } },
              { id: "call_x", type: "function", function: { name: "submit", arguments: '{"summary":"ok"}' } },
              { id: "bad", type: "function", function: {} },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const res = await chat(a, "@cf/zai-org/glm-5.3-flash", [{ role: "user", content: "Go" }], { tools: [] });
    expect(res!.message).toEqual({
      role: "assistant",
      content: "I call the tool.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } },
        { id: "call_x", type: "function", function: { name: "submit", arguments: '{"summary":"ok"}' } },
      ],
    });
    expect(JSON.stringify(res)).not.toContain("thoughts");
    expect(cleanToolCalls(undefined)).toBeUndefined();
    expect(answerText(null)).toBeNull();
    expect(answerText("plain")).toBe("plain");
  });

  it("gives a model with a 1M-token context a larger budget", () => {
    const glm = contextBudget("@cf/zai-org/glm-5.3-flash");
    const other = contextBudget("@cf/moonshotai/kimi-k2.7-code");
    expect(other).toEqual({ briefChars: 60_000, fileChars: 20_000, turnChars: 240_000, toolChars: 14_000 });
    expect(glm.briefChars).toBe(400_000);
    expect(glm.fileChars).toBeGreaterThan(other.fileChars);
    // One turn stays far below the context of the model (about 4 characters a token).
    expect(glm.turnChars / 4).toBeLessThan(1_048_576 / 2);
    expect(contextBudget(undefined)).toEqual(other);
  });
});
