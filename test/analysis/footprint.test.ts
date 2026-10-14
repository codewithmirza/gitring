import { describe, expect, it } from "vitest";
import { analyzeFootprint, computeFootprint, type FileVersions } from "../../src/core/analysis/footprint";
import type { Footprint } from "../../src/core/types";
import { ALL_FILES, INDEX_JS, PRODUCTS_JS, RENDER_JS, STYLES_JS, replaceOnce, toCRLF } from "./fixtures";

const NOW = 1_700_000_000_000;
const fp = (files: FileVersions[], all: Set<string> = ALL_FILES): Footprint => computeFootprint(files, all, NOW);
const none = { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] };

/** formatPrice(cents) → formatPrice(cents, currency = "USD"), body included (lines 7–8). */
const PRODUCTS_CURRENCY = replaceOnce(
  PRODUCTS_JS,
  `export function formatPrice(cents) {\n  return "$" + (cents / 100).toFixed(2);`,
  `export function formatPrice(cents, currency = "USD") {\n  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);`,
);

describe("computeFootprint: scenarios", () => {
  it("(a) flags an interface change of formatPrice", () => {
    const f = fp([{ path: "src/products.js", base: PRODUCTS_JS, head: PRODUCTS_CURRENCY }]);
    expect(f.files).toEqual({ "src/products.js": { status: "M", hunks: [[7, 8]], additions: 2, deletions: 2 } });
    expect(f.symbols).toEqual({
      defined: [],
      modified: ["src/products.js#formatPrice"],
      removed: [],
      signatureChanged: ["src/products.js#formatPrice"],
      referenced: [],
    });
    expect(f.computedAt).toBe(NOW);
  });

  it("(a) gives the before/after signatures through analyzeFootprint", () => {
    const { signatures } = analyzeFootprint([{ path: "src/products.js", base: PRODUCTS_JS, head: PRODUCTS_CURRENCY }], ALL_FILES, NOW);
    expect(signatures).toEqual({ "src/products.js#formatPrice": { before: "formatPrice(cents)", after: 'formatPrice(cents, currency = "USD")' } });
  });

  it("(a) does not flag a body-only change as a signature change", () => {
    const head = replaceOnce(PRODUCTS_JS, `return "$" + (cents / 100).toFixed(2);`, `return "USD " + (cents / 100).toFixed(2);`);
    const f = fp([{ path: "src/products.js", base: PRODUCTS_JS, head }]);
    expect(f.symbols.modified).toEqual(["src/products.js#formatPrice"]);
    expect(f.symbols.signatureChanged).toEqual([]);
    expect(f.files["src/products.js"].hunks).toEqual([[8, 8]]);
  });

  it("(b) resolves a new formatPrice call in renderItem through the import", () => {
    const head = replaceOnce(
      RENDER_JS,
      `function renderItem(p) {\n  return`,
      `function renderItem(p) {\n  const was = p.listCents ? \` <s>\${formatPrice(p.listCents)}</s>\` : "";\n  return`,
    );
    const f = fp([{ path: "src/render.js", base: RENDER_JS, head }]);
    expect(f.files["src/render.js"]).toEqual({ status: "M", hunks: [[8, 8]], additions: 1, deletions: 0 });
    expect(f.symbols.modified).toEqual(["src/render.js#renderItem"]);
    expect(f.symbols.referenced).toContain("src/products.js#formatPrice");
    expect(f.symbols.referenced).toEqual(["src/products.js#formatPrice", "src/render.js#escapeHtml"]);
    expect(f.symbols.signatureChanged).toEqual([]);
  });

  it("(c) reports a new function as defined, without touching its neighbours", () => {
    const head = PRODUCTS_JS + `\nexport function formatPriceRange(minCents, maxCents) {\n  return \`\${formatPrice(minCents)} – \${formatPrice(maxCents)}\`;\n}\n`;
    const f = fp([{ path: "src/products.js", base: PRODUCTS_JS, head }]);
    expect(f.files["src/products.js"]).toEqual({ status: "M", hunks: [[13, 13]], additions: 4, deletions: 0 });
    expect(f.symbols).toEqual({
      ...none,
      defined: ["src/products.js#formatPriceRange"],
      referenced: ["src/products.js#formatPrice"],
      referencedIn: { "src/products.js#formatPrice": ["src/products.js"] },
    });
  });

  it("(c) does not mark a declaration modified when code is inserted right before or after it", () => {
    const head = replaceOnce(PRODUCTS_JS, `}\n\nexport function findProduct`, `}\n\nexport const CURRENCY = "USD";\n\nexport function findProduct`);
    const f = fp([{ path: "src/products.js", base: PRODUCTS_JS, head }]);
    expect(f.files["src/products.js"].hunks).toEqual([[10, 10]]);
    expect(f.symbols).toEqual({ ...none, defined: ["src/products.js#CURRENCY"] });
  });

  it("(d) treats a whole-file add", () => {
    const cart = `import { formatPrice } from "./products.js";\n\nexport function cartTotal(items) {\n  return formatPrice(items.reduce((sum, i) => sum + i.cents, 0));\n}\n`;
    const all = new Set([...ALL_FILES, "src/cart.js"]);
    const f = fp([{ path: "src/cart.js", base: null, head: cart }], all);
    expect(f.files["src/cart.js"]).toEqual({ status: "A", hunks: [[0, 0]], additions: 5, deletions: 0 });
    expect(f.symbols).toEqual({
      ...none,
      defined: ["src/cart.js#cartTotal"],
      referenced: ["src/products.js#formatPrice"],
      referencedIn: { "src/products.js#formatPrice": ["src/cart.js"] },
    });
  });

  it("(d) treats a whole-file delete", () => {
    const f = fp([{ path: "src/styles.js", base: STYLES_JS, head: null }]);
    expect(f.files["src/styles.js"]).toEqual({ status: "D", hunks: [[1, 4]], additions: 0, deletions: 4 });
    expect(f.symbols).toEqual({ ...none, removed: ["src/styles.js#STYLES"] });
  });

  it("(e) gives base hunks for edits at the top, middle and end, insertions and deletions", () => {
    let head = replaceOnce(PRODUCTS_JS, "export const PRODUCTS = [", "export const PRODUCTS = Object.freeze([");
    head = replaceOnce(head, "];\n", "]);\n\nconst PAGE_SIZE = 20;\n");
    head = replaceOnce(head, `  { id: "mug", title: "Stoneware mug", cents: 1800 },\n`, "");
    head = replaceOnce(head, "  return PRODUCTS.find((p) => p.id === id);\n}\n", "  return PRODUCTS.find((p) => p.id === id) ?? null;\n}\n");
    const f = fp([{ path: "src/products.js", base: PRODUCTS_JS, head }]);
    expect(f.files["src/products.js"]).toEqual({
      status: "M",
      hunks: [
        [1, 1], // top: replaced
        [4, 5], // middle: "mug" deleted, "];" replaced by "]);"
        [6, 6], // pure insertion after base line 6 (the blank line keeps its place): PAGE_SIZE + a blank line
        [12, 12], // end: replaced
      ],
      additions: 5,
      deletions: 4,
    });
    expect(f.symbols.modified).toEqual(["src/products.js#PRODUCTS", "src/products.js#findProduct"]);
    expect(f.symbols.defined).toEqual(["src/products.js#PAGE_SIZE"]);
    expect(f.symbols.referenced).toEqual(["src/products.js#PRODUCTS"]);
  });

  it("(e) reports a pure deletion in the middle of a declaration", () => {
    const head = replaceOnce(PRODUCTS_JS, `  { id: "lantern", title: "Brass lantern", cents: 1500 },\n`, "");
    const f = fp([{ path: "src/products.js", base: PRODUCTS_JS, head }]);
    expect(f.files["src/products.js"]).toEqual({ status: "M", hunks: [[3, 3]], additions: 0, deletions: 1 });
    expect(f.symbols).toEqual({ ...none, modified: ["src/products.js#PRODUCTS"] });
  });

  it("(h) handles CRLF files like LF files", () => {
    const crlf = fp([{ path: "src/products.js", base: toCRLF(PRODUCTS_JS), head: toCRLF(PRODUCTS_CURRENCY) }]);
    const lf = fp([{ path: "src/products.js", base: PRODUCTS_JS, head: PRODUCTS_CURRENCY }]);
    expect(crlf).toEqual(lf);
  });

  it("(h) treats a CRLF → LF conversion as a touch without line changes", () => {
    const f = fp([{ path: "src/products.js", base: toCRLF(PRODUCTS_JS), head: PRODUCTS_JS }]);
    expect(f.files["src/products.js"]).toEqual({ status: "M", hunks: [], additions: 0, deletions: 0 });
    expect(f.symbols).toEqual(none);
  });

  it("(h) finds a real edit in a CRLF file that an agent rewrote with LF", () => {
    const head = replaceOnce(PRODUCTS_JS, "export function findProduct(id) {", "export function findProduct(id, fallback) {");
    const f = fp([{ path: "src/products.js", base: toCRLF(PRODUCTS_JS), head }]);
    expect(f.files["src/products.js"].hunks).toEqual([[11, 11]]);
    expect(f.symbols.signatureChanged).toEqual(["src/products.js#findProduct"]);
  });
});

