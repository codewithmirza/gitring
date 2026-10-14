/**
 * The code check of a confirmed change request (gitring_ack). An agent says "done": gitring looks at the
 * code of the work copy, not at the words of the agent.
 *
 *   avoidRegions   the changes of the work copy still replace lines of a region of the same file → not applied
 *   useSignatures  the work copy changes the function, and calls of the asked form do not work with the new
 *                  parameter list → not applied. When the work copy does not change the function, the files
 *                  where its changed code uses the function still call it with a number of arguments that
 *                  the asked form does not take → not applied.
 *
 * Constraints with nothing to check (notes only, lines of work that left the traffic, no use of the function)
 * give `applied: null`. The check is best effort: it reads the text, it does not run the code.
 */
import type { Correction, Footprint, LineRange, SymbolKey } from "../core/types";
import { callForm, symbolName, symbolPath, type SignatureInfo } from "../core/analysis/range";
import { formatLines } from "../core/coord/corrections";

export interface AckCheck {
  applied: boolean | null;
  /** One or two sentences for the agent. */
  reason: string;
}

/** What the check reads of a work copy. */
export interface AckWork {
  footprint: Footprint;
  /** The full text of the work copy. */
  files: Map<string, string>;
  /** Signatures (before and after) of the symbols that the work copy changes. */
  signatures: Record<SymbolKey, SignatureInfo>;
}

/**
 * Does the work copy keep the constraints of the change request? `regions`: false when the lines of the
 * request do not count any more (the work that holds them merged or left the traffic).
 */
export function checkAck(c: Pick<Correction, "constraints">, work: AckWork, opts: { regions?: boolean } = {}): AckCheck {
  const failed: string[] = [];
  let lines = false;
  let signatures = false;

  if (opts.regions !== false) {
    for (const r of c.constraints.avoidRegions ?? []) {
      lines = true;
      const touch = work.footprint.files[r.path];
      const hits = (touch?.hunks ?? []).filter((h) => h[0] <= r.lines[1] && r.lines[0] <= h[1]).map((h): LineRange => [Math.max(h[0], r.lines[0]), Math.min(h[1], r.lines[1])]);
      if (hits.length) failed.push(`Your code still edits ${formatLines(hits)} of ${r.path}.`);
    }
  }

  for (const s of c.constraints.useSignatures ?? []) {
    const name = symbolName(s.symbol);
    const mine = signatureIn(work.signatures, s.symbol);
    const file = symbolPath(s.symbol) || "its module";
    if (mine?.before && !mine.after) {
      signatures = true;
      failed.push(`Your code removes ${name} from ${file}.`);
      continue;
    }
    if (mine?.after && mine.after !== mine.before) {
      // The work copy sets the parameter list itself: calls of the asked form must still work.
      signatures = true;
      if (!keepsValid(mine.after, s.signature)) failed.push(`Your code changes ${name} in ${file} to ${mine.after}. Calls of the form ${callForm(s.signature)} must still work.`);
      continue;
    }
    for (const path of callFiles(work.footprint, s.symbol)) {
      const counts = callArgCounts(work.files.get(path) ?? "", name);
      if (!counts.length) continue;
      signatures = true;
      const bad = counts.find((n) => !takes(s.signature, n));
      if (bad !== undefined) {
        failed.push(`Your code in ${path} still calls ${name} with ${bad} ${bad === 1 ? "argument" : "arguments"}. Call ${callForm(s.signature)}.`);
        break;
      }
    }
  }

  if (failed.length) return { applied: false, reason: failed.slice(0, 2).join(" ") };
  if (!lines && !signatures) return { applied: null, reason: "The change request has no lines or signatures that gitring can check." };
  const what = lines && signatures ? "the lines and the signatures" : lines ? "the lines" : "the signatures";
  return { applied: true, reason: `Your code keeps ${what} of the change request.` };
}

/** The signature of `key` in the work copy: the exact key, else the same name in the same file (or a key with no file). */
function signatureIn(sigs: Record<SymbolKey, SignatureInfo>, key: SymbolKey): SignatureInfo | undefined {
  if (sigs[key]) return sigs[key];
  const name = symbolName(key);
  const path = symbolPath(key);
  for (const [k, info] of Object.entries(sigs)) {
    if (symbolName(k) === name && (!path || !symbolPath(k) || symbolPath(k) === path)) return info;
  }
  return undefined;
}

