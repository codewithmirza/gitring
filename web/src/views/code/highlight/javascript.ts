/**
 * The line scanner for JavaScript and TypeScript, with JSX.
 * One state carries template strings and JSX nesting from line to line. It is one state machine, so it stays in one file.
 * HTML uses it for <script> blocks.
 */
import { ATTR, COM, FN, KW, LIT, META, NUM, OP, PLAIN, PROP, PUNC, RE, STR, TAG, TYPE } from "./classes";
import type { LineFn } from "./emit";
import { at, isDigit, isIdStart, nextNonSpace, quoted, sticky, WS } from "./scanners";

const JS_KW = new Set(
  "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await get set from as".split(
    " ",
  ),
);
const TS_KW = new Set([
  ...JS_KW,
  ..."abstract asserts declare enum implements infer interface is keyof module namespace override private protected public readonly satisfies type unique accessor out".split(" "),
]);
const JS_LIT = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
const TS_TYPES = new Set(["string", "number", "boolean", "any", "unknown", "never", "void", "object", "symbol", "bigint"]);
/** After these words an expression starts: a "/" is a regex and a "<" opens JSX. */
const EXPR_KW = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends", "default"]);

type JsFrame =
  | { k: "bcom" }
  | { k: "tpl" }
  | { k: "expr"; depth: number }
  | { k: "jsxTag"; closing: boolean }
  | { k: "jsxText" }
  | { k: "jsxExpr"; depth: number };

export interface JsState {
  stack: JsFrame[];
  /** The next token may start an expression. */
  ex: boolean;
}

const JS_NUM = sticky(/(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/);
const JS_ID = sticky(/[A-Za-z_$À-￿][\w$À-￿]*/);
const JS_RE = sticky(/\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuyv]*/);
const JS_OP = sticky(/(?:=>|\?\?=|\?\?|\?\.|\.\.\.|\*\*=|>>>=|>>=|<<=|&&=|\|\|=|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|[-+*%&|^]=|<<|>>>?|[=+\-*%&|^!~?:<>])/);
const JSX_NAME = sticky(/[A-Za-z_$][\w$.:-]*/);
const JSX_ATTR = sticky(/[A-Za-z_$][\w$:-]*/);

