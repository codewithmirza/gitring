import { describe, expect, it } from "vitest";
import type { FileNode } from "../../src/core/types";
import { allFolders, ancestors, buildTree, findFiles, flattenTree, foldersToShow, fuzzy, hitRuns, looksBinary, matchPath } from "../../web/src/views/code/tree";
import { codeHref, codeUrl, lineHash, parseCodeLocation, parseLineHash } from "../../web/src/views/code/links";
import { parseLineInput } from "../../web/src/views/code/pickers";

const f = (path: string): FileNode => ({ path, size: 100, lang: "js" });
const FILES = ["src/app.js", "src/cart/total.js", "src/cart/index.js", "README.md", "tests/cart.test.js", "src/file10.js", "src/file2.js", "node_modules/x/index.js"].map(f);

describe("tree", () => {
  it("builds folders first, in natural order, with file counts", () => {
    const root = buildTree(FILES);
    expect(root.dirs.map((d) => d.name)).toEqual(["node_modules", "src", "tests"]);
    expect(root.files.map((x) => x.path)).toEqual(["README.md"]);
    const src = root.dirs[1];
    expect(src.count).toBe(5);
    expect(src.dirs.map((d) => d.name)).toEqual(["cart"]);
    expect(src.files.map((x) => x.path)).toEqual(["src/app.js", "src/file2.js", "src/file10.js"]);
  });

  it("flattens only open folders, with aria levels and positions", () => {
    const root = buildTree(FILES);
    const rows = flattenTree(root, new Set(["src"]));
    expect(rows.map((r) => `${r.level}:${r.name}`)).toEqual(["1:node_modules", "1:src", "2:cart", "2:app.js", "2:file2.js", "2:file10.js", "1:tests", "1:README.md"]);
    const src = rows.find((r) => r.path === "src")!;
    expect(src.expanded).toBe(true);
    expect(src.posinset).toBe(2);
    expect(src.setsize).toBe(4);
    const cart = rows.find((r) => r.path === "src/cart")!;
    expect(cart.expanded).toBe(false);
    expect(cart.parent).toBe("src");
  });

  it("filters by path and opens the folders of the matches", () => {
    const root = buildTree(FILES);
    const rows = flattenTree(root, new Set(), { filter: "total" });
    expect(rows.map((r) => r.path)).toEqual(["src", "src/cart", "src/cart/total.js"]);
    expect(rows[2].hits).toEqual([0, 1, 2, 3, 4]);
  });

  it("shows only some files when asked (changed files of a work copy)", () => {
    const root = buildTree(FILES);
    const rows = flattenTree(root, new Set(), { only: new Set(["tests/cart.test.js", "README.md"]) });
    expect(rows.map((r) => r.path)).toEqual(["tests", "tests/cart.test.js", "README.md"]);
  });

  it("knows ancestors and the folders to open", () => {
    expect(ancestors("a/b/c.js")).toEqual(["a", "a/b"]);
    expect(ancestors("c.js")).toEqual([]);
    expect(foldersToShow(["a/b/c.js", "a/d.js"]).sort()).toEqual(["a", "a/b"]);
    expect(allFolders(buildTree(FILES)).sort()).toEqual(["node_modules", "node_modules/x", "src", "src/cart", "tests"]);
  });

  it("handles thousands of files quickly", () => {
    const many: FileNode[] = [];
    for (let d = 0; d < 50; d++) for (let i = 0; i < 100; i++) many.push(f(`pkg${d}/src/mod${i}/file${i}.ts`));
    const t0 = performance.now();
    const root = buildTree(many);
    const rows = flattenTree(root, new Set(allFolders(root)));
    const filtered = flattenTree(root, new Set(), { filter: "mod42/file42" });
    const t = performance.now() - t0;
    expect(rows.length).toBe(5000 + 50 + 50 + 5000);
    expect(filtered.filter((r) => r.kind === "file")).toHaveLength(50);
    expect(t).toBeLessThan(1500);
  });
});