/** The files where the changed code of the work copy uses the symbol. */
function callFiles(fp: Footprint, key: SymbolKey): string[] {
  const seen = fp.symbols.referencedIn ?? {};
  if (seen[key]) return seen[key];
  const name = symbolName(key);
  const path = symbolPath(key);
  const files = Object.entries(seen)
    .filter(([k]) => symbolName(k) === name && (!path || !symbolPath(k) || symbolPath(k) === path))
    .flatMap(([, fs]) => fs);
  if (files.length) return [...new Set(files)];
  return fp.symbols.referenced.some((k) => symbolName(k) === name && (!path || !symbolPath(k) || symbolPath(k) === path)) ? Object.keys(fp.files) : [];
}

/* ───────────────────────── parameter lists and calls ───────────────────────── */

interface Param {
  optional: boolean;
  rest: boolean;
}

/** The parameters of a signature ("f(a, b = 1, ...c)"), or undefined when it has no parameter list. */
export function paramsOf(signature: string): Param[] | undefined {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  return splitTop(signature.slice(open + 1, close), true)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const head = p.split(/[=:]/)[0].trim();
      return { rest: p.startsWith("..."), optional: topLevelHas(p, "=") || head.endsWith("?") };
    });
}

/** Do calls of the form `want` still work with the parameter list `have`? Types and names do not count. */
export function keepsValid(have: string, want: string): boolean {
  const h = paramsOf(have);
  const w = paramsOf(want);
  if (!h || !w) return have.replace(/\s+/g, "") === want.replace(/\s+/g, "");
  if (have.slice(0, have.indexOf("(")).trim() !== want.slice(0, want.indexOf("(")).trim()) return false;
  for (let i = 0; i < w.length; i++) {
    const p = h[i];
    if (!p) return false; // a parameter of the asked form is gone
    if (p.rest) return true; // a rest parameter takes all the others
    if (w[i].optional && !p.optional) return false; // a call that leaves it out does not work the same way
  }
  return h.slice(w.length).every((p) => p.optional || p.rest);
}

/** Does a function with this signature take `n` arguments? */
export function takes(signature: string, n: number): boolean {
  const ps = paramsOf(signature);
  if (!ps) return true;
  let min = 0;
  ps.forEach((p, i) => {
    if (!p.optional && !p.rest) min = i + 1;
  });
  const max = ps.some((p) => p.rest) ? Number.POSITIVE_INFINITY : ps.length;
  return n >= min && n <= max;
}

/**
 * The number of arguments of each call of `name` in a source text. Definitions (`function name(`, a method
 * `name(a) {`) and calls with a spread argument do not count. Comments are left out.
 */
export function callArgCounts(src: string, name: string): number[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [];
  const text = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
  const out: number[] = [];
  const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (/(^|[^\w$])function\s*\*?\s*$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const close = closeOf(text, open);
    if (close < 0) continue;
    if (/^\s*\{/.test(text.slice(close + 1, close + 20))) continue; // a method definition: name(a, b) { … }
    const args = splitTop(text.slice(open + 1, close)).map((a) => a.trim()).filter(Boolean);
    if (args.some((a) => a.startsWith("..."))) continue;
    out.push(args.length);
  }
  return out;
}

/** The index of the ")" that closes the "(" at `open`, or -1. Strings and nested brackets count as one. */
function closeOf(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i = endOfString(s, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return c === ")" ? i : -1;
    }
  }
  return -1;
}

function endOfString(s: string, start: number): number {
  const q = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === q) return i;
  }
  return s.length;
}

/** Split on commas that are not inside brackets or strings. `angles`: "<" and ">" are brackets too (type parameters). */
function splitTop(s: string, angles = false): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = endOfString(s, i);
      cur += s.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{" || (angles && c === "<")) depth++;
    else if (c === ")" || c === "]" || c === "}" || (angles && c === ">" && s[i - 1] !== "=")) depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Is `ch` in `s` outside brackets and strings? */
function topLevelHas(s: string, ch: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i = endOfString(s, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth = Math.max(0, depth - 1);
    else if (c === ch && depth === 0 && s[i + 1] !== ">" && s[i + 1] !== "=") return true;
  }
  return false;
}
