/**
 * The model behind the guess of the install and test commands: Workers AI, one short JSON answer.
 *
 * Without an AI binding there is no model, and the rules of core/guess.ts (guessTree) decide alone.
 */
import { GUESS_MODEL, type AskModel } from "../../core/guess";
import { chat } from "./models";

/**
 * A short job: little reasoning, and time for the reasoning tokens of GLM 5.3 Flash. GLM 5.3 needs a
 * reasoning effort: chat() passes `reasoning` on where it supports the field.
 */
export const GUESS_CALL = { maxTokens: 600, timeoutMs: 15_000, json: true, temperature: 0, reasoning: "low" as const };

export function guessModel(ai: unknown): AskModel | undefined {
  if (!ai) return undefined;
  return async (messages) => {
    const res = await chat(ai as never, GUESS_MODEL, messages, GUESS_CALL);
    return res?.message.content ?? null;
  };
}
