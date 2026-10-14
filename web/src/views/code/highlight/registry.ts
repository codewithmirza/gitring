/**
 * Picks the highlighter for a language, and holds the Markdown scanner (headings, emphasis, links, fenced code).
 * Both are here because a Markdown code fence picks its highlighter by language: the two call each other.
 */
import { CODE, EM, ESC, HEAD, LINK, META, PLAIN, PUNC, STR, STRONG, TAG } from "./classes";
import { CSS_START, cssLine, type CssState } from "./css";
import { Emit, type Highlighter, type LineFn, make } from "./emit";
import { goLine, type GoState } from "./go";
import { htmlLine, type HtmlState } from "./html";
import { jsLine, type JsState } from "./javascript";
import { jsonLine } from "./json";
import { FENCE_LANG, type LangInfo, languageOf } from "./language";
import { pyLine, type PyState } from "./python";
import { at, sticky } from "./scanners";

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
