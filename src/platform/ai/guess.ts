/**
 * The model behind the guess of the install and test commands (core/guess.ts guessTree): Workers AI,
 * asked for one short JSON answer. No AI binding: no model, and the rules decide alone.
 */
import { GUESS_MODEL, type AskModel } from "../../core/guess";
import { chat } from "./models";

export function guessModel(ai: unknown): AskModel | undefined {
  if (!ai) return undefined;
  return async (messages) => {
    const res = await chat(ai as never, GUESS_MODEL, messages, { maxTokens: 600, timeoutMs: 8000, json: true, temperature: 0 });
    return res?.message.content ?? null;
  };
}
