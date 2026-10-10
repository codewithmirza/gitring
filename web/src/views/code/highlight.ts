/**
 * A small syntax highlighter for the code view: JavaScript, TypeScript (also JSX and TSX), JSON, CSS,
 * HTML, Markdown, Python and Go. No packages.
 *
 * It works one line at a time and carries a state from line to line (block comments, template
 * strings, triple-quoted strings, JSX children, code fences in Markdown, <script> in HTML), so a file
 * can be highlighted in small steps and only the lines on screen need tokens.
 *
 * Tokens of a line are a flat number array: [end0, class0, end1, class1, …]. Text before end0 has
 * class0, and so on. Class 0 is plain text. CLASS_NAMES maps a class to its CSS class.
 */

export const CLASS_NAMES = [
  "",
  "tk-com",
  "tk-str",
  "tk-num",
  "tk-kw",
  "tk-lit",
  "tk-type",
  "tk-fn",
  "tk-prop",
  "tk-op",
  "tk-punc",
  "tk-tag",
  "tk-attr",
  "tk-re",
  "tk-head",
  "tk-em",
  "tk-strong",
  "tk-code",
  "tk-link",
  "tk-key",
  "tk-sel",
  "tk-var",
  "tk-esc",
  "tk-meta",
] as const;

const PLAIN = 0;
const COM = 1;
const STR = 2;
const NUM = 3;
const KW = 4;
const LIT = 5;
const TYPE = 6;
const FN = 7;
const PROP = 8;
const OP = 9;
const PUNC = 10;
const TAG = 11;
const ATTR = 12;
const RE = 13;
const HEAD = 14;
const EM = 15;
const STRONG = 16;
const CODE = 17;
const LINK = 18;
const KEY = 19;
const SEL = 20;
const VAR = 21;
const ESC = 22;
const META = 23;

export type Lang = "js" | "ts" | "json" | "css" | "html" | "md" | "py" | "go";

export interface LangInfo {
  lang: Lang;
  /** JSX in .js, .jsx, .mjs and .tsx files. */
  jsx: boolean;
}

const EXT: Record<string, LangInfo> = {
  js: { lang: "js", jsx: true },
  mjs: { lang: "js", jsx: true },
  cjs: { lang: "js", jsx: false },
  jsx: { lang: "js", jsx: true },
  ts: { lang: "ts", jsx: false },
  mts: { lang: "ts", jsx: false },
  cts: { lang: "ts", jsx: false },
  tsx: { lang: "ts", jsx: true },
  json: { lang: "json", jsx: false },
  jsonc: { lang: "json", jsx: false },
  json5: { lang: "json", jsx: false },
  webmanifest: { lang: "json", jsx: false },
  css: { lang: "css", jsx: false },
  html: { lang: "html", jsx: false },
  htm: { lang: "html", jsx: false },
  svg: { lang: "html", jsx: false },
  xml: { lang: "html", jsx: false },
  md: { lang: "md", jsx: false },
  markdown: { lang: "md", jsx: false },
  mdx: { lang: "md", jsx: false },
  py: { lang: "py", jsx: false },
  pyi: { lang: "py", jsx: false },
  go: { lang: "go", jsx: false },
};

const FENCE_LANG: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  golang: "go",
  shell: "",
  bash: "",
  sh: "",
};

/** The language of a file, from its name (the server's `lang` is a fallback). null: plain text. */
export function languageOf(path: string, lang?: string): LangInfo | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "tsconfig.json" || base === "jsconfig.json" || base.endsWith(".code-workspace")) return EXT.jsonc;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return EXT[ext] ?? (lang ? EXT[lang.toLowerCase()] ?? null : null);
}

/* ───────────── output ───────────── */

class Emit {
  t: number[] = [];
  at = 0;
  constructor(readonly s: string) {}
  /** Text from `at` to `end` has class `cls`. */
  to(end: number, cls: number) {
    if (end <= this.at) return;
    const n = this.t.length;
    if (n && this.t[n - 1] === cls) this.t[n - 2] = end;
    else this.t.push(end, cls);
    this.at = end;
  }
}