describe("computeFootprint: references", () => {
  it("resolves imports in the edited handler of index.js", () => {
    const head = replaceOnce(
      replaceOnce(INDEX_JS, `import { PRODUCTS } from "./products.js";`, `import { PRODUCTS, findProduct } from "./products.js";`),
      `    const query =`,
      `    if (url.pathname.startsWith("/api/products/")) {\n      return Response.json(findProduct(url.pathname.slice(14)));\n    }\n    const query =`,
    );
    const f = fp([{ path: "src/index.js", base: INDEX_JS, head }]);
    // The handler `fetch` is a member of the default-exported object: the object itself does not change.
    expect(f.symbols.modified).toEqual(["src/index.js#default.fetch"]);
    expect(f.symbols.referenced).toEqual(["src/products.js#PRODUCTS", "src/products.js#findProduct", "src/render.js#renderPage"]);
  });

  it("resolves namespace imports (ns.fn → target#fn) and skips packages and globals", () => {
    const base = `import * as products from "./products.js";\nimport { Hono } from "hono";\n\nexport function price(p) {\n  return products.formatPrice(p.cents);\n}\n`;
    const head = base.replace("return products.formatPrice(p.cents);", "console.log(new Hono());\n  return products.formatPrice(p.cents) + products.PRODUCTS.length;");
    const f = fp([{ path: "src/price.js", base, head }], new Set([...ALL_FILES, "src/price.js"]));
    expect(f.symbols.referenced).toEqual(["src/products.js#PRODUCTS", "src/products.js#formatPrice"]);
  });

  it("adds what changed top-level statements use", () => {
    const base = `import { renderPage } from "./render.js";\nimport { PRODUCTS } from "./products.js";\nconst routes = new Map();\nroutes.set("/", renderPage);\n`;
    const head = base + `routes.set("/api", () => PRODUCTS);\n`;
    const f = fp([{ path: "src/routes.js", base, head }], new Set([...ALL_FILES, "src/routes.js"]));
    expect(f.symbols).toEqual({
      ...none,
      referenced: ["src/products.js#PRODUCTS", "src/routes.js#routes"],
      referencedIn: { "src/products.js#PRODUCTS": ["src/routes.js"], "src/routes.js#routes": ["src/routes.js"] },
    });
  });

  it("uses export aliases and named default exports as extra keys", () => {
    const base = `function format(c) { return c; }\nexport { format as formatPrice };\nexport default function handler(req) { return format(req); }\n`;
    const head = base.replace("return c;", "return c / 100;").replace("handler(req)", "handler(req, env)");
    const f = fp([{ path: "src/a.js", base, head }]);
    expect(f.symbols.modified).toEqual(["src/a.js#default", "src/a.js#format", "src/a.js#formatPrice", "src/a.js#handler"]);
    expect(f.symbols.signatureChanged).toEqual(["src/a.js#default", "src/a.js#handler"]);
    expect(f.symbols.referenced).toEqual(["src/a.js#format"]);
  });

  it("records where each referenced symbol is used (a local call stays in its own file)", () => {
    const head = replaceOnce(RENDER_JS, "</ul>", "</ul>\n  <p>${products.length} products</p>");
    const f = fp([{ path: "src/render.js", base: RENDER_JS, head }]);
    expect(f.symbols.referenced).toContain("src/render.js#renderItem");
    for (const k of f.symbols.referenced) expect(f.symbols.referencedIn?.[k]).toEqual(["src/render.js"]);
  });

  it("reports removed declarations", () => {
    const head = replaceOnce(PRODUCTS_JS, `\nexport function findProduct(id) {\n  return PRODUCTS.find((p) => p.id === id);\n}\n`, "");
    const f = fp([{ path: "src/products.js", base: PRODUCTS_JS, head }]);
    expect(f.files["src/products.js"]).toEqual({ status: "M", hunks: [[10, 13]], additions: 0, deletions: 4 });
    expect(f.symbols).toEqual({ ...none, removed: ["src/products.js#findProduct"] });
  });

  it("still finds symbols when the head has a syntax error (regex fallback)", () => {
    const head = replaceOnce(RENDER_JS, "function renderItem(p) {\n  return", "function renderItem(p) {\n  const sale = formatPrice(p.saleCents\n  return");
    const f = fp([{ path: "src/render.js", base: RENDER_JS, head }]);
    // unchanged neighbours keep the same ranges in the regex scanner, so they are not "modified"
    expect(f.symbols.modified).toEqual(["src/render.js#renderItem"]);
    expect(f.symbols.referenced).toContain("src/products.js#formatPrice");
  });
});

