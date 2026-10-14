/**
 * Layer 4 of 6 of the type strip: reads class member heads, object keys and parameter starts.
 *
 * It also holds the scan state: the stack of contexts and the position. Next layer: `ts-scan-declarations.ts`.
 */

import { TsStatementSkipper } from "./ts-statement-skip";
import type { Tok } from "./ts-tokens";

// ───── Types ─────

export type ScanKind = "top" | "block" | "class" | "object" | "params" | "paren" | "bracket" | "template";

export interface ScanCtx {
  k: ScanKind;
  paramStart?: boolean;
  inDefault?: boolean;
  fnStart?: number;
  arrow?: boolean;
  memberStart?: boolean;
  /** Token index where the last member head was read (guards against re-reading it). */
  memberAt?: number;
  atKey?: boolean;
  varDecl?: boolean;
}

// ───── Constants ─────

const TS_CLASS_MODIFIERS = new Set(["public", "private", "protected", "readonly", "abstract", "override", "declare"]);
const TS_PARAM_MODIFIERS = new Set(["public", "private", "protected", "readonly", "override"]);
const JS_MEMBER_PREFIXES = new Set(["static", "async", "get", "set", "accessor"]);

// ───── The class ─────

/** Reads the places where types hide in a head: class members, object keys and parameters. Holds the scan state. */
export class TsHeadReader extends TsStatementSkipper {
  protected readonly stack: ScanCtx[] = [{ k: "top" }];
  protected pendingParams: { at: number; fnStart: number } | null = null;
  protected pendingBrace: ScanKind | null = null;
  /** The index of the token that the scan reads now. */
  protected i = 0;

  /** A binding after `const`, `var` or `let`: a name or a pattern, an optional `!` and an optional type. Returns the index after it. */
  protected varBinding(j: number): number {
    if (this.t(j) === "name") j++;
    else if (this.t(j) === "{" || this.t(j) === "[") {
      const c = this.closeOf(j);
      if (c < 0) return this.fail();
      j = c + 1;
    } else return j;
    if (this.t(j) === "!" && !this.nl(j)) {
      this.cut(j, j + 1);
      j++;
    }
    if (this.t(j) === ":") {
      const k = this.skipType(j + 1);
      if (k < 0) return this.fail();
      this.cut(j, k);
      j = k;
    }
    return j;
  }

  /** The modifiers before the name of a class member. TypeScript ones are cut. `static` and `async` stay. */
  protected skipClassModifiers(from: number): { j: number; ambient: boolean } {
    let j = from;
    let ambient = false;
    for (;;) {
      const w = this.word(j);
      if (!w) break;
      const after = this.t(j + 1);
      const modifierUse = !this.nl(j + 1) && (this.isKey(j + 1) || after === "[" || after === "*" || after === "{" || after === "#");
      if (!modifierUse) break;
      if (TS_CLASS_MODIFIERS.has(w)) {
        if (w === "abstract" || w === "declare") ambient = true;
        this.cut(j, j + 1);
        j++;
        continue;
      }
      if (JS_MEMBER_PREFIXES.has(w)) {
        j++;
        continue;
      }
      break;
    }
    return { j, ambient };
  }

  /** An index signature in a class (`[key: string]: T`): cut the whole member. */
  protected cutIndexSignature(ctx: ScanCtx, start: number, j: number): boolean {
    let k = this.closeOf(j) + 1;
    if (this.t(k) === "?") k++;
    if (this.t(k) === ":") k = this.skipType(k + 1);
    if (k < 0) { this.fail(); return true; }
    if (this.t(k) === ";") k++;
    this.cut(start, k);
    ctx.memberStart = true;
    this.i = k;
    return true;
  }

  /** An `abstract` or `declare` member has no code: cut the whole member. */
  protected cutAmbientMember(ctx: ScanCtx, start: number, j: number): boolean {
    let k = j;
    if (this.t(k) === "<") k = this.skipAngle(k);
    if (k > 0 && this.t(k) === "(") {
      k = this.closeOf(k) + 1;
      if (this.t(k) === ":") k = this.skipReturnType(k + 1);
    } else if (k > 0 && this.t(k) === ":") k = this.skipType(k + 1);
    if (k > 0 && this.t(k) === "=") k = this.statementEnd(k);
    if (k < 0) { this.fail(); return true; }
    if (this.t(k) === ";") k++;
    this.cut(start, k);
    ctx.memberStart = true;
    this.i = k;
    return true;
  }

