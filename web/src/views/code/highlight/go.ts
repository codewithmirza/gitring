/**
 * The line scanner for Go: keywords, types, strings (also raw strings), numbers and comments.
 */
import { COM, FN, KW, LIT, NUM, OP, PLAIN, PROP, PUNC, STR, TYPE } from "./classes";
import type { LineFn } from "./emit";
import { at, isDigit, isIdStart, nextNonSpace, quoted, sticky, WS } from "./scanners";

const GO_KW = new Set(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var".split(" "),
);
const GO_TYPES = new Set(
  "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable".split(" "),
);
const GO_LIT = new Set(["true", "false", "nil", "iota"]);
const GO_NUM = sticky(/(?:0[xX][\da-fA-F_]+(?:\.[\da-fA-F_]*)?(?:[pP][+-]?\d+)?|0[bB][01_]+|0[oO]?[0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)i?/);
const GO_ID = sticky(/[A-Za-z_À-￿][\wÀ-￿]*/);

export interface GoState {
  bcom: boolean;
  raw: boolean;
}

export const goLine: LineFn<GoState> = (s, from, end, st, e) => {
  let { bcom, raw } = st;
  let i = from;
  let afterFunc = false;
  while (i < end) {
    if (bcom) {
      const j = s.indexOf("*/", i);
      if (j === -1 || j >= end) {
        e.to(end, COM);
        return { bcom, raw };
      }
      e.to(j + 2, COM);
      i = j + 2;
      bcom = false;
      continue;
    }
    if (raw) {
      const j = s.indexOf("`", i);
      if (j === -1 || j >= end) {
        e.to(end, STR);
        return { bcom, raw };
      }
      e.to(j + 1, STR);
      i = j + 1;
      raw = false;
      continue;
    }
    const c = s[i];
    if (WS.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      e.to(end, COM);
      return { bcom, raw };
    }
    if (c === "/" && s[i + 1] === "*") {
      e.to(i + 2, COM);
      i += 2;
      bcom = true;
      continue;
    }
    if (c === "`") {
      e.to(i + 1, STR);
      i++;
      raw = true;
      continue;
    }
    if (c === '"' || c === "'") {
      const [j] = quoted(s, i, end, c);
      e.to(j, STR);
      i = j;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(s[i + 1] ?? ""))) {
      const j = at(GO_NUM, s, i, end);
      e.to(j === -1 ? i + 1 : j, NUM);
      i = j === -1 ? i + 1 : j;
      continue;
    }
    if (isIdStart(c)) {
      const j = at(GO_ID, s, i, end);
      const word = s.slice(i, j);
      const n = nextNonSpace(s, j, end);
      let p = i - 1;
      while (p >= from && s[p] === " ") p--;
      const afterDot = p >= from && s[p] === ".";
      let cls = PLAIN;
      if (afterDot) cls = s[n] === "(" ? FN : PROP;
      else if (GO_KW.has(word)) cls = KW;
      else if (GO_LIT.has(word)) cls = LIT;
      else if (GO_TYPES.has(word)) cls = TYPE;
      else if (afterFunc || s[n] === "(") cls = FN;
      else if (/^[A-Z]/.test(word) && (s[n] === "{" || s[n] === ")" || s[n] === "," || n >= end)) cls = TYPE;
      e.to(j, cls);
      afterFunc = word === "func";
      i = j;
      continue;
    }
    afterFunc = false;
    e.to(i + 1, "()[]{},;.:".includes(c) ? PUNC : OP);
    i++;
  }
  return { bcom, raw };
};