describe("computeFootprint: files", () => {
  it("skips identical versions and sorts paths", () => {
    const f = fp([
      { path: "src/render.js", base: RENDER_JS, head: RENDER_JS },
      { path: "src/z.js", base: null, head: "export const z = 1;\n" },
      { path: "src/a.js", base: null, head: "export const a = 1;\n" },
      { path: "src/gone.js", base: null, head: null },
    ]);
    expect(Object.keys(f.files)).toEqual(["src/a.js", "src/z.js"]);
    expect(f.symbols.defined).toEqual(["src/a.js#a", "src/z.js#z"]);
  });

  it("gives non-analyzable files a file touch and no symbols", () => {
    const f = fp([{ path: "README.md", base: "# Catalog\n", head: "# Catalog\n\nfunction notCode() {}\n" }]);
    expect(f.files["README.md"]).toEqual({ status: "M", hunks: [[1, 1]], additions: 2, deletions: 0 });
    expect(f.symbols).toEqual(none);
  });

  it("gives binary files a whole-file touch", () => {
    const png = "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR";
    const f = fp([
      { path: "public/logo.png", base: png, head: png + "\u0000x" },
      { path: "public/new.png", base: null, head: png },
    ]);
    // the base text has 3 "lines" ("\x89PNG\r", "\x1a", "\0\0\0\rIHDR"): the whole base is one touch
    expect(f.files["public/logo.png"]).toEqual({ status: "M", hunks: [[1, 3]], additions: 0, deletions: 0 });
    expect(f.files["public/new.png"]).toEqual({ status: "A", hunks: [[0, 0]], additions: 0, deletions: 0 });
  });

  it("does not resolve Object.prototype names as declarations", () => {
    const base = `export function show(x) {\n  return x;\n}\n`;
    const head = `export function show(x) {\n  return toString(x) + hasOwnProperty(x) + constructor;\n}\n`;
    const f = fp([{ path: "src/show.js", base, head }]);
    expect(f.symbols.modified).toEqual(["src/show.js#show"]);
    expect(f.symbols.referenced).toEqual([]);
    expect(Object.getPrototypeOf(f.files)).toBe(Object.prototype);
  });

  it("is deterministic across input order", () => {
    const a: FileVersions = { path: "src/products.js", base: PRODUCTS_JS, head: PRODUCTS_CURRENCY };
    const b: FileVersions = { path: "src/render.js", base: RENDER_JS, head: RENDER_JS.replace("All products", "Every product") };
    expect(JSON.stringify(fp([a, b]))).toBe(JSON.stringify(fp([b, a])));
  });
});

