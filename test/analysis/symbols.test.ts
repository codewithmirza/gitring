import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { analyzeModule, extractSymbols, isAnalyzable, pathAliasesOf, resolveImport, stripTypeScript } from "../../src/core/analysis/symbols";
import { ALL_FILES, INDEX_JS, PRODUCTS_JS, RENDER_JS } from "./fixtures";

describe("extractSymbols: the app", () => {
  it("reads products.js: data, formatPrice(cents), findProduct(id)", () => {
    const s = extractSymbols("src/products.js", PRODUCTS_JS);
    expect(s.parseError).toBeUndefined();
    expect(s.decls).toEqual({
      PRODUCTS: { name: "PRODUCTS", kind: "const", range: [1, 5], exported: true },
      formatPrice: { name: "formatPrice", kind: "function", params: ["cents"], signature: "formatPrice(cents)", range: [7, 9], exported: true },
      findProduct: { name: "findProduct", kind: "function", params: ["id"], signature: "findProduct(id)", range: [11, 13], exported: true },
    });
    expect(s.exports).toEqual({ PRODUCTS: "PRODUCTS", formatPrice: "formatPrice", findProduct: "findProduct" });
    expect(s.imports).toEqual([]);
    expect(s.references).toEqual({ PRODUCTS: [], formatPrice: [], findProduct: ["PRODUCTS", "PRODUCTS.find"] });
    expect(s.topLevelReferences).toEqual([]);
  });

  it("reads render.js: imports, helper references, destructured params", () => {
    const s = extractSymbols("src/render.js", RENDER_JS);
    expect(s.imports).toEqual([
      { from: "./products.js", names: [{ imported: "formatPrice", local: "formatPrice" }] },
      { from: "./styles.js", names: [{ imported: "STYLES", local: "STYLES" }] },
    ]);
    expect(Object.keys(s.decls)).toEqual(["escapeHtml", "renderItem", "renderPage"]);
    expect(s.decls.renderItem).toEqual({ name: "renderItem", kind: "function", params: ["p"], signature: "renderItem(p)", range: [8, 10], exported: false });
    expect(s.decls.renderPage.params).toEqual(["{ products, query }"]);
    expect(s.decls.renderPage.signature).toBe("renderPage({ products, query })");
    expect(s.decls.renderPage.range).toEqual([12, 23]);
    expect(s.references.renderItem).toEqual(["escapeHtml", "formatPrice"]);
    expect(s.references.renderPage).toEqual(["STYLES", "escapeHtml", "renderItem"]);
    expect(s.references.escapeHtml).toEqual(["String"]);
    expect(s.exports).toEqual({ renderPage: "renderPage" });
  });

  it("reads index.js: the default-exported handler object", () => {
    const s = extractSymbols("src/index.js", INDEX_JS);
    expect(s.decls).toEqual({ default: { name: "default", kind: "const", range: [4, 16], exported: true } });
    expect(s.exports).toEqual({ default: "default" });
    expect(s.references.default).toEqual(["PRODUCTS", "PRODUCTS.filter", "Response", "Response.json", "URL", "renderPage"]);
    expect(s.imports.map((i) => i.from)).toEqual(["./render.js", "./products.js"]);
  });

  it("fills imports[].resolved when the file set is given", () => {
    const s = extractSymbols("src/render.js", RENDER_JS, ALL_FILES);
    expect(s.imports.map((i) => i.resolved)).toEqual(["src/products.js", "src/styles.js"]);
  });
});

