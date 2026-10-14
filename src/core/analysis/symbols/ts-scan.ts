/**
 * Layer 6 of 6 of the type strip: the main scan. It walks the tokens and cuts every type position.
 *
 * Called by `ts-strip.ts`. Read `run` and `scanToken` first.
 */

import { TsDeclarationReader } from "./ts-scan-declarations";
import type { ScanCtx, ScanKind } from "./ts-scan-heads";
import type { Tok } from "./ts-tokens";

/** Tokens after which a `{` starts an object literal. */
const OBJECT_AFTER = new Set([
  "=", "(", "[", ",", "?", "??", "||", "&&", "|", "&", "^", "==", "===", "!=", "!==", "<", ">", "<=", ">=", "<<",
  ">>", ">>>", "+", "-", "*", "/", "%", "**", "!", "~", "...", "return", "typeof", "void", "delete", "in",
  "instanceof", "new", "case", "throw", "${", "default", "?.", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=",
  ">>>=", "&=", "|=", "^=", "&&=", "||=", "??=", "extends", "yield", "await",
]);

/** The type strip. `run` cuts every type out of the tokens, and `output` gives the stripped text. */
export class TsStripper extends TsDeclarationReader {
  /** Walks every token once. A class member head, an object key or a parameter start is read first. Any other token goes to `scanToken`. */
  run(): void {
    while (this.i < this.n && !this.failed) {
      const ctx = this.stack[this.stack.length - 1];
      const tok = this.toks[this.i];
      if (this.readClassMember(ctx, tok)) continue;
      if (this.readObjectKey(ctx, tok)) continue;
      if (this.readParamStart(ctx)) continue;
      this.scanToken(ctx, tok);
    }
  }

  /** One token that is not a class member, an object key or a parameter start. Every case moves the position `i` on. */
  protected scanToken(ctx: ScanCtx, tok: Tok): void {
    const t = tok.t;
    switch (t) {
      case "(":
        this.openParen();
        return;
      case "[":
        this.stack.push({ k: "bracket" });
        this.i++;
        return;
      case "${":
        this.stack.push({ k: "template" });
        this.i++;
        return;
      case "{":
        this.openBrace(ctx);
        return;
      case ")":
        this.closeParen(ctx, tok);
        return;
      case "]":
      case "}": {
        this.stack.pop();
        const parent = this.stack[this.stack.length - 1];
        if (!parent) return void this.fail();
        if (t === "}" && parent.k === "class" && ctx.k === "block") parent.memberStart = true;
        this.i++;
        return;
      }
      case ",":
        this.scanComma(ctx);
        return;
      case ";":
        ctx.varDecl = false;
        if (ctx.k === "class") ctx.memberStart = true;
        this.i++;
        return;
      case "=":
        if (ctx.k === "params") ctx.inDefault = true;
        this.i++;
        return;
      case "?":
        this.scanQuestionMark(ctx);
        return;
      case ":":
        this.scanColon(ctx);
        return;
      case "!":
        if (this.i > 0 && !tok.nl && this.endsExpr(this.effPrev(this.i))) this.cut(this.i, this.i + 1);
        this.i++;
        return;
      case "<":
        this.openAngle();
        return;
      case "function":
        this.scanFunction();
        return;
      case "class":
        this.scanClass();
        return;
      case "import":
        this.scanImport(tok);
        return;
      case "export":
        this.scanExport();
        return;
      case "const":
      case "var":
        this.scanConstOrVar(ctx, tok);
        return;
      case "name":
        this.scanName(ctx, tok);
        return;
      default:
        this.i++;
        return;
    }
  }

  /** A comma: the next parameter or object key starts, or the next declarator of a `const` list. */
  protected scanComma(ctx: ScanCtx): void {
    if (ctx.k === "params") {
      ctx.paramStart = true;
      ctx.inDefault = false;
    } else if (ctx.k === "object") ctx.atKey = true;
    else if (ctx.varDecl) {
      this.i = this.varBinding(this.i + 1);
      return;
    }
    this.i++;
  }

  /** A `?` in a parameter list: an optional parameter mark is a type position, so it is cut. */
  protected scanQuestionMark(ctx: ScanCtx): void {
    if (ctx.k === "params" && !ctx.inDefault) {
      const next = this.t(this.i + 1);
      if (next === ":" || next === "," || next === ")" || next === "=") this.cut(this.i, this.i + 1);
    }
    this.i++;
  }

  /** A `:` in a parameter list: the type after it is cut. */
  protected scanColon(ctx: ScanCtx): void {
    if (ctx.k === "params" && !ctx.inDefault) {
      const k = this.skipType(this.i + 1);
      if (k < 0) return void this.fail();
      this.cut(this.i, k);
      this.i = k;
      return;
    }
    this.i++;
  }