  /** Class members: modifiers, keys, optional marks, field types and method type parameters. */
  protected readClassMember(ctx: ScanCtx, tok: Tok): boolean {
    const t = tok.t;
    if (ctx.k === "class") {
      if (!ctx.memberStart && ctx.memberAt !== this.i && tok.nl && this.endsExpression(this.effPrev(this.i)) && !this.continuesExpression(this.i)) ctx.memberStart = true;
      if (ctx.memberStart && ctx.memberAt !== this.i) {
        ctx.memberStart = false;
        ctx.memberAt = this.i;
        if (t === ";") {
          ctx.memberStart = true;
          this.i++;
          return true;
        }
        if (t === "}") {
          this.stack.pop();
          this.i++;
          return true;
        }
        const start = this.i;
        const modifiers = this.skipClassModifiers(this.i);
        let j = modifiers.j;
        const ambient = modifiers.ambient;
        if (this.t(j) === "{") {
          // static block
          this.i = j;
          this.pendingBrace = "block";
          return true;
        }
        if (this.t(j) === "[" && this.t(j + 1) === "name" && this.t(j + 2) === ":") return this.cutIndexSignature(ctx, start, j);
        if (this.t(j) === "*") j++;
        if (this.t(j) === "[") {
          const c = this.closeOf(j);
          if (c < 0) { this.fail(); return true; }
          j = c + 1;
        } else if (this.isKey(j)) j++;
        else {
          this.i = j;
          return true;
        }
        if ((this.t(j) === "?" || this.t(j) === "!") && !this.nl(j)) {
          this.cut(j, j + 1);
          j++;
        }
        if (ambient) return this.cutAmbientMember(ctx, start, j);
        if (this.t(j) === "<") {
          const k = this.skipAngle(j);
          if (k < 0) { this.fail(); return true; }
          this.cut(j, k);
          j = k;
        }
        if (this.t(j) === "(") {
          this.pendingParams = { at: j, fnStart: start };
        } else if (this.t(j) === ":") {
          const k = this.skipType(j + 1);
          if (k < 0) { this.fail(); return true; }
          this.cut(j, k);
          j = k;
        }
        // a field without initializer that ends at a line break: the next line is a new member
        const tj = this.t(j);
        if (tj !== "(" && tj !== "=" && tj !== ";" && tj !== "}" && this.nl(j)) ctx.memberStart = true;
        this.i = j;
        return true;
      }
    }
    return false;
  }

  /** Object literal (or destructuring pattern) keys: method shorthand gets its parameters. */
  protected readObjectKey(ctx: ScanCtx, tok: Tok): boolean {
    const t = tok.t;
    if (ctx.k === "object" && ctx.atKey) {
      ctx.atKey = false;
      let j = this.i;
      if (t !== "}" && t !== "...") {
        while ((this.word(j) === "get" || this.word(j) === "set" || this.word(j) === "async") && !this.nl(j + 1) && (this.isKey(j + 1) || this.t(j + 1) === "[" || this.t(j + 1) === "*")) j++;
        if (this.t(j) === "*") j++;
        if (this.t(j) === "[") {
          const c = this.closeOf(j);
          if (c < 0) { this.fail(); return true; }
          j = c + 1;
        } else if (this.isKey(j)) j++;
        if (this.t(j) === "<") {
          const k = this.skipAngle(j);
          if (k > 0 && this.t(k) === "(") {
            this.cut(j, k);
            j = k;
          }
        }
        if (this.t(j) === "(") this.pendingParams = { at: j, fnStart: -1 };
        if (j > this.i) {
          this.i = j;
          return true;
        }
      }
    }
    return false;
  }

  /** Parameter start: TypeScript parameter properties and `this` parameters. */
  protected readParamStart(ctx: ScanCtx): boolean {
    if (ctx.k === "params" && ctx.paramStart) {
      ctx.paramStart = false;
      let j = this.i;
      while (TS_PARAM_MODIFIERS.has(this.word(j)) && (this.t(j + 1) === "name" || this.t(j + 1) === "{" || this.t(j + 1) === "[")) {
        this.cut(j, j + 1);
        j++;
      }
      if (this.t(j) === "this" && this.t(j + 1) === ":") {
        let k = this.skipType(j + 2);
        if (k < 0) { this.fail(); return true; }
        if (this.t(k) === ",") k++;
        this.cut(j, k);
        ctx.paramStart = true;
        this.i = k;
        return true;
      }
      if (j > this.i) {
        this.i = j;
        return true;
      }
    }
    return false;
  }
}
