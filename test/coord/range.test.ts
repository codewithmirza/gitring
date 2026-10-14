import { describe, expect, it } from "vitest";
import {
  callForm,
  computeRange,
  emptyShape,
  hunksOverlap,
  intersectSymbols,
  mergeRanges,
  paramNames,
  parseSymbolRef,
  qualifyBareName,
  sameSignature,
  sharedChanges,
  shapeFromCourse,
  shapeFromFootprint,
  unionShapes,
  type WorkShape,
} from "../../src/core/analysis/range";
import type { Course, Footprint } from "../../src/core/types";
import { graph, T0 } from "./fixtures";

const course = (files: string[], symbols: string[] = []): Course => ({ plan: [], files, symbols, approach: "", declaredAt: T0 });
const shape = (s: Partial<WorkShape>): WorkShape => ({ ...emptyShape(), ...s });

describe("symbol references", () => {
  it("parses the forms that agents write", () => {
    expect(parseSymbolRef("src/products.js#formatPrice")).toEqual({ key: "src/products.js#formatPrice", path: "src/products.js", name: "formatPrice" });
    expect(parseSymbolRef("./src/products.js:formatPrice")).toEqual({ key: "src/products.js#formatPrice", path: "src/products.js", name: "formatPrice" });
    expect(parseSymbolRef("`src/products.js#formatPrice(cents,currency)`")).toEqual({
      key: "src/products.js#formatPrice",
      path: "src/products.js",
      name: "formatPrice",
      signature: "formatPrice(cents, currency)",
    });
    expect(parseSymbolRef("formatPrice")).toEqual({ key: "formatPrice", path: "", name: "formatPrice" });
    expect(parseSymbolRef("src/render.js#renderPage({ products, query = {} })").signature).toBe("renderPage({ products, query = {} })");
  });

  it("reads a note in parentheses as a note, not as a parameter list", () => {
    expect(parseSymbolRef("src/render.js#renderHeader (adds button and script)")).toEqual({ key: "src/render.js#renderHeader", path: "src/render.js", name: "renderHeader" });
    expect(parseSymbolRef("src/styles.js#TOKENS — adds a dark block")).toEqual({ key: "src/styles.js#TOKENS", path: "src/styles.js", name: "TOKENS" });
    const s = shapeFromCourse(course(["src/render.js"], ["src/render.js#renderHeader (adds button and script)"]), { "src/render.js#renderHeader": "renderHeader()" });
    expect(s.signatureChanged).toEqual([]);
  });

  it("compares signatures by parameter names", () => {
    expect(paramNames("formatPrice(cents, currency = 'USD')")).toEqual(["cents", "currency"]);
    expect(paramNames("f({ a, b }, ...rest)")).toEqual(["{a,b}", "...rest"]);
    expect(sameSignature("formatPrice(cents)", "formatPrice( cents )")).toBe(true);
    expect(sameSignature("formatPrice(cents: number)", "formatPrice(cents)")).toBe(true);
    expect(sameSignature("formatPrice(cents)", "formatPrice(cents, currency)")).toBe(false);
    expect(callForm('formatPrice(cents, currency = "USD")')).toBe("formatPrice(cents, currency)");
    expect(callForm("f(a: number, opts?: Opts)")).toBe("f(a, opts)");
  });

  it("matches a bare name against a qualified key", () => {
    expect(intersectSymbols(["formatPrice"], ["src/products.js#formatPrice", "src/render.js#header"])).toEqual(["src/products.js#formatPrice"]);
    expect(intersectSymbols(["src/products.js#formatPrice"], ["formatPrice"])).toEqual(["src/products.js#formatPrice"]);
    expect(intersectSymbols(["src/a.js#f"], ["src/b.js#f"])).toEqual([]);
  });
});