type LineFn<S> = (s: string, from: number, end: number, state: S, e: Emit) => S;

export interface Highlighter<S = unknown> {
  start: S;
  line(text: string, state: S): { tokens: number[]; state: S };
}

/** Longer lines (minified code) get tokens for this many characters; the rest stays plain. */
const MAX_LINE = 4000;

function make<S>(start: S, fn: LineFn<S>): Highlighter<S> {
  return {
    start,
    line(text, state) {
      const e = new Emit(text);
      const end = Math.min(text.length, MAX_LINE);
      const next = fn(text, 0, end, state, e);
      e.to(text.length, PLAIN);
      return { tokens: e.t, state: next };
    },
  };
}

/* ───────────── shared scanners ───────────── */

const isIdStart = (c: string) => /[A-Za-z_$À-￿]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";
const WS = /\s/;

function sticky(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("y") ? re.flags : re.flags + "y");
}

/** Match a sticky regex at `i` (within `end`); returns the end index or -1. */
function at(re: RegExp, s: string, i: number, end: number): number {
  re.lastIndex = i;
  const m = re.exec(s);
  if (!m || m.index !== i) return -1;
  return Math.min(i + m[0].length, end);
}

/** A quoted string from `i` (the quote) to the closing quote or the end. Returns [end, closed]. */
function quoted(s: string, i: number, end: number, q: string): [number, boolean] {
  for (let j = i + 1; j < end; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === q) return [j + 1, true];
  }
  return [end, false];
}

function nextNonSpace(s: string, i: number, end: number): number {
  while (i < end && WS.test(s[i])) i++;
  return i;
}

/* ───────────── JavaScript and TypeScript ───────────── */

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

