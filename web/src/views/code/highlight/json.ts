/**
 * The line scanner for JSON: keys, strings, numbers and the three literals.
 */
import { COM, KEY, LIT, NUM, PLAIN, PUNC, STR } from "./classes";
import type { LineFn } from "./emit";
import { at, isDigit, nextNonSpace, quoted, sticky, WS } from "./scanners";

const JSON_NUM = sticky(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);

export const jsonLine: LineFn<boolean> = (s, from, end, bcom, e) => {
  let i = from;
  while (i < end) {
    if (bcom) {
      const j = s.indexOf("*/", i);
      if (j === -1 || j >= end) {
        e.to(end, COM);
        return true;
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
    if (c === "/" && s[i + 1] === "/") {
      e.to(end, COM);
      return false;
    }
    if (c === "/" && s[i + 1] === "*") {
      e.to(i + 2, COM);
      i += 2;
      bcom = true;
      continue;
    }
    if (c === '"') {
      const [j] = quoted(s, i, end, '"');
      const n = nextNonSpace(s, j, end);
      e.to(j, s[n] === ":" ? KEY : STR);
      i = j;
      continue;
    }
    if (c === "-" || isDigit(c)) {
      const j = at(JSON_NUM, s, i, end);
      e.to(j === -1 ? i + 1 : j, NUM);
      i = j === -1 ? i + 1 : j;
      continue;
    }
    if (s.startsWith("true", i) || s.startsWith("null", i)) {
      e.to(i + 4, LIT);
      i += 4;
      continue;
    }
    if (s.startsWith("false", i)) {
      e.to(i + 5, LIT);
      i += 5;
      continue;
    }
    e.to(i + 1, "{}[]:,".includes(c) ? PUNC : PLAIN);
    i++;
  }
  return bcom;
};
