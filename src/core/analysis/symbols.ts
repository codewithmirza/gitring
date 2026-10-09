/**
 * Module symbols for footprints and the import graph: top-level declarations, exports, imports,
 * and the identifiers each declaration uses.
 *
 * Pure module (acorn only): runs in Node and in workerd. Never throws.
 *
 *   .js .mjs .cjs .jsx      acorn (ecmaVersion "latest", sourceType "module"; a script retry for
 *                           CommonJS-style files)
 *   .ts .tsx .mts .cts      best-effort type strip (types are blanked in place, so offsets and line
 *                           numbers do not move), then acorn
 *   parse failure           regex scanner; `parseError` is set
 *
 * Line numbers are 1-based and come from character offsets with the line model of `lineDiff`
 * (lines end at "\n"), so ranges and diff hunks always agree.
 */
import { parse, tokenizer, type Options } from "acorn";
import type { LineRange } from "../types";

/* ───────────────────────────── contract types ───────────────────────────── */

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

/* ───────────────────────────── extension types ───────────────────────────── */

/** A local name bound by an `import` declaration (re-exports are not local bindings). */
export interface ImportBinding {
  from: string;
  /** "default", "*" (namespace) or the exported name. */
  imported: string;
}

/**
 * Extension of `ModuleSymbols` for footprints: what each top-level statement outside the
 * declarations uses, and the local import bindings.
 */
export interface ModuleAnalysis extends ModuleSymbols {
  bindings: Record<string, ImportBinding>;
  /** Top-level statements that are not declarations or imports, with the identifiers each uses. */
  statements: { range: LineRange; references: string[] }[];
}

/* ───────────────────────────── public API ───────────────────────────── */

const JS_EXT = /\.(?:js|mjs|cjs|jsx)$/i;
const TS_EXT = /\.(?:ts|tsx|mts|cts)$/i;

/** True for .js .mjs .cjs .jsx .ts .tsx .mts .cts. */
export function isAnalyzable(path: string): boolean {
  return JS_EXT.test(path) || TS_EXT.test(path);
}

/**
 * Symbols of one module. Never throws. On a parse failure the regex scanner gives approximate
 * results and `parseError` holds the parser message.
 * Extension: pass `files` (all repo paths) to fill `imports[].resolved`.
 */
export function extractSymbols(path: string, source: string, files?: Set<string>): ModuleSymbols {
  const a = analyzeModule(path, source, files);
  const out: ModuleSymbols = {
    path: a.path,
    decls: a.decls,
    exports: a.exports,
    imports: a.imports,
    references: a.references,
    topLevelReferences: a.topLevelReferences,
  };
  if (a.parseError !== undefined) out.parseError = a.parseError;
  return out;
}

/** `extractSymbols` plus statement-level references and import bindings (used by footprints). Never throws. */
export function analyzeModule(path: string, source: string, files?: Set<string>): ModuleAnalysis {
  let result: ModuleAnalysis;
  const ts = TS_EXT.test(path);
  try {
    let code = source;
    let removed: Uint8Array | undefined;
    if (ts) {
      const stripped = stripTypeScriptDetailed(source, /\.tsx$/i.test(path));
      if (stripped !== null) ({ code, removed } = stripped);
    }
    let program: AnyNode | undefined;
    let parseError: string | undefined;
    try {
      program = parseProgram(code);
    } catch (e) {
      parseError = errorMessage(e);
    }
    result = program ? analyzeProgram(path, code, program, removed) : regexAnalysis(path, source, ts, parseError ?? "parse failed");
  } catch (e) {
    try {
      result = regexAnalysis(path, source, ts, errorMessage(e));
    } catch (e2) {
      result = emptyAnalysis(path, errorMessage(e2));
    }
  }
  if (files) {
    for (const imp of result.imports) {
      const r = resolveImport(path, imp.from, files);
      if (r !== undefined) imp.resolved = r;
    }
  }
  // Records are built prototype-free (a declaration may be called "toString"); hand out plain objects.
  result.decls = plainRecord(result.decls);
  result.exports = plainRecord(result.exports);
  result.references = plainRecord(result.references);
  result.bindings = plainRecord(result.bindings);
  return result;
}

/** A plain object with the same own entries (`Object.fromEntries` also keeps a "__proto__" key as data). */
function plainRecord<T>(d: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(d));
}

/** Own property lookup (safe for keys such as "constructor" or "toString"). */
export function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Resolve a relative import specifier ("./x", "../y/z.js") against the importer's directory.
 * Tries the exact path, then + ".js", ".mjs", ".ts", "/index.js", "/index.ts" (then a few more:
 * ".jsx", ".tsx", ".cjs", ".mts", "/index.mjs", "/index.jsx", "/index.tsx", and the TypeScript
 * convention "./x.js" → "x.ts"). Bare package specifiers return undefined.
 */
