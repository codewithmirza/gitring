/**
 * Reads a parsed syntax tree: top-level declarations, exports, imports, the names each one uses, and class members.
 *
 * Called by the front door `../symbols`. For a file that does not parse, see `regex-analysis.ts`.
 */

import type { LineRange } from "../../types";
import type { CommentSpan } from "./acorn-parse";
import { MAX_MEMBERS, collapse, emptyAnalysis, lineIndex, ownEntry, sortedArray } from "./helpers";
import type { AnyNode } from "./helpers";
import { RefCollector, SKIP_KEYS, Scope, boundNames, isNode } from "./references";
import { keptText } from "./ts-tokens";
import type { DeclInfo, ImportInfo, MemberInfo, ModuleAnalysis } from "./types";

function nameOf(node: AnyNode): string {
  return node.type === "Identifier" ? node.name : String(node.value);
}

/** `removed` (TypeScript only) marks blanked type positions, which param texts leave out. */
export function analyzeProgram(path: string, code: string, program: AnyNode, removed?: Uint8Array, comments: CommentSpan[] = []): ModuleAnalysis {
  const a = emptyAnalysis(path);
  const lineOf = lineIndex(code);
  const rangeOf = (n: AnyNode): LineRange => [lineOf(n.start), lineOf(Math.max(n.start, n.end - 1))];
  const paramText = (p: AnyNode): string => collapse(removed ? keptText(code, p.start, p.end, removed) : code.slice(p.start, p.end));
  const refSets = new Map<string, Set<string>>();
  const topLevel = new Set<string>();
  const memberRefs = new Map<string, Set<string>>();

  /** The first comment that starts at or after `offset` (comments come in source order). */
  const commentAt = (offset: number): number => {
    let lo = 0;
    let hi = comments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (comments[mid][0] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  /**
   * Members of a class body or an object literal. Each member keeps the comments between the member
   * before it (or the opening brace) and itself. An owner with more than MAX_MEMBERS members gets none.
   */
  const addMembers = (owner: string, node: AnyNode): void => {
    const isClass = node.type === "ClassDeclaration" || node.type === "ClassExpression";
    const items: AnyNode[] = isClass ? node.body.body : node.properties;
    const found: { name: string; item: AnyNode; kind: MemberInfo["kind"]; fn?: AnyNode }[] = [];
    for (const item of items) {
      if (!item || item.computed) continue;
      const key = item.key;
      let name: string | undefined;
      if (key?.type === "Identifier") name = key.name;
      else if (key?.type === "PrivateIdentifier") name = `#${key.name}`;
      else if (key?.type === "Literal" && typeof key.value === "string" && /^[A-Za-z_$][\w$]*$/.test(key.value)) name = key.value;
      if (name === undefined) continue;
      const value = item.value;
      const isFn = !!value && (value.type === "FunctionExpression" || value.type === "ArrowFunctionExpression");
      if (item.type === "MethodDefinition") found.push({ name, item, kind: item.kind === "get" || item.kind === "set" ? item.kind : "method", fn: item.kind === "get" || item.kind === "set" ? undefined : value });
      else if (item.type === "PropertyDefinition" || item.type === "AccessorProperty") found.push({ name, item, kind: "field", fn: isFn ? value : undefined });
      else if (item.type === "Property") {
        const kind: MemberInfo["kind"] = item.kind === "get" || item.kind === "set" ? item.kind : item.method ? "method" : "field";
        found.push({ name, item, kind, fn: kind !== "get" && kind !== "set" && isFn ? value : undefined });
      }
    }
    if (found.length > MAX_MEMBERS) return;
    a.memberOwners.push(owner);
    let boundary = isClass ? node.body.start : node.start;
    for (const { name, item, kind, fn } of found) {
      const c = commentAt(boundary);
      const start = c < comments.length && comments[c][1] <= item.start ? Math.min(item.start, comments[c][0]) : item.start;
      boundary = item.end;
      const key = `${owner}.${name}`;
      const r = new RefCollector();
      const root = new Scope(null);
      const value = item.value;
      // `this` in a method, a getter, a setter or a class field is the owner. In an arrow property of an object, it is not.
      if (kind !== "field" || isClass || value?.type === "FunctionExpression") r.thisName = owner;
      if (value && value.type === "FunctionExpression") r.fn(value, root, true);
      else if (value) r.walk(value, root);
      r.out.delete(owner);
      r.out.delete(key);
      const prev = ownEntry(a.members, key);
      if (prev) {
        // A getter and a setter (or a static and an instance member) of one name are one member.
        prev.span = [Math.min(prev.span[0], start), Math.max(prev.span[1], item.end)];
        prev.range = [lineOf(prev.span[0]), lineOf(Math.max(prev.span[0], prev.span[1] - 1))];
        for (const x of r.out) memberRefs.get(key)!.add(x);
        continue;
      }
      const info: MemberInfo = { name: key, owner, kind, range: [lineOf(start), lineOf(Math.max(start, item.end - 1))], span: [start, item.end], exported: false };
      if (item.static) info.static = true;
      if (fn) {
        info.params = fn.params.map(paramText);
        info.signature = `${key}(${info.params!.join(", ")})`;
      }
      a.members[key] = info;
      memberRefs.set(key, r.out);
    }
  };

  /** `require("x")` or `require("x").name`: the specifier and the property. */
  const requireOf = (init: AnyNode): { from: string; prop?: string } | undefined => {
    if (!init) return undefined;
    if (init.type === "MemberExpression" && !init.computed && init.property.type === "Identifier") {
      const inner = requireOf(init.object);
      return inner && inner.prop === undefined ? { from: inner.from, prop: init.property.name } : undefined;
    }
    const arg = init.type === "CallExpression" && init.callee.type === "Identifier" && init.callee.name === "require" && init.arguments.length === 1 ? init.arguments[0] : undefined;
    return arg && arg.type === "Literal" && typeof arg.value === "string" ? { from: arg.value } : undefined;
  };

  /** `const x = require("./x")` and `const { a, b: c } = require("./x")` bind names as an import does. */
  const addRequire = (id: AnyNode, req: { from: string; prop?: string }): void => {
    const names: ImportInfo["names"] = [];
    if (id.type === "Identifier") names.push({ imported: req.prop ?? "*", local: id.name });
    else if (id.type === "ObjectPattern" && req.prop === undefined) {
      for (const p of id.properties) {
        if (p.type !== "Property" || p.computed || p.key.type !== "Identifier") continue;
        const local = p.value.type === "Identifier" ? p.value : p.value.type === "AssignmentPattern" && p.value.left.type === "Identifier" ? p.value.left : undefined;
        if (local) names.push({ imported: p.key.name, local: local.name });
      }
    }
    a.imports.push({ from: req.from, names });
    for (const n of names) a.bindings[n.local] = { from: req.from, imported: n.imported };
  };

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
      r.cls(node, new Scope(null), name);
      addDecl({ name, kind: "class", range, exported }, r.out);
      ownMembers(name, node);
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
        if (d.id.type === "Identifier") ownMembers(d.id.name, d.init);
      }
    }
  };

  /** Members of a top-level class or object literal (once per owner: a repeated `var` keeps the first). */
  const ownMembers = (owner: string, node: AnyNode): void => {
    if (!node || !["ClassDeclaration", "ClassExpression", "ObjectExpression"].includes(node.type) || a.memberOwners.includes(owner)) return;
    addMembers(owner, node);
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
          // `export default { fetch() {} }` (a Worker): its handlers are members.
          ownMembers("default", d);
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
        declare(st, st, false);
        break;
      case "VariableDeclaration": {
        const reqs = (st.declarations as AnyNode[]).map((d) => requireOf(d.init));
        (st.declarations as AnyNode[]).forEach((d, i) => {
          if (reqs[i]) addRequire(d.id, reqs[i]!);
        });
        // A statement of `require` calls only is an import, not a declaration.
        if (!reqs.every(Boolean)) declare(st, st, false);
        break;
      }
      default: {
        const r = new RefCollector();
        r.walk(st, new Scope(null));
        addStatement(st, r.out);
      }
    }
  }

  // Other `require("x")` calls (in a function, or a bare `require("./setup")`) are imports without names.
  if (code.includes("require")) {
    const seen = new Set(a.imports.map((i) => i.from));
    const calls: { at: number; from: string }[] = [];
    const stack: AnyNode[] = [program];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === "CallExpression") {
        const req = requireOf(n);
        if (req && !seen.has(req.from)) {
          seen.add(req.from);
          calls.push({ at: n.start, from: req.from });
        }
      }
      for (const key in n) {
        if (SKIP_KEYS.has(key)) continue;
        const v = n[key];
        if (Array.isArray(v)) {
          for (const x of v) if (isNode(x)) stack.push(x);
        } else if (isNode(v)) stack.push(v);
      }
    }
    for (const c of calls.sort((x, y) => x.at - y.at)) a.imports.push({ from: c.from, names: [] });
  }

  for (const local of Object.values(a.exports)) {
    const d = a.decls[local];
    if (d) d.exported = true;
  }
  for (const [name, set] of refSets) a.references[name] = sortedArray(set);
  for (const m of Object.values(a.members)) m.exported = !!ownEntry(a.decls, m.owner)?.exported && !m.name.startsWith(`${m.owner}.#`);
  for (const [key, set] of memberRefs) a.memberReferences[key] = sortedArray(set);
  a.topLevelReferences = sortedArray(topLevel);
  return a;
}