interface JsState {
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

function jsLine(ts: boolean, jsx: boolean): LineFn<JsState> {
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

/* ───────────── JSON ───────────── */

const JSON_NUM = sticky(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);

const jsonLine: LineFn<boolean> = (s, from, end, bcom, e) => {
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

/* ───────────── CSS ───────────── */

interface CssState {
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

const cssLine: LineFn<CssState> = (s, from, end, st, e) => {
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

/* ───────────── HTML ───────────── */

interface HtmlState {
  mode: "text" | "comment" | "tag" | "script" | "style";
  tag: string;
  /** Inside an attribute value that spans lines. */
  quote: string;
  sub: unknown;
}

const HTML_NAME = sticky(/[A-Za-z][\w:.-]*/);
const HTML_ATTR = sticky(/[^\s"'>/=]+/);
const HTML_UNQUOTED = sticky(/[^\s>]+/);
const HTML_ENT = sticky(/&(?:[A-Za-z][\w]*|#\d+|#x[\da-fA-F]+);/);

const JS_EMBED = jsLine(false, false);
const JS_START: JsState = { stack: [], ex: true };
const CSS_START: CssState = { bcom: false, depth: 0, value: false };

const htmlLine: LineFn<HtmlState> = (s, from, end, st, e) => {
  let { mode, tag, quote, sub } = st;
  let i = from;
  let afterEq = false;
  while (i < end) {
    if (mode === "comment") {
      const j = s.indexOf("-->", i);
      if (j === -1 || j >= end) {
        e.to(end, COM);
        return { mode, tag, quote, sub };
      }
      e.to(j + 3, COM);
      i = j + 3;
      mode = "text";
      continue;
    }
    if (mode === "script" || mode === "style") {
      const close = s.slice(i, end).search(mode === "script" ? /<\/script/i : /<\/style/i);
      const stop = close === -1 ? end : i + close;
      if (stop > i) sub = mode === "script" ? JS_EMBED(s, i, stop, (sub as JsState) ?? JS_START, e) : cssLine(s, i, stop, (sub as CssState) ?? CSS_START, e);
      i = stop;
      if (close !== -1) {
        mode = "text";
        sub = null;
      }
      continue;
    }
    if (mode === "tag") {
      if (quote) {
        const j = s.indexOf(quote, i);
        if (j === -1 || j >= end) {
          e.to(end, STR);
          return { mode, tag, quote, sub };
        }
        e.to(j + 1, STR);
        i = j + 1;
        quote = "";
        continue;
      }
      const c = s[i];
      if (WS.test(c)) {
        i++;
        continue;
      }
      if (c === "/" && s[i + 1] === ">") {
        e.to(i + 2, PUNC);
        i += 2;
        mode = "text";
        continue;
      }
      if (c === ">") {
        e.to(i + 1, PUNC);
        i++;
        const t = tag.toLowerCase();
        mode = t === "script" ? "script" : t === "style" ? "style" : "text";
        sub = mode === "script" ? JS_START : mode === "style" ? CSS_START : null;
        continue;
      }
      if (c === "=") {
        e.to(i + 1, OP);
        i++;
        afterEq = true;
        continue;
      }
      if (c === '"' || c === "'") {
        afterEq = false;
        const j = s.indexOf(c, i + 1);
        if (j === -1 || j >= end) {
          e.to(end, STR);
          quote = c;
          return { mode, tag, quote, sub };
        }
        e.to(j + 1, STR);
        i = j + 1;
        continue;
      }
      if (afterEq) {
        afterEq = false;
        const j = at(HTML_UNQUOTED, s, i, end);
        e.to(j === -1 ? i + 1 : j, STR);
        i = j === -1 ? i + 1 : j;
        continue;
      }
      const j = at(HTML_ATTR, s, i, end);
      e.to(j === -1 ? i + 1 : j, ATTR);
      i = j === -1 ? i + 1 : j;
      continue;
    }
    // Text.
    const c = s[i];
    if (c === "<") {
      if (s.startsWith("<!--", i)) {
        e.to(i + 4, COM);
        i += 4;
        mode = "comment";
        continue;
      }
      if (s[i + 1] === "!" || s[i + 1] === "?") {
        const j = s.indexOf(">", i);
        e.to(j === -1 || j >= end ? end : j + 1, META);
        i = j === -1 || j >= end ? end : j + 1;
        continue;
      }
      const closing = s[i + 1] === "/";
      const ne = at(HTML_NAME, s, i + (closing ? 2 : 1), end);
      if (ne !== -1) {
        e.to(i + (closing ? 2 : 1), PUNC);
        e.to(ne, TAG);
        tag = closing ? "" : s.slice(i + 1, ne);
        i = ne;
        mode = "tag";
        continue;
      }
    }
    if (c === "&") {
      const j = at(HTML_ENT, s, i, end);
      if (j !== -1) {
        e.to(j, ESC);
        i = j;
        continue;
      }
    }
    let j = i + 1;
    while (j < end && s[j] !== "<" && s[j] !== "&") j++;
    e.to(j, PLAIN);
    i = j;
  }
  return { mode, tag, quote, sub };
};

/* ───────────── Markdown ───────────── */

interface MdState {
  fence: { marker: string; size: number; hl: Highlighter | null; sub: unknown } | null;
}

const MD_FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)/;

function mdInline(s: string, from: number, end: number, e: Emit) {
  let i = from;
  while (i < end) {
    const c = s[i];
    if (c === "\\" && i + 1 < end && /[\\`*_{}[\]()#+\-.!|<>~]/.test(s[i + 1])) {
      e.to(i + 2, ESC);
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const tick = "`".repeat(n);
      const j = s.indexOf(tick, i + n);
      if (j !== -1 && j < end) {
        e.to(j + n, CODE);
        i = j + n;
        continue;
      }
      e.to(i + n, PLAIN);
      i += n;
      continue;
    }
    if ((c === "*" || c === "_") && s[i + 1] === c) {
      const j = s.indexOf(c + c, i + 2);
      if (j !== -1 && j < end && j > i + 2) {
        e.to(j + 2, STRONG);
        i = j + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] !== " " && s[i + 1] !== c) {
      const wordStart = i === 0 || /[\s([{>"'*_~]/.test(s[i - 1]);
      if (c === "*" || wordStart) {
        const j = s.indexOf(c, i + 1);
        if (j !== -1 && j < end && j > i + 1 && s[j - 1] !== " ") {
          e.to(j + 1, EM);
          i = j + 1;
          continue;
        }
      }
    }
    if (c === "[" || (c === "!" && s[i + 1] === "[")) {
      const open = c === "!" ? i + 1 : i;
      const close = s.indexOf("]", open + 1);
      if (close !== -1 && close < end && (s[close + 1] === "(" || s[close + 1] === "[")) {
        const endCh = s[close + 1] === "(" ? ")" : "]";
        const j = s.indexOf(endCh, close + 2);
        if (j !== -1 && j < end) {
          e.to(open + 1, PUNC);
          e.to(close, LINK);
          e.to(close + 2, PUNC);
          e.to(j, STR);
          e.to(j + 1, PUNC);
          i = j + 1;
          continue;
        }
      }
    }
    if (c === "<") {
      const j = at(sticky(/<(?:https?:\/\/[^\s>]+|[\w.+-]+@[\w.-]+)>/), s, i, end);
      if (j !== -1) {
        e.to(j, LINK);
        i = j;
        continue;
      }
      const t = at(sticky(/<\/?[A-Za-z][\w-]*(?:\s[^>]*)?\/?>/), s, i, end);
      if (t !== -1) {
        e.to(t, TAG);
        i = t;
        continue;
      }
    }
    if (c === "h" && (s.startsWith("http://", i) || s.startsWith("https://", i))) {
      const j = at(sticky(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/), s, i, end);
      if (j !== -1) {
        e.to(j, LINK);
        i = j;
        continue;
      }
    }
    let j = i + 1;
    while (j < end && !"\\`*_[!<h".includes(s[j])) j++;
    e.to(j, PLAIN);
    i = j;
  }
}

const mdLine: LineFn<MdState> = (s, from, end, st, e) => {
  const fence = st.fence;
  if (fence) {
    const m = MD_FENCE.exec(s);
    // A closing fence has the same marker, at least as long, and no info string.
    if (m && m[2][0] === fence.marker && m[2].length >= fence.size && !m[3] && !s.slice(m[0].length).trim()) {
      e.to(end, META);
      return { fence: null };
    }
    if (!fence.hl) {
      e.to(end, CODE);
      return st;
    }
    const r = fence.hl.line(s.slice(0, end), fence.sub);
    // Copy the inner tokens.
    for (let k = 0; k < r.tokens.length; k += 2) e.to(r.tokens[k], r.tokens[k + 1]);
    return { fence: { ...fence, sub: r.state } };
  }
  const m = MD_FENCE.exec(s);
  if (m) {
    e.to(end, META);
    const name = m[3].toLowerCase();
    const mapped = FENCE_LANG[name] ?? name;
    const info = mapped ? languageOf(`x.${mapped}`) : null;
    const hl = info ? highlighterFor(info) : null;
    return { fence: { marker: m[2][0], size: m[2].length, hl, sub: hl?.start ?? null } };
  }
  if (/^\s{0,3}#{1,6}(\s|$)/.test(s)) {
    e.to(end, HEAD);
    return st;
  }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(s) || /^\s{0,3}=+\s*$/.test(s)) {
    e.to(end, PUNC);
    return st;
  }
  let i = from;
  const quote = /^\s{0,3}(>\s?)+/.exec(s);
  if (quote) {
    e.to(quote[0].length, PUNC);
    i = quote[0].length;
  }
  const list = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s+\[[ xX]\])?\s+/.exec(s.slice(i));
  if (list) {
    e.to(i + list[0].length, PUNC);
    i += list[0].length;
  }
  mdInline(s, i, end, e);
  return st;
};

/* ───────────── Python ───────────── */

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

interface PyState {
  tq: string;
}

const pyLine: LineFn<PyState> = (s, from, end, st, e) => {
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

/* ───────────── Go ───────────── */

const GO_KW = new Set(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var".split(" "),
);
const GO_TYPES = new Set(
  "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable".split(" "),
);
const GO_LIT = new Set(["true", "false", "nil", "iota"]);
const GO_NUM = sticky(/(?:0[xX][\da-fA-F_]+(?:\.[\da-fA-F_]*)?(?:[pP][+-]?\d+)?|0[bB][01_]+|0[oO]?[0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)i?/);
const GO_ID = sticky(/[A-Za-z_À-￿][\wÀ-￿]*/);

interface GoState {
  bcom: boolean;
  raw: boolean;
}

const goLine: LineFn<GoState> = (s, from, end, st, e) => {
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

/* ───────────── registry ───────────── */

const cache = new Map<string, Highlighter>();

/** The highlighter for a language (null for plain text). */
export function highlighterFor(info: LangInfo | null): Highlighter | null {
  if (!info) return null;
  const key = `${info.lang}${info.jsx ? "x" : ""}`;
  let h = cache.get(key);
  if (h) return h;
  switch (info.lang) {
    case "js":
    case "ts":
      h = make<JsState>({ stack: [], ex: true }, jsLine(info.lang === "ts", info.jsx)) as Highlighter;
      break;
    case "json":
      h = make<boolean>(false, jsonLine) as Highlighter;
      break;
    case "css":
      h = make<CssState>(CSS_START, cssLine) as Highlighter;
      break;
    case "html":
      h = make<HtmlState>({ mode: "text", tag: "", quote: "", sub: null }, htmlLine) as Highlighter;
      break;
    case "md":
      h = make<MdState>({ fence: null }, mdLine) as Highlighter;
      break;
    case "py":
      h = make<PyState>({ tq: "" }, pyLine) as Highlighter;
      break;
    case "go":
      h = make<GoState>({ bcom: false, raw: false }, goLine) as Highlighter;
      break;
    default:
      return null;
  }
  cache.set(key, h);
  return h;
}

/** Tokens for all lines at once (tests and small files). */
export function tokenizeAll(info: LangInfo | null, lines: readonly string[]): number[][] {
  const hl = highlighterFor(info);
  if (!hl) return lines.map((l) => (l.length ? [l.length, PLAIN] : []));
  let st = hl.start;
  return lines.map((l) => {
    const r = hl.line(l, st);
    st = r.state;
    return r.tokens;
  });
}

/** Text runs of a tokenized line, for rendering and tests: [[text, className], …]. */
export function runsOf(text: string, tokens: readonly number[] | undefined): [string, string][] {
  if (!tokens || !tokens.length) return text ? [[text, ""]] : [];
  const out: [string, string][] = [];
  let p = 0;
  for (let k = 0; k < tokens.length; k += 2) {
    const end = tokens[k];
    if (end > p) out.push([text.slice(p, end), CLASS_NAMES[tokens[k + 1]] ?? ""]);
    p = end;
  }
  if (p < text.length) out.push([text.slice(p), ""]);
  return out;
}

/**
 * Highlights the lines of one file in small steps (so a large file never blocks the page): run() does
 * work for a time budget and says if more is left. Lines without tokens yet render as plain text.
 */
export class LineHighlighter {
  readonly tokens: (number[] | undefined)[];
  private state: unknown;
  private next = 0;

  constructor(
    readonly lines: readonly string[],
    private readonly hl: Highlighter,
  ) {
    this.tokens = new Array(lines.length);
    this.state = hl.start;
  }

  /** Lines with tokens: 0 … done-1. */
  get done(): number {
    return this.next;
  }

  get finished(): boolean {
    return this.next >= this.lines.length;
  }

  /** Tokenize until `budgetMs` is used or line `upTo` is done. Returns true when lines are left. */
  run(budgetMs: number, upTo = this.lines.length): boolean {
    const stop = Math.min(upTo, this.lines.length);
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    while (this.next < stop) {
      const r = this.hl.line(this.lines[this.next], this.state);
      this.tokens[this.next] = r.tokens;
      this.state = r.state;
      this.next++;
      if ((this.next & 31) === 0) {
        const t = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (t - t0 > budgetMs) break;
      }
    }
    return this.next < this.lines.length;
  }
}
