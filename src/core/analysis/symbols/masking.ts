/**
 * Blanks comments and string contents in source text without moving an offset, and finds matching brackets.
 *
 * Used by `regex-analysis.ts` and `ts-tokens.ts`. It never changes the length of the text or its line breaks.
 */


const REGEX_PREFIX_WORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

/**
 * Blank comments (and, with `maskStrings`, the contents of string, template and regex literals)
 * with spaces. Quotes, newlines and every offset stay, so line numbers and positions are unchanged.
 * Template `${…}` expressions stay visible as code.
 */
export function maskSource(src: string, maskStrings: boolean): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const tpl: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let mode: "code" | "template" = "code";
  let lastChar = "";
  let lastWord = "";
  let i = 0;
  if (src.startsWith("#!")) {
    const e = src.indexOf("\n");
    i = e === -1 ? n : e;
    blank(0, i);
  }
  while (i < n) {
    const c = src[i];
    if (mode === "template") {
      if (c === "\\") {
        if (maskStrings) blank(i, i + 2);
        i += 2;
      } else if (c === "`") {
        mode = "code";
        lastChar = "`";
        lastWord = "";
        i++;
      } else if (c === "$" && src[i + 1] === "{") {
        // keep "{" for bracket balance; drop "$" so it is not read as an identifier
        if (maskStrings) blank(i, i + 1);
        tpl.push(depth);
        mode = "code";
        lastChar = "{";
        lastWord = "";
        i += 2;
      } else {
        if (maskStrings) blank(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let e = src.indexOf("\n", i);
      if (e === -1) e = n;
      blank(i, e);
      i = e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const closed = j < n && src[j] === c;
      if (maskStrings) blank(i + 1, Math.min(j, n));
      i = closed ? j + 1 : j;
      lastChar = c;
      lastWord = "";
      continue;
    }
    if (c === "`") {
      mode = "template";
      i++;
      continue;
    }
    if (c === "/") {
      const regexOk = lastChar === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastChar) || REGEX_PREFIX_WORDS.has(lastWord);
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          const d = src[j];
          if (d === "\\") j += 2;
          else {
            if (d === "[") inClass = true;
            else if (d === "]") inClass = false;
            else if (d === "/" && !inClass) break;
            j++;
          }
        }
        if (j < n && src[j] === "/") {
          if (maskStrings) blank(i + 1, j);
          i = j + 1;
          while (i < n && /[a-z]/i.test(src[i])) i++;
          lastChar = "/";
          lastWord = "";
          continue;
        }
      }
      lastChar = "/";
      lastWord = "";
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      if (tpl.length && tpl[tpl.length - 1] === depth) {
        tpl.pop();
        mode = "template";
        i++;
        continue;
      }
      depth--;
    }
    if (isWordCode(src.charCodeAt(i))) {
      let j = i + 1;
      while (j < n && isWordCode(src.charCodeAt(j))) j++;
      lastWord = src.slice(i, j);
      lastChar = src[j - 1];
      i = j;
      continue;
    }
    if (!isSpaceCode(src.charCodeAt(i))) {
      lastChar = c;
      lastWord = "";
    }
    i++;
  }
  return out.join("");
}

/** [A-Za-z0-9_$] */
function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 36 || code === 95;
}

function isSpaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0xfeff || code === 0x2028 || code === 0x2029 || (code > 127 && /\s/.test(String.fromCharCode(code)));
}

/** Index of the bracket that closes the one at `open` in masked text, or -1. */
export function matchBracket(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas outside (), [], {} and <>. */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || (c === ">" && s[i - 1] !== "=")) depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}
