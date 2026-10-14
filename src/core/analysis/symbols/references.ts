/**
 * Walks a syntax tree and collects the names that code uses, with scopes so that locals do not count.
 *
 * Called by `ast-analysis.ts`. Read `RefCollector` first.
 */

import type { AnyNode } from "./helpers";

// ───── Scopes ─────

export class Scope {
  readonly names = new Set<string>();
  constructor(readonly parent: Scope | null) {}
  has(name: string): boolean {
    for (let s: Scope | null = this; s; s = s.parent) if (s.names.has(name)) return true;
    return false;
  }
}

export const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "raw"]);

export function isNode(v: unknown): v is AnyNode {
  return !!v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";
}

/** Names bound by a binding pattern. */
export function boundNames(p: AnyNode, out: Set<string>): void {
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
  if (!node.computed) {
    if (node.property.type === "PrivateIdentifier") return `#${node.property.name}`;
    return node.property.type === "Identifier" ? node.property.name : undefined;
  }
  return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : undefined;
}

// ───── Collecting references ─────

/**
 * Collects free identifiers (and `root.prop` for member access on a free identifier). In the methods
 * of a class or object (`thisName`), `this.prop` gives `Owner.prop`. JSX components count as uses
 * (`<Card />` gives `Card`; `<ui.Card />` gives `ui` and `ui.Card`); HTML tags (`<div>`) do not.
 */
export class RefCollector {
  readonly out = new Set<string>();
  /** The class or object that `this` means here, if known. */
  thisName?: string;

  /** Walks one node and records the free names that it uses. Each kind of node has its own rule for scope. */
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
      case "JSXOpeningElement":
        this.jsxName(node.name, scope);
        for (const at of node.attributes) this.walk(at, scope);
        return;
      case "JSXAttribute":
        if (node.value) this.walk(node.value, scope);
        return;
      case "JSXClosingElement":
      case "JSXIdentifier":
      case "JSXText":
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        this.cls(node, scope);
        return;
      case "VariableDeclaration":
        this.variableDeclaration(node, scope);
        return;
      case "BlockStatement":
      case "StaticBlock":
        this.block(node, scope);
        return;
      case "SwitchStatement":
        this.switchStatement(node, scope);
        return;
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
        this.loop(node, scope);
        return;
      case "CatchClause":
        this.catchClause(node, scope);
        return;
      case "Property":
        if (node.computed) this.walk(node.key, scope);
        this.walk(node.value, scope);
        return;
      case "MethodDefinition":
        if (node.computed) this.walk(node.key, scope);
        // A method body keeps the `this` of its class.
        if (node.value) this.fn(node.value, scope, true);
        return;
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

  /** `const`, `let` or `var`: the pattern, then the value of each declarator. */
  private variableDeclaration(node: AnyNode, scope: Scope): void {
    for (const d of node.declarations) {
      this.pattern(d.id, scope);
      if (d.init) this.walk(d.init, scope);
    }
  }

  /** A block: its own scope, with the names that it declares. */
  private block(node: AnyNode, scope: Scope): void {
    const s = new Scope(scope);
    declareStatements(node.body, s.names);
    for (const st of node.body) this.walk(st, s);
  }

  /** A switch: the cases share one scope. */
  private switchStatement(node: AnyNode, scope: Scope): void {
    this.walk(node.discriminant, scope);
    const s = new Scope(scope);
    for (const c of node.cases) declareStatements(c.consequent, s.names);
    for (const c of node.cases) {
      if (c.test) this.walk(c.test, s);
      for (const st of c.consequent) this.walk(st, s);
    }
  }

  /** A for loop: the names of its head belong to the loop. */
  private loop(node: AnyNode, scope: Scope): void {
    const s = new Scope(scope);
    const head = node.type === "ForStatement" ? node.init : node.left;
    if (head && head.type === "VariableDeclaration") for (const d of head.declarations) boundNames(d.id, s.names);
    this.children(node, s);
  }

  /** A catch clause: its parameter belongs to the clause. */
  private catchClause(node: AnyNode, scope: Scope): void {
    const s = new Scope(scope);
    if (node.param) {
      boundNames(node.param, s.names);
      this.pattern(node.param, s);
    }
    this.walk(node.body, s);
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

  /** A function. Its own `this` hides the `this` of a class, unless it is an arrow or a method body (`keepThis`). */
  fn(node: AnyNode, outer: Scope, keepThis = false): void {
    const thisBefore = this.thisName;
    if (node.type !== "ArrowFunctionExpression" && !keepThis) this.thisName = undefined;
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
    this.thisName = thisBefore;
  }

  /** A class. In its body, `this` means the class (`name`, else its own name). */
  cls(node: AnyNode, outer: Scope, name?: string): void {
    if (node.superClass) this.walk(node.superClass, outer);
    const thisBefore = this.thisName;
    this.thisName = name ?? node.id?.name;
    const s = new Scope(outer);
    if (node.id) s.names.add(node.id.name);
    for (const m of node.body.body) this.walk(m, s);
    this.thisName = thisBefore;
  }

  member(node: AnyNode, scope: Scope): void {
    const obj = node.object;
    if (obj.type === "Identifier") {
      if (!scope.has(obj.name)) {
        this.out.add(obj.name);
        const prop = memberPropertyName(node);
        if (prop !== undefined) this.out.add(`${obj.name}.${prop}`);
      }
    } else if (obj.type === "ThisExpression") {
      const prop = this.thisName ? memberPropertyName(node) : undefined;
      if (prop !== undefined) this.out.add(`${this.thisName}.${prop}`);
    } else this.walk(obj, scope);
    if (node.computed) this.walk(node.property, scope);
  }

  /** The name of a JSX element: a component is a use, an HTML tag (lowercase) is not. */
  jsxName(n: AnyNode, scope: Scope): void {
    if (n.type === "JSXIdentifier") {
      if (!/^[a-z]/.test(n.name) && n.name !== "this" && !scope.has(n.name)) this.out.add(n.name);
    } else if (n.type === "JSXMemberExpression") {
      let inner = n;
      while (inner.object.type === "JSXMemberExpression") inner = inner.object;
      const root = inner.object;
      if (root.type !== "JSXIdentifier" || root.name === "this" || scope.has(root.name)) return;
      this.out.add(root.name);
      this.out.add(`${root.name}.${inner.property.name}`);
    }
  }
}
