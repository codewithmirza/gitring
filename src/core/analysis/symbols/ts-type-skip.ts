/**
 * Layer 2 of 6 of the type strip: finds where a type ends (unions, generics, function types and more).
 *
 * Next layer: `ts-statement-skip.ts`.
 */

import { TsCursor } from "./ts-cursor";

/** Tokens allowed inside `<…>` type arguments/parameters (besides bracketed groups, which are skipped). */
const ANGLE_TOKENS = new Set([
  "name", "num", "string", "template", ",", ".", "|", "&", "?", ":", "=>", "=", "...", "-", "extends", "typeof", "void",
  "null", "this", "true", "false", "new", "import", "in", "const", "default",
]);

/** Finds where a type starts and ends in the token list. */
export class TsTypeSkipper extends TsCursor {
  /** Index after `<…>` starting at i, or -1. */
  skipAngle(i: number): number {
    if (this.t(i) !== "<") return -1;
    let depth = 0;
    let j = i;
    while (j < this.n) {
      const t = this.t(j);
      if (t === "<") depth++;
      else if (t === ">" || t === ">>" || t === ">>>") {
        depth -= t.length;
        if (depth === 0) return j + 1;
        if (depth < 0) return -1;
      } else if (t === "(" || t === "[" || t === "{" || t === "`") {
        const c = this.closeOf(j);
        if (c < 0) return -1;
        j = c + 1;
        continue;
      } else if (!ANGLE_TOKENS.has(t) && !this.isKey(j)) return -1;
      j++;
    }
    return -1;
  }

  /** Index after a type starting at i, or -1. */
  skipType(i: number, depth = 0): number {
    if (depth > 64) return -1;
    const j = this.skipUnion(i, depth);
    if (j < 0) return -1;
    if (this.t(j) === "extends" && !this.nl(j)) {
      const k = this.skipUnion(j + 1, depth + 1);
      if (k > 0 && this.t(k) === "?") {
        const x = this.skipType(k + 1, depth + 1);
        if (x > 0 && this.t(x) === ":") {
          const y = this.skipType(x + 1, depth + 1);
          if (y > 0) return y;
        }
      }
    }
    return j;
  }

  private skipUnion(i: number, depth: number): number {
    let j = i;
    if (this.t(j) === "|" || this.t(j) === "&") j++;
    j = this.skipPostfix(j, depth);
    while (j > 0 && (this.t(j) === "|" || this.t(j) === "&")) j = this.skipPostfix(j + 1, depth);
    return j;
  }

  private skipPostfix(i: number, depth: number): number {
    let j = this.skipPrimary(i, depth);
    while (j > 0 && this.t(j) === "[" && !this.nl(j)) {
      const c = this.closeOf(j);
      if (c < 0) return -1;
      j = c + 1;
    }
    return j;
  }

  private skipEntity(i: number): number {
    let j = i + 1;
    while (this.t(j) === "." && this.isKey(j + 1)) j += 2;
    return j;
  }

  /** Index after one primary type: a group, an object or tuple type, a literal, a function type or a name. Or -1. */
  private skipPrimary(i: number, depth: number): number {
    const t = this.t(i);
    switch (t) {
      case "(": {
        const c = this.closeOf(i);
        if (c < 0) return -1;
        return this.t(c + 1) === "=>" ? this.skipType(c + 2, depth + 1) : c + 1;
      }
      case "{":
      case "[":
      case "`": {
        const c = this.closeOf(i);
        return c < 0 ? -1 : c + 1;
      }
      case "<": {
        const k = this.skipAngle(i);
        if (k < 0 || this.t(k) !== "(") return -1;
        const c = this.closeOf(k);
        if (c < 0 || this.t(c + 1) !== "=>") return -1;
        return this.skipType(c + 2, depth + 1);
      }
      case "new": {
        let j = i + 1;
        if (this.t(j) === "<") j = this.skipAngle(j);
        if (j < 0 || this.t(j) !== "(") return -1;
        const c = this.closeOf(j);
        if (c < 0 || this.t(c + 1) !== "=>") return -1;
        return this.skipType(c + 2, depth + 1);
      }
      case "typeof":
        return this.skipTypeof(i, depth);
      case "import":
        return this.skipImportType(i);
      case "string":
      case "num":
      case "void":
      case "null":
      case "true":
      case "false":
      case "const":
        return i + 1;
      case "this":
        if (this.word(i + 1) === "is" && !this.nl(i + 1)) return this.skipType(i + 2, depth + 1);
        return i + 1;
      case "-":
        return this.t(i + 1) === "num" ? i + 2 : -1;
      case "name":
        return this.skipTypeName(i, depth);
      default:
        return -1;
    }
  }

  /** `typeof x` and `typeof import("x")`, with optional type arguments. */
  private skipTypeof(i: number, depth: number): number {
    let j: number;
    if (this.t(i + 1) === "import") {
      j = this.skipPrimary(i + 1, depth + 1);
      if (j < 0) return -1;
    } else {
      if (!this.isKey(i + 1)) return -1;
      j = this.skipEntity(i + 1);
    }
    if (this.t(j) === "<" && !this.nl(j)) {
      const k = this.skipAngle(j);
      if (k > 0) j = k;
    }
    return j;
  }

  /** `import("x").Name<T>`: a type that comes from another module. */
  private skipImportType(i: number): number {
    if (this.t(i + 1) !== "(") return -1;
    const c = this.closeOf(i + 1);
    if (c < 0) return -1;
    let j = c + 1;
    while (this.t(j) === "." && this.isKey(j + 1)) j += 2;
    if (this.t(j) === "<") {
      const k = this.skipAngle(j);
      if (k > 0) j = k;
    }
    return j;
  }

  /** A name: `keyof`, `unique`, `readonly`, `infer`, `asserts`, `abstract new`, or a plain (qualified, generic) type name. */
  private skipTypeName(i: number, depth: number): number {
    const w = this.word(i);
    const next = this.t(i + 1);
    const nextStartsType = next !== "eof" && !this.nl(i + 1) && next !== "," && next !== ")" && next !== "]" && next !== ">" && next !== ";" && next !== "=" && next !== "|" && next !== "&" && next !== "}" && next !== "?" && next !== ":" && next !== "." && next !== "<" && next !== "[";
    if ((w === "keyof" || w === "unique" || w === "readonly") && nextStartsType) return this.skipPostfix(i + 1, depth + 1);
    if (w === "infer" && this.t(i + 1) === "name") return i + 2;
    if (w === "asserts" && (this.t(i + 1) === "name" || this.t(i + 1) === "this") && !this.nl(i + 1)) {
      const j = i + 2;
      return this.word(j) === "is" && !this.nl(j) ? this.skipType(j + 1, depth + 1) : j;
    }
    if (w === "abstract" && next === "new") return this.skipPrimary(i + 1, depth);
    let j = this.skipEntity(i);
    if (this.t(j) === "<" && !this.nl(j)) {
      const k = this.skipAngle(j);
      if (k < 0) return -1;
      j = k;
    }
    if (this.word(j) === "is" && !this.nl(j)) return this.skipType(j + 1, depth + 1);
    return j;
  }

  /** Index after a return type (type predicates and `asserts` included), or -1. */
  protected skipReturnType(i: number): number {
    return this.skipType(i);
  }
}
