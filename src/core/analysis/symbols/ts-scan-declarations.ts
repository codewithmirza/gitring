/**
 * Layer 5 of 6 of the type strip: handles the keywords function, class, import, export, const, var and names.
 *
 * Next layer: `ts-scan.ts`.
 */

import { TsHeadReader } from "./ts-scan-heads";
import type { ScanCtx } from "./ts-scan-heads";
import type { Tok } from "./ts-tokens";

/** Handles the keywords that start a declaration or a type-only statement. */
export class TsDeclarationReader extends TsHeadReader {
  /** The keyword `function`: cuts its type parameters and marks its parameter list. */
  protected scanFunction(): void {
    let start = this.i;
    while (start > 0 && ["async", "declare"].includes(this.word(start - 1))) start--;
    while (start > 0 && (this.t(start - 1) === "export" || this.t(start - 1) === "default")) start--;
    let j = this.i + 1;
    if (this.t(j) === "*") j++;
    if (this.t(j) === "name") j++;
    if (this.t(j) === "<") {
      const k = this.skipAngle(j);
      if (k < 0) return void this.fail();
      this.cut(j, k);
      j = k;
    }
    if (this.t(j) === "(") this.pendingParams = { at: j, fnStart: start };
    this.i = j;
  }

  /** The keyword `class`: cuts type parameters, `implements` and the type arguments of `extends`. */
  protected scanClass(): void {
    let j = this.i + 1;
    if (this.t(j) === "name" && this.word(j) !== "implements") j++;
    if (this.t(j) === "<") {
      const k = this.skipAngle(j);
      if (k < 0) return void this.fail();
      this.cut(j, k);
      j = k;
    }
    if (this.t(j) === "extends") {
      j++;
      while (j < this.n && this.t(j) !== "{" && this.word(j) !== "implements") {
        const tj = this.t(j);
        if (tj === "(" || tj === "[") {
          j = this.closeOf(j) + 1;
          continue;
        }
        if (tj === "<") {
          const k = this.skipAngle(j);
          if (k > 0) {
            this.cut(j, k);
            j = k;
            continue;
          }
        }
        j++;
      }
    }
    if (this.word(j) === "implements") {
      let k = j + 1;
      while (k < this.n && this.t(k) !== "{") {
        if (this.t(k) === "<") {
          const a = this.skipAngle(k);
          if (a < 0) return void this.fail();
          k = a;
          continue;
        }
        k++;
      }
      this.cut(j, k);
      j = k;
    }
    if (this.t(j) === "{") this.pendingBrace = "class";
    this.i = j;
  }

  /** An `import`: drops `type` modifiers and rewrites `import x = require()`. */
  protected scanImport(tok: Tok): void {
    const next = this.t(this.i + 1);
    if (next === "(" || next === ".") {
      this.i++;
      return;
    }
    let j = this.i + 1;
    // `import type …` stays an import (a type-only import is still a dependency): drop the modifier only
    if (this.word(j) === "type" && (this.t(j + 1) === "{" || this.t(j + 1) === "*" || (this.t(j + 1) === "name" && this.word(j + 1) !== "from"))) {
      this.cut(j, j + 1);
      j++;
    }
    if (this.t(j) === "name" && this.t(j + 1) === "=") {
      // import x = require("y") / import x = A.B  →  const x = …
      this.edits.push([tok.s, "const "]);
      this.i = j;
      return;
    }
    const end = this.moduleStatementEnd(j);
    for (let k = j; k < end && this.t(k) !== "string"; k++) {
      if (this.t(k) === "{") {
        this.stripTypeSpecifiers(k, this.closeOf(k));
        break;
      }
    }
    this.i = end;
  }