describe("shapes", () => {
  it("treats course symbols as changed and adds their files", () => {
    const s = shapeFromCourse(course(["src/render.js"], ["src/products.js#formatPrice(cents, currency)", "src/render.js#header"]));
    expect(s.files).toEqual(["src/products.js", "src/render.js"]);
    expect(s.changed).toEqual(["src/products.js#formatPrice", "src/render.js#header"]);
    expect(s.hunks).toEqual({});
    // Without base signatures, a declared parameter list is recorded but is not a signature change.
    expect(s.signatureChanged).toEqual([]);
    expect(s.signatures).toEqual({ "src/products.js#formatPrice": { after: "formatPrice(cents, currency)" } });
  });

  it("detects a declared signature change when base signatures are known", () => {
    const s = shapeFromCourse(course([], ["src/products.js#formatPrice(cents, currency)"]), {
      "src/products.js#formatPrice": "formatPrice(cents)",
    });
    expect(s.signatureChanged).toEqual(["src/products.js#formatPrice"]);
    expect(s.signatures!["src/products.js#formatPrice"]).toEqual({ before: "formatPrice(cents)", after: "formatPrice(cents, currency)" });
    const same = shapeFromCourse(course([], ["src/products.js#formatPrice(cents)"]), { "src/products.js#formatPrice": "formatPrice(cents)" });
    expect(same.signatureChanged).toEqual([]);
  });

  it("normalizes footprint hunks (added file at the top, deleted file whole, merged ranges)", () => {
    const fp: Footprint = {
      files: {
        "src/new.js": { status: "A", hunks: [], additions: 10, deletions: 0 },
        "src/old.js": { status: "D", hunks: [], additions: 0, deletions: 12 },
        "src/render.js": { status: "M", hunks: [[12, 14], [8, 10], [15, 15]], additions: 5, deletions: 4 },
      },
      symbols: { defined: ["src/new.js#a"], modified: ["src/render.js#header"], removed: ["src/old.js#b"], signatureChanged: [], referenced: ["src/products.js#formatPrice"] },
      computedAt: T0,
    };
    const s = shapeFromFootprint(fp);
    expect(s.hunks).toEqual({ "src/new.js": [[0, 0]], "src/old.js": [[1, 12]], "src/render.js": [[8, 10], [12, 15]] });
    expect(s.changed).toEqual(["src/new.js#a", "src/old.js#b", "src/render.js#header"]);
    expect(s.referenced).toEqual(["src/products.js#formatPrice"]);
  });

  it("unions course and footprint; footprint signature info wins", () => {
    const c = shapeFromCourse(course(["src/render.js"], ["src/products.js#formatPrice(cents, cur)"]));
    const f = shape({ files: ["src/products.js"], hunks: { "src/products.js": [[12, 14]] }, signatures: { "src/products.js#formatPrice": { before: "formatPrice(cents)", after: "formatPrice(cents, currency)" } } });
    const u = unionShapes(c, f);
    expect(u.files).toEqual(["src/products.js", "src/render.js"]);
    expect(u.hunks).toEqual({ "src/products.js": [[12, 14]] });
    expect(u.signatures!["src/products.js#formatPrice"]).toEqual({ before: "formatPrice(cents)", after: "formatPrice(cents, currency)" });
    // Inputs are not mutated.
    expect(c.hunks).toEqual({});
  });

  it("merges touching ranges and keeps inputs intact", () => {
    const input: [number, number][] = [[20, 22], [8, 12], [13, 13]];
    expect(mergeRanges(input)).toEqual([[8, 13], [20, 22]]);
    expect(input).toEqual([[20, 22], [8, 12], [13, 13]]);
  });
});