describe("computeFootprint: members of classes and objects", () => {
  // 1 import · 3 class Cart · 4 #items · 6 constructor 6–8 · 10–14 add (JSDoc on 10) · 16–18 total · 19 }
  const CART = `import { formatPrice } from "./products.js";

export class Cart extends Base {
  #items = [];

  constructor(owner) {
    this.owner = owner;
  }

  /** Add one item. */
  add(item) {
    this.#items.push(item);
    return this.total();
  }

  total() {
    return formatPrice(this.#items.reduce((s, x) => s + x.cents, 0));
  }
}
`;
  const ALL = new Set([...ALL_FILES, "src/cart.js", "src/shop.js"]);
  const cart = (head: string) => fp([{ path: "src/cart.js", base: CART, head }], ALL);

  it("marks only the method that changes, not the class", () => {
    const a = cart(replaceOnce(CART, "this.#items.push(item);", "this.#items.push({ ...item });"));
    const b = cart(replaceOnce(CART, "s + x.cents", "s + x.cents * x.qty"));
    expect(a.symbols.modified).toEqual(["src/cart.js#Cart.add"]);
    expect(b.symbols.modified).toEqual(["src/cart.js#Cart.total"]);
    // this.total() and this.#items are uses of the members of the same class.
    expect(a.symbols.referenced).toEqual(["src/cart.js#Cart.#items", "src/cart.js#Cart.total"]);
    expect(b.symbols.referenced).toEqual(["src/cart.js#Cart.#items", "src/products.js#formatPrice"]);
  });

  it("marks the class when its head changes", () => {
    const f = cart(replaceOnce(CART, "extends Base", "extends Store"));
    expect(f.symbols.modified).toEqual(["src/cart.js#Cart"]);
  });

  it("counts a JSDoc change as a change of its method", () => {
    const f = cart(replaceOnce(CART, "/** Add one item. */", "/** Add one item to the cart. */"));
    expect(f.symbols.modified).toEqual(["src/cart.js#Cart.add"]);
  });

  it("reports new and removed methods without a change of the class", () => {
    const added = cart(replaceOnce(CART, "  total() {", "  clear() {\n    this.#items = [];\n  }\n\n  total() {"));
    expect(added.symbols).toMatchObject({ defined: ["src/cart.js#Cart.clear"], modified: [], removed: [] });
    const removed = cart(replaceOnce(CART, "  total() {\n    return formatPrice(this.#items.reduce((s, x) => s + x.cents, 0));\n  }\n", ""));
    expect(removed.symbols.removed).toEqual(["src/cart.js#Cart.total"]);
    expect(removed.symbols.modified).toEqual([]);
  });

  it("finds a method signature change (R3), and a constructor change as a change of the class signature", () => {
    const { footprint, signatures } = analyzeFootprint([{ path: "src/cart.js", base: CART, head: replaceOnce(CART, "add(item) {", "add(item, qty) {") }], ALL, NOW);
    expect(footprint.symbols.signatureChanged).toEqual(["src/cart.js#Cart.add"]);
    expect(signatures["src/cart.js#Cart.add"]).toEqual({ before: "Cart.add(item)", after: "Cart.add(item, qty)" });
    const ctor = analyzeFootprint([{ path: "src/cart.js", base: CART, head: replaceOnce(CART, "constructor(owner) {", "constructor(owner, currency) {") }], ALL, NOW);
    expect(ctor.footprint.symbols.signatureChanged).toEqual(["src/cart.js#Cart", "src/cart.js#Cart.constructor"]);
    expect(ctor.signatures["src/cart.js#Cart"]).toEqual({ before: "Cart(owner)", after: "Cart(owner, currency)" });
  });

  it("gives members the keys of the exported names of their class", () => {
    const base = CART.replace("export class Cart", "export default class Cart");
    const f = fp([{ path: "src/cart.js", base, head: replaceOnce(base, "s + x.cents", "s + 2 * x.cents") }], ALL);
    expect(f.symbols.modified).toEqual(["src/cart.js#Cart.total", "src/cart.js#default.total"]);
  });

  it("keeps the old rule (the whole class) when a version does not parse", () => {
    const f = cart(replaceOnce(CART, "this.#items.push(item);", "this.#items.push(item;"));
    expect(f.symbols.modified).toContain("src/cart.js#Cart");
    expect(f.symbols.modified.some((k) => k.includes("Cart."))).toBe(false);
  });

  it("uses Owner.member of an imported class when the repository has that member", () => {
    const base = `import { Cart } from "./cart.js";\nexport function rate() {\n  return 1;\n}\n`;
    const head = `import { Cart } from "./cart.js";\nexport function rate() {\n  return Cart.rate() + Cart.unknown;\n}\n`;
    const known = (k: string) => k === "src/cart.js#Cart.rate";
    const withIndex = computeFootprint([{ path: "src/shop.js", base, head }], ALL, NOW, { knownMember: known });
    expect(withIndex.symbols.referenced).toEqual(["src/cart.js#Cart", "src/cart.js#Cart.rate"]);
    const without = fp([{ path: "src/shop.js", base, head }], ALL);
    expect(without.symbols.referenced).toEqual(["src/cart.js#Cart"]);
  });

  it("gives the import edges of the changed files from the same parse (for the graph of a check)", () => {
    const head = `import { formatPrice } from "./products.js";\nimport { Cart } from "./cart.js";\nexport const shop = () => new Cart(formatPrice(1));\n`;
    const { imports } = analyzeFootprint([{ path: "src/shop.js", base: null, head }, { path: "src/cart.js", base: CART, head: null }], ALL, NOW);
    expect(imports).toEqual([
      ["src/shop.js", "src/products.js"],
      ["src/shop.js", "src/cart.js"],
    ]);
  });

  it("resolves aliased imports (tsconfig paths)", () => {
    const base = `import { formatPrice } from "@/products.js";\nexport function label(p) {\n  return p.title;\n}\n`;
    const head = base.replace("return p.title;", "return p.title + formatPrice(p.cents);");
    const aliases = { paths: [{ pattern: "@/*", targets: ["src/*"] }] };
    const f = computeFootprint([{ path: "src/shop.js", base, head }], ALL, NOW, { aliases });
    expect(f.symbols.referenced).toEqual(["src/products.js#formatPrice"]);
    expect(fp([{ path: "src/shop.js", base, head }], ALL).symbols.referenced).toEqual([]);
  });
});
