/**
 * The fallback for a file that does not parse: a scanner of lines and brackets that finds top-level declarations.
 *
 * Called by the front door `../symbols` when acorn fails. The result is approximate, and `parseError` says so.
 * Read `masking.ts` first.
 */

import type { LineRange } from "../../types";
import { collapse, emptyAnalysis, sortedArray } from "./helpers";
import { maskSource, matchBracket, splitTopLevel } from "./masking";
import type { DeclInfo, ModuleAnalysis } from "./types";

// ───── Constants ─────

// Words the regex scanner never reports as references. Kept short on purpose: a reference only
// counts when it resolves to an import or a declaration, so an extra word costs nothing, while a
// skipped real name (a function called `get`, `type` or `unique`) would hide a dependency.
const JS_WORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "export",
  "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return",
  "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "let",
  "static", "await", "async", "of", "as", "from", "enum",
]);

const TS_WORDS = new Set([
  "interface", "implements", "private", "public", "protected", "readonly", "abstract", "declare", "keyof", "infer",
  "asserts", "satisfies", "override", "string", "number", "boolean", "any", "unknown", "never", "bigint",
]);

const IDENT_RE = /[A-Za-z_$][\w$]*/g;

/** `.name` at lastIndex (sticky). */
const MEMBER_RE = /\.\s*([A-Za-z_$][\w$]*)/y;

// ───── Helpers ─────

/** Strip TypeScript-only parts from one parameter text (regex fallback). */
function stripParamTypes(p: string): string | null {
  let s = p.trim().replace(/^(?:(?:public|private|protected|readonly|override)\s+)+/, "");
  if (/^this\s*(?::|$)/.test(s)) return null;
  let depth = 0;
  let colon = -1;
  let eq = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || (c === ">" && s[i - 1] !== "=")) depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ":" && colon < 0 && eq < 0) colon = i;
    else if (depth === 0 && c === "=" && s[i + 1] !== ">" && s[i + 1] !== "=" && eq < 0) eq = i;
  }
  if (colon >= 0) s = s.slice(0, colon) + (eq > colon ? " " + s.slice(eq) : "");
  s = s.replace(/^(\.\.\.)?([\w$]+)\s*\?/, "$1$2");
  return s;
}

// A line that starts a top-level statement.
const TOP = /^(?:export\b|import\b|(?:async\s+)?function\b|class\b|const\b|let\b|var\b|interface\b|type\s+[A-Za-z_$]|enum\b|declare\b|abstract\s+class\b)/;

/** The offset of the start of each line. */
function lineStartsOf(lines: string[]): number[] {
  const lineStart: number[] = [];
  let off = 0;
  for (const l of lines) {
    lineStart.push(off);
    off += l.length + 1;
  }
  return lineStart;
}

/** How deep in brackets each line starts. A line that starts a new top-level statement resets the depth. */
function depthBeforeEachLine(lines: string[]): number[] {
  const depthBefore: number[] = new Array(lines.length).fill(0);
  let d = 0;
  for (let k = 0; k < lines.length; k++) {
    if (d > 0 && TOP.test(lines[k])) d = 0;
    depthBefore[k] = d;
    for (const ch of lines[k]) {
      if (ch === "{" || ch === "(" || ch === "[") d++;
      else if (ch === "}" || ch === ")" || ch === "]") d = Math.max(0, d - 1);
    }
  }
  return depthBefore;
}

export function regexAnalysis(path: string, source: string, ts: boolean, parseError: string): ModuleAnalysis {
  return new RegexReader(path, source, ts, parseError).read();
}

/**
 * The state of one scan: the masked text, its lines, and the result (`analysis`). `read` walks the top-level statements.
 * Each `read...` method handles one form of statement.
 */
class RegexReader {
  private readonly analysis: ModuleAnalysis;
  private readonly code: string;
  private readonly plain: string;
  private readonly lines: string[];
  private readonly n: number;
  private readonly lineStart: number[];
  private readonly depthBefore: number[];
  private readonly topLevel = new Set<string>();
  private readonly refSets = new Map<string, Set<string>>();

  constructor(
    path: string,
    source: string,
    private readonly ts: boolean,
    parseError: string,
  ) {
    this.analysis = emptyAnalysis(path, parseError);
    this.code = maskSource(source, true);
    this.plain = maskSource(source, false);
    this.lines = this.code.split("\n");
    this.n = this.lines.length;
    this.lineStart = lineStartsOf(this.lines);
    this.depthBefore = depthBeforeEachLine(this.lines);
  }

