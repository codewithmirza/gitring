/**
 * Splits TypeScript source into tokens for the type strip, and blanks the decorators that the tokenizer cannot read.
 *
 * Used by `ts-strip.ts`. The strip itself is built in layers, from `ts-cursor.ts` to `ts-scan.ts`.
 */

import { tokenizer, type Options } from "acorn";
import { JsxParser } from "./acorn-parse";
import { maskSource, matchBracket } from "./masking";

export interface Tok {
  /** Tag: "name" | "num" | "string" | "regexp" | "privateId" | "template" | a keyword | the punctuator text. */
  t: string;
  /** Source text of the token. */
  v: string;
  s: number;
  e: number;
  /** A line break comes before this token. */
  nl: boolean;
}

export const TOKEN_CATEGORIES = new Set(["name", "num", "string", "regexp", "privateId", "template", "invalidTemplate"]);

/** Blank decorators (`@name`, `@a.b(…)`), which the tokenizer cannot read; marks them in `removed`. */
export function blankDecorators(src: string, removed: Uint8Array): string {
  if (src.indexOf("@") === -1) return src;
  const masked = maskSource(src, true);
  let at = masked.indexOf("@");
  if (at === -1) return src;
  const out = src.split("");
  while (at !== -1) {
    let j = at + 1;
    while (j < masked.length && /[\w$.]/.test(masked[j])) j++;
    let k = j;
    while (k < masked.length && (masked[k] === " " || masked[k] === "\t")) k++;
    if (masked[k] === "(") {
      const c = matchBracket(masked, k);
      if (c > 0) j = c + 1;
    }
    for (let x = at; x < j; x++) {
      removed[x] = 1;
      if (out[x] !== "\n" && out[x] !== "\r") out[x] = " ";
    }
    at = masked.indexOf("@", j);
  }
  return out.join("");
}

/**
 * Tokens of (TypeScript) source, or null if the JavaScript tokenizer cannot read it. With `withJsx`,
 * the JSX tokenizer reads TSX: JSX tokens get their own names ("jsxTagStart", "jsxName", "jsxText",
 * "jsxTagEnd"), which the type strip leaves alone.
 */
export function tokenizeTs(src: string, withJsx = false): Tok[] | null {
  const toks: Tok[] = [];
  try {
    let prevEnd = 0;
    let nextNl = src.indexOf("\n");
    const options: Options = { ecmaVersion: "latest", sourceType: "module", allowHashBang: true };
    for (const tok of withJsx ? JsxParser.tokenizer(src, options) : tokenizer(src, options)) {
      const type = tok.type;
      let t: string;
      if (type.keyword) t = type.keyword;
      else if (TOKEN_CATEGORIES.has(type.label)) t = type.label === "invalidTemplate" ? "template" : type.label;
      else if (type.label.startsWith("jsx")) t = type.label;
      else t = src.slice(tok.start, tok.end);
      while (nextNl !== -1 && nextNl < prevEnd) nextNl = src.indexOf("\n", nextNl + 1);
      const nl = nextNl !== -1 && nextNl < tok.start;
      const value = (tok as unknown as { value?: unknown }).value;
      toks.push({ t, v: type.label === "name" ? String(value) : src.slice(tok.start, tok.end), s: tok.start, e: tok.end, nl });
      prevEnd = tok.end;
    }
  } catch {
    return null;
  }
  return toks;
}

/** Characters of code[start, end) that were not blanked by the type strip. */
export function keptText(code: string, start: number, end: number, removed: Uint8Array): string {
  let out = "";
  let runStart = start;
  for (let k = start; k < end; k++) {
    if (removed[k]) {
      if (k > runStart) out += code.slice(runStart, k);
      runStart = k + 1;
    }
  }
  if (end > runStart) out += code.slice(runStart, end);
  return out;
}
