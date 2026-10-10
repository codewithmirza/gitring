import { describe, expect, it } from "vitest";
import { buildImportGraph, emptyGraph, graphFromEdges } from "../../src/core/analysis/graph";
import { appFiles } from "./fixtures";

describe("buildImportGraph: the app", () => {
  const graph = buildImportGraph(appFiles());

  it("has one edge per resolved import", () => {
    expect(graph.edges).toEqual([
      ["src/index.js", "src/products.js"],
      ["src/index.js", "src/render.js"],
      ["src/render.js", "src/products.js"],
      ["src/render.js", "src/styles.js"],
      ["tests/render.test.js", "harness/test.js"],
      ["tests/render.test.js", "src/render.js"],
    ]);
  });

  it("lists undirected neighbours", () => {
    expect(graph.neighbors("src/products.js")).toEqual(["src/index.js", "src/render.js"]);
    expect(graph.neighbors("src/render.js")).toEqual(["src/index.js", "src/products.js", "src/styles.js", "tests/render.test.js"]);
    expect(graph.neighbors("README.md")).toEqual([]);
  });

  it("measures distances in import hops", () => {
    expect(graph.distance("src/render.js", "src/products.js")).toBe(1);
    expect(graph.distance("src/products.js", "src/render.js")).toBe(1);
    // index.js imports products.js directly (not only through render.js)
    expect(graph.distance("src/index.js", "src/products.js")).toBe(1);
    expect(graph.distance("src/index.js", "src/styles.js")).toBe(2);
    expect(graph.distance("src/products.js", "src/styles.js")).toBe(2);
    expect(graph.distance("tests/render.test.js", "src/products.js")).toBe(2);
    expect(graph.distance("harness/test.js", "src/styles.js")).toBe(3);
    expect(graph.distance("src/index.js", "src/index.js")).toBe(0);
  });

  it("returns Infinity above max or when unreachable", () => {
    expect(graph.distance("src/index.js", "src/styles.js", 1)).toBe(Infinity);
    expect(graph.distance("harness/test.js", "src/styles.js", 2)).toBe(Infinity);
    expect(graph.distance("src/index.js", "README.md")).toBe(Infinity);
    expect(graph.distance("README.md", "nowhere.js")).toBe(Infinity);
    expect(graph.distance("README.md", "README.md")).toBe(0);
  });
});

describe("buildImportGraph: edge cases", () => {
  it("ignores packages, missing files, self-imports and non-analyzable files", () => {
    const g = buildImportGraph(
      new Map([
        ["src/a.js", `import { Hono } from "hono";\nimport "./missing.js";\nimport "./a.js";\nexport * from "./b.ts";\n`],
        ["src/b.ts", `import type { T } from "./c";\nimport { c } from "./c";\nexport const b: number = c;\n`],
        ["src/c.ts", `export const c = 1;\n`],
        ["notes.md", `import x from "./src/a.js"`],
      ]),
    );
    expect(g.edges).toEqual([
      ["src/a.js", "src/b.ts"],
      ["src/b.ts", "src/c.ts"],
    ]);
    expect(g.distance("src/a.js", "src/c.ts")).toBe(2);
  });

  it("counts type-only imports and re-exports as edges", () => {
    const g = buildImportGraph(
      new Map([
        ["src/range.ts", `import type { ImportGraph } from "./graph";\nexport function f(g: ImportGraph) { return g.edges; }\n`],
        ["src/graph.ts", `export interface ImportGraph { edges: [string, string][] }\n`],
        ["src/index.ts", `export type { ImportGraph } from "./graph";\n`],
      ]),
    );
    expect(g.edges).toEqual([
      ["src/index.ts", "src/graph.ts"],
      ["src/range.ts", "src/graph.ts"],
    ]);
  });

  it("keeps edges from files with syntax errors (regex fallback)", () => {
    const g = buildImportGraph(new Map([["src/a.js", `import { b } from "./b.js";\nexport function broken( {\n`], ["src/b.js", "export const b = 1;\n"]]));
    expect(g.edges).toEqual([["src/a.js", "src/b.js"]]);
  });
});

describe("graphFromEdges and emptyGraph", () => {
  it("rebuilds a graph from stored edges", () => {
    const g = graphFromEdges([
      ["b", "c"],
      ["a", "b"],
      ["a", "b"],
      ["c", "c"],
    ]);
    expect(g.edges).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(g.distance("a", "c")).toBe(2);
    expect(g.distance("c", "a", 1)).toBe(Infinity);
  });

  it("has no edges and no distances", () => {
    const g = emptyGraph();
    expect(g.edges).toEqual([]);
    expect(g.neighbors("a")).toEqual([]);
    expect(g.distance("a", "b")).toBe(Infinity);
    expect(g.distance("a", "a")).toBe(0);
  });
});
