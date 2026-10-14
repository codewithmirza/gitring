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
  return new SourceMasker(src, maskStrings).mask();
}

/**
 * The state of one masking pass over a text. Template literals nest: `tpl` keeps the brace depth of every open `${`.
 * `lastChar` and `lastWord` tell a regular expression from a division.
 */
class SourceMasker {
  private readonly out: string[];
  private readonly n: number;
  private readonly tpl: number[] = []; // brace depth at each open `${`
  private depth = 0;
  private mode: "code" | "template" = "code";
  private lastChar = "";
  private lastWord = "";
  private i = 0;

  constructor(
    private readonly src: string,
    private readonly maskStrings: boolean,
  ) {
    this.out = src.split("");
    this.n = src.length;
    if (this.src.startsWith("#!")) {
      const e = this.src.indexOf("\n");
      this.i = e === -1 ? this.n : e;
      this.blank(0, this.i);
    }
  }

  /** Walks the text once and gives the masked copy. */
  mask(): string {
    while (this.i < this.n) {
      const c = this.src[this.i];
      if (this.mode === "template") this.readTemplateText(c);
      else if (c === "/" && this.src[this.i + 1] === "/") this.readLineComment();
      else if (c === "/" && this.src[this.i + 1] === "*") this.readBlockComment();
      else if (c === "'" || c === '"') this.readString(c);
      else if (c === "`") { this.mode = "template"; this.i++; }
      else if (c === "/") this.readSlash();
      else this.readCode(c);
    }
    return this.out.join("");
  }

  /** Text inside a template literal. A `${` goes back to code; a closing backtick ends the template. */
  private readTemplateText(c: string): void {
    if (c === "\\") {
      if (this.maskStrings) this.blank(this.i, this.i + 2);
      this.i += 2;
    } else if (c === "`") {
      this.mode = "code";
      this.lastChar = "`";
      this.lastWord = "";
      this.i++;
    } else if (c === "$" && this.src[this.i + 1] === "{") {
      // keep "{" for bracket balance; drop "$" so it is not read as an identifier
      if (this.maskStrings) this.blank(this.i, this.i + 1);
      this.tpl.push(this.depth);
      this.mode = "code";
      this.lastChar = "{";
      this.lastWord = "";
      this.i += 2;
    } else {
      if (this.maskStrings) this.blank(this.i, this.i + 1);
      this.i++;
    }
  }

  /** A `//` comment: blank it up to the end of the line. */
  private readLineComment(): void {
    let e = this.src.indexOf("\n", this.i);
    if (e === -1) e = this.n;
    this.blank(this.i, e);
    this.i = e;
  }

  /** A block comment: blank it. */
  private readBlockComment(): void {
    const e = this.src.indexOf("*/", this.i + 2);
    const end = e === -1 ? this.n : e + 2;
    this.blank(this.i, end);
    this.i = end;
  }

  /** A string in single or double quotes: keep the quotes, blank the inside when `maskStrings` is set. */
  private readString(c: string): void {
    let j = this.i + 1;
    while (j < this.n && this.src[j] !== c && this.src[j] !== "\n") j += this.src[j] === "\\" ? 2 : 1;
    const closed = j < this.n && this.src[j] === c;
    if (this.maskStrings) this.blank(this.i + 1, Math.min(j, this.n));
    this.i = closed ? j + 1 : j;
    this.lastChar = c;
    this.lastWord = "";
  }

  /** A `/`: the start of a regular expression, or a division. The previous token decides. */
  private readSlash(): void {
    const regexOk = this.lastChar === "" || "(,=:[!&|?{};+-*%<>~^".includes(this.lastChar) || REGEX_PREFIX_WORDS.has(this.lastWord);
    if (regexOk) {
      let j = this.i + 1;
      let inClass = false;
      while (j < this.n && this.src[j] !== "\n") {
        const d = this.src[j];
        if (d === "\\") j += 2;
        else {
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          j++;
        }
      }
      if (j < this.n && this.src[j] === "/") {
        if (this.maskStrings) this.blank(this.i + 1, j);
        this.i = j + 1;
        while (this.i < this.n && /[a-z]/i.test(this.src[this.i])) this.i++;
        this.lastChar = "/";
        this.lastWord = "";
        return;
      }
    }
    this.lastChar = "/";
    this.lastWord = "";
    this.i++;
  }

  /** Any other character: a brace, a word or a symbol. It moves the position `i` on. */
  private readCode(c: string): void {
    if (c === "{") this.depth++;
    else if (c === "}") {
      if (this.tpl.length && this.tpl[this.tpl.length - 1] === this.depth) {
        this.tpl.pop();
        this.mode = "template";
        this.i++;
        return;
      }
      this.depth--;
    }
    if (isWordCode(this.src.charCodeAt(this.i))) {
      let j = this.i + 1;
      while (j < this.n && isWordCode(this.src.charCodeAt(j))) j++;
      this.lastWord = this.src.slice(this.i, j);
      this.lastChar = this.src[j - 1];
      this.i = j;
      return;
    }
    if (!isSpaceCode(this.src.charCodeAt(this.i))) {
      this.lastChar = c;
      this.lastWord = "";
    }
    this.i++;
  }

  /** Blanks [from, to) with spaces. Line breaks stay. */
  private blank(from: number, to: number): void {
    for (let k = from; k < to && k < this.n; k++) if (this.out[k] !== "\n" && this.out[k] !== "\r") this.out[k] = " ";
  }
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
