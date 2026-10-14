/**
 * The types of the symbol reader: declarations, imports, module symbols, class members and path aliases.
 *
 * Read through `../symbols`, the front door. This file holds types only.
 */

import type { LineRange } from "../../types";

// ───── Contract types ─────

export interface DeclInfo {
  name: string;
  kind: "function" | "class" | "const" | "let" | "var";
  /** Parameter source texts, whitespace collapsed (function declarations and const/let/var arrow or function expressions). */
  params?: string[];
  /** `name(p1, p2)` when `params` is known. */
  signature?: string;
  /** Lines of the whole statement (including `export`), 1-based inclusive. */
  range: LineRange;
  exported: boolean;
}

export interface ImportInfo {
  /** Module specifier as written. */
  from: string;
  /** Repo path of the target, when a file set was given and the specifier is relative. */
  resolved?: string;
  /** `imported` is "default", "*" (namespace or `export *`) or a name. */
  names: { imported: string; local: string }[];
}

export interface ModuleSymbols {
  path: string;
  /** Top-level declarations (incl. arrow functions in const/let/var, and the anonymous default export as "default"). */
  decls: Record<string, DeclInfo>;
  /** Exported name → local name ("default" supported). Re-exports map the name to itself. */
  exports: Record<string, string>;
  /**
   * Static imports and `export … from` re-exports (dynamic `import()` is ignored). TypeScript
   * type-only imports are included: they are dependencies too.
   */
  imports: ImportInfo[];
  /** Top-level declaration name → identifiers it uses (not its own locals). `ns.fn` gives "ns" and "ns.fn". */
  references: Record<string, string[]>;
  /** Identifiers used at module top level outside any declaration. */
  topLevelReferences: string[];
  parseError?: string;
}

// ───── Extension types ─────

/** A local name bound by an `import` declaration (re-exports are not local bindings). */
export interface ImportBinding {
  from: string;
  /** "default", "*" (namespace) or the exported name. */
  imported: string;
}

/**
 * A member of a top-level class or of a top-level object literal (`const api = { list() {} }`,
 * `export default { fetch() {} }`): a method, a getter or setter, or a field.
 */
export interface MemberInfo {
  /** `Owner.name`, for example `Cart.add`, `Cart.#items` or `default.fetch`. */
  name: string;
  /** The top-level declaration that holds the member. */
  owner: string;
  kind: "method" | "get" | "set" | "field";
  static?: boolean;
  /** Parameter texts of a method (or of a field or property whose value is a function). */
  params?: string[];
  /** `Owner.name(p1, p2)` when `params` is known. */
  signature?: string;
  /** Lines of the member, with the comments right above it (its JSDoc), 1-based inclusive. */
  range: LineRange;
  /** The same as character offsets [start, end) of the analyzed text. */
  span: [number, number];
  /** The owner is exported and the member is not private (`#name`). */
  exported: boolean;
}

/**
 * Extension of `ModuleSymbols` for footprints: what each top-level statement outside the
 * declarations uses, the local import bindings, and the members of top-level classes and objects.
 */
export interface ModuleAnalysis extends ModuleSymbols {
  bindings: Record<string, ImportBinding>;
  /** Top-level statements that are not declarations or imports, with the identifiers each uses. */
  statements: { range: LineRange; references: string[] }[];
  /**
   * Members keyed `Owner.name`. Empty when the parse failed: the regex scanner sees top-level
   * declarations only.
   */
  members: Record<string, MemberInfo>;
  /** Member key → identifiers that the member uses. `this.x` in a method gives `Owner.x`. */
  memberReferences: Record<string, string[]>;
  /** Owners whose members are recorded (an owner with more than MAX_MEMBERS members is not). */
  memberOwners: string[];
}

/** Path aliases from `compilerOptions` of tsconfig.json or jsconfig.json at the repository root. */
export interface PathAliases {
  /** Repo-relative directory for bare specifiers and for the targets of `paths` ("" = the root). */
  baseUrl?: string;
  /** `paths` entries in file order, with targets relative to the root: `{ pattern: "@/*", targets: ["src/*"] }`. */
  paths: { pattern: string; targets: string[] }[];
}