  /** An opening `(`: a parameter list (a function, a catch clause or an arrow), or a plain group or call. */
  protected openParen(): void {
    let kind: ScanKind = "paren";
    let fnStart = -1;
    let arrow = false;
    if (this.pendingParams && this.pendingParams.at === this.i) {
      kind = "params";
      fnStart = this.pendingParams.fnStart;
      this.pendingParams = null;
    } else if (this.t(this.effPrev(this.i)) === "catch") {
      kind = "params";
    } else {
      const pi = this.effPrev(this.i);
      const prev = this.t(pi);
      const isCall = (this.endsExpr(pi) && !(prev === "name" && this.word(pi) === "async")) || prev === "}";
      if (!isCall) {
        const c = this.closeOf(this.i);
        if (c > 0 && this.t(c + 1) === "=>" && !this.nl(c + 1)) {
          kind = "params";
          arrow = true;
        } else if (c > 0 && this.t(c + 1) === ":") {
          const k = this.skipReturnType(c + 2);
          if (k > 0 && this.t(k) === "=>" && !this.nl(k)) {
            kind = "params";
            arrow = true;
          }
        }
      }
    }
    this.stack.push(kind === "params" ? { k: kind, paramStart: true, inDefault: false, fnStart, arrow } : { k: kind });
    this.i++;
  }

  /** An opening `{`: a block, a class body or an object literal, by what comes before it. */
  protected openBrace(ctx: ScanCtx): void {
    let kind: ScanKind;
    if (this.pendingBrace) {
      kind = this.pendingBrace;
      this.pendingBrace = null;
    } else {
      const pi = this.effPrev(this.i);
      const p = this.t(pi);
      if (pi < 0 || p === "=>" || p === ")" || p === ";" || p === "{" || p === "}" || p === "else" || p === "do" || p === "try" || p === "finally") kind = "block";
      else if (p === ":") kind = ctx.k === "object" || ctx.k === "params" || ctx.k === "paren" || ctx.k === "bracket" ? "object" : this.colonStartsBlock(pi) ? "block" : "object";
      else if (OBJECT_AFTER.has(p) || (p === "name" && (this.word(pi) === "await" || this.word(pi) === "yield"))) kind = "object";
      else kind = "block";
      if (ctx.k === "params" && (p === "(" || p === ",")) kind = "object";
    }
    this.stack.push(kind === "class" ? { k: kind, memberStart: true } : kind === "object" ? { k: kind, atKey: true } : { k: kind });
    this.i++;
  }

  /** A closing `)`: after a parameter list, it cuts the return type and an overload signature without a body. */
  protected closeParen(ctx: ScanCtx, tok: Tok): void {
    this.stack.pop();
    if (ctx.k !== "params") {
      this.i++;
      return;
    }
    let j = this.i + 1;
    if (this.t(j) === ":" && ctx.fnStart !== undefined) {
      const k = this.skipReturnType(j + 1);
      if (k < 0) return void this.fail();
      this.cut(j, k);
      j = k;
      // JS allows no line break between arrow params and "=>": move ")" next to "=>"
      const arrowAt = this.toks[k]?.s ?? -1;
      if (this.t(k) === "=>" && this.src.slice(tok.e, arrowAt).includes("\n")) {
        const slot = arrowAt - 1;
        if (slot >= tok.e && this.src[slot] !== "\n" && this.src[slot] !== "\r") {
          this.cut(this.i, this.i + 1);
          this.edits.push([slot, ")"]);
        } else return void this.fail();
      }
    }
    if (this.t(j) === "{") this.pendingBrace = "block";
    else if (this.t(j) !== "=>" && !ctx.arrow && (ctx.fnStart ?? -1) >= 0) {
      // no body: an overload, abstract or ambient signature
      const end = this.t(j) === ";" ? j + 1 : j;
      this.cut(ctx.fnStart!, end);
      const parent = this.stack[this.stack.length - 1];
      if (parent.k === "class") parent.memberStart = true;
      this.i = end;
      return;
    }
    this.i = j;
  }

  /** A `<`: the type arguments of a call, or a type assertion or generic arrow outside a .tsx file. It cuts them. */
  protected openAngle(): void {
    const pi = this.effPrev(this.i);
    const prev = this.t(pi);
    if (pi >= 0 && this.endsExpr(pi) && prev !== "num" && prev !== "string") {
      const nameLike = prev === "name" || (prev !== "eof" && /^[a-z]+$/.test(prev) && (this.t(pi - 1) === "." || this.t(pi - 1) === "?."));
      const k = nameLike ? this.skipAngle(this.i) : -1;
      if (k > 0 && (this.t(k) === "(" || this.t(k) === "`")) {
        this.cut(this.i, k);
        this.i = k;
        return;
      }
    } else if (!this.tsx) {
      const k = this.skipAngle(this.i);
      if (k > 0) {
        this.cut(this.i, k);
        this.i = k;
        return;
      }
    }
    this.i++;
  }
}
