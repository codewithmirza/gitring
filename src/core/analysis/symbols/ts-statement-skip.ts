/**
 * Layer 3 of 6 of the type strip: finds where a type-only statement ends (type alias, interface, declare, enum).
 *
 * Next layer: `ts-scan-heads.ts`.
 */

import { TsTypeSkipper } from "./ts-type-skip";

/** Finds where a whole type-only statement ends, and rewrites enums and namespaces. */
export class TsStatementSkipper extends TsTypeSkipper {
  /** Index after a statement that starts at i: through a top-level ";" or before a line break that ends it. */
  protected statementEnd(i: number): number {
    let j = i;
    while (j < this.n) {
      const t = this.t(j);
      if (t === ";") return j + 1;
      if (t === "}" || t === ")" || t === "]") return j; // unbalanced: the enclosing block ends here
      if (j > i && this.nl(j) && this.endsExpression(j - 1) && !this.continuesExpression(j)) return j;
      if (t === "(" || t === "[" || t === "{" || t === "${" || t === "`") {
        const c = this.closeOf(j);
        if (c < 0) return this.n;
        j = c + 1;
        continue;
      }
      j++;
    }
    return j;
  }

  protected endsExpression(i: number): boolean {
    return this.endsExpr(i) || this.t(i) === "}";
  }

  protected continuesExpression(i: number): boolean {
    const t = this.t(i);
    return t === "." || t === "?." || t === "=>" || t === "?" || t === ":" || t === "|" || t === "&" || t === "=" || t === "," || t === "extends" || t === "[" || t === "(" || t === "<" || t === ">" || (t === "name" && (this.word(i) === "as" || this.word(i) === "satisfies"));
  }

  /** Index after `type Name<…> = Type;` starting at the `type` word. */
  protected typeAliasEnd(i: number): number {
    let j = i + 2;
    if (this.t(j) === "<") j = this.skipAngle(j);
    if (j < 0 || this.t(j) !== "=") return -1;
    j = this.skipType(j + 1);
    if (j < 0) return -1;
    return this.t(j) === ";" ? j + 1 : j;
  }

  /** Index after `interface Name<…> extends A, B { … }` starting at the `interface` word. */
  protected interfaceEnd(i: number): number {
    let j = i + 1;
    while (j < this.n && this.t(j) !== "{") {
      if (this.t(j) === "<") {
        const k = this.skipAngle(j);
        if (k < 0) return -1;
        j = k;
        continue;
      }
      if (this.t(j) === ";" || this.t(j) === "}") return -1;
      j++;
    }
    const c = this.closeOf(j);
    return c < 0 ? -1 : c + 1;
  }

  /** Index after an ambient declaration (`declare …`) starting at the `declare` word. */
  protected declareEnd(i: number): number {
    const j = i + 1;
    const t = this.t(j);
    const w = this.word(j);
    if (w === "type") return this.typeAliasEnd(j);
    if (w === "interface") return this.interfaceEnd(j);
    if (t === "function") {
      let k = j + 1;
      while (k < this.n && this.t(k) !== "(") {
        if (this.t(k) === "<") {
          const a = this.skipAngle(k);
          if (a < 0) return -1;
          k = a;
          continue;
        }
        k++;
      }
      const c = this.closeOf(k);
      if (c < 0) return -1;
      let e = c + 1;
      if (this.t(e) === ":") e = this.skipReturnType(e + 1);
      if (e < 0) return -1;
      return this.t(e) === ";" ? e + 1 : e;
    }
    if (t === "class" || w === "module" || w === "namespace" || w === "global" || w === "enum" || w === "abstract" || (t === "const" && this.word(j + 1) === "enum")) {
      let k = j;
      while (k < this.n && this.t(k) !== "{") {
        if (this.t(k) === ";") return k + 1;
        k++;
      }
      const c = this.closeOf(k);
      return c < 0 ? -1 : c + 1;
    }
    return this.statementEnd(j);
  }

  /** `enum E { … }` / `namespace N { … }` → `var E;` (same length, blanks the body). `start` may be `const`. */
  protected rewriteAsVar(start: number, nameIdx: number): number {
    let k = nameIdx + 1;
    while (k < this.n && this.t(k) !== "{") {
      if (this.t(k) === ";") return -1;
      k++;
    }
    const c = this.closeOf(k);
    if (c < 0) return -1;
    this.cut(start, c + 1);
    const name = this.toks[nameIdx].v;
    const text = `var ${name};`;
    const s = this.toks[start].s;
    if (/^[\w$]+$/.test(name) && !this.src.slice(s, s + text.length).includes("\n") && s + text.length <= this.toks[c].e) {
      this.edits.push([s, text]);
    }
    return c + 1;
  }

  /**
   * Specifier list `{ … }` at open..close: drop `type` modifiers. In a local export list
   * (`localExport`), drop whole specifiers whose name exists only as a type, as TypeScript does.
   */
  protected stripTypeSpecifiers(open: number, close: number, localExport = false): void {
    let k = open + 1;
    while (k < close) {
      let e = k;
      while (e < close && this.t(e) !== ",") e++;
      const typeWord = this.word(k) === "type" && e > k + 1 && this.word(k + 1) !== "as";
      const name = this.word(typeWord ? k + 1 : k);
      if (localExport && e > k && this.typeOnlyNames.has(name)) {
        if (this.t(e) === ",") this.cut(k, e + 1);
        else if (this.t(k - 1) === ",") this.cut(k - 1, e);
        else this.cut(k, e);
      } else if (typeWord) this.cut(k, k + 1);
      k = e + 1;
    }
  }

  /** Index after the module specifier (and attributes and ";") of an import/export starting at i. */
  protected moduleStatementEnd(i: number): number {
    let j = i;
    while (j < this.n && this.t(j) !== "string") {
      if (this.t(j) === ";") return j + 1;
      if (this.t(j) === "{") {
        const c = this.closeOf(j);
        if (c < 0) return this.n;
        j = c + 1;
        continue;
      }
      if (j > i && this.nl(j) && this.t(j - 1) === "}" && this.word(j) !== "from") return j;
      j++;
    }
    j++;
    if ((this.word(j) === "with" || this.word(j) === "assert") && this.t(j + 1) === "{") j = this.closeOf(j + 1) + 1;
    return this.t(j) === ";" ? j + 1 : j;
  }

  /** After `label:` or `case x:` a `{` starts a block; after a ternary `:` it starts an object. */
  protected colonStartsBlock(colon: number): boolean {
    for (let k = colon - 1, steps = 0; k >= 0 && steps < 64; k--, steps++) {
      const t = this.t(k);
      if (t === "case" || t === "default") return true;
      if (t === "?" || t === ";" || t === "{" || t === "}") return t !== "?" && k === colon - 2;
      if (this.nl(k)) return k === colon - 1;
    }
    return false;
  }
}