describe("extractSymbols: declarations", () => {
  it("records params for arrow functions and function expressions", () => {
    const s = extractSymbols(
      "a.js",
      `export const add = (a, b = 2) => a + b;
const scale = async function (value, { factor = 1, ...rest } = {}) { return value * factor; };
let counter = 0;
var legacy = x => x;
class Cart extends Base {}
`,
    );
    expect(s.decls.add).toEqual({ name: "add", kind: "const", params: ["a", "b = 2"], signature: "add(a, b = 2)", range: [1, 1], exported: true });
    expect(s.decls.scale.params).toEqual(["value", "{ factor = 1, ...rest } = {}"]);
    expect(s.decls.scale.kind).toBe("const");
    expect(s.decls.counter).toEqual({ name: "counter", kind: "let", range: [3, 3], exported: false });
    expect(s.decls.legacy).toMatchObject({ kind: "var", params: ["x"], signature: "legacy(x)" });
    expect(s.decls.Cart).toEqual({ name: "Cart", kind: "class", range: [5, 5], exported: false });
    expect(s.references.Cart).toEqual(["Base"]);
  });

  it("collapses whitespace in multi-line params", () => {
    const s = extractSymbols("a.js", `export function renderPage({\n  products,\n  query,\n}, options = {\n  dense: true,\n}) {}\n`);
    expect(s.decls.renderPage.params).toEqual(["{ products, query, }", "options = { dense: true, }"]);
  });

  it("names default exports", () => {
    expect(extractSymbols("a.js", "export default function handler(req) {}\n").decls.handler).toMatchObject({ kind: "function", exported: true, params: ["req"] });
    expect(extractSymbols("a.js", "export default function handler(req) {}\n").exports).toEqual({ default: "handler" });
    const anon = extractSymbols("a.js", "export default function (req, env) {}\n");
    expect(anon.decls.default).toEqual({ name: "default", kind: "function", params: ["req", "env"], signature: "default(req, env)", range: [1, 1], exported: true });
    expect(extractSymbols("a.js", "export default class {}\n").decls.default.kind).toBe("class");
    const arrow = extractSymbols("a.js", "export default (a, b) => a + b;\n");
    expect(arrow.decls.default).toMatchObject({ kind: "function", params: ["a", "b"] });
    const ident = extractSymbols("a.js", "const app = {};\nexport default app;\n");
    expect(ident.exports).toEqual({ default: "app" });
    expect(ident.decls.app.exported).toBe(true);
    expect(ident.topLevelReferences).toEqual(["app"]);
  });

  it("maps export lists and marks the local declarations exported", () => {
    const s = extractSymbols("a.js", "export { format as formatPrice, total };\nfunction format(c) {}\nconst total = 1;\nconst hidden = 2;\n");
    expect(s.exports).toEqual({ formatPrice: "format", total: "total" });
    expect(s.decls.format.exported).toBe(true);
    expect(s.decls.total.exported).toBe(true);
    expect(s.decls.hidden.exported).toBe(false);
  });

  it("records re-exports as imports and exports", () => {
    const s = extractSymbols("src/index.js", `export { formatPrice as price, default } from "./products.js";\nexport * from "./render.js";\nexport * as styles from "./styles.js";\n`);
    expect(s.imports).toEqual([
      { from: "./products.js", names: [{ imported: "formatPrice", local: "price" }, { imported: "default", local: "default" }] },
      { from: "./render.js", names: [{ imported: "*", local: "*" }] },
      { from: "./styles.js", names: [{ imported: "*", local: "styles" }] },
    ]);
    expect(s.exports).toEqual({ price: "price", default: "default", styles: "styles" });
    expect(s.decls).toEqual({});
  });

  it("reads default, named and namespace imports, and ignores dynamic import()", () => {
    const s = extractSymbols("a.js", `import React, { useState as useS } from "react";\nimport * as products from "./products.js";\nimport "./polyfill.js";\nconst lazy = () => import("./lazy.js");\n`);
    expect(s.imports).toEqual([
      { from: "react", names: [{ imported: "default", local: "React" }, { imported: "useState", local: "useS" }] },
      { from: "./products.js", names: [{ imported: "*", local: "products" }] },
      { from: "./polyfill.js", names: [] },
    ]);
  });

  it("uses the whole statement as the range, including export and multi-line bodies", () => {
    const s = extractSymbols("a.js", "\n\nexport const a = 1,\n  b = [\n    2,\n  ];\n");
    expect(s.decls.a.range).toEqual([3, 6]);
    expect(s.decls.b.range).toEqual([3, 6]);
  });
});