describe("computeRange", () => {
  const render = (h: [number, number][]) => shape({ files: ["src/render.js"], hunks: { "src/render.js": h } });

  it("0: overlapping hunks on a shared file (slack 2)", () => {
    expect(hunksOverlap([8, 20], [22, 25])).toBe(true);
    expect(hunksOverlap([8, 20], [23, 25])).toBe(false);
    expect(computeRange(render([[8, 20]]), render([[12, 18]]), graph)).toBe(0);
    expect(computeRange(render([[8, 20]]), render([[22, 30]]), graph)).toBe(0);
    expect(computeRange(render([[8, 20]]), render([[23, 30]]), graph)).toBe(2);
  });

  it("0: a symbol that both change, even with course-only shapes", () => {
    const a = shapeFromCourse(course(["src/render.js"], ["src/render.js#header"]));
    const b = shapeFromCourse(course([], ["header"]));
    expect(computeRange(a, b, graph)).toBe(0);
  });

  it("1: a changed or re-signed symbol that the other side uses", () => {
    const producer = shape({ files: ["src/products.js"], changed: ["src/products.js#formatPrice"], signatureChanged: ["src/products.js#formatPrice"] });
    const consumer = shape({ files: ["src/render.js"], referenced: ["src/products.js#formatPrice"] });
    expect(computeRange(producer, consumer, graph)).toBe(1);
    expect(computeRange(consumer, producer, graph)).toBe(1);
    // A course declaration counts as "changed".
    const declared = shapeFromCourse(course([], ["src/products.js#formatPrice"]));
    expect(computeRange(declared, consumer, graph)).toBe(1);
  });

  it("2: a shared file, other lines", () => {
    expect(computeRange(render([[8, 20]]), render([[40, 45]]), graph)).toBe(2);
    // Course-only: files are enough.
    expect(computeRange(shapeFromCourse(course(["src/render.js"])), render([[8, 20]]), graph)).toBe(2);
  });

  it("3, 4, 5: import distance", () => {
    const index = shape({ files: ["src/index.js"] });
    const styles = shape({ files: ["src/styles.js"] });
    const readme = shape({ files: ["README.md"] });
    expect(computeRange(index, render([[8, 20]]), graph)).toBe(3);
    expect(computeRange(index, styles, graph)).toBe(4);
    expect(computeRange(readme, styles, graph)).toBe(5);
    expect(computeRange(emptyShape(), styles, graph)).toBe(5);
  });

  it("survives a graph that throws", () => {
    const broken = { edges: [], neighbors: () => [], distance: () => { throw new Error("boom"); } };
    expect(computeRange(shape({ files: ["a.js"] }), shape({ files: ["b.js"] }), broken)).toBe(5);
  });
});

describe("plans that use symbols (Course.uses)", () => {
  it("puts the used symbols in `referenced`: two plans are at range 1 before any code exists", () => {
    const changer = shapeFromCourse(course(["src/products.js"], ["src/products.js#formatPrice(cents, currency)"]), { "src/products.js#formatPrice": "formatPrice(cents)" });
    const user = shapeFromCourse({ ...course(["src/badge.js"], ["src/badge.js#renderBadge"]), uses: ["src/products.js#formatPrice"] });
    expect(user.referenced).toEqual(["src/products.js#formatPrice"]);
    // The used file is not a file of the plan.
    expect(user.files).toEqual(["src/badge.js"]);
    expect(computeRange(changer, user, graph)).toBe(1);
    expect(computeRange(user, changer, graph)).toBe(1);
    // Without `uses`, the two plans look unrelated.
    expect(computeRange(changer, shapeFromCourse(course(["src/badge.js"], ["src/badge.js#renderBadge"])), graph)).toBe(5);
  });
});