  /** An `export`: cuts type-only exports and drops type names from export lists. */
  protected scanExport(): void {
    const j = this.i + 1;
    const w = this.word(j);
    if (w === "type" && (this.t(j + 1) === "{" || this.t(j + 1) === "*")) {
      const end = this.moduleStatementEnd(j + 1);
      const close = this.t(j + 1) === "{" ? this.closeOf(j + 1) : -1;
      if (this.t(j + 1) === "*" || this.word(close + 1) === "from") {
        // `export type { X } from "y"` stays a re-export (a dependency): drop the modifier only
        this.cut(j, j + 1);
        if (close > 0) this.stripTypeSpecifiers(j + 1, close);
      } else this.cut(this.i, end); // a local type-only export list
      this.i = end;
      return;
    }
    if (w === "type" && this.t(j + 1) === "name" && (this.t(j + 2) === "=" || this.t(j + 2) === "<")) {
      const end = this.typeAliasEnd(j);
      if (end < 0) return void this.fail();
      this.cut(this.i, end);
      this.i = end;
      return;
    }
    if (w === "interface" && this.t(j + 1) === "name") {
      const end = this.interfaceEnd(j);
      if (end < 0) return void this.fail();
      this.cut(this.i, end);
      this.i = end;
      return;
    }
    if (this.t(j) === "default" && this.word(j + 1) === "interface") {
      const end = this.interfaceEnd(j + 1);
      if (end < 0) return void this.fail();
      this.cut(this.i, end);
      this.i = end;
      return;
    }
    if (w === "declare") {
      const end = this.declareEnd(j);
      if (end < 0) return void this.fail();
      this.cut(this.i, end);
      this.i = end;
      return;
    }
    if (this.t(j) === "=" || (w === "as" && this.word(j + 1) === "namespace")) {
      const end = this.statementEnd(j);
      this.cut(this.i, end);
      this.i = end;
      return;
    }
    if (this.t(j) === "{" || this.t(j) === "*") {
      const end = this.moduleStatementEnd(j);
      if (this.t(j) === "{") {
        const close = this.closeOf(j);
        // a local export list (no `from`) drops names that exist only as types
        this.stripTypeSpecifiers(j, close, this.word(close + 1) !== "from");
      }
      this.i = end;
      return;
    }
    this.i = j;
  }

  /** The keyword `const` or `var`: rewrites a const enum, or reads the binding of a declaration. */
  protected scanConstOrVar(ctx: ScanCtx, tok: Tok): void {
    const t = tok.t;
    if (t === "const" && this.word(this.i + 1) === "enum" && this.t(this.i + 2) === "name") {
      const end = this.rewriteAsVar(this.i, this.i + 2);
      if (end < 0) return void this.fail();
      this.i = end;
      return;
    }
    ctx.varDecl = true;
    this.i = this.varBinding(this.i + 1);
  }

  /** A name token: `as`, `satisfies`, `type`, `interface`, `declare`, `enum`, `namespace`, `abstract` and `let`. */
  protected scanName(ctx: ScanCtx, tok: Tok): void {
    const w = tok.v;
    const next = this.t(this.i + 1);
    const sameLine = !this.nl(this.i + 1);
    if (w === "let" && (next === "name" || next === "{" || next === "[")) {
      ctx.varDecl = true;
      this.i = this.varBinding(this.i + 1);
      return;
    }
    if ((w === "as" || w === "satisfies") && this.i > 0 && !tok.nl && this.endsExpression(this.effPrev(this.i)) && next !== "eof") {
      const k = this.skipType(this.i + 1);
      if (k > 0) {
        this.cut(this.i, k);
        this.i = k;
        return;
      }
    }
    if (w === "type" && next === "name" && sameLine && (this.t(this.i + 2) === "=" || this.t(this.i + 2) === "<")) {
      const end = this.typeAliasEnd(this.i);
      if (end > 0) {
        this.cut(this.i, end);
        this.i = end;
        return;
      }
    }
    if (w === "interface" && next === "name" && sameLine) {
      const end = this.interfaceEnd(this.i);
      if (end < 0) return void this.fail();
      this.cut(this.i, end);
      this.i = end;
      return;
    }
    if (w === "declare" && sameLine && (next === "const" || next === "var" || next === "class" || next === "function" || ["let", "enum", "module", "namespace", "global", "type", "interface", "abstract", "async"].includes(this.word(this.i + 1)))) {
      const end = this.declareEnd(this.i);
      if (end < 0) return void this.fail();
      this.cut(this.i, end);
      this.i = end;
      return;
    }
    if (w === "enum" && next === "name" && sameLine) {
      const end = this.rewriteAsVar(this.i, this.i + 1);
      if (end < 0) return void this.fail();
      this.i = end;
      return;
    }
    if ((w === "namespace" || w === "module") && next === "name" && sameLine && this.t(this.i + 2) !== "=") {
      let k = this.i + 2;
      while (this.t(k) === "." && this.t(k + 1) === "name") k += 2;
      if (this.t(k) === "{") {
        const end = this.rewriteAsVar(this.i, this.i + 1);
        if (end < 0) return void this.fail();
        this.i = end;
        return;
      }
    }
    if (w === "abstract" && next === "class" && sameLine) {
      this.cut(this.i, this.i + 1);
      this.i++;
      return;
    }
    this.i++;
  }
}
