/**
 * The line scanner for CSS: selectors, properties, values, at-rules and block comments.
 * HTML uses it for <style> blocks.
 */
import { COM, FN, KW, NUM, OP, PLAIN, PROP, PUNC, SEL, STR, VAR } from "./classes";
import type { LineFn } from "./emit";
import { at, isDigit, quoted, sticky, WS } from "./scanners";

export interface CssState {
  bcom: boolean;
  depth: number;
  /** After "property:" until ";" or "}" (values can span lines). */
  value: boolean;
}

const CSS_NUM = sticky(/-?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?(?:%|[a-zA-Z]+)?/);
const CSS_HEX = sticky(/#[\da-fA-F]{3,8}\b/);
const CSS_IDENT = sticky(/-?-?[A-Za-z_À-￿][\wÀ-￿-]*/);
const CSS_AT = sticky(/@[A-Za-z-]+/);
const CSS_IMPORTANT = sticky(/!\s*important/i);
const CSS_PSEUDO = sticky(/::?[\w-]+/);
const CSS_SEL = sticky(/[.#]?-?[A-Za-z_À-￿][\wÀ-￿-]*/);

export const cssLine: LineFn<CssState> = (s, from, end, st, e) => {
  let { bcom, depth, value } = st;
  let i = from;
  let decl: boolean | null = null; // property context for this segment, decided lazily
  // A declaration ("color: red") has a ":" and no "{" before the next ";", "}" or the line end.
  const declHere = (k: number) => {
    const seg = s.slice(k, end).split(/[;}]/)[0];
    return seg.includes(":") && !seg.includes("{");
  };
  while (i < end) {
    if (bcom) {
      const j = s.indexOf("*/", i);
      if (j === -1 || j >= end) {
        e.to(end, COM);
        return { bcom: true, depth, value };
      }
      e.to(j + 2, COM);
      i = j + 2;
      bcom = false;
      continue;
    }
    const c = s[i];
    if (WS.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      e.to(i + 2, COM);
      i += 2;
      bcom = true;
      continue;
    }
    if (c === '"' || c === "'") {
      const [j] = quoted(s, i, end, c);
      e.to(j, STR);
      i = j;
      continue;
    }
    if (c === "{") {
      e.to(i + 1, PUNC);
      i++;
      depth++;
      value = false;
      decl = null;
      continue;
    }
    if (c === "}") {
      e.to(i + 1, PUNC);
      i++;
      depth = Math.max(0, depth - 1);
      value = false;
      decl = null;
      continue;
    }
    if (c === ";") {
      e.to(i + 1, PUNC);
      i++;
      value = false;
      decl = null;
      continue;
    }
    if (c === "@") {
      const j = at(CSS_AT, s, i, end);
      if (j !== -1) {
        e.to(j, KW);
        i = j;
        continue;
      }
    }
    if (value) {
      if (c === "#") {
        const j = at(CSS_HEX, s, i, end);
        if (j !== -1) {
          e.to(j, NUM);
          i = j;
          continue;
        }
      }
      if (isDigit(c) || ((c === "-" || c === ".") && (isDigit(s[i + 1] ?? "") || s[i + 1] === "."))) {
        const j = at(CSS_NUM, s, i, end);
        if (j !== -1) {
          e.to(j, NUM);
          i = j;
          continue;
        }
      }
      if (c === "!") {
        const j = at(CSS_IMPORTANT, s, i, end);
        if (j !== -1) {
          e.to(j, KW);
          i = j;
          continue;
        }
      }
      const j = at(CSS_IDENT, s, i, end);
      if (j !== -1) {
        const word = s.slice(i, j);
        e.to(j, word.startsWith("--") ? VAR : s[j] === "(" ? FN : PLAIN);
        i = j;
        continue;
      }
      e.to(i + 1, ",()/".includes(c) ? PUNC : OP);
      i++;
      continue;
    }
    if (depth > 0) {
      if (decl === null) decl = declHere(i);
      if (decl) {
        const j = at(CSS_IDENT, s, i, end);
        if (j !== -1) {
          e.to(j, s.slice(i, j).startsWith("--") ? VAR : PROP);
          i = j;
          continue;
        }
        if (c === ":") {
          e.to(i + 1, PUNC);
          i++;
          value = true;
          continue;
        }
      }
    }
    // Selector context.
    if (c === ":") {
      const j = at(CSS_PSEUDO, s, i, end);
      e.to(j === -1 ? i + 1 : j, KW);
      i = j === -1 ? i + 1 : j;
      continue;
    }
    if (c === "," || c === ">" || c === "+" || c === "~" || c === "(" || c === ")" || c === "[" || c === "]" || c === "=" || c === "*" || c === "&") {
      e.to(i + 1, c === "," || c === "(" || c === ")" || c === "[" || c === "]" ? PUNC : OP);
      i++;
      continue;
    }
    const j = at(CSS_SEL, s, i, end);
    if (j !== -1) {
      e.to(j, SEL);
      i = j;
      continue;
    }
    e.to(i + 1, PLAIN);
    i++;
  }
  return { bcom, depth, value };
};

export const CSS_START: CssState = { bcom: false, depth: 0, value: false };