describe("extractSymbols: references", () => {
  it("excludes params, locals and inner functions, and keeps outer names", () => {
    const s = extractSymbols(
      "a.js",
      `import { formatPrice } from "./products.js";
const TAX = 0.2;
export function total(items, rate = TAX) {
  let sum = 0;
  for (const item of items) sum += item.cents;
  function round(x) { return Math.round(x); }
  try { audit(sum); } catch (err) { report(err); }
  const label = (cents) => formatPrice(cents);
  return label(round(sum * (1 + rate)));
}
`,
    );
    expect(s.references.total).toEqual(["Math", "Math.round", "TAX", "audit", "formatPrice", "report"]);
  });

  it("records member access roots: ns.fn gives ns and ns.fn", () => {
    const s = extractSymbols("a.js", `import * as products from "./products.js";\nexport function price(p) { return products.formatPrice(p.cents) + products["findProduct"](p.id); }\n`);
    expect(s.references.price).toEqual(["products", "products.findProduct", "products.formatPrice"]);
  });

  it("respects block scope and shadowing", () => {
    const s = extractSymbols(
      "a.js",
      `function f() {
  if (a) { const formatPrice = 1; use(formatPrice); }
  return formatPrice(2);
}
`,
    );
    expect(s.references.f).toEqual(["a", "formatPrice", "use"]);
  });

  it("does not count object keys, labels, methods or its own name", () => {
    const s = extractSymbols(
      "a.js",
      `function walk(node) {
  outer: for (const k of keys) { if (k) break outer; }
  const o = { fetch: 1, render() { return walk(node.child); }, [dynamic]: 2, shorthand };
  return o.fetch + this.x + arguments.length;
}
class Store { static of() { return new Store(); } #items = []; get size() { return this.#items.length; } }
`,
    );
    expect(s.references.walk).toEqual(["dynamic", "keys", "shorthand"]);
    expect(s.references.Store).toEqual([]);
  });

  it("collects top-level references outside declarations", () => {
    const s = analyzeModule("a.js", `import { renderPage } from "./render.js";\nconst app = createApp();\napp.get("/", renderPage);\nexport { app as server };\n`);
    expect(s.topLevelReferences).toEqual(["app", "app.get", "renderPage"]);
    expect(s.statements).toEqual([
      { range: [3, 3], references: ["app", "app.get", "renderPage"] },
      { range: [4, 4], references: ["app"] },
    ]);
    expect(s.bindings).toEqual({ renderPage: { from: "./render.js", imported: "renderPage" } });
    expect(s.references.app).toEqual(["createApp"]);
  });
});

describe("extractSymbols: never throws", () => {
  it("falls back to the regex scanner on a syntax error", () => {
    const src = `import { formatPrice } from "./products.js";
import * as styles from "./styles.js";

export function renderTotal(items) {
  const total = items.reduce((sum, item) => sum + item.cents, 0);
  return \`<p>Total: \${formatPrice(total)}</p>\`;
}

export const renderBadge = (label, tone = "info") => \`<b class="\${tone}">\${label}</b>\`;

function broken( {
  return styles.badge;
}

export default renderTotal;
`;
    const s = extractSymbols("src/total.js", src);
    expect(s.parseError).toMatch(/Unexpected token|\(\d+:\d+\)/);
    expect(s.imports).toEqual([
      { from: "./products.js", names: [{ imported: "formatPrice", local: "formatPrice" }] },
      { from: "./styles.js", names: [{ imported: "*", local: "styles" }] },
    ]);
    expect(s.decls.renderTotal).toEqual({ name: "renderTotal", kind: "function", params: ["items"], signature: "renderTotal(items)", range: [4, 7], exported: true });
    expect(s.decls.renderBadge).toEqual({
      name: "renderBadge",
      kind: "const",
      params: ["label", 'tone = "info"'],
      signature: 'renderBadge(label, tone = "info")',
      range: [9, 9],
      exported: true,
    });
    expect(s.decls.broken).toMatchObject({ kind: "function", exported: false });
    expect(s.references.renderTotal).toEqual(["formatPrice"]);
    expect(s.references.broken).toEqual(["styles", "styles.badge"]);
    expect(s.exports).toEqual({ renderTotal: "renderTotal", renderBadge: "renderBadge", default: "renderTotal" });
  });

  it("returns empty symbols for empty and non-code input", () => {
    expect(extractSymbols("a.js", "")).toMatchObject({ decls: {}, imports: [], topLevelReferences: [] });
    const junk = extractSymbols("a.js", "\u0000\u0001 }{ ))) <<<");
    expect(junk.parseError).toBeTruthy();
    expect(junk.decls).toEqual({});
  });

  it("parses CommonJS-style scripts and hashbangs", () => {
    const s = extractSymbols("bin/cli.cjs", "#!/usr/bin/env node\nfunction main() { return 1; }\nif (!module.parent) return;\n");
    expect(s.parseError).toBeUndefined();
    expect(Object.keys(s.decls)).toEqual(["main"]);
  });

  it("returns plain objects and handles names such as toString and __proto__", () => {
    const s = extractSymbols("a.js", "export function toString() { return valueOf(); }\nconst __proto__ = 1;\nexport { __proto__ as constructor };\n");
    expect(Object.getPrototypeOf(s.decls)).toBe(Object.prototype);
    expect(Object.keys(s.decls)).toEqual(["toString", "__proto__"]);
    expect(Object.hasOwn(s.decls, "__proto__")).toBe(true);
    const name: string = "toString";
    expect(s.decls[name].params).toEqual([]);
    expect(s.references[name]).toEqual(["valueOf"]);
    expect(s.exports).toStrictEqual(Object.fromEntries([["toString", "toString"], ["constructor", "__proto__"]]));
    expect(JSON.parse(JSON.stringify(s)).decls.__proto__.kind).toBe("const");
  });

  it("gives CRLF files the same ranges", () => {
    const crlf = PRODUCTS_JS.replace(/\n/g, "\r\n");
    expect(extractSymbols("src/products.js", crlf).decls).toEqual(extractSymbols("src/products.js", PRODUCTS_JS).decls);
  });
});