export function jsLine(ts: boolean, jsx: boolean): LineFn<JsState> {
  const KWS = ts ? TS_KW : JS_KW;
  return (s, from, end, state, e) => {
    const stack = state.stack.slice();
    let ex = state.ex;
    let i = from;
    const top = () => stack[stack.length - 1] as JsFrame | undefined;

    /** "<" at i in an expression position: open or close a JSX element. Returns false when it is not JSX. */
    const jsxOpen = (): boolean => {
      const c1 = s[i + 1];
      if (c1 === ">") {
        e.to(i + 2, PUNC);
        i += 2;
        stack.push({ k: "jsxText" });
        return true;
      }
      if (c1 === "/") {
        // Closing tag.
        e.to(i + 2, PUNC);
        i += 2;
        const ne = at(JSX_NAME, s, i, end);
        if (ne !== -1) {
          e.to(ne, TAG);
          i = ne;
        }
        stack.push({ k: "jsxTag", closing: true });
        return true;
      }
      if (c1 && /[A-Za-z_$]/.test(c1)) {
        e.to(i + 1, PUNC);
        i += 1;
        const ne = at(JSX_NAME, s, i, end);
        e.to(ne, TAG);
        i = ne;
        stack.push({ k: "jsxTag", closing: false });
        return true;
      }
      return false;
    };

    while (i < end) {
      const f = top();
      const c = s[i];

      if (f?.k === "bcom") {
        const j = s.indexOf("*/", i);
        if (j === -1 || j >= end) {
          e.to(end, COM);
          i = end;
          break;
        }
        e.to(j + 2, COM);
        i = j + 2;
        stack.pop();
        continue;
      }

      if (f?.k === "tpl") {
        let j = i;
        let done = false;
        for (; j < end; j++) {
          const d = s[j];
          if (d === "\\") {
            j++;
            continue;
          }
          if (d === "`") {
            e.to(j + 1, STR);
            stack.pop();
            i = j + 1;
            ex = false;
            done = true;
            break;
          }
          if (d === "$" && s[j + 1] === "{") {
            e.to(j, STR);
            e.to(j + 2, PUNC);
            stack.push({ k: "expr", depth: 0 });
            i = j + 2;
            ex = true;
            done = true;
            break;
          }
        }
        if (!done) {
          e.to(end, STR);
          i = end;
        }
        continue;
      }

      if (f?.k === "jsxText") {
        let j = i;
        while (j < end && s[j] !== "<" && s[j] !== "{") j++;
        e.to(j, PLAIN);
        i = j;
        if (i >= end) break;
        if (s[i] === "{") {
          e.to(i + 1, PUNC);
          i++;
          stack.push({ k: "jsxExpr", depth: 0 });
          ex = true;
          continue;
        }
        // "<": a child element, or the closing tag of this element.
        if (s[i + 1] === "/") {
          stack.pop(); // the children end here
          e.to(i + 2, PUNC);
          i += 2;
          const ne = at(JSX_NAME, s, i, end);
          if (ne !== -1) {
            e.to(ne, TAG);
            i = ne;
          }
          stack.push({ k: "jsxTag", closing: true });
          continue;
        }
        if (!jsxOpen()) {
          e.to(i + 1, PLAIN);
          i++;
        }
        continue;
      }

      if (f?.k === "jsxTag") {
        if (WS.test(c)) {
          i++;
          continue;
        }
        if (c === "/" && s[i + 1] === ">") {
          e.to(i + 2, PUNC);
          i += 2;
          stack.pop();
          ex = false;
          continue;
        }
        if (c === ">") {
          e.to(i + 1, PUNC);
          i++;
          const closing = f.closing;
          stack.pop();
          if (!closing) stack.push({ k: "jsxText" });
          ex = false;
          continue;
        }
        if (c === "{") {
          e.to(i + 1, PUNC);
          i++;
          stack.push({ k: "jsxExpr", depth: 0 });
          ex = true;
          continue;
        }
        if (c === '"' || c === "'") {
          const [j] = quoted(s, i, end, c);
          e.to(j, STR);
          i = j;
          continue;
        }
        if (c === "=") {
          e.to(i + 1, OP);
          i++;
          continue;
        }
        const ae = at(JSX_ATTR, s, i, end);
        if (ae !== -1) {
          e.to(ae, ATTR);
          i = ae;
          continue;
        }
        e.to(i + 1, PLAIN);
        i++;
        continue;
      }

      // Code: the top level, ${…} in a template, or {…} in JSX.
      if (WS.test(c)) {
        i++;
        continue;
      }
      if (c === "/" && s[i + 1] === "/") {
        e.to(end, COM);
        i = end;
        break;
      }
      if (c === "/" && s[i + 1] === "*") {
        const j = s.indexOf("*/", i + 2);
        if (j === -1 || j >= end) {
          stack.push({ k: "bcom" });
          e.to(end, COM);
          i = end;
          break;
        }
        e.to(j + 2, COM);
        i = j + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        const [j] = quoted(s, i, end, c);
        e.to(j, STR);
        i = j;
        ex = false;
        continue;
      }
      if (c === "`") {
        e.to(i + 1, STR);
        i++;
        stack.push({ k: "tpl" });
        continue;
      }
      if (isDigit(c) || (c === "." && isDigit(s[i + 1] ?? ""))) {
        const j = at(JS_NUM, s, i, end);
        e.to(j === -1 ? i + 1 : j, NUM);
        i = j === -1 ? i + 1 : j;
        ex = false;
        continue;
      }
      if (c === "#" && i === 0 && s[1] === "!") {
        e.to(end, COM);
        i = end;
        break;
      }
      if (isIdStart(c) || (c === "#" && isIdStart(s[i + 1] ?? ""))) {
        const j = at(JS_ID, s, c === "#" ? i + 1 : i, end);
        const word = s.slice(c === "#" ? i + 1 : i, j);
        let p = i - 1;
        while (p >= from && s[p] === " ") p--;
        const afterDot = p >= from && s[p] === "." && s[p - 1] !== ".";
        const n = nextNonSpace(s, j, end);
        const call = s[n] === "(" || (s[n] === "?" && s[n + 1] === "." && s[n + 2] === "(");
        let cls = PLAIN;
        if (afterDot) cls = call ? FN : PROP;
        else if (KWS.has(word) && !(s[n] === ":" && f?.k !== "jsxExpr" && word !== "default")) cls = KW;
        else if (JS_LIT.has(word)) cls = LIT;
        else if (call) cls = FN;
        else if (ts && TS_TYPES.has(word)) cls = TYPE;
        else if (/^[A-Z]/.test(word)) cls = TYPE;
        e.to(j, cls);
        i = j;
        ex = cls === KW && EXPR_KW.has(word);
        continue;
      }
      if (c === "@" && isIdStart(s[i + 1] ?? "")) {
        const j = at(JS_ID, s, i + 1, end);
        e.to(j, META);
        i = j;
        continue;
      }
      if (c === "{") {
        if (f && (f.k === "expr" || f.k === "jsxExpr")) f.depth++;
        e.to(i + 1, PUNC);
        i++;
        ex = true;
        continue;
      }
      if (c === "}") {
        if (f && (f.k === "expr" || f.k === "jsxExpr")) {
          if (f.depth === 0) {
            stack.pop();
            e.to(i + 1, PUNC);
            i++;
            ex = false;
            continue;
          }
          stack[stack.length - 1] = { ...f, depth: f.depth - 1 };
        }
        e.to(i + 1, PUNC);
        i++;
        ex = false;
        continue;
      }
      if (c === "(" || c === "[" || c === "," || c === ";") {
        e.to(i + 1, PUNC);
        i++;
        ex = true;
        continue;
      }
      if (c === ")" || c === "]") {
        e.to(i + 1, PUNC);
        i++;
        ex = false;
        continue;
      }
      if (c === "." && s[i + 1] !== "." && !isDigit(s[i + 1] ?? "")) {
        e.to(i + 1, PUNC);
        i++;
        ex = false;
        continue;
      }
      if (c === "/" && ex) {
        const j = at(JS_RE, s, i, end);
        if (j !== -1) {
          e.to(j, RE);
          i = j;
          ex = false;
          continue;
        }
      }
      if (c === "<" && jsx && ex && jsxOpen()) continue;
      const oe = at(JS_OP, s, i, end);
      if (oe !== -1) {
        e.to(oe, OP);
        i = oe;
        ex = true;
        continue;
      }
      e.to(i + 1, PLAIN);
      i++;
    }
    // Strings and regexes do not span lines (template strings do).
    return { stack, ex };
  };
}

export const JS_START: JsState = { stack: [], ex: true };