export function resolveImport(fromPath: string, spec: string, files: Set<string>): string | undefined {
  if (!(spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../"))) return undefined;
  const clean = spec.replace(/[?#].*$/, "");
  const from = normalizeRepoPath(fromPath);
  const slash = from.lastIndexOf("/");
  const dir = slash < 0 ? "" : from.slice(0, slash);
  const joined = joinPath(dir, clean);
  if (joined === undefined) return undefined;
  const candidates: string[] = [];
  if (joined !== "") {
    candidates.push(joined, joined + ".js", joined + ".mjs", joined + ".ts");
  }
  const indexBase = joined === "" ? "" : joined + "/";
  candidates.push(indexBase + "index.js", indexBase + "index.ts");
  if (joined !== "") {
    candidates.push(joined + ".jsx", joined + ".tsx", joined + ".cjs", joined + ".mts");
    const m = /\.(m|c)?js(x)?$/.exec(joined);
    if (m) {
      const stem = joined.slice(0, m.index);
      if (m[1] === "m") candidates.push(stem + ".mts");
      else if (m[1] === "c") candidates.push(stem + ".cts");
      else if (m[2]) candidates.push(stem + ".tsx");
      else candidates.push(stem + ".ts", stem + ".tsx");
    }
  }
  candidates.push(indexBase + "index.mjs", indexBase + "index.jsx", indexBase + "index.tsx");
  for (const c of candidates) if (files.has(c)) return c;
  return undefined;
}

/* ───────────────────────────── shared helpers ───────────────────────────── */

// The AST is walked generically; acorn's node types are too narrow for that, so nodes are `any`.
type AnyNode = any;

function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function normalizeRepoPath(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

/** Join and normalize; undefined if ".." climbs above the repo root. */
function joinPath(dir: string, rel: string): string | undefined {
  const out: string[] = dir ? dir.split("/").filter(Boolean) : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

function emptyAnalysis(path: string, parseError?: string): ModuleAnalysis {
  const a: ModuleAnalysis = {
    path,
    decls: dict(),
    exports: dict(),
    imports: [],
    references: dict(),
    topLevelReferences: [],
    bindings: dict(),
    statements: [],
  };
  if (parseError !== undefined) a.parseError = parseError;
  return a;
}

/** 1-based line of a character offset (lines end at "\n"). */
function lineIndex(src: string): (offset: number) => number {
  const starts = [0];
  for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const sortedArray = (s: Iterable<string>): string[] => [...new Set(s)].sort();

const ACORN_MODULE: Options = { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true };
const ACORN_SCRIPT: Options = {
  ecmaVersion: "latest",
  sourceType: "script",
  locations: true,
  allowHashBang: true,
  allowReturnOutsideFunction: true,
};

/** Parse as a module; if that fails, try a (CommonJS-style) script. Throws the module error. */
function parseProgram(code: string): AnyNode {
  try {
    return parse(code, ACORN_MODULE);
  } catch (e) {
    try {
      return parse(code, ACORN_SCRIPT);
    } catch {
      throw e;
    }
  }
}

/* ───────────────────────────── scopes + references ───────────────────────────── */

class Scope {
  readonly names = new Set<string>();
  constructor(readonly parent: Scope | null) {}
  has(name: string): boolean {
    for (let s: Scope | null = this; s; s = s.parent) if (s.names.has(name)) return true;
    return false;
  }
}

const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "raw"]);

function isNode(v: unknown): v is AnyNode {
  return !!v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";
}

/** Names bound by a binding pattern. */
function boundNames(p: AnyNode, out: Set<string>): void {
  if (!p) return;
  switch (p.type) {
    case "Identifier":
      out.add(p.name);
      return;
    case "ObjectPattern":
      for (const prop of p.properties) boundNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      return;
    case "ArrayPattern":
      for (const el of p.elements) if (el) boundNames(el, out);
      return;
    case "RestElement":
      boundNames(p.argument, out);
      return;
    case "AssignmentPattern":
      boundNames(p.left, out);
      return;
  }
}

/** Lexical declarations directly in a statement list (let/const/var/function/class). */
function declareStatements(body: AnyNode[], out: Set<string>): void {
  for (const st of body) {
    if (!st) continue;
    if (st.type === "VariableDeclaration") for (const d of st.declarations) boundNames(d.id, out);
    else if ((st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && st.id) out.add(st.id.name);
  }
}

/** `var` declarations anywhere in a function body (not in nested functions). Only statements can hold them. */
function hoistVars(root: AnyNode, out: Set<string>): void {
  const stack: AnyNode[] = [root];
  const push = (n: AnyNode): void => {
    if (n) stack.push(n);
  };
  while (stack.length) {
    const n = stack.pop();
    switch (n.type) {
      case "VariableDeclaration":
        if (n.kind === "var") for (const d of n.declarations) boundNames(d.id, out);
        break;
      case "BlockStatement":
        for (const st of n.body) push(st);
        break;
      case "IfStatement":
        push(n.consequent);
        push(n.alternate);
        break;
      case "ForStatement":
        push(n.init && n.init.type === "VariableDeclaration" ? n.init : null);
        push(n.body);
        break;
      case "ForInStatement":
      case "ForOfStatement":
        push(n.left && n.left.type === "VariableDeclaration" ? n.left : null);
        push(n.body);
        break;
      case "WhileStatement":
      case "DoWhileStatement":
      case "LabeledStatement":
      case "WithStatement":
        push(n.body);
        break;
      case "TryStatement":
        push(n.block);
        push(n.handler && n.handler.body);
        push(n.finalizer);
        break;
      case "SwitchStatement":
        for (const c of n.cases) for (const st of c.consequent) push(st);
        break;
    }
  }
}

function memberPropertyName(node: AnyNode): string | undefined {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : undefined;
}

/** Collects free identifiers (and `root.prop` for member access on a free identifier). */
class RefCollector {
  readonly out = new Set<string>();

  walk(node: AnyNode, scope: Scope): void {
    if (!node) return;
    switch (node.type) {
      case "Identifier":
        if (!scope.has(node.name)) this.out.add(node.name);
        return;
      case "MemberExpression":
        this.member(node, scope);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        this.fn(node, scope);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        this.cls(node, scope);
        return;
      case "VariableDeclaration":
        for (const d of node.declarations) {
          this.pattern(d.id, scope);
          if (d.init) this.walk(d.init, scope);
        }
        return;
      case "BlockStatement":
      case "StaticBlock": {
        const s = new Scope(scope);
        declareStatements(node.body, s.names);
        for (const st of node.body) this.walk(st, s);
        return;
      }
      case "SwitchStatement": {
        this.walk(node.discriminant, scope);
        const s = new Scope(scope);
        for (const c of node.cases) declareStatements(c.consequent, s.names);
        for (const c of node.cases) {
          if (c.test) this.walk(c.test, s);
          for (const st of c.consequent) this.walk(st, s);
        }
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const s = new Scope(scope);
        const head = node.type === "ForStatement" ? node.init : node.left;
        if (head && head.type === "VariableDeclaration") for (const d of head.declarations) boundNames(d.id, s.names);
        this.children(node, s);
        return;
      }
      case "CatchClause": {
        const s = new Scope(scope);
        if (node.param) {
          boundNames(node.param, s.names);
          this.pattern(node.param, s);
        }
        this.walk(node.body, s);
        return;
      }
      case "Property":
        if (node.computed) this.walk(node.key, scope);
        this.walk(node.value, scope);
        return;
      case "MethodDefinition":
      case "PropertyDefinition":
      case "AccessorProperty":
        if (node.computed) this.walk(node.key, scope);
        if (node.value) this.walk(node.value, scope);
        return;
      case "LabeledStatement":
        this.walk(node.body, scope);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
      case "PrivateIdentifier":
      case "Literal":
      case "ThisExpression":
      case "Super":
      case "TemplateElement":
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        return;
      default:
        this.children(node, scope);
    }
  }

  children(node: AnyNode, scope: Scope): void {
    for (const key in node) {
      if (SKIP_KEYS.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const x of v) if (isNode(x)) this.walk(x, scope);
      } else if (isNode(v)) this.walk(v, scope);
    }
  }

  /** A binding pattern: only default values and computed keys are uses. */
  pattern(p: AnyNode, scope: Scope): void {
    if (!p) return;
    switch (p.type) {
      case "Identifier":
        return;
      case "ObjectPattern":
        for (const prop of p.properties) {
          if (prop.type === "RestElement") this.pattern(prop.argument, scope);
          else {
            if (prop.computed) this.walk(prop.key, scope);
            this.pattern(prop.value, scope);
          }
        }
        return;
      case "ArrayPattern":
        for (const el of p.elements) if (el) this.pattern(el, scope);
        return;
      case "RestElement":
        this.pattern(p.argument, scope);
        return;
      case "AssignmentPattern":
        this.pattern(p.left, scope);
        this.walk(p.right, scope);
        return;
      default:
        this.walk(p, scope);
    }
  }

  fn(node: AnyNode, outer: Scope): void {
    const s = new Scope(outer);
    if (node.type === "FunctionExpression" && node.id) s.names.add(node.id.name);
    if (node.type !== "ArrowFunctionExpression") s.names.add("arguments");
    for (const p of node.params) boundNames(p, s.names);
    const block = node.body && node.body.type === "BlockStatement";
    if (block) {
      hoistVars(node.body, s.names);
      declareStatements(node.body.body, s.names);
    }
    for (const p of node.params) this.pattern(p, s);
    if (block) for (const st of node.body.body) this.walk(st, s);
    else this.walk(node.body, s);
  }

  cls(node: AnyNode, outer: Scope): void {
    if (node.superClass) this.walk(node.superClass, outer);
    const s = new Scope(outer);
    if (node.id) s.names.add(node.id.name);
    for (const m of node.body.body) this.walk(m, s);
  }

  member(node: AnyNode, scope: Scope): void {
    const obj = node.object;
    if (obj.type === "Identifier") {
      if (!scope.has(obj.name)) {
        this.out.add(obj.name);
        const prop = memberPropertyName(node);
        if (prop !== undefined) this.out.add(`${obj.name}.${prop}`);
      }
    } else this.walk(obj, scope);
    if (node.computed) this.walk(node.property, scope);
  }
}

/* ───────────────────────────── AST analysis ───────────────────────────── */

function nameOf(node: AnyNode): string {
  return node.type === "Identifier" ? node.name : String(node.value);
}

/** `removed` (TypeScript only) marks blanked type positions, which param texts leave out. */
function analyzeProgram(path: string, code: string, program: AnyNode, removed?: Uint8Array): ModuleAnalysis {
  const a = emptyAnalysis(path);
  const lineOf = lineIndex(code);
  const rangeOf = (n: AnyNode): LineRange => [lineOf(n.start), lineOf(Math.max(n.start, n.end - 1))];
  const paramText = (p: AnyNode): string => collapse(removed ? keptText(code, p.start, p.end, removed) : code.slice(p.start, p.end));
  const refSets = new Map<string, Set<string>>();
  const topLevel = new Set<string>();

  const addDecl = (info: DeclInfo, refs: Set<string>): void => {
    refs.delete(info.name);
    for (const r of [...refs]) if (r.startsWith(info.name + ".")) refs.delete(r);
    const prev = a.decls[info.name];
    if (prev) {
      prev.exported = prev.exported || info.exported;
      const set = refSets.get(info.name);
      if (set) for (const r of refs) set.add(r);
      return;
    }
    a.decls[info.name] = info;
    refSets.set(info.name, refs);
  };

  const fnDecl = (name: string, kind: DeclInfo["kind"], fn: AnyNode, range: LineRange, exported: boolean): DeclInfo => {
    const params = fn.params.map(paramText);
    return { name, kind, params, signature: `${name}(${params.join(", ")})`, range, exported };
  };

  const declare = (node: AnyNode, rangeNode: AnyNode, exported: boolean, nameOverride?: string): void => {
    const range = rangeOf(rangeNode);
    if (node.type === "FunctionDeclaration") {
      const name = nameOverride ?? (node.id ? node.id.name : "default");
      const r = new RefCollector();
      r.fn(node, new Scope(null));
      addDecl(fnDecl(name, "function", node, range, exported), r.out);
    } else if (node.type === "ClassDeclaration") {
      const name = nameOverride ?? (node.id ? node.id.name : "default");
      const r = new RefCollector();
      r.cls(node, new Scope(null));
      addDecl({ name, kind: "class", range, exported }, r.out);
    } else if (node.type === "VariableDeclaration") {
      const kind: DeclInfo["kind"] = node.kind === "let" || node.kind === "var" ? node.kind : "const";
      for (const d of node.declarations) {
        const names = new Set<string>();
        boundNames(d.id, names);
        const r = new RefCollector();
        const root = new Scope(null);
        r.pattern(d.id, root);
        if (d.init) r.walk(d.init, root);
        const fnInit = d.id.type === "Identifier" && d.init && (d.init.type === "ArrowFunctionExpression" || d.init.type === "FunctionExpression") ? d.init : undefined;
        for (const name of names) {
          const info: DeclInfo = fnInit ? fnDecl(name, kind, fnInit, range, exported) : { name, kind, range, exported };
          addDecl(info, new Set(r.out));
        }
      }
    }
  };

  const addStatement = (node: AnyNode, refs: Set<string>): void => {
    if (refs.size === 0) return;
    for (const r of refs) topLevel.add(r);
    a.statements.push({ range: rangeOf(node), references: sortedArray(refs) });
  };

  for (const st of program.body as AnyNode[]) {
    switch (st.type) {
      case "ImportDeclaration": {
        const from = String(st.source.value);
        const names = (st.specifiers as AnyNode[]).map((s) => {
          if (s.type === "ImportDefaultSpecifier") return { imported: "default", local: s.local.name as string };
          if (s.type === "ImportNamespaceSpecifier") return { imported: "*", local: s.local.name as string };
          return { imported: nameOf(s.imported), local: s.local.name as string };
        });
        a.imports.push({ from, names });
        for (const n of names) a.bindings[n.local] = { from, imported: n.imported };
        break;
      }
      case "ExportNamedDeclaration": {
        if (st.declaration) {
          declare(st.declaration, st, true);
          const names = new Set<string>();
          if (st.declaration.type === "VariableDeclaration") for (const d of st.declaration.declarations) boundNames(d.id, names);
          else if (st.declaration.id) names.add(st.declaration.id.name);
          for (const n of names) a.exports[n] = n;
        } else if (st.source) {
          const names = (st.specifiers as AnyNode[]).map((s) => ({ imported: nameOf(s.local), local: nameOf(s.exported) }));
          a.imports.push({ from: String(st.source.value), names });
          for (const n of names) a.exports[n.local] = n.local;
        } else {
          const refs = new Set<string>();
          for (const s of st.specifiers as AnyNode[]) {
            const local = nameOf(s.local);
            a.exports[nameOf(s.exported)] = local;
            refs.add(local);
          }
          addStatement(st, refs);
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const d = st.declaration;
        if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") {
          const name = d.id ? d.id.name : "default";
          declare(d, st, true, name);
          a.exports.default = name;
        } else if (d.type === "Identifier") {
          a.exports.default = d.name;
          addStatement(st, new Set([d.name]));
        } else {
          const r = new RefCollector();
          r.walk(d, new Scope(null));
          const range = rangeOf(st);
          const isFn = d.type === "ArrowFunctionExpression" || d.type === "FunctionExpression";
          const info: DeclInfo = isFn
            ? fnDecl("default", "function", d, range, true)
            : { name: "default", kind: d.type === "ClassExpression" ? "class" : "const", range, exported: true };
          addDecl(info, r.out);
          a.exports.default = "default";
        }
        break;
      }
      case "ExportAllDeclaration": {
        const from = String(st.source.value);
        if (st.exported) {
          const n = nameOf(st.exported);
          a.imports.push({ from, names: [{ imported: "*", local: n }] });
          a.exports[n] = n;
        } else a.imports.push({ from, names: [{ imported: "*", local: "*" }] });
        break;
      }
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "VariableDeclaration":
        declare(st, st, false);
        break;
      default: {
        const r = new RefCollector();
        r.walk(st, new Scope(null));
        addStatement(st, r.out);
      }
    }
  }

  for (const local of Object.values(a.exports)) {
    const d = a.decls[local];
    if (d) d.exported = true;
  }
  for (const [name, set] of refSets) a.references[name] = sortedArray(set);
  a.topLevelReferences = sortedArray(topLevel);
  return a;
}

/* ───────────────────────────── source masking (regex fallback, decorators) ───────────────────────────── */

const REGEX_PREFIX_WORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

/**
 * Blank comments (and, with `maskStrings`, the contents of string, template and regex literals)
 * with spaces. Quotes, newlines and every offset stay, so line numbers and positions are unchanged.
 * Template `${…}` expressions stay visible as code.
 */
function maskSource(src: string, maskStrings: boolean): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const tpl: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let mode: "code" | "template" = "code";
  let lastChar = "";
  let lastWord = "";
  let i = 0;
  if (src.startsWith("#!")) {
    const e = src.indexOf("\n");
    i = e === -1 ? n : e;
    blank(0, i);
  }
  while (i < n) {
    const c = src[i];
    if (mode === "template") {
      if (c === "\\") {
        if (maskStrings) blank(i, i + 2);
        i += 2;
      } else if (c === "`") {
        mode = "code";
        lastChar = "`";
        lastWord = "";
        i++;
      } else if (c === "$" && src[i + 1] === "{") {
        // keep "{" for bracket balance; drop "$" so it is not read as an identifier
        if (maskStrings) blank(i, i + 1);
        tpl.push(depth);
        mode = "code";
        lastChar = "{";
        lastWord = "";
        i += 2;
      } else {
        if (maskStrings) blank(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let e = src.indexOf("\n", i);
      if (e === -1) e = n;
      blank(i, e);
      i = e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const closed = j < n && src[j] === c;
      if (maskStrings) blank(i + 1, Math.min(j, n));
      i = closed ? j + 1 : j;
      lastChar = c;
      lastWord = "";
      continue;
    }
    if (c === "`") {
      mode = "template";
      i++;
      continue;
    }
    if (c === "/") {
      const regexOk = lastChar === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastChar) || REGEX_PREFIX_WORDS.has(lastWord);
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          const d = src[j];
          if (d === "\\") j += 2;
          else {
            if (d === "[") inClass = true;
            else if (d === "]") inClass = false;
            else if (d === "/" && !inClass) break;
            j++;
          }
        }
        if (j < n && src[j] === "/") {
          if (maskStrings) blank(i + 1, j);
          i = j + 1;
          while (i < n && /[a-z]/i.test(src[i])) i++;
          lastChar = "/";
          lastWord = "";
          continue;
        }
      }
      lastChar = "/";
      lastWord = "";
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      if (tpl.length && tpl[tpl.length - 1] === depth) {
        tpl.pop();
        mode = "template";
        i++;
        continue;
      }
      depth--;
    }
    if (isWordCode(src.charCodeAt(i))) {
      let j = i + 1;
      while (j < n && isWordCode(src.charCodeAt(j))) j++;
      lastWord = src.slice(i, j);
      lastChar = src[j - 1];
      i = j;
      continue;
    }
    if (!isSpaceCode(src.charCodeAt(i))) {
      lastChar = c;
      lastWord = "";
    }
    i++;
  }
  return out.join("");
}

/** [A-Za-z0-9_$] */
function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 36 || code === 95;
}

function isSpaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0xfeff || code === 0x2028 || code === 0x2029 || (code > 127 && /\s/.test(String.fromCharCode(code)));
}

/** Index of the bracket that closes the one at `open` in masked text, or -1. */
function matchBracket(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas outside (), [], {} and <>. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || (c === ">" && s[i - 1] !== "=")) depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/* ───────────────────────────── regex fallback ───────────────────────────── */

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

function regexAnalysis(path: string, source: string, ts: boolean, parseError: string): ModuleAnalysis {
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

/* ───────────────────────────── TypeScript type strip (best effort) ───────────────────────────── */

interface Tok {
  /** Tag: "name" | "num" | "string" | "regexp" | "privateId" | "template" | a keyword | the punctuator text. */
  t: string;
  /** Source text of the token. */
  v: string;
  s: number;
  e: number;
  /** A line break comes before this token. */
  nl: boolean;
}

const TOKEN_CATEGORIES = new Set(["name", "num", "string", "regexp", "privateId", "template", "invalidTemplate"]);
const TS_CLASS_MODIFIERS = new Set(["public", "private", "protected", "readonly", "abstract", "override", "declare"]);
const TS_PARAM_MODIFIERS = new Set(["public", "private", "protected", "readonly", "override"]);
const JS_MEMBER_PREFIXES = new Set(["static", "async", "get", "set", "accessor"]);
const EXPR_END_TAGS = new Set(["name", "num", "string", "regexp", "privateId", ")", "]", "`", "this", "super", "null", "true", "false"]);
/** Tokens after which a `{` starts an object literal. */
const OBJECT_AFTER = new Set([
  "=", "(", "[", ",", "?", "??", "||", "&&", "|", "&", "^", "==", "===", "!=", "!==", "<", ">", "<=", ">=", "<<",
  ">>", ">>>", "+", "-", "*", "/", "%", "**", "!", "~", "...", "return", "typeof", "void", "delete", "in",
  "instanceof", "new", "case", "throw", "${", "default", "?.", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=",
  ">>>=", "&=", "|=", "^=", "&&=", "||=", "??=", "extends", "yield", "await",
]);
/** Tokens allowed inside `<…>` type arguments/parameters (besides bracketed groups, which are skipped). */
const ANGLE_TOKENS = new Set([
  "name", "num", "string", "template", ",", ".", "|", "&", "?", ":", "=>", "=", "...", "-", "extends", "typeof", "void",
  "null", "this", "true", "false", "new", "import", "in", "const", "default",
]);

class TsStripper {
  private readonly n: number;
  private readonly match: Int32Array;
  private readonly cuts: [number, number][] = [];
  private readonly edits: [number, string][] = [];
  failed = false;

  constructor(
    private readonly src: string,
    private readonly toks: Tok[],
    private readonly tsx: boolean,
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

  private t(i: number): string {
    return i >= 0 && i < this.n ? this.toks[i].t : "eof";
  }
  private word(i: number): string {
    return i >= 0 && i < this.n && this.toks[i].t === "name" ? this.toks[i].v : "";
  }
  private nl(i: number): boolean {
    return i >= 0 && i < this.n ? this.toks[i].nl : true;
  }
  private isKey(i: number): boolean {
    const t = this.t(i);
    return t === "name" || t === "num" || t === "string" || t === "privateId" || /^[a-z]+$/.test(t) && !TOKEN_CATEGORIES.has(t) && t !== "eof";
  }
  private cut(i: number, j: number): void {
    if (!(j > i && i >= 0)) return;
    const end = Math.min(j, this.n);
    this.cuts.push([this.toks[i].s, this.toks[end - 1].e]);
    const prev = this.cutStartAt.get(end);
    if (prev === undefined || i < prev) this.cutStartAt.set(end, i);
  }
  /** Cut ranges in token space: end index (exclusive) → start index. */
  private readonly cutStartAt = new Map<number, number>();
  /** The token before i, skipping tokens that were cut (types end before the next real token). */
  private effPrev(i: number): number {
    let p = i;
    for (let guard = 0; guard < 64; guard++) {
      const s = this.cutStartAt.get(p);
      if (s === undefined || s >= p) break;
      p = s;
    }
    return p - 1;
  }
  /** Does token k end an expression? A keyword after "." or "?." is a property name. */
  private endsExpr(k: number): boolean {
    const t = this.t(k);
    if (EXPR_END_TAGS.has(t)) return true;
    return /^[a-z]+$/.test(t) && !TOKEN_CATEGORIES.has(t) && t !== "eof" && (this.t(k - 1) === "." || this.t(k - 1) === "?.");
  }
  /** Names that only exist as types in this file (interfaces, type aliases, type imports, ambient declarations). */
  private typeOnlyNames = new Set<string>();
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
  private fail(): number {
    this.failed = true;
    return this.n;
  }
  private closeOf(i: number): number {
    const m = this.match[i];
    return m < 0 ? -1 : m;
  }

  /* ── types ── */

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
      case "typeof": {
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
      case "import": {
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
      case "name": {
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
      default:
        return -1;
    }
  }

  /** Index after a return type (type predicates and `asserts` included), or -1. */
  private skipReturnType(i: number): number {
    return this.skipType(i);
  }

  /* ── statement helpers ── */

  /** Index after a statement that starts at i: through a top-level ";" or before a line break that ends it. */
  private statementEnd(i: number): number {
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

  private endsExpression(i: number): boolean {
    return this.endsExpr(i) || this.t(i) === "}";
  }

  private continuesExpression(i: number): boolean {
    const t = this.t(i);
    return t === "." || t === "?." || t === "=>" || t === "?" || t === ":" || t === "|" || t === "&" || t === "=" || t === "," || t === "extends" || t === "[" || t === "(" || t === "<" || t === ">" || (t === "name" && (this.word(i) === "as" || this.word(i) === "satisfies"));
  }

  /** Index after `type Name<…> = Type;` starting at the `type` word. */
  private typeAliasEnd(i: number): number {
    let j = i + 2;
    if (this.t(j) === "<") j = this.skipAngle(j);
    if (j < 0 || this.t(j) !== "=") return -1;
    j = this.skipType(j + 1);
    if (j < 0) return -1;
    return this.t(j) === ";" ? j + 1 : j;
  }

  /** Index after `interface Name<…> extends A, B { … }` starting at the `interface` word. */
  private interfaceEnd(i: number): number {
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
  private declareEnd(i: number): number {
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
  private rewriteAsVar(start: number, nameIdx: number): number {
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

  /** Remove `type X` entries from an import/export specifier list `{ … }` at open..close. */
  /**
   * Specifier list `{ … }` at open..close: drop `type` modifiers. In a local export list
   * (`localExport`), drop whole specifiers whose name exists only as a type, as TypeScript does.
   */
  private stripTypeSpecifiers(open: number, close: number, localExport = false): void {
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
  private moduleStatementEnd(i: number): number {
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

  /* ── main scan ── */

  run(): void {
    type Kind = "top" | "block" | "class" | "object" | "params" | "paren" | "bracket" | "template";
    interface Ctx {
      k: Kind;
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
    const stack: Ctx[] = [{ k: "top" }];
    let pendingParams: { at: number; fnStart: number } | null = null;
    let pendingBrace: Kind | null = null;
    let i = 0;
    const toks = this.toks;

    const varBinding = (j: number): number => {
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
    };

    while (i < this.n && !this.failed) {
      const ctx = stack[stack.length - 1];
      const tok = toks[i];
      const t = tok.t;

      // Class members: modifiers, keys, optional marks, field types, method type parameters.
      if (ctx.k === "class") {
        if (!ctx.memberStart && ctx.memberAt !== i && tok.nl && this.endsExpression(this.effPrev(i)) && !this.continuesExpression(i)) ctx.memberStart = true;
        if (ctx.memberStart && ctx.memberAt !== i) {
          ctx.memberStart = false;
          ctx.memberAt = i;
          if (t === ";") {
            ctx.memberStart = true;
            i++;
            continue;
          }
          if (t === "}") {
            stack.pop();
            i++;
            continue;
          }
          const start = i;
          let j = i;
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
          if (this.t(j) === "{") {
            // static block
            i = j;
            pendingBrace = "block";
            continue;
          }
          if (this.t(j) === "[" && this.t(j + 1) === "name" && this.t(j + 2) === ":") {
            // index signature
            let k = this.closeOf(j) + 1;
            if (this.t(k) === "?") k++;
            if (this.t(k) === ":") k = this.skipType(k + 1);
            if (k < 0) return void this.fail();
            if (this.t(k) === ";") k++;
            this.cut(start, k);
            ctx.memberStart = true;
            i = k;
            continue;
          }
          if (this.t(j) === "*") j++;
          if (this.t(j) === "[") {
            const c = this.closeOf(j);
            if (c < 0) return void this.fail();
            j = c + 1;
          } else if (this.isKey(j)) j++;
          else {
            i = j;
            continue;
          }
          if ((this.t(j) === "?" || this.t(j) === "!") && !this.nl(j)) {
            this.cut(j, j + 1);
            j++;
          }
          if (ambient) {
            let k = j;
            if (this.t(k) === "<") k = this.skipAngle(k);
            if (k > 0 && this.t(k) === "(") {
              k = this.closeOf(k) + 1;
              if (this.t(k) === ":") k = this.skipReturnType(k + 1);
            } else if (k > 0 && this.t(k) === ":") k = this.skipType(k + 1);
            if (k > 0 && this.t(k) === "=") k = this.statementEnd(k);
            if (k < 0) return void this.fail();
            if (this.t(k) === ";") k++;
            this.cut(start, k);
            ctx.memberStart = true;
            i = k;
            continue;
          }
          if (this.t(j) === "<") {
            const k = this.skipAngle(j);
            if (k < 0) return void this.fail();
            this.cut(j, k);
            j = k;
          }
          if (this.t(j) === "(") {
            pendingParams = { at: j, fnStart: start };
          } else if (this.t(j) === ":") {
            const k = this.skipType(j + 1);
            if (k < 0) return void this.fail();
            this.cut(j, k);
            j = k;
          }
          // a field without initializer that ends at a line break: the next line is a new member
          const tj = this.t(j);
          if (tj !== "(" && tj !== "=" && tj !== ";" && tj !== "}" && this.nl(j)) ctx.memberStart = true;
          i = j;
          continue;
        }
      }

      // Object literal (or destructuring pattern) keys: method shorthand gets params.
      if (ctx.k === "object" && ctx.atKey) {
        ctx.atKey = false;
        let j = i;
        if (t !== "}" && t !== "...") {
          while ((this.word(j) === "get" || this.word(j) === "set" || this.word(j) === "async") && !this.nl(j + 1) && (this.isKey(j + 1) || this.t(j + 1) === "[" || this.t(j + 1) === "*")) j++;
          if (this.t(j) === "*") j++;
          if (this.t(j) === "[") {
            const c = this.closeOf(j);
            if (c < 0) return void this.fail();
            j = c + 1;
          } else if (this.isKey(j)) j++;
          if (this.t(j) === "<") {
            const k = this.skipAngle(j);
            if (k > 0 && this.t(k) === "(") {
              this.cut(j, k);
              j = k;
            }
          }
          if (this.t(j) === "(") pendingParams = { at: j, fnStart: -1 };
          if (j > i) {
            i = j;
            continue;
          }
        }
      }

      // Parameter start: TS parameter properties and `this` parameters.
      if (ctx.k === "params" && ctx.paramStart) {
        ctx.paramStart = false;
        let j = i;
        while (TS_PARAM_MODIFIERS.has(this.word(j)) && (this.t(j + 1) === "name" || this.t(j + 1) === "{" || this.t(j + 1) === "[")) {
          this.cut(j, j + 1);
          j++;
        }
        if (this.t(j) === "this" && this.t(j + 1) === ":") {
          let k = this.skipType(j + 2);
          if (k < 0) return void this.fail();
          if (this.t(k) === ",") k++;
          this.cut(j, k);
          ctx.paramStart = true;
          i = k;
          continue;
        }
        if (j > i) {
          i = j;
          continue;
        }
      }

      switch (t) {
        case "(": {
          let kind: Kind = "paren";
          let fnStart = -1;
          let arrow = false;
          if (pendingParams && pendingParams.at === i) {
            kind = "params";
            fnStart = pendingParams.fnStart;
            pendingParams = null;
          } else if (this.t(this.effPrev(i)) === "catch") {
            kind = "params";
          } else {
            const pi = this.effPrev(i);
            const prev = this.t(pi);
            const isCall = (this.endsExpr(pi) && !(prev === "name" && this.word(pi) === "async")) || prev === "}";
            if (!isCall) {
              const c = this.closeOf(i);
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
          stack.push(kind === "params" ? { k: kind, paramStart: true, inDefault: false, fnStart, arrow } : { k: kind });
          i++;
          continue;
        }
        case "[":
          stack.push({ k: "bracket" });
          i++;
          continue;
        case "${":
          stack.push({ k: "template" });
          i++;
          continue;
        case "{": {
          let kind: Kind;
          if (pendingBrace) {
            kind = pendingBrace;
            pendingBrace = null;
          } else {
            const pi = this.effPrev(i);
            const p = this.t(pi);
            if (pi < 0 || p === "=>" || p === ")" || p === ";" || p === "{" || p === "}" || p === "else" || p === "do" || p === "try" || p === "finally") kind = "block";
            else if (p === ":") kind = ctx.k === "object" || ctx.k === "params" || ctx.k === "paren" || ctx.k === "bracket" ? "object" : this.colonStartsBlock(pi) ? "block" : "object";
            else if (OBJECT_AFTER.has(p) || (p === "name" && (this.word(pi) === "await" || this.word(pi) === "yield"))) kind = "object";
            else kind = "block";
            if (ctx.k === "params" && (p === "(" || p === ",")) kind = "object";
          }
          stack.push(kind === "class" ? { k: kind, memberStart: true } : kind === "object" ? { k: kind, atKey: true } : { k: kind });
          i++;
          continue;
        }
        case ")": {
          stack.pop();
          if (ctx.k !== "params") {
            i++;
            continue;
          }
          let j = i + 1;
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
                this.cut(i, i + 1);
                this.edits.push([slot, ")"]);
              } else return void this.fail();
            }
          }
          if (this.t(j) === "{") pendingBrace = "block";
          else if (this.t(j) !== "=>" && !ctx.arrow && (ctx.fnStart ?? -1) >= 0) {
            // no body: an overload, abstract or ambient signature
            const end = this.t(j) === ";" ? j + 1 : j;
            this.cut(ctx.fnStart!, end);
            const parent = stack[stack.length - 1];
            if (parent.k === "class") parent.memberStart = true;
            i = end;
            continue;
          }
          i = j;
          continue;
        }
        case "]":
        case "}": {
          stack.pop();
          const parent = stack[stack.length - 1];
          if (!parent) return void this.fail();
          if (t === "}" && parent.k === "class" && ctx.k === "block") parent.memberStart = true;
          i++;
          continue;
        }
        case ",":
          if (ctx.k === "params") {
            ctx.paramStart = true;
            ctx.inDefault = false;
          } else if (ctx.k === "object") ctx.atKey = true;
          else if (ctx.varDecl) {
            i = varBinding(i + 1);
            continue;
          }
          i++;
          continue;
        case ";":
          ctx.varDecl = false;
          if (ctx.k === "class") ctx.memberStart = true;
          i++;
          continue;
        case "=":
          if (ctx.k === "params") ctx.inDefault = true;
          i++;
          continue;
        case "?":
          if (ctx.k === "params" && !ctx.inDefault) {
            const next = this.t(i + 1);
            if (next === ":" || next === "," || next === ")" || next === "=") this.cut(i, i + 1);
          }
          i++;
          continue;
        case ":":
          if (ctx.k === "params" && !ctx.inDefault) {
            const k = this.skipType(i + 1);
            if (k < 0) return void this.fail();
            this.cut(i, k);
            i = k;
            continue;
          }
          i++;
          continue;
        case "!":
          if (i > 0 && !tok.nl && this.endsExpr(this.effPrev(i))) this.cut(i, i + 1);
          i++;
          continue;
        case "<": {
          const pi = this.effPrev(i);
          const prev = this.t(pi);
          if (pi >= 0 && this.endsExpr(pi) && prev !== "num" && prev !== "string") {
            const nameLike = prev === "name" || (prev !== "eof" && /^[a-z]+$/.test(prev) && (this.t(pi - 1) === "." || this.t(pi - 1) === "?."));
            const k = nameLike ? this.skipAngle(i) : -1;
            if (k > 0 && (this.t(k) === "(" || this.t(k) === "`")) {
              this.cut(i, k);
              i = k;
              continue;
            }
          } else if (!this.tsx) {
            const k = this.skipAngle(i);
            if (k > 0) {
              this.cut(i, k);
              i = k;
              continue;
            }
          }
          i++;
          continue;
        }
        case "function": {
          let start = i;
          while (start > 0 && ["async", "declare"].includes(this.word(start - 1))) start--;
          while (start > 0 && (this.t(start - 1) === "export" || this.t(start - 1) === "default")) start--;
          let j = i + 1;
          if (this.t(j) === "*") j++;
          if (this.t(j) === "name") j++;
          if (this.t(j) === "<") {
            const k = this.skipAngle(j);
            if (k < 0) return void this.fail();
            this.cut(j, k);
            j = k;
          }
          if (this.t(j) === "(") pendingParams = { at: j, fnStart: start };
          i = j;
          continue;
        }
        case "class": {
          let j = i + 1;
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
          if (this.t(j) === "{") pendingBrace = "class";
          i = j;
          continue;
        }
        case "import": {
          const next = this.t(i + 1);
          if (next === "(" || next === ".") {
            i++;
            continue;
          }
          let j = i + 1;
          // `import type …` stays an import (a type-only import is still a dependency): drop the modifier only
          if (this.word(j) === "type" && (this.t(j + 1) === "{" || this.t(j + 1) === "*" || (this.t(j + 1) === "name" && this.word(j + 1) !== "from"))) {
            this.cut(j, j + 1);
            j++;
          }
          if (this.t(j) === "name" && this.t(j + 1) === "=") {
            // import x = require("y") / import x = A.B  →  const x = …
            this.edits.push([tok.s, "const "]);
            i = j;
            continue;
          }
          const end = this.moduleStatementEnd(j);
          for (let k = j; k < end && this.t(k) !== "string"; k++) {
            if (this.t(k) === "{") {
              this.stripTypeSpecifiers(k, this.closeOf(k));
              break;
            }
          }
          i = end;
          continue;
        }
        case "export": {
          const j = i + 1;
          const w = this.word(j);
          if (w === "type" && (this.t(j + 1) === "{" || this.t(j + 1) === "*")) {
            const end = this.moduleStatementEnd(j + 1);
            const close = this.t(j + 1) === "{" ? this.closeOf(j + 1) : -1;
            if (this.t(j + 1) === "*" || this.word(close + 1) === "from") {
              // `export type { X } from "y"` stays a re-export (a dependency): drop the modifier only
              this.cut(j, j + 1);
              if (close > 0) this.stripTypeSpecifiers(j + 1, close);
            } else this.cut(i, end); // a local type-only export list
            i = end;
            continue;
          }
          if (w === "type" && this.t(j + 1) === "name" && (this.t(j + 2) === "=" || this.t(j + 2) === "<")) {
            const end = this.typeAliasEnd(j);
            if (end < 0) return void this.fail();
            this.cut(i, end);
            i = end;
            continue;
          }
          if (w === "interface" && this.t(j + 1) === "name") {
            const end = this.interfaceEnd(j);
            if (end < 0) return void this.fail();
            this.cut(i, end);
            i = end;
            continue;
          }
          if (this.t(j) === "default" && this.word(j + 1) === "interface") {
            const end = this.interfaceEnd(j + 1);
            if (end < 0) return void this.fail();
            this.cut(i, end);
            i = end;
            continue;
          }
          if (w === "declare") {
            const end = this.declareEnd(j);
            if (end < 0) return void this.fail();
            this.cut(i, end);
            i = end;
            continue;
          }
          if (this.t(j) === "=" || (w === "as" && this.word(j + 1) === "namespace")) {
            const end = this.statementEnd(j);
            this.cut(i, end);
            i = end;
            continue;
          }
          if (this.t(j) === "{" || this.t(j) === "*") {
            const end = this.moduleStatementEnd(j);
            if (this.t(j) === "{") {
              const close = this.closeOf(j);
              // a local export list (no `from`) drops names that exist only as types
              this.stripTypeSpecifiers(j, close, this.word(close + 1) !== "from");
            }
            i = end;
            continue;
          }
          i = j;
          continue;
        }
        case "const":
        case "var": {
          if (t === "const" && this.word(i + 1) === "enum" && this.t(i + 2) === "name") {
            const end = this.rewriteAsVar(i, i + 2);
            if (end < 0) return void this.fail();
            i = end;
            continue;
          }
          ctx.varDecl = true;
          i = varBinding(i + 1);
          continue;
        }
        case "name": {
          const w = tok.v;
          const next = this.t(i + 1);
          const sameLine = !this.nl(i + 1);
          if (w === "let" && (next === "name" || next === "{" || next === "[")) {
            ctx.varDecl = true;
            i = varBinding(i + 1);
            continue;
          }
          if ((w === "as" || w === "satisfies") && i > 0 && !tok.nl && this.endsExpression(this.effPrev(i)) && next !== "eof") {
            const k = this.skipType(i + 1);
            if (k > 0) {
              this.cut(i, k);
              i = k;
              continue;
            }
          }
          if (w === "type" && next === "name" && sameLine && (this.t(i + 2) === "=" || this.t(i + 2) === "<")) {
            const end = this.typeAliasEnd(i);
            if (end > 0) {
              this.cut(i, end);
              i = end;
              continue;
            }
          }
          if (w === "interface" && next === "name" && sameLine) {
            const end = this.interfaceEnd(i);
            if (end < 0) return void this.fail();
            this.cut(i, end);
            i = end;
            continue;
          }
          if (w === "declare" && sameLine && (next === "const" || next === "var" || next === "class" || next === "function" || ["let", "enum", "module", "namespace", "global", "type", "interface", "abstract", "async"].includes(this.word(i + 1)))) {
            const end = this.declareEnd(i);
            if (end < 0) return void this.fail();
            this.cut(i, end);
            i = end;
            continue;
          }
          if (w === "enum" && next === "name" && sameLine) {
            const end = this.rewriteAsVar(i, i + 1);
            if (end < 0) return void this.fail();
            i = end;
            continue;
          }
          if ((w === "namespace" || w === "module") && next === "name" && sameLine && this.t(i + 2) !== "=") {
            let k = i + 2;
            while (this.t(k) === "." && this.t(k + 1) === "name") k += 2;
            if (this.t(k) === "{") {
              const end = this.rewriteAsVar(i, i + 1);
              if (end < 0) return void this.fail();
              i = end;
              continue;
            }
          }
          if (w === "abstract" && next === "class" && sameLine) {
            this.cut(i, i + 1);
            i++;
            continue;
          }
          i++;
          continue;
        }
        default:
          i++;
          continue;
      }
    }
  }

  /** After `label:` or `case x:` a `{` starts a block; after a ternary `:` it starts an object. */
  private colonStartsBlock(colon: number): boolean {
    for (let k = colon - 1, steps = 0; k >= 0 && steps < 64; k--, steps++) {
      const t = this.t(k);
      if (t === "case" || t === "default") return true;
      if (t === "?" || t === ";" || t === "{" || t === "}") return t !== "?" && k === colon - 2;
      if (this.nl(k)) return k === colon - 1;
    }
    return false;
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

/** Blank decorators (`@name`, `@a.b(…)`), which the tokenizer cannot read; marks them in `removed`. */
function blankDecorators(src: string, removed: Uint8Array): string {
  if (src.indexOf("@") === -1) return src;
  const masked = maskSource(src, true);
  let at = masked.indexOf("@");
  if (at === -1) return src;
  const out = src.split("");
  while (at !== -1) {
    let j = at + 1;
    while (j < masked.length && /[\w$.]/.test(masked[j])) j++;
    let k = j;
    while (k < masked.length && (masked[k] === " " || masked[k] === "\t")) k++;
    if (masked[k] === "(") {
      const c = matchBracket(masked, k);
      if (c > 0) j = c + 1;
    }
    for (let x = at; x < j; x++) {
      removed[x] = 1;
      if (out[x] !== "\n" && out[x] !== "\r") out[x] = " ";
    }
    at = masked.indexOf("@", j);
  }
  return out.join("");
}

/** Tokens of (TypeScript) source, or null if the JavaScript tokenizer cannot read it. */
function tokenizeTs(src: string): Tok[] | null {
  const toks: Tok[] = [];
  try {
    let prevEnd = 0;
    let nextNl = src.indexOf("\n");
    for (const tok of tokenizer(src, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true })) {
      const type = tok.type;
      let t: string;
      if (type.keyword) t = type.keyword;
      else if (TOKEN_CATEGORIES.has(type.label)) t = type.label === "invalidTemplate" ? "template" : type.label;
      else t = src.slice(tok.start, tok.end);
      while (nextNl !== -1 && nextNl < prevEnd) nextNl = src.indexOf("\n", nextNl + 1);
      const nl = nextNl !== -1 && nextNl < tok.start;
      const value = (tok as unknown as { value?: unknown }).value;
      toks.push({ t, v: type.label === "name" ? String(value) : src.slice(tok.start, tok.end), s: tok.start, e: tok.end, nl });
      prevEnd = tok.end;
    }
  } catch {
    return null;
  }
  return toks;
}

/** Characters of code[start, end) that were not blanked by the type strip. */
function keptText(code: string, start: number, end: number, removed: Uint8Array): string {
  let out = "";
  let runStart = start;
  for (let k = start; k < end; k++) {
    if (removed[k]) {
      if (k > runStart) out += code.slice(runStart, k);
      runStart = k + 1;
    }
  }
  if (end > runStart) out += code.slice(runStart, end);
  return out;
}

/**
 * Best-effort TypeScript → JavaScript by blanking types in place (same length, same line breaks).
 * Handles annotations, generics, `as`/`satisfies`/`!`, interfaces, type aliases, `declare`,
 * `import type`/`export type`, overloads, class modifiers, parameter properties, enums and
 * namespaces (as `var X;`). Returns null when the source cannot be tokenized or a construct is
 * not understood; the caller then parses the original and falls back to the regex scanner.
 */
export function stripTypeScript(source: string, tsx = false): string | null {
  return stripTypeScriptDetailed(source, tsx)?.code ?? null;
}

/** `stripTypeScript` plus a map of the positions it blanked (1 = removed). */
function stripTypeScriptDetailed(source: string, tsx: boolean): { code: string; removed: Uint8Array } | null {
  const removed = new Uint8Array(source.length);
  let src = source;
  let toks = tokenizeTs(src);
  if (toks === null && source.includes("@")) {
    // decorators are the one TypeScript construct the tokenizer cannot read
    src = blankDecorators(source, removed);
    toks = tokenizeTs(src);
  }
  if (toks === null) return null;
  const s = new TsStripper(src, toks, tsx);
  if (!s.pair()) return null;
  s.collectTypeOnlyNames();
  s.run();
  if (s.failed) return null;
  return { code: s.output(removed), removed };
}