describe("finder", () => {
  it("matches letters in order and ranks file names and word starts first", () => {
    expect(fuzzy("ct", "src/cart/total.js")).not.toBeNull();
    expect(fuzzy("xyz", "src/cart/total.js")).toBeNull();
    const hits = findFiles(["src/cart/total.js", "src/cart/index.js", "tests/cart.test.js", "docs/contact.md"], "cart");
    expect(hits[0].path).toBe("tests/cart.test.js");
    const t = findFiles(["src/cart/total.js", "src/app.js", "src/totally/other.js"], "total");
    expect(t[0].path).toBe("src/cart/total.js");
  });

  it("leaves out dependency and build folders", () => {
    const hits = findFiles(FILES.map((x) => x.path), "index");
    expect(hits.map((h) => h.path)).toEqual(["src/cart/index.js"]);
  });

  it("splits text into match runs", () => {
    expect(hitRuns("total.js", [0, 1])).toEqual([
      { text: "to", hit: true },
      { text: "tal.js", hit: false },
    ]);
    expect(matchPath("cart", "src/cart/total.js")?.nameHits).toEqual([]);
  });

  it("knows binary files by extension", () => {
    expect(looksBinary("public/logo.png")).toBe(true);
    expect(looksBinary("fonts/a.woff2")).toBe(true);
    expect(looksBinary("src/app.js")).toBe(false);
  });
});

describe("addresses", () => {
  it("makes the same links as the router's codeHref", () => {
    expect(codeHref("src/a b.js", "main")).toBe("/code/main/src/a%20b.js");
    expect(codeHref(null, "at_1", { diff: true })).toBe("/code/at_1?view=diff");
    expect(codeHref("x.js", "main", { line: 12 })).toBe("/code/main/x.js#L12");
    expect(codeHref("x.js", "main", { line: 10, endLine: 20 })).toBe("/code/main/x.js#L10-L20");
  });

  it("reads path, old query form, view and lines", () => {
    expect(parseCodeLocation("/code/at_1/src/a%20b.js", "?project=p&view=diff", "#L3-L5")).toEqual({ ref: "at_1", path: "src/a b.js", view: "diff", lines: [3, 5] });
    expect(parseCodeLocation("/code", "?ref=abc&path=src/x.js", "")).toEqual({ ref: "abc", path: "src/x.js", view: "code", lines: null });
    expect(parseCodeLocation("/code", "", "")).toEqual({ ref: "main", path: null, view: "code", lines: null });
    expect(parseCodeLocation("/code/main", "", "#L7")).toEqual({ ref: "main", path: null, view: "code", lines: [7, 7] });
  });

  it("parses and writes line hashes", () => {
    expect(parseLineHash("#L20-L10")).toEqual([10, 20]);
    expect(parseLineHash("#L0")).toBeNull();
    expect(parseLineHash("#readme")).toBeNull();
    expect(lineHash([4, 4])).toBe("#L4");
    expect(lineHash([9, 2])).toBe("#L2-L9");
  });

  it("keeps the project in the query", () => {
    expect(codeUrl({ ref: "main", path: "a.js", lines: [2, 3] }, { search: "?project=p1&view=diff&ref=x" })).toBe("/code/main/a.js?project=p1#L2-L3");
    expect(codeUrl({ ref: "at_1", view: "diff" }, { search: "?project=p1" })).toBe("/code/at_1?project=p1&view=diff");
  });

  it("reads typed line numbers", () => {
    expect(parseLineInput("12", 100)).toEqual([12, 12]);
    expect(parseLineInput("10-20", 100)).toEqual([10, 20]);
    expect(parseLineInput("L30-L5", 100)).toEqual([5, 30]);
    expect(parseLineInput("10:900", 100)).toEqual([10, 100]);
    expect(parseLineInput("abc", 100)).toBeNull();
  });
});
