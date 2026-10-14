/**
 * The line scanner for HTML and XML: tags, attributes, entities and comments, with JavaScript in <script> and CSS in <style>.
 */
import { ATTR, COM, ESC, META, OP, PLAIN, PUNC, STR, TAG } from "./classes";
import { CSS_START, cssLine, type CssState } from "./css";
import type { LineFn } from "./emit";
import { JS_START, jsLine, type JsState } from "./javascript";
import { at, sticky, WS } from "./scanners";

export interface HtmlState {
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

export const htmlLine: LineFn<HtmlState> = (s, from, end, st, e) => {
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
