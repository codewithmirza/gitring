/**
 * Layer 1 of 6 of the type strip: bracket pairs, token lookups, the list of cuts and the output text.
 *
 * The strip is one class chain, one layer in each file. Next layer: `ts-type-skip.ts`.
 * Never throw here. A construct that gitring does not understand sets `failed`.
 */

import { TOKEN_CATEGORIES } from "./ts-tokens";
import type { Tok } from "./ts-tokens";

const EXPR_END_TAGS = new Set(["name", "num", "string", "regexp", "privateId", ")", "]", "`", "this", "super", "null", "true", "false"]);

/** The token list of one TypeScript file, with its bracket pairs, the cuts that blank the types, and the output text. */
export class TsCursor {
  protected readonly n: number;
  private readonly match: Int32Array;
  private readonly cuts: [number, number][] = [];
  protected readonly edits: [number, string][] = [];
  failed = false;
  /** Cut ranges in token space: end index (exclusive) → start index. */
  private readonly cutStartAt = new Map<number, number>();
  /** Names that only exist as types in this file (interfaces, type aliases, type imports, ambient declarations). */
  protected typeOnlyNames = new Set<string>();

  constructor(
    protected readonly src: string,
    protected readonly toks: Tok[],
    protected readonly tsx: boolean,
  ) {
    this.n = toks.length;
    this.match = new Int32Array(this.n).fill(-1);
  }

  /** Pair brackets; false if they do not balance. */
  pair(): boolean {
    const stack: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const t = this.toks[i].t;
      if (t === "(" || t === "[" || t === "{" || t === "${") stack.push(i);
      else if (t === "`") {
        if (stack.length && this.toks[stack[stack.length - 1]].t === "`") {
          const o = stack.pop()!;
          this.match[o] = i;
          this.match[i] = o;
        } else stack.push(i);
      } else if (t === ")" || t === "]" || t === "}") {
        const o = stack.pop();
        if (o === undefined) return false;
        const ot = this.toks[o].t;
        if ((t === ")" && ot !== "(") || (t === "]" && ot !== "[") || (t === "}" && ot !== "{" && ot !== "${")) return false;
        this.match[o] = i;
        this.match[i] = o;
      }
    }
    return stack.length === 0;
  }

  protected t(i: number): string {
    return i >= 0 && i < this.n ? this.toks[i].t : "eof";
  }

  protected word(i: number): string {
    return i >= 0 && i < this.n && this.toks[i].t === "name" ? this.toks[i].v : "";
  }

  protected nl(i: number): boolean {
    return i >= 0 && i < this.n ? this.toks[i].nl : true;
  }

  protected isKey(i: number): boolean {
    const t = this.t(i);
    return t === "name" || t === "num" || t === "string" || t === "privateId" || /^[a-z]+$/.test(t) && !TOKEN_CATEGORIES.has(t) && t !== "eof";
  }

  protected cut(i: number, j: number): void {
    if (!(j > i && i >= 0)) return;
    const end = Math.min(j, this.n);
    this.cuts.push([this.toks[i].s, this.toks[end - 1].e]);
    const prev = this.cutStartAt.get(end);
    if (prev === undefined || i < prev) this.cutStartAt.set(end, i);
  }

  /** The token before i, skipping tokens that were cut (types end before the next real token). */
  protected effPrev(i: number): number {
    let p = i;
    for (let guard = 0; guard < 64; guard++) {
      const s = this.cutStartAt.get(p);
      if (s === undefined || s >= p) break;
      p = s;
    }
    return p - 1;
  }

  /** Does token k end an expression? A keyword after "." or "?." is a property name. */
  protected endsExpr(k: number): boolean {
    const t = this.t(k);
    if (EXPR_END_TAGS.has(t)) return true;
    return /^[a-z]+$/.test(t) && !TOKEN_CATEGORIES.has(t) && t !== "eof" && (this.t(k - 1) === "." || this.t(k - 1) === "?.");
  }

  /** Pre-pass: which names are type-only (an `export { X }` of such a name is dropped, as TypeScript does). */
  collectTypeOnlyNames(): void {
    const types = new Set<string>();
    const values = new Set<string>();
    for (let i = 0; i < this.n; i++) {
      const t = this.t(i);
      const w = this.word(i);
      const nextName = this.t(i + 1) === "name" && !this.nl(i + 1) ? this.word(i + 1) : "";
      if ((w === "interface" || w === "type") && nextName && (w === "interface" || this.t(i + 2) === "=" || this.t(i + 2) === "<")) types.add(nextName);
      else if (w === "declare") {
        let k = i + 1;
        while (this.word(k) === "abstract" || this.word(k) === "async" || this.t(k) === "const" || this.word(k) === "enum") k++;
        if (this.t(k) === "function" || this.t(k) === "class" || this.t(k) === "var" || this.word(k) === "let" || this.word(k) === "namespace" || this.word(k) === "module") k++;
        if (this.t(k) === "name") types.add(this.word(k));
      } else if (t === "import" && this.t(i - 1) !== "." && this.t(i + 1) !== "(" && this.t(i + 1) !== ".") {
        // imports stay bindings after the strip (type-only ones too), so they are values here
        for (let k = i + 1; k < this.n && this.t(k) !== "string" && this.t(k) !== ";"; k++) {
          if (this.t(k) !== "name" || this.word(k) === "type" || this.word(k) === "as" || this.word(k) === "from") continue;
          if (this.t(k + 1) === "name" && this.word(k + 1) === "as") continue; // `a as b`: the local name is b
          values.add(this.word(k));
        }
      } else if ((t === "function" || t === "class") && this.t(i + 1) === "name" && this.word(i - 1) !== "declare") values.add(this.word(i + 1));
      else if ((t === "const" || t === "var" || w === "let") && this.t(i + 1) === "name" && this.word(i - 1) !== "declare") values.add(this.word(i + 1));
      else if ((w === "enum" || w === "namespace") && nextName && this.word(i - 1) !== "declare") values.add(nextName);
    }
    for (const v of values) types.delete(v);
    this.typeOnlyNames = types;
  }

  protected fail(): number {
    this.failed = true;
    return this.n;
  }

  protected closeOf(i: number): number {
    const m = this.match[i];
    return m < 0 ? -1 : m;
  }

  /** The stripped text; marks every blanked position in `removed` (positions written by edits are kept). */
  output(removed: Uint8Array): string {
    const merged: [number, number][] = [];
    for (const [s, e] of [...this.cuts].sort((a, b) => a[0] - b[0])) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    const parts: string[] = [];
    let pos = 0;
    for (const [s, e] of merged) {
      if (s > pos) parts.push(this.src.slice(pos, s));
      parts.push(this.src.slice(s, e).replace(/[^\n\r]/g, " "));
      removed.fill(1, s, e);
      pos = e;
    }
    parts.push(this.src.slice(pos));
    let out = parts.join("");
    if (this.edits.length) {
      const pieces: string[] = [];
      let p = 0;
      for (const [s, text] of [...this.edits].sort((a, b) => a[0] - b[0])) {
        if (s < p) continue;
        pieces.push(out.slice(p, s), text);
        removed.fill(0, s, s + text.length);
        p = s + text.length;
      }
      pieces.push(out.slice(p));
      out = pieces.join("");
    }
    return out;
  }
}
