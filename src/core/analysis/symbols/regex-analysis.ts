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

// ───── The scanner ─────

export function regexAnalysis(path: string, source: string, ts: boolean, parseError: string): ModuleAnalysis {
  const a = emptyAnalysis(path, parseError);
  const code = maskSource(source, true);
  const plain = maskSource(source, false);
  const lines = code.split("\n");
  const n = lines.length;
  const lineStart: number[] = [];
  {
    let off = 0;
    for (const l of lines) {
      lineStart.push(off);
      off += l.length + 1;
    }
  }
  const TOP = /^(?:export\b|import\b|(?:async\s+)?function\b|class\b|const\b|let\b|var\b|interface\b|type\s+[A-Za-z_$]|enum\b|declare\b|abstract\s+class\b)/;
  const depthBefore: number[] = new Array(n).fill(0);
  {
    let d = 0;
    for (let k = 0; k < n; k++) {
      if (d > 0 && TOP.test(lines[k])) d = 0;
      depthBefore[k] = d;
      for (const ch of lines[k]) {
        if (ch === "{" || ch === "(" || ch === "[") d++;
        else if (ch === "}" || ch === ")" || ch === "]") d = Math.max(0, d - 1);
      }
    }
  }
  const nextNonBlank = (k: number): number => {
    for (let m = k; m < n; m++) if (lines[m].trim()) return m;
    return -1;
  };
  const statementEnd = (k: number): number => {
    let d = 0;
    let lastCode = k;
    let inTemplate = false; // a template literal open across lines (its text is masked, its backticks are not)
    for (let m = k; m < n; m++) {
      if (m > k && d > 0 && !inTemplate && TOP.test(lines[m])) return lastCode;
      for (const ch of lines[m]) {
        if (ch === "{" || ch === "(" || ch === "[") d++;
        else if (ch === "}" || ch === ")" || ch === "]") d--;
        else if (ch === "`") inTemplate = !inTemplate;
      }
      const t = lines[m].trim();
      if (t) lastCode = m;
      if (d <= 0 && t && !inTemplate) {
        const last = t[t.length - 1];
        const nx = nextNonBlank(m + 1);
        const cont = "=,([{+-*/%&|^!?:<>.".includes(last) || (nx >= 0 && /^\s*(?:\.(?!\.\.)|\?\.|\?(?!\?)|:|&&|\|\||\?\?|=>|[+*/%](?![+=]))/.test(lines[nx]));
        if (!cont) return m;
      }
    }
    return lastCode;
  };
  const isWord = (w: string): boolean => JS_WORDS.has(w) || (ts && TS_WORDS.has(w));
  const stripParam = (p: string): string | null => (ts ? stripParamTypes(p) : p);
  const paramsAt = (open: number): { params: string[]; close: number } | undefined => {
    const close = matchBracket(code, open);
    if (close < 0) return undefined;
    const inner = plain.slice(open + 1, close);
    const params: string[] = [];
    for (const raw of splitTopLevel(inner)) {
      const p = stripParam(raw);
      if (p !== null && collapse(p)) params.push(collapse(p));
    }
    return { params, close };
  };
  /** Identifiers used in code[from, to), minus `locals` and the definition sites in `skip` (offsets in the slice). */
  const identifiers = (from: number, to: number, locals: Set<string>, skip: Set<number> = new Set()): Set<string> => {
    const text = code.slice(from, to);
    const out = new Set<string>();
    IDENT_RE.lastIndex = 0;
    for (let m = IDENT_RE.exec(text); m; m = IDENT_RE.exec(text)) {
      const name = m[0];
      const p = m.index;
      if (/^[0-9]/.test(name) || isWord(name) || locals.has(name) || skip.has(p)) continue;
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
  };
  /** Names bound by one parameter or destructuring pattern (keys, computed keys, defaults and TS types left out). */
  const patternNames = (raw: string): string[] => {
    const p = ts ? stripParamTypes(raw) : raw;
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
    for (let m = IDENT_RE.exec(s); m; m = IDENT_RE.exec(s)) if (!isWord(m[0])) out.push(m[0]);
    return out;
  };
  /** Names declared inside a declaration's text (approximate locals), and method-name sites to skip. */
  const innerLocals = (from: number, to: number): { names: Set<string>; skip: Set<number> } => {
    const text = code.slice(from, to);
    const names = new Set<string>();
    const skip = new Set<number>();
    const addList = (list: string): void => {
      for (const raw of splitTopLevel(list)) for (const name of patternNames(raw)) names.add(name);
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
      if (close > 0) for (const name of patternNames(text.slice(open, close + 1))) names.add(name);
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
      if (isWord(m[2])) continue;
      skip.add(m.index + m[1].length);
      addParamsAt(m.index + m[1].length + m[2].length + m[3].length);
    }
    return { names, skip };
  };
  const lineEndOffset = (m: number): number => lineStart[m] + lines[m].length;
  const topLevel = new Set<string>();
  const refSets = new Map<string, Set<string>>();

  const addDecl = (info: DeclInfo, from: number, to: number, extraLocals: Iterable<string> = []): void => {
    if (a.decls[info.name]) return;
    a.decls[info.name] = info;
    const { names: locals, skip } = innerLocals(from, to);
    for (const l of extraLocals) locals.add(l);
    locals.add(info.name);
    for (const p of info.params ?? []) for (const name of patternNames(p)) locals.add(name);
    const refs = identifiers(from, to, locals, skip);
    for (const r of [...refs]) if (r.startsWith(info.name + ".")) refs.delete(r);
    refSets.set(info.name, refs);
  };
  const specText = (_stmtFrom: number, quoteAt: number): string => {
    const q = plain[quoteAt];
    const end = plain.indexOf(q, quoteAt + 1);
    return plain.slice(quoteAt + 1, end < 0 ? quoteAt + 1 : end);
  };
  const parseNamed = (inner: string): { imported: string; local: string }[] => {
    const out: { imported: string; local: string }[] = [];
    for (const part of inner.split(",")) {
      // a `type` modifier keeps the specifier (a type-only import is still a dependency)
      const p = ts ? part.trim().replace(/^type\s+(?!as\b)(?=[\w$])/, "") : part.trim();
      if (!p) continue;
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(p);
      if (m) out.push({ imported: m[1], local: m[2] ?? m[1] });
    }
    return out;
  };

  let k = 0;
  while (k < n) {
    if (!lines[k].trim() || depthBefore[k] > 0) {
      k++;
      continue;
    }
    const end = statementEnd(k);
    const from = lineStart[k];
    const to = lineEndOffset(end);
    const stmt = code.slice(from, to);
    const range: LineRange = [k + 1, end + 1];
    let m: RegExpExecArray | null;

    if (/^\s*import\b(?!\s*[(.])/.test(stmt)) {
      if ((m = /^\s*import\s*(["'])/.exec(stmt))) {
        a.imports.push({ from: specText(from, from + m[0].length - 1), names: [] });
      } else if ((m = /^\s*import\s+([\w$]+)\s*=\s*require\s*\(\s*(["'])/.exec(stmt))) {
        const spec = specText(from, from + m[0].length - 1);
        a.imports.push({ from: spec, names: [{ imported: "*", local: m[1] }] });
        a.bindings[m[1]] = { from: spec, imported: "*" };
      } else if ((m = /^\s*import\s+([\s\S]*?)\s*\bfrom\s*(["'])/.exec(stmt))) {
        const spec = specText(from, from + m[0].length - 1);
        const clause = m[1].replace(/^type\s+/, "");
        const names: { imported: string; local: string }[] = [];
        const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
        if (def) names.push({ imported: "default", local: def[1] });
        const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
        if (ns) names.push({ imported: "*", local: ns[1] });
        const named = /\{([\s\S]*?)\}/.exec(clause);
        if (named) names.push(...parseNamed(named[1]));
        a.imports.push({ from: spec, names });
        for (const x of names) a.bindings[x.local] = { from: spec, imported: x.imported };
      }
    } else if ((m = /^\s*export\s+(type\s+)?(\*(?:\s*as\s+([A-Za-z_$][\w$]*))?|\{([\s\S]*?)\})\s*from\s*(["'])/.exec(stmt))) {
      const spec = specText(from, from + m[0].length - 1);
      let names: { imported: string; local: string }[];
      if (m[4] !== undefined) names = parseNamed(m[4]).map((x) => ({ imported: x.imported, local: x.local }));
      else names = [{ imported: "*", local: m[3] ?? "*" }];
      a.imports.push({ from: spec, names });
      for (const x of names) if (x.local !== "*") a.exports[x.local] = x.local;
    } else if ((m = /^\s*export\s+(type\s+)?\{([\s\S]*?)\}/.exec(stmt))) {
      if (!(ts && m[1])) {
        const refs = new Set<string>();
        for (const x of parseNamed(m[2])) {
          a.exports[x.local] = x.imported;
          refs.add(x.imported);
        }
        for (const r of refs) topLevel.add(r);
        if (refs.size) a.statements.push({ range, references: sortedArray(refs) });
      }
    } else if ((m = /^\s*export\s+default\s+(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(?:<[^(]*?>)?\s*\(/.exec(stmt))) {
      const name = m[1] ?? "default";
      const p = paramsAt(from + m[0].length - 1);
      const params = p?.params ?? [];
      addDecl({ name, kind: "function", params, signature: `${name}(${params.join(", ")})`, range, exported: true }, from, to);
      a.exports.default = name;
    } else if ((m = /^\s*export\s+default\s+(?:abstract\s+)?class\b\s*([A-Za-z_$][\w$]*)?/.exec(stmt))) {
      const name = m[1] ?? "default";
      addDecl({ name, kind: "class", range, exported: true }, from, to);
      a.exports.default = name;
    } else if ((m = /^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(stmt)) && !isWord(m[1])) {
      a.exports.default = m[1];
      topLevel.add(m[1]);
      a.statements.push({ range, references: [m[1]] });
    } else if ((m = /^\s*export\s+default\b/.exec(stmt))) {
      const arrow = /^\s*export\s+default\s+(?:async\s+)?\(/.exec(stmt);
      let info: DeclInfo = { name: "default", kind: "const", range, exported: true };
      if (arrow) {
        const p = paramsAt(from + arrow[0].length - 1);
        if (p && /^\s*(?::[^=]*)?=>/.test(code.slice(p.close + 1, to))) {
          info = { name: "default", kind: "function", params: p.params, signature: `default(${p.params.join(", ")})`, range, exported: true };
        }
      }
      addDecl(info, from, to);
      a.exports.default = "default";
    } else if ((m = /^\s*(export\s+)?(?:declare\s+)?(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^(]*?>)?\s*\(/.exec(stmt))) {
      const p = paramsAt(from + m[0].length - 1);
      const params = p?.params ?? [];
      const name = m[2];
      addDecl({ name, kind: "function", params, signature: `${name}(${params.join(", ")})`, range, exported: !!m[1] }, from, to);
      if (m[1]) a.exports[name] = name;
    } else if ((m = /^\s*(export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(stmt))) {
      addDecl({ name: m[2], kind: "class", range, exported: !!m[1] }, from, to);
      if (m[1]) a.exports[m[2]] = m[2];
    } else if (ts && (m = /^\s*(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(stmt))) {
      addDecl({ name: m[2], kind: "const", range, exported: !!m[1] }, from, to);
      if (m[1]) a.exports[m[2]] = m[2];
    } else if ((m = /^\s*(export\s+)?(?:declare\s+)?(const|let|var)\s+/.exec(stmt))) {
      const exported = !!m[1];
      const kind = m[2] as DeclInfo["kind"];
      const bodyFrom = from + m[0].length;
      // declarators: split the statement at top-level commas
      const rest = code.slice(bodyFrom, to);
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
          const close = matchBracket(code, partFrom + pat[0].length - 1);
          const inner = close > 0 ? code.slice(partFrom + pat[0].length, close) : "";
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
          const init = /^\s*(?::[^=]*)?=\s*((?:\(\s*)*)(?:async\s+)?(?:(function\b\s*\*?\s*[\w$]*\s*(?:<[^(]*?>)?\s*\()|(?:<[^(]*?>\s*)?(\()|([A-Za-z_$][\w$]*)\s*=>)/.exec(code.slice(afterId, to));
          let called = false;
          if (init && init[1]) {
            // `= (() => …)()` is a call (an IIFE), not a function value
            const group = afterId + init[0].indexOf("(", init[0].indexOf("="));
            const close = matchBracket(code, group);
            called = close > 0 && /^\s*(?:\?\.\s*)?\(/.test(code.slice(close + 1, close + 40));
          }
          if (init && !called) {
            if (init[4]) params = [init[4]];
            else {
              const open = afterId + init[0].length - 1;
              const p = paramsAt(open);
              if (p && (init[2] || /^\s*(?::[^=;{]*)?=>/.test(code.slice(p.close + 1, to)))) params = p.params;
            }
          }
        }
        for (const name of names) {
          if (isWord(name)) continue;
          const info: DeclInfo = { name, kind, range, exported };
          if (params) {
            info.params = params;
            info.signature = `${name}(${params.join(", ")})`;
          }
          addDecl(info, from, to, names.filter((x) => x !== name));
          declared.push(name);
          if (exported) a.exports[name] = name;
        }
      }
    } else if (ts && /^\s*(?:export\s+)?(?:declare\s+)?(?:interface\b|type\s+[A-Za-z_$][\w$]*\s*(?:<|=)|namespace\b|module\b|global\b|declare\b)/.test(stmt)) {
      // type-only or ambient TypeScript: not code
    } else {
      const refs = identifiers(from, to, new Set());
      for (const r of refs) topLevel.add(r);
      if (refs.size) a.statements.push({ range, references: sortedArray(refs) });
    }
    k = end + 1;
  }

  for (const local of Object.values(a.exports)) {
    const d = a.decls[local];
    if (d) d.exported = true;
  }
  for (const [name, set] of refSets) a.references[name] = sortedArray(set);
  a.topLevelReferences = sortedArray(topLevel);
  return a;
}
