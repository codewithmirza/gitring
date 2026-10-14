/**
 * Finds the words that people read inside a source file: string literals and JSX text that look like prose.
 * Used by the copy tests to check the plain-word rules (test/coord/ste.ts) on views that keep their text inline.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { steViolations } from "./ste";

const ROOT = resolve(__dirname, "..", "..");

function isProse(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).length < 2) return false;
  if (!/^[A-Z"“]|^gitring\b/.test(t)) return false;
  if (/[=<>{};]|=>|\bhttps?:/.test(t)) return false;
  return /[a-z]{2,} [a-z]{2,}/i.test(t);
}

/** The prose pieces of one source file (comments left out). */
export function proseOf(source: string): string[] {
  const out: string[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*") || line.startsWith("import ")) continue;
    for (const lit of line.match(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []) {
      const text = lit.slice(1, -1).replace(/\$\{[^}]*\}/g, "x").replace(/\\n/g, " ").replace(/\\"/g, '"');
      if (isProse(text)) out.push(text);
    }
    for (const m of line.matchAll(/>([^<>{}]+)</g)) if (isProse(m[1])) out.push(m[1].trim());
    if (/^[A-Z][^=;(){}<>"`]*$/.test(line) && isProse(line)) out.push(line);
  }
  return out;
}

export function proseOfFile(path: string): string[] {
  return proseOf(readFileSync(resolve(ROOT, path), "utf8"));
}

/** Words that end in "ing" but are not verb forms (the list of test/docs/readme.test.ts), and the callsign of a change request. */
const NOT_VERB_FORMS = new Set(["anything", "binding", "bring", "during", "everything", "merging", "nothing", "something", "string", "thing", "gitring"]);

/** The plain-word problems of every prose piece in a file, with the piece in front. */
export function copyProblems(path: string): string[] {
  const found: string[] = [];
  for (const text of proseOfFile(path)) {
    for (const p of steViolations(text)) {
      const word = /^"-ing" form "([^"]*)"/.exec(p)?.[1]?.toLowerCase();
      if (word && (NOT_VERB_FORMS.has(word) || word === "gitring")) continue;
      found.push(`${path}: ${p}`);
    }
  }
  return found;
}