describe("plan symbols without a path", () => {
  const definedIn = { header: ["src/render.js"], formatPrice: ["src/products.js"], init: ["src/a.js", "src/b.js"], "Cart.add": ["src/cart.js"] };

  it("keep the old meaning without an index of main (any key with that name)", () => {
    expect(qualifyBareName("header", [], "changed")).toEqual(["header"]);
  });

  it("lie in the plan's own code files, else in the one main file that defines the name", () => {
    expect(qualifyBareName("header", ["src/render.js", "README.md"], "changed", definedIn)).toEqual(["src/render.js#header"]);
    // A new name: each code file of the plan.
    expect(qualifyBareName("badge", ["src/a.js", "src/b.js"], "changed", definedIn)).toEqual(["src/a.js#badge", "src/b.js#badge"]);
    expect(qualifyBareName("formatPrice", [], "changed", definedIn)).toEqual(["src/products.js#formatPrice"]);
    expect(qualifyBareName("Cart.add", [], "changed", definedIn)).toEqual(["src/cart.js#Cart.add"]);
    // Two files define it, or none: no key.
    expect(qualifyBareName("init", [], "changed", definedIn)).toEqual([]);
    expect(qualifyBareName("nothing", ["README.md"], "changed", definedIn)).toEqual([]);
  });

  it("place used names in the one main file, else in the plan's files that define them, else keep them bare", () => {
    expect(qualifyBareName("formatPrice", ["src/render.js"], "used", definedIn)).toEqual(["src/products.js#formatPrice"]);
    expect(qualifyBareName("init", ["src/b.js"], "used", definedIn)).toEqual(["src/b.js#init"]);
    expect(qualifyBareName("init", ["src/c.js"], "used", definedIn)).toEqual([]);
    expect(qualifyBareName("slugify", [], "used", definedIn)).toEqual(["slugify"]);
    expect(qualifyBareName("constructor", [], "used", definedIn)).toEqual(["constructor"]);
  });

  it("no longer give a false range 0 with a symbol of the same name in another file", () => {
    const plan = shapeFromCourse(course(["src/index.js"], ["header"]), undefined, { ...definedIn, header: ["src/render.js", "src/index.js"] });
    expect(plan.changed).toEqual(["src/index.js#header"]);
    const other = shape({ files: ["src/render.js"], changed: ["src/render.js#header"] });
    expect(computeRange(plan, other, graph)).toBe(3);
    // A plan without files: the one main file that defines the name, and that file counts as touched.
    const fileless = shapeFromCourse(course([], ["formatPrice(cents, currency)"]), { "src/products.js#formatPrice": "formatPrice(cents)" }, definedIn);
    expect(fileless.changed).toEqual(["src/products.js#formatPrice"]);
    expect(fileless.files).toEqual(["src/products.js"]);
    expect(fileless.signatureChanged).toEqual(["src/products.js#formatPrice"]);
  });
});

describe("members of classes and objects", () => {
  const method = (name: string) => shape({ files: ["src/cart.js"], changed: [`src/cart.js#${name}`] });

  it("two methods of one class are not one symbol (range 2, the shared file)", () => {
    expect(computeRange(method("Cart.add"), method("Cart.remove"), graph)).toBe(2);
    expect(sharedChanges(method("Cart.add"), method("Cart.remove"))).toEqual([]);
  });

  it("a class and one of its members are one symbol (range 0), also for a plan that names the class", () => {
    expect(sharedChanges(method("Cart"), method("Cart.add"))).toEqual(["src/cart.js#Cart.add"]);
    expect(computeRange(method("Cart"), method("Cart.add"), graph)).toBe(0);
    expect(computeRange(shapeFromCourse(course([], ["Cart"])), method("Cart.add"), graph)).toBe(0);
    // Not across files, and not for a name that only starts the same way.
    expect(intersectSymbols(["src/a.js#Cart"], ["src/b.js#Cart.add"], { members: true })).toEqual([]);
    expect(intersectSymbols(["src/a.js#Car"], ["src/a.js#Cart.add"], { members: true })).toEqual([]);
  });

  it("a change to a member that the other side uses is range 1", () => {
    const user = shape({ files: ["src/shop.js"], referenced: ["src/cart.js#Cart.add"] });
    expect(computeRange(method("Cart.add"), user, graph)).toBe(1);
    expect(computeRange(method("Cart.remove"), user, graph)).toBe(5);
  });
});
