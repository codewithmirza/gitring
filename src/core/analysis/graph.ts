/**
 * Import graph of a tree: edges importer → imported, read as an undirected graph for distances.
 * The course check uses it for range 3 (one import hop) and range 4 (two hops).
 *
 * Pure module: runs in Node and in workerd.
 */
import { extractSymbols, isAnalyzable, resolveImport, type PathAliases } from "./symbols";

export interface ImportGraph {
  /** [importer, imported], unique, sorted. */
  edges: [string, string][];
  /** Files linked to `path` by an import in either direction, sorted. */
  neighbors(path: string): string[];
  /** BFS hops over undirected edges: 0 if a === b; Infinity if farther than `max` (default 4) or unreachable. */
  distance(a: string, b: string, max?: number): number;
}

/**
 * Build the graph from file texts (path → source). Only analyzable files are parsed; relative
 * imports, `export … from` re-exports and `require("…")` calls resolve against all keys of `files`
 * (and through the path aliases, when given). Self-imports and unresolved (package) imports are dropped.
 */
export function buildImportGraph(files: Map<string, string>, aliases?: PathAliases): ImportGraph {
  return graphFromEdges(importEdges(files, new Set(files.keys()), aliases));
}

/**
 * The import edges of some files (path → source), resolved against `paths` (all files of the tree).
 * A work copy gives the edges of its changed and new files this way, without a parse of the other files.
 */
export function importEdges(files: ReadonlyMap<string, string>, paths: Set<string>, aliases?: PathAliases): [string, string][] {
  const edges: [string, string][] = [];
  for (const [path, source] of files) {
    if (!isAnalyzable(path) || typeof source !== "string") continue;
    for (const imp of extractSymbols(path, source).imports) {
      const target = resolveImport(path, imp.from, paths, aliases);
      if (target !== undefined && target !== path) edges.push([path, target]);
    }
  }
  return edges;
}

const edgeKeys = new WeakMap<ImportGraph, Set<string>>();

/**
 * A graph with more edges. Gives `graph` itself when every edge is in it already, so its memo of
 * distances stays.
 */
export function extendGraph(graph: ImportGraph, extra: Iterable<readonly [string, string]>): ImportGraph {
  let have = edgeKeys.get(graph);
  if (!have) edgeKeys.set(graph, (have = new Set(graph.edges.map(([a, b]) => `${a}\u0000${b}`))));
  const added: [string, string][] = [];
  for (const e of extra) {
    if (!e || e[0] === e[1] || have.has(`${e[0]}\u0000${e[1]}`)) continue;
    added.push([e[0], e[1]]);
  }
  return added.length ? graphFromEdges([...graph.edges, ...added]) : graph;
}

/** Extension: a graph from stored edges (for example `ProjectState.imports`), without parsing. */
export function graphFromEdges(edges: Iterable<readonly [string, string]>): ImportGraph {
  const seen = new Set<string>();
  const list: [string, string][] = [];
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    let s = adj.get(a);
    if (!s) adj.set(a, (s = new Set()));
    s.add(b);
  };
  for (const e of edges) {
    if (!e || typeof e[0] !== "string" || typeof e[1] !== "string" || e[0] === e[1]) continue;
    const k = `${e[0]}\u0000${e[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    list.push([e[0], e[1]]);
    link(e[0], e[1]);
    link(e[1], e[0]);
  }
  list.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));

  const memo = new Map<string, number>();
  const bfs = (a: string, b: string, max: number): number => {
    if (!adj.has(a) || !adj.has(b)) return Infinity;
    const visited = new Set([a]);
    let frontier = [a];
    for (let d = 1; d <= max && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const nb of adj.get(node) ?? []) {
          if (nb === b) return d;
          if (!visited.has(nb)) {
            visited.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    return Infinity;
  };

  return {
    edges: list,
    neighbors(path: string): string[] {
      return [...(adj.get(path) ?? [])].sort();
    },
    distance(a: string, b: string, max = 4): number {
      if (a === b) return 0;
      const limit = typeof max === "number" && !Number.isNaN(max) ? max : 4;
      if (limit < 1) return Infinity;
      const k = `${limit}\u0000${a < b ? a : b}\u0000${a < b ? b : a}`;
      const hit = memo.get(k);
      if (hit !== undefined) return hit;
      const d = bfs(a, b, limit);
      if (memo.size > 50_000) memo.clear();
      memo.set(k, d);
      return d;
    },
  };
}

/** A graph with no files. */
export function emptyGraph(): ImportGraph {
  return graphFromEdges([]);
}