describe("TypeScript (best-effort type strip)", () => {
  const TS = `import type { Product } from "./types";
import { type Money, toMoney } from "./money";
export type Currency = "USD" | "EUR";
export interface PriceOptions<T = string> {
  currency?: Currency;
  format(value: T): string;
}
declare const DEBUG: boolean;
enum Tone { Info, Warn = 2 }

export function formatPrice(cents: number, currency: Currency = "USD"): string {
  return toMoney(cents, currency).toFixed(2);
}

export function parse(input: string): number;
export function parse(input: string | number): number {
  return Number(input as string)!;
}

export const priceOf = <T extends Product>(p: T, opts?: PriceOptions): string => formatPrice(p.cents, opts?.currency);

export abstract class Stack<T> implements Iterable<T> {
  private readonly items: T[] = [];
  static count = 0;
  constructor(public name: string, protected limit?: number) {}
  abstract describe(): string;
  add(item: T): this { this.items.push(item); return this; }
  [Symbol.iterator](): Iterator<T> { return this.items[Symbol.iterator](); }
}

const config = { tone: Tone.Info } satisfies Record<string, unknown>;
const lookup = new Map<string, Product>();
`;

  it("strips types in place and keeps every line", () => {
    const out = stripTypeScript(TS);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(TS.length);
    expect(out!.split("\n").length).toBe(TS.split("\n").length);
    expect(() => parse(out!, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
  });

  it("reads declarations, params without types, imports and exports", () => {
    const s = extractSymbols("src/price.ts", TS);
    expect(s.parseError).toBeUndefined();
    expect(Object.keys(s.decls).sort()).toEqual(["Stack", "Tone", "config", "formatPrice", "lookup", "parse", "priceOf"]);
    expect(s.decls.formatPrice).toEqual({
      name: "formatPrice",
      kind: "function",
      params: ["cents", 'currency = "USD"'],
      signature: 'formatPrice(cents, currency = "USD")',
      range: [11, 13],
      exported: true,
    });
    expect(s.decls.parse).toMatchObject({ params: ["input"], range: [16, 18] });
    expect(s.decls.priceOf).toMatchObject({ kind: "const", params: ["p", "opts"], exported: true });
    expect(s.decls.Stack).toMatchObject({ kind: "class", exported: true });
    // type-only imports stay imports: they are dependencies for the import graph
    expect(s.imports).toEqual([
      { from: "./types", names: [{ imported: "Product", local: "Product" }] },
      {
        from: "./money",
        names: [
          { imported: "Money", local: "Money" },
          { imported: "toMoney", local: "toMoney" },
        ],
      },
    ]);
    expect(Object.keys(s.exports).sort()).toEqual(["Stack", "formatPrice", "parse", "priceOf"]);
    expect(s.references.formatPrice).toEqual(["toMoney"]);
    expect(s.references.priceOf).toEqual(["formatPrice"]);
    expect(s.references.config).toEqual(["Tone", "Tone.Info"]);
    expect(s.references.lookup).toEqual(["Map"]);
  });

  it("handles generics calls, assertions, non-null, overloads in classes and decorators", () => {
    const src = `@Component({ selector: "x" })
export class View {
  @Input() title!: string;
  render(x: number): string;
  render(x: any): string { return String(x); }
  private cache = new Map<string, Array<number>>();
}
export function first<T>(xs: readonly T[]): T | undefined { return xs[0]!; }
const n = <number>(<unknown>"1");
let v: number | undefined, w!: string;
for (const [k, val] of Object.entries<number>({})) {}
`;
    const out = stripTypeScript(src);
    expect(out).not.toBeNull();
    expect(() => parse(out!, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
    const s = extractSymbols("view.ts", src);
    expect(s.parseError).toBeUndefined();
    expect(s.decls.first.params).toEqual(["xs"]);
    expect(Object.keys(s.decls).sort()).toEqual(["View", "first", "n", "v", "w"]);
  });

  it("handles constructs found in real code (multi-line arrow return types, keyword properties, members after `as const`)", () => {
    const src = `interface Opts { a: string }
export type { Opts as Options } from "./opts";
export { Opts };
export class Scope {
  else?: Scope | undefined
  protected readonly _prefixes?: Set<string>
  static OPEN = 1 as const
  readonly CONNECTING = 0 as const
  constructor(
    private condition: boolean,
  ) {}
  static create = <S extends object>(
    shape: S,
  ): Promise<
    S
  > => {
    return Promise.resolve(shape);
  };
}
export const out = (def: { in: unknown }) => def.in as string;
const h = (handlers as Record<string, unknown>)["x"] as
  (() => void) | undefined;
`;
    const out = stripTypeScript(src);
    expect(out).not.toBeNull();
    expect(out!.split("\n").length).toBe(src.split("\n").length);
    expect(() => parse(out!, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
    const s = extractSymbols("scope.ts", src);
    expect(s.parseError).toBeUndefined();
    expect(Object.keys(s.decls).sort()).toEqual(["Scope", "h", "out"]);
    expect(s.imports).toEqual([{ from: "./opts", names: [{ imported: "Opts", local: "Options" }] }]);
    expect(s.exports).toEqual({ Options: "Options", Scope: "Scope", out: "out" });
    expect(s.references.h).toEqual(["handlers", "handlers.x"]);
  });

  it("keeps param texts free of blanked types", () => {
    const s = extractSymbols("e.ts", `export function flatten(error: E, mapper = (issue: Issue): string => issue.message) {}\n`);
    expect(s.decls.flatten.params).toEqual(["error", "mapper = (issue) => issue.message"]);
  });

  it("reads TSX: the types are stripped and JSX parses (acorn-jsx)", () => {
    const src = `import { toMoney } from "./money";\nexport function formatPrice(cents: number, currency?: string = "USD"): string {\n  return toMoney(cents);\n}\nexport const view = () => <div>{formatPrice(1)}</div>;\n`;
    const s = extractSymbols("view.tsx", src);
    expect(s.parseError).toBeUndefined();
    expect(s.decls.formatPrice).toMatchObject({ params: ["cents", 'currency = "USD"'], range: [2, 4], exported: true });
    expect(s.references.formatPrice).toEqual(["toMoney"]);
    expect(s.references.view).toEqual(["formatPrice"]);
  });

  it("falls back to the regex scanner when it cannot strip, with types removed from params", () => {
    const src = `import { toMoney } from "./money";\nexport function formatPrice(cents: number, currency?: string = "USD"): string {\n  return toMoney(cents);\n}\nfunction broken( {\n  return 1;\n}\n`;
    const s = extractSymbols("view.ts", src);
    expect(s.parseError).toBeTruthy();
    expect(s.decls.formatPrice).toMatchObject({ params: ["cents", 'currency = "USD"'], range: [2, 4], exported: true });
    expect(s.references.formatPrice).toEqual(["toMoney"]);
  });
});

describe("isAnalyzable", () => {
  it("accepts JS and TS modules only", () => {
    for (const p of ["a.js", "a.mjs", "a.cjs", "a.jsx", "a.ts", "a.tsx", "a.mts", "src/X.JS"]) expect(isAnalyzable(p)).toBe(true);
    for (const p of ["README.md", "a.json", "a.css", "a.js.map", "Makefile"]) expect(isAnalyzable(p)).toBe(false);
  });
});

describe("resolveImport", () => {
  const files = new Set(["src/products.js", "src/render.js", "src/lib/index.js", "src/util.ts", "src/view.tsx", "harness/test.js", "data.json"]);

  it("resolves relative specifiers against the importer", () => {
    expect(resolveImport("src/render.js", "./products.js", files)).toBe("src/products.js");
    expect(resolveImport("src/render.js", "./products", files)).toBe("src/products.js");
    expect(resolveImport("tests/render.test.js", "../harness/test.js", files)).toBe("harness/test.js");
    expect(resolveImport("src/render.js", "./lib", files)).toBe("src/lib/index.js");
    expect(resolveImport("src/render.js", "./util", files)).toBe("src/util.ts");
    expect(resolveImport("src/render.js", "./util.js", files)).toBe("src/util.ts");
    expect(resolveImport("src/a/b.js", "../../data.json", files)).toBe("data.json");
    expect(resolveImport("src/render.js", "./view.js", files)).toBe("src/view.tsx");
  });

  it("returns undefined for packages, missing files and paths above the root", () => {
    expect(resolveImport("src/render.js", "hono", files)).toBeUndefined();
    expect(resolveImport("src/render.js", "@scope/pkg/x.js", files)).toBeUndefined();
    expect(resolveImport("src/render.js", "./missing.js", files)).toBeUndefined();
    expect(resolveImport("src/render.js", "../../../x.js", files)).toBeUndefined();
  });
});

describe("members of top-level classes and objects", () => {
  const CART = `import { formatPrice } from "./products.js";

export class Cart extends Base {
  #items = [];
  static TAX = 0.2;

  constructor(owner, currency = "USD") {
    super(owner);
    this.currency = currency;
  }

  /** Add one item. */
  add(item, qty = 1) {
    this.#items.push({ item, qty });
    return this.total();
  }

  total() {
    return formatPrice(this.#items.reduce((s, x) => s + x.item.cents * x.qty, 0) * (1 + Cart.TAX));
  }

  get size() { return this.#items.length; }
  set size(n) { this.#items.length = n; }
}
`;

  it("records methods, fields and accessors with their own lines and params", () => {
    const s = analyzeModule("src/cart.js", CART);
    expect(s.parseError).toBeUndefined();
    // The contract stays: decls hold top-level declarations only.
    expect(Object.keys(s.decls)).toEqual(["Cart"]);
    expect(Object.keys(s.members)).toEqual(["Cart.#items", "Cart.TAX", "Cart.constructor", "Cart.add", "Cart.total", "Cart.size"]);
    expect(s.memberOwners).toEqual(["Cart"]);
    expect(s.members["Cart.add"]).toMatchObject({ owner: "Cart", kind: "method", params: ["item", "qty = 1"], signature: "Cart.add(item, qty = 1)", exported: true });
    // The JSDoc right above a method belongs to the method.
    expect(s.members["Cart.add"].range).toEqual([12, 16]);
    expect(s.members["Cart.total"].range).toEqual([18, 20]);
    expect(s.members["Cart.constructor"]).toMatchObject({ kind: "method", params: ["owner", 'currency = "USD"'], range: [7, 10] });
    expect(s.members["Cart.TAX"]).toMatchObject({ kind: "field", static: true, range: [5, 5] });
    // A private member is not part of the interface.
    expect(s.members["Cart.#items"].exported).toBe(false);
    // A getter and a setter of one name are one member.
    expect(s.members["Cart.size"]).toMatchObject({ kind: "get", range: [22, 23] });
    expect(s.members["Cart.size"].params).toBeUndefined();
  });

  it("gives each member its own references: this.x is Owner.x", () => {
    const s = analyzeModule("src/cart.js", CART);
    expect(s.memberReferences["Cart.add"]).toEqual(["Cart.#items", "Cart.total"]);
    expect(s.memberReferences["Cart.total"]).toEqual(["Cart.#items", "Cart.TAX", "formatPrice"]);
    expect(s.memberReferences["Cart.constructor"]).toEqual(["Cart.currency"]);
    // The class itself still uses all that its body uses (members of itself excluded).
    expect(s.references.Cart).toEqual(["Base", "formatPrice"]);
  });

  it("records the members of top-level object literals and of the default export of a Worker", () => {
    const s = analyzeModule(
      "src/api.js",
      `export const api = {\n  list(page) { return this.get("/items", page); },\n  get: async (path, page = 1) => fetch(path + page),\n  base: "/v1",\n  [dynamic]: 1,\n};\n`,
    );
    expect(Object.keys(s.members)).toEqual(["api.list", "api.get", "api.base"]);
    expect(s.members["api.list"]).toMatchObject({ kind: "method", params: ["page"], range: [2, 2], exported: true });
    expect(s.members["api.get"]).toMatchObject({ kind: "field", params: ["path", "page = 1"], signature: "api.get(path, page = 1)" });
    expect(s.memberReferences["api.list"]).toEqual(["api.get"]);
    expect(s.memberReferences["api.get"]).toEqual(["fetch"]);
    const worker = analyzeModule("src/index.js", INDEX_JS);
    expect(Object.keys(worker.members)).toEqual(["default.fetch"]);
    expect(worker.members["default.fetch"]).toMatchObject({ kind: "method", params: ["request"], range: [5, 15], exported: true });
  });

  it("records no members when the parse fails (the regex scanner)", () => {
    const s = analyzeModule("src/cart.js", CART.replace("total() {", "total( {"));
    expect(s.parseError).toBeTruthy();
    expect(s.members).toEqual({});
    expect(s.memberOwners).toEqual([]);
  });

  it("records no members for a very large object (a table of data)", () => {
    const rows = Array.from({ length: 250 }, (_, i) => `  k${i}: ${i},`).join("\n");
    const s = analyzeModule("src/table.js", `export const TABLE = {\n${rows}\n};\n`);
    expect(s.members).toEqual({});
    expect(s.memberOwners).toEqual([]);
  });

  it("reads class members in TypeScript (types stripped from params)", () => {
    const s = analyzeModule("src/stack.ts", `export class Stack<T> {\n  private items: T[] = [];\n  push(item: T, at?: number): this {\n    this.items.push(item);\n    return this;\n  }\n}\n`);
    expect(s.members["Stack.push"]).toMatchObject({ params: ["item", "at"], signature: "Stack.push(item, at)", range: [3, 6] });
    expect(s.memberReferences["Stack.push"]).toEqual(["Stack.items"]);
  });
});

describe("JSX (acorn-jsx)", () => {
  it("parses .jsx: components are references, HTML tags are not", () => {
    const s = extractSymbols(
      "src/App.jsx",
      `import { Card } from "./Card.jsx";\nimport * as ui from "./ui.js";\nexport function App({ items }) {\n  return <main className="app">{items.map((x) => <Card key={x.id} item={x} />)}<ui.Footer note={NOTE} /></main>;\n}\n`,
    );
    expect(s.parseError).toBeUndefined();
    expect(s.decls.App).toMatchObject({ kind: "function", params: ["{ items }"], range: [3, 5], exported: true });
    expect(s.references.App).toEqual(["Card", "NOTE", "ui", "ui.Footer"]);
  });

  it("parses a .js file with JSX", () => {
    const s = extractSymbols("src/view.js", `export const View = () => <section>It's "fine" {label}</section>;\n`);
    expect(s.parseError).toBeUndefined();
    expect(s.references.View).toEqual(["label"]);
  });

  it("parses .tsx with JSX text that holds quotes and colons", () => {
    const s = extractSymbols(
      "src/Price.tsx",
      `import type { Product } from "./types";\nexport function Price({ p }: { p: Product }): JSX.Element {\n  const label: string = p.title as string;\n  return <span title={label}>Price: it's {format(p.cents)}</span>;\n}\n`,
    );
    expect(s.parseError).toBeUndefined();
    expect(s.decls.Price).toMatchObject({ params: ["{ p }"], range: [2, 5] });
    expect(s.references.Price).toEqual(["format"]);
  });
});

describe("require() calls", () => {
  it("reads require calls as imports with bindings", () => {
    const s = analyzeModule(
      "src/server.js",
      `const db = require("./db");\nconst { query, close: shut } = require("./pool.js");\nconst one = require("./util").one;\nconst fs = require("fs"), limit = 10;\nrequire("./setup");\nfunction lazy() { return require("./heavy"); }\n`,
      new Set(["src/db.js", "src/pool.js", "src/util.js", "src/setup.js", "src/heavy.js"]),
    );
    expect(s.imports.map((i) => [i.from, i.resolved, i.names])).toEqual([
      ["./db", "src/db.js", [{ imported: "*", local: "db" }]],
      ["./pool.js", "src/pool.js", [{ imported: "query", local: "query" }, { imported: "close", local: "shut" }]],
      ["./util", "src/util.js", [{ imported: "one", local: "one" }]],
      ["fs", undefined, [{ imported: "*", local: "fs" }]],
      ["./setup", "src/setup.js", []],
      ["./heavy", "src/heavy.js", []],
    ]);
    expect(s.bindings.shut).toEqual({ from: "./pool.js", imported: "close" });
    // A statement of require calls only is an import, not a declaration; a mixed one keeps its declarations.
    expect(Object.keys(s.decls)).toEqual(["fs", "limit", "lazy"]);
  });

  it("reads `import x = require()` in TypeScript", () => {
    const s = analyzeModule("src/a.ts", `import fs = require("./fs-lite");\nexport const read = (p: string) => fs.read(p);\n`, new Set(["src/fs-lite.ts"]));
    expect(s.imports).toEqual([{ from: "./fs-lite", resolved: "src/fs-lite.ts", names: [{ imported: "*", local: "fs" }] }]);
  });
});

describe("path aliases (tsconfig.json, jsconfig.json)", () => {
  const files = new Set(["src/lib/money.ts", "src/lib/index.ts", "src/components/Card.tsx", "app/util.js", "shared/x.js"]);

  it("reads compilerOptions.paths and baseUrl, with comments and trailing commas", () => {
    const tsconfig = `{
  // the app
  "compilerOptions": {
    "baseUrl": "./",
    "paths": {
      "@/*": ["src/*"], // the source
      "~lib": ["src/lib/index.ts"],
      /* two targets */
      "#shared/*": ["missing/*", "shared/*",],
    },
  },
}`;
    const aliases = pathAliasesOf(new Map([["tsconfig.json", tsconfig]]));
    expect(aliases).toEqual({
      baseUrl: "",
      paths: [
        { pattern: "@/*", targets: ["src/*"] },
        { pattern: "~lib", targets: ["src/lib/index.ts"] },
        { pattern: "#shared/*", targets: ["missing/*", "shared/*"] },
      ],
    });
    expect(resolveImport("src/components/Card.tsx", "@/lib/money", files, aliases)).toBe("src/lib/money.ts");
    expect(resolveImport("src/components/Card.tsx", "@/lib", files, aliases)).toBe("src/lib/index.ts");
    expect(resolveImport("app/util.js", "~lib", files, aliases)).toBe("src/lib/index.ts");
    expect(resolveImport("app/util.js", "#shared/x", files, aliases)).toBe("shared/x.js");
    // baseUrl: a bare specifier can name a file from the root.
    expect(resolveImport("shared/x.js", "app/util", files, aliases)).toBe("app/util.js");
    expect(resolveImport("app/util.js", "react", files, aliases)).toBeUndefined();
    // Without the aliases, nothing of this resolves.
    expect(resolveImport("src/components/Card.tsx", "@/lib/money", files)).toBeUndefined();
  });

  it("puts the targets under baseUrl, reads jsconfig.json, and gives undefined without aliases", () => {
    expect(pathAliasesOf(new Map([["jsconfig.json", `{ "compilerOptions": { "baseUrl": "app", "paths": { "@/*": ["./*"] } } }`]]))).toEqual({ baseUrl: "app", paths: [{ pattern: "@/*", targets: ["app/*"] }] });
    expect(pathAliasesOf(new Map([["tsconfig.json", `{ "compilerOptions": { "strict": true } }`]]))).toBeUndefined();
    expect(pathAliasesOf(new Map([["tsconfig.json", `{ not json`]]))).toBeUndefined();
    expect(pathAliasesOf(new Map())).toBeUndefined();
  });

  it("fills imports[].resolved through the aliases", () => {
    const aliases = { paths: [{ pattern: "@/*", targets: ["src/*"] }] };
    const s = extractSymbols("src/components/Card.tsx", `import { toMoney } from "@/lib/money";\nexport const Card = () => <b>{toMoney(1)}</b>;\n`, files, aliases);
    expect(s.imports[0].resolved).toBe("src/lib/money.ts");
  });
});