  /** Reads every top-level statement, one after the other, and gives the result. */
  read(): ModuleAnalysis {
    let k = 0;
    while (k < this.n) {
      if (!this.lines[k].trim() || this.depthBefore[k] > 0) {
        k++;
        continue;
      }
      const end = this.statementEnd(k);
      const from = this.lineStart[k];
      const to = this.lineEndOffset(end);
      const stmt = this.code.slice(from, to);
      const range: LineRange = [k + 1, end + 1];
      this.readStatement(stmt, from, to, range);
      k = end + 1;
    }
    this.finish();
    return this.analysis;
  }

  /** One top-level statement. The first form that matches reads it. */
  private readStatement(stmt: string, from: number, to: number, range: LineRange): void {
    let m: RegExpExecArray | null;
    if (/^\s*import\b(?!\s*[(.])/.test(stmt)) {
      this.readImport(stmt, from);
    } else if ((m = /^\s*export\s+(type\s+)?(\*(?:\s*as\s+([A-Za-z_$][\w$]*))?|\{([\s\S]*?)\})\s*from\s*(["'])/.exec(stmt))) {
      this.readReexport(m, from);
    } else if ((m = /^\s*export\s+(type\s+)?\{([\s\S]*?)\}/.exec(stmt))) {
      this.readExportList(m, range);
    } else if ((m = /^\s*export\s+default\s+(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(?:<[^(]*?>)?\s*\(/.exec(stmt))) {
      this.readDefaultFunction(m, from, to, range);
    } else if ((m = /^\s*export\s+default\s+(?:abstract\s+)?class\b\s*([A-Za-z_$][\w$]*)?/.exec(stmt))) {
      this.readDefaultClass(m, from, to, range);
    } else if ((m = /^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(stmt)) && !this.isWord(m[1])) {
      this.readDefaultName(m, range);
    } else if ((m = /^\s*export\s+default\b/.exec(stmt))) {
      this.readDefaultExpression(stmt, from, to, range);
    } else if ((m = /^\s*(export\s+)?(?:declare\s+)?(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^(]*?>)?\s*\(/.exec(stmt))) {
      this.readFunction(m, from, to, range);
    } else if ((m = /^\s*(export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(stmt))) {
      this.readClass(m, from, to, range);
    } else if (this.ts && (m = /^\s*(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(stmt))) {
      this.readEnum(m, from, to, range);
    } else if ((m = /^\s*(export\s+)?(?:declare\s+)?(const|let|var)\s+/.exec(stmt))) {
      this.readVariables(m, from, to, range);
    } else if (this.ts && /^\s*(?:export\s+)?(?:declare\s+)?(?:interface\b|type\s+[A-Za-z_$][\w$]*\s*(?:<|=)|namespace\b|module\b|global\b|declare\b)/.test(stmt)) {
      // type-only or ambient TypeScript: not code
    } else {
      this.readOtherStatement(from, to, range);
    }
  }

  /** An `import` statement in any of its forms: bare, `import x = require()`, or with names. */
  private readImport(stmt: string, from: number): void {
    let m: RegExpExecArray | null;
    if ((m = /^\s*import\s*(["'])/.exec(stmt))) {
      this.analysis.imports.push({ from: this.specText(from, from + m[0].length - 1), names: [] });
    } else if ((m = /^\s*import\s+([\w$]+)\s*=\s*require\s*\(\s*(["'])/.exec(stmt))) {
      const spec = this.specText(from, from + m[0].length - 1);
      this.analysis.imports.push({ from: spec, names: [{ imported: "*", local: m[1] }] });
      this.analysis.bindings[m[1]] = { from: spec, imported: "*" };
    } else if ((m = /^\s*import\s+([\s\S]*?)\s*\bfrom\s*(["'])/.exec(stmt))) {
      const spec = this.specText(from, from + m[0].length - 1);
      const clause = m[1].replace(/^type\s+/, "");
      const names: { imported: string; local: string }[] = [];
      const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
      if (def) names.push({ imported: "default", local: def[1] });
      const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      if (ns) names.push({ imported: "*", local: ns[1] });
      const named = /\{([\s\S]*?)\}/.exec(clause);
      if (named) names.push(...this.parseNamed(named[1]));
      this.analysis.imports.push({ from: spec, names });
      for (const x of names) this.analysis.bindings[x.local] = { from: spec, imported: x.imported };
    }
  }

  /** `export { a } from "x"` and `export * from "x"`: an import and an export in one. */
  private readReexport(m: RegExpExecArray, from: number): void {
    const spec = this.specText(from, from + m[0].length - 1);
    let names: { imported: string; local: string }[];
    if (m[4] !== undefined) names = this.parseNamed(m[4]).map((x) => ({ imported: x.imported, local: x.local }));
    else names = [{ imported: "*", local: m[3] ?? "*" }];
    this.analysis.imports.push({ from: spec, names });
    for (const x of names) if (x.local !== "*") this.analysis.exports[x.local] = x.local;
  }

  /** `export { a, b as c }` without `from`: names that are exported, and used. */
  private readExportList(m: RegExpExecArray, range: LineRange): void {
    if (!(this.ts && m[1])) {
      const refs = new Set<string>();
      for (const x of this.parseNamed(m[2])) {
        this.analysis.exports[x.local] = x.imported;
        refs.add(x.imported);
      }
      for (const r of refs) this.topLevel.add(r);
      if (refs.size) this.analysis.statements.push({ range, references: sortedArray(refs) });
    }
  }

  /** `export default function`: a declaration with a name, or the name `default`. */
  private readDefaultFunction(m: RegExpExecArray, from: number, to: number, range: LineRange): void {
    const name = m[1] ?? "default";
    const p = this.paramsAt(from + m[0].length - 1);
    const params = p?.params ?? [];
    this.addDecl({ name, kind: "function", params, signature: `${name}(${params.join(", ")})`, range, exported: true }, from, to);
    this.analysis.exports.default = name;
  }

  /** `export default class`. */
  private readDefaultClass(m: RegExpExecArray, from: number, to: number, range: LineRange): void {
    const name = m[1] ?? "default";
    this.addDecl({ name, kind: "class", range, exported: true }, from, to);
    this.analysis.exports.default = name;
  }

  /** `export default name;` */
  private readDefaultName(m: RegExpExecArray, range: LineRange): void {
    this.analysis.exports.default = m[1];
    this.topLevel.add(m[1]);
    this.analysis.statements.push({ range, references: [m[1]] });
  }

  /** `export default` with any other expression. An arrow function with a parameter list gets its parameters. */
  private readDefaultExpression(stmt: string, from: number, to: number, range: LineRange): void {
    const arrow = /^\s*export\s+default\s+(?:async\s+)?\(/.exec(stmt);
    let info: DeclInfo = { name: "default", kind: "const", range, exported: true };
    if (arrow) {
      const p = this.paramsAt(from + arrow[0].length - 1);
      if (p && /^\s*(?::[^=]*)?=>/.test(this.code.slice(p.close + 1, to))) {
        info = { name: "default", kind: "function", params: p.params, signature: `default(${p.params.join(", ")})`, range, exported: true };
      }
    }
    this.addDecl(info, from, to);
    this.analysis.exports.default = "default";
  }

  /** A function declaration, exported or not. */
  private readFunction(m: RegExpExecArray, from: number, to: number, range: LineRange): void {
    const p = this.paramsAt(from + m[0].length - 1);
    const params = p?.params ?? [];
    const name = m[2];
    this.addDecl({ name, kind: "function", params, signature: `${name}(${params.join(", ")})`, range, exported: !!m[1] }, from, to);
    if (m[1]) this.analysis.exports[name] = name;
  }

  /** A class declaration, exported or not. */
  private readClass(m: RegExpExecArray, from: number, to: number, range: LineRange): void {
    this.addDecl({ name: m[2], kind: "class", range, exported: !!m[1] }, from, to);
    if (m[1]) this.analysis.exports[m[2]] = m[2];
  }

  /** A TypeScript enum: a declaration that holds a value. */
  private readEnum(m: RegExpExecArray, from: number, to: number, range: LineRange): void {
    this.addDecl({ name: m[2], kind: "const", range, exported: !!m[1] }, from, to);
    if (m[1]) this.analysis.exports[m[2]] = m[2];
  }

  /** `const`, `let` or `var` with one or more names. A name that holds a function gets its parameters. */
  private readVariables(m: RegExpExecArray, from: number, to: number, range: LineRange): void {
    const exported = !!m[1];
    const kind = m[2] as DeclInfo["kind"];
    const bodyFrom = from + m[0].length;
    // declarators: split the statement at top-level commas
    const rest = this.code.slice(bodyFrom, to);
    let offset = bodyFrom;
    const declared: string[] = [];
    for (const part of splitTopLevel(rest)) {
      const partFrom = offset;
      offset += part.length + 1;
      const id = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
      const pat = /^\s*([{[])/.exec(part);
      let names: string[] = [];
      if (id) names = [id[1]];
      else if (pat) {
        const close = matchBracket(this.code, partFrom + pat[0].length - 1);
        const inner = close > 0 ? this.code.slice(partFrom + pat[0].length, close) : "";
        names = inner
          .split(",")
          .map((x) => x.split("=")[0])
          .map((x) => (x.includes(":") ? x.split(":")[1] : x).replace(/\.\.\./, "").trim())
          .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
      } else continue;
      let params: string[] | undefined;
      if (id) {
        const afterId = partFrom + id[0].length;
        // `= (a) =>`, `= ((a) => …)`, `= async (a) =>`, `= <T>(a: T) =>`, `= a =>`, `= function (a)`
        const init = /^\s*(?::[^=]*)?=\s*((?:\(\s*)*)(?:async\s+)?(?:(function\b\s*\*?\s*[\w$]*\s*(?:<[^(]*?>)?\s*\()|(?:<[^(]*?>\s*)?(\()|([A-Za-z_$][\w$]*)\s*=>)/.exec(this.code.slice(afterId, to));
        let called = false;
        if (init && init[1]) {
          // `= (() => …)()` is a call (an IIFE), not a function value
          const group = afterId + init[0].indexOf("(", init[0].indexOf("="));
          const close = matchBracket(this.code, group);
          called = close > 0 && /^\s*(?:\?\.\s*)?\(/.test(this.code.slice(close + 1, close + 40));
        }
        if (init && !called) {
          if (init[4]) params = [init[4]];
          else {
            const open = afterId + init[0].length - 1;
            const p = this.paramsAt(open);
            if (p && (init[2] || /^\s*(?::[^=;{]*)?=>/.test(this.code.slice(p.close + 1, to)))) params = p.params;
          }
        }
      }
      for (const name of names) {
        if (this.isWord(name)) continue;
        const info: DeclInfo = { name, kind, range, exported };
        if (params) {
          info.params = params;
          info.signature = `${name}(${params.join(", ")})`;
        }
        this.addDecl(info, from, to, names.filter((x) => x !== name));
        declared.push(name);
        if (exported) this.analysis.exports[name] = name;
      }
    }
  }

  /** Any other statement: it keeps the names that it uses. */
  private readOtherStatement(from: number, to: number, range: LineRange): void {
    const refs = this.identifiers(from, to, new Set());
    for (const r of refs) this.topLevel.add(r);
    if (refs.size) this.analysis.statements.push({ range, references: sortedArray(refs) });
  }

  /** The index of the first line at or after `k` that is not blank, or -1. */
  private nextNonBlank(k: number): number {
    for (let m = k; m < this.n; m++) if (this.lines[m].trim()) return m;
    return -1;
  }

  /** The index of the last line of the statement that starts at line `k`. */
  private statementEnd(k: number): number {
    let d = 0;
    let lastCode = k;
    let inTemplate = false; // a template literal open across lines (its text is masked, its backticks are not)
    for (let m = k; m < this.n; m++) {
      if (m > k && d > 0 && !inTemplate && TOP.test(this.lines[m])) return lastCode;
      for (const ch of this.lines[m]) {
        if (ch === "{" || ch === "(" || ch === "[") d++;
        else if (ch === "}" || ch === ")" || ch === "]") d--;
        else if (ch === "`") inTemplate = !inTemplate;
      }
      const t = this.lines[m].trim();
      if (t) lastCode = m;
      if (d <= 0 && t && !inTemplate) {
        const last = t[t.length - 1];
        const nx = this.nextNonBlank(m + 1);
        const cont = "=,([{+-*/%&|^!?:<>.".includes(last) || (nx >= 0 && /^\s*(?:\.(?!\.\.)|\?\.|\?(?!\?)|:|&&|\|\||\?\?|=>|[+*/%](?![+=]))/.test(this.lines[nx]));
        if (!cont) return m;
      }
    }
    return lastCode;
  }

  /** True for a word that is not a name: a keyword, and with TypeScript a type word. */
  private isWord(w: string): boolean {
    return JS_WORDS.has(w) || (this.ts && TS_WORDS.has(w));
  }

  /** One parameter text, without its TypeScript parts when the file is TypeScript. */
  private stripParam(p: string): string | null {
    return (this.ts ? stripParamTypes(p) : p);
  }

  /** The parameter texts of the list that opens at `open`, and the index of its closing bracket. */
  private paramsAt(open: number): { params: string[]; close: number } | undefined {
    const close = matchBracket(this.code, open);
    if (close < 0) return undefined;
    const inner = this.plain.slice(open + 1, close);
    const params: string[] = [];
    for (const raw of splitTopLevel(inner)) {
      const p = this.stripParam(raw);
      if (p !== null && collapse(p)) params.push(collapse(p));
    }
    return { params, close };
  }

  /** Identifiers used in code[from, to), minus `locals` and the definition sites in `skip` (offsets in the slice). */
  private identifiers(from: number, to: number, locals: Set<string>, skip: Set<number> = new Set()): Set<string> {
    const text = this.code.slice(from, to);
    const out = new Set<string>();
    IDENT_RE.lastIndex = 0;
    for (let m = IDENT_RE.exec(text); m; m = IDENT_RE.exec(text)) {
      const name = m[0];
      const p = m.index;
      if (/^[0-9]/.test(name) || this.isWord(name) || locals.has(name) || skip.has(p)) continue;
      let b = p - 1;
      while (b >= 0 && /\s/.test(text[b])) b--;
      if (text[b] === "." && text.slice(b - 2, b + 1) !== "...") continue;
      if (p > 0 && /[\w$#]/.test(text[p - 1])) continue;
      let f = p + name.length;
      while (f < text.length && /[ \t]/.test(text[f])) f++;
      if (text[f] === ":" && text[f + 1] !== ":" && (text[b] === "{" || text[b] === ",")) continue;
      out.add(name);
      const dot = text[f] === "." && text[f + 1] !== "." ? f : text[f] === "?" && text[f + 1] === "." ? f + 1 : -1;
      if (dot >= 0) {
        MEMBER_RE.lastIndex = dot;
        const pm = MEMBER_RE.exec(text);
        if (pm) out.add(`${name}.${pm[1]}`);
      }
    }
    return out;
  }

  /** Names bound by one parameter or destructuring pattern (keys, computed keys, defaults and TS types left out). */
  private patternNames(raw: string): string[] {
    const p = this.ts ? stripParamTypes(raw) : raw;
    if (p === null) return [];
    let s = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "=" && p[i + 1] !== ">" && p[i + 1] !== "=" && p[i - 1] !== "=" && p[i - 1] !== "!" && p[i - 1] !== "<" && p[i - 1] !== ">") {
        // a default value: skip to the next "," / "}" / "]" at this depth
        let d = 0;
        let j = i + 1;
        for (; j < p.length; j++) {
          const e = p[j];
          if (e === "(" || e === "[" || e === "{") d++;
          else if (e === ")" || e === "]" || e === "}") {
            if (d === 0) break;
            d--;
          } else if (e === "," && d === 0) break;
        }
        i = j - 1;
        continue;
      }
      if (c === "[") {
        // a computed key `[expr]:` is not a binding
        const close = matchBracket(p, i);
        if (close > 0 && /^\s*:/.test(p.slice(close + 1))) {
          i = close;
          continue;
        }
      }
      s += c;
    }
    s = s.replace(/[A-Za-z_$][\w$]*\s*:(?!:)/g, " ").replace(/\.\.\./g, " ");
    const out: string[] = [];
    IDENT_RE.lastIndex = 0;
    for (let m = IDENT_RE.exec(s); m; m = IDENT_RE.exec(s)) if (!this.isWord(m[0])) out.push(m[0]);
    return out;
  }

  /** Names declared inside a declaration's text (approximate locals), and method-name sites to skip. */
  private innerLocals(from: number, to: number): { names: Set<string>; skip: Set<number> } {
    const text = this.code.slice(from, to);
    const names = new Set<string>();
    const skip = new Set<number>();
    const addList = (list: string): void => {
      for (const raw of splitTopLevel(list)) for (const name of this.patternNames(raw)) names.add(name);
    };
    const addParamsAt = (open: number): void => {
      const close = matchBracket(text, open);
      if (close > 0) addList(text.slice(open + 1, close));
    };
    // Every pattern below is bounded (no unbounded cross-line spans), so this stays linear.
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of text.matchAll(/\b(?:const|let|var)\s*(?=[{[])/g)) {
      const open = m.index + m[0].length;
      const close = matchBracket(text, open);
      if (close > 0) for (const name of this.patternNames(text.slice(open, close + 1))) names.add(name);
    }
    for (const m of text.matchAll(/\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(?:<[^(]*?>)?\s*\(/g)) {
      if (m[1]) names.add(m[1]);
      addParamsAt(m.index + m[0].length - 1);
    }
    for (const m of text.matchAll(/\(([^()]*)\)[ \t]*(?::[^=;{\n]{0,200})?=>/g)) addList(m[1]);
    for (const m of text.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)[ \t]*=>/g)) {
      // `x => …` binds x; in `(): A | B =>` the last name is a TypeScript return type
      let b = m.index - 1;
      while (b >= 0 && (text[b] === " " || text[b] === "\t")) b--;
      if (text[b] === "|" || text[b] === "&") continue;
      if (text[b] === ":") {
        let c = b - 1;
        while (c >= 0 && /\s/.test(text[c])) c--;
        if (text[c] === ")") continue;
      }
      names.add(m[1]);
    }
    for (const m of text.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of text.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    // method definitions (class bodies, object literals): the name site is not a use; the params are locals
    for (const m of text.matchAll(/^([ \t]*(?:(?:static|async|get|set|public|private|protected|readonly)[ \t]+)*\*?[ \t]*)([A-Za-z_$][\w$]*)([ \t]*)\([^()\n]*\)[ \t]*(?::[^{\n]{0,200})?\{/gm)) {
      if (this.isWord(m[2])) continue;
      skip.add(m.index + m[1].length);
      addParamsAt(m.index + m[1].length + m[2].length + m[3].length);
    }
    return { names, skip };
  }

  /** The offset of the end of line `m`. */
  private lineEndOffset(m: number): number {
    return this.lineStart[m] + this.lines[m].length;
  }

  /** Records a top-level declaration with the names that its text uses. The first declaration of a name wins. */
  private addDecl(info: DeclInfo, from: number, to: number, extraLocals: Iterable<string> = []): void {
    if (this.analysis.decls[info.name]) return;
    this.analysis.decls[info.name] = info;
    const { names: locals, skip } = this.innerLocals(from, to);
    for (const l of extraLocals) locals.add(l);
    locals.add(info.name);
    for (const p of info.params ?? []) for (const name of this.patternNames(p)) locals.add(name);
    const refs = this.identifiers(from, to, locals, skip);
    for (const r of [...refs]) if (r.startsWith(info.name + ".")) refs.delete(r);
    this.refSets.set(info.name, refs);
  }

  /** The module specifier of an import, read from the unmasked text. */
  private specText(_stmtFrom: number, quoteAt: number): string {
    const q = this.plain[quoteAt];
    const end = this.plain.indexOf(q, quoteAt + 1);
    return this.plain.slice(quoteAt + 1, end < 0 ? quoteAt + 1 : end);
  }

  /** The names in `{ a, b as c }` of an import or export. */
  private parseNamed(inner: string): { imported: string; local: string }[] {
    const out: { imported: string; local: string }[] = [];
    for (const part of inner.split(",")) {
      // a `type` modifier keeps the specifier (a type-only import is still a dependency)
      const p = this.ts ? part.trim().replace(/^type\s+(?!as\b)(?=[\w$])/, "") : part.trim();
      if (!p) continue;
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(p);
      if (m) out.push({ imported: m[1], local: m[2] ?? m[1] });
    }
    return out;
  }

  /** Marks the exported declarations and turns the collected sets into sorted lists. */
  private finish(): void {
    for (const local of Object.values(this.analysis.exports)) {
      const d = this.analysis.decls[local];
      if (d) d.exported = true;
    }
    for (const [name, set] of this.refSets) this.analysis.references[name] = sortedArray(set);
    this.analysis.topLevelReferences = sortedArray(this.topLevel);
  }
}
