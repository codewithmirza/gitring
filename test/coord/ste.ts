/**
 * ASD-STE100 checks for correction messages:
 *  - every sentence has at most 20 words;
 *  - no word ends in "-ing", except identifiers (paths, symbols, signatures, callsigns, numbers)
 *    and quoted human text (intent titles).
 */
import { expect } from "vitest";

export function sentencesOf(message: string): string[] {
  return message
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isIdentifier(raw: string): boolean {
  const core = raw.replace(/[.,;:!?]+$/, "");
  return /[./#()_\d]/.test(core) || /[a-z][A-Z]/.test(core) || /^[A-Z][A-Z0-9]*-\d+$/.test(core);
}

/** Names (the product name is a proper noun, not an "-ing" form). */
const PROPER_NOUNS = new Set(["Gitring"]);

export function steViolations(message: string): string[] {
  const problems: string[] = [];
  for (const s of sentencesOf(message)) {
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length > 20) problems.push(`more than 20 words (${words.length}): ${s}`);
    const unquoted = s.replace(/"[^"]*"/g, " ");
    for (const raw of unquoted.split(/\s+/).filter(Boolean)) {
      const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
      if (/ing$/i.test(word) && !isIdentifier(raw) && !PROPER_NOUNS.has(word)) problems.push(`"-ing" form "${word}" in: ${s}`);
    }
  }
  return problems;
}

/** Assert STE rules and the closing sentence. */
export function expectSTE(message: string): void {
  expect(steViolations(message)).toEqual([]);
  expect(message.endsWith("Continue your work.")).toBe(true);
}
