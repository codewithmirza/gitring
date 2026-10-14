/**
 * The line scanner for Python: keywords, built-ins, strings (also triple-quoted), numbers and comments.
 */
import { COM, FN, KW, LIT, META, NUM, OP, PLAIN, PROP, PUNC, STR, TYPE, VAR } from "./classes";
import type { LineFn } from "./emit";
import { at, isDigit, isIdStart, nextNonSpace, quoted, sticky, WS } from "./scanners";

const PY_KW = new Set(
  "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(
    " ",
  ),
);
const PY_LIT = new Set(["True", "False", "None", "NotImplemented", "Ellipsis", "__debug__"]);
const PY_BUILTIN = new Set(
  "abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip".split(
    " ",
  ),
);
const PY_NUM = sticky(/(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[jJ]?/);
const PY_ID = sticky(/[A-Za-z_À-￿][\wÀ-￿]*/);
const PY_STR = sticky(/(?:[rRbBuUfF]{1,2})?(?:"""|'''|"|')/);

export interface PyState {
  tq: string;
}

export const pyLine: LineFn<PyState> = (s, from, end, st, e) => {
  let tq = st.tq;
  let i = from;
  let after = ""; // the keyword before this word (def, class)
  while (i < end) {
    if (tq) {
      const j = s.indexOf(tq, i);
      if (j === -1 || j >= end) {
        e.to(end, STR);
        return { tq };
      }
      e.to(j + 3, STR);
      i = j + 3;
      tq = "";
      continue;
    }
    const c = s[i];
    if (WS.test(c)) {
      i++;
      continue;
    }
    if (c === "#") {
      e.to(end, COM);
      return { tq };
    }
    const sq = at(PY_STR, s, i, end);
    if (sq !== -1) {
      const q = s.slice(i, sq).replace(/^[rRbBuUfF]+/, "");
      if (q.length === 3) {
        const j = s.indexOf(q, sq);
        if (j === -1 || j >= end) {
          e.to(end, STR);
          return { tq: q };
        }
        e.to(j + 3, STR);
        i = j + 3;
      } else {
        const [j] = quoted(s, sq - 1, end, q);
        e.to(j, STR);
        i = j;
      }
      after = "";
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(s[i + 1] ?? ""))) {
      const j = at(PY_NUM, s, i, end);
      e.to(j === -1 ? i + 1 : j, NUM);
      i = j === -1 ? i + 1 : j;
      continue;
    }
    if (c === "@" && s.slice(from, i).trim() === "") {
      const j = at(sticky(/@[\w.]+/), s, i, end);
      e.to(j === -1 ? i + 1 : j, META);
      i = j === -1 ? i + 1 : j;
      continue;
    }
    if (isIdStart(c)) {
      const j = at(PY_ID, s, i, end);
      const word = s.slice(i, j);
      const n = nextNonSpace(s, j, end);
      let p = i - 1;
      while (p >= from && s[p] === " ") p--;
      const afterDot = p >= from && s[p] === ".";
      let cls = PLAIN;
      if (after === "def") cls = FN;
      else if (after === "class") cls = TYPE;
      else if (afterDot) cls = s[n] === "(" ? FN : PROP;
      else if (PY_KW.has(word)) cls = KW;
      else if (PY_LIT.has(word)) cls = LIT;
      else if (word === "self" || word === "cls") cls = VAR;
      else if (s[n] === "(") cls = PY_BUILTIN.has(word) ? FN : /^[A-Z]/.test(word) ? TYPE : FN;
      else if (/^[A-Z][a-z]/.test(word)) cls = TYPE;
      e.to(j, cls);
      after = word === "def" || word === "class" ? word : "";
      i = j;
      continue;
    }
    after = "";
    e.to(i + 1, "()[]{},:;.".includes(c) ? PUNC : OP);
    i++;
  }
  return { tq };
};
