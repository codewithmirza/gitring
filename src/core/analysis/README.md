# src/core/analysis

Reading code. These files turn source text into the facts that the conflict check needs: which symbols a file defines and uses, how files import each other, what a work copy really changed, and how far two plans are from each other.

Every file here is a pure module. It runs in Node and in workerd. It never reads storage or the network.

| File | What it is for |
|---|---|
| `symbols.ts` | The front door of the symbol reader. It tells which symbols a JavaScript or TypeScript file declares, exports, imports and uses. The parts are in `symbols/`. |
| `graph.ts` | The import graph of a tree: a file is a node, an import is an edge. The distances 3 and 4 come from it. |
| `footprint.ts` | The real changes of a work copy (footprint), file by file: status, hunks and line counts. It asks `footprint-symbols.ts` for the symbols. |
| `footprint-symbols.ts` | The symbols of one changed file: which ones were defined, changed, removed or used, and which signatures changed. |
| `range.ts` | The distance (range) from 0 to 5 between two pieces of work, and the helpers that compare files, lines and symbols. |
| `meaning.ts` | The meaning of a change: only comments, only layout, only docs, only tests, or logic. The approval rules use it. |

## How the files work together

1. `symbols.ts` reads each file of the tree and each changed file.
2. `graph.ts` builds the import graph from the imports that `symbols.ts` found.
3. `footprint.ts` compares the old and the new version of each changed file. `footprint-symbols.ts` names the symbols that changed in it.
4. `range.ts` takes two pieces of work (a plan or real changes) and the graph, and gives the distance. `coord/facts.ts` calls it.

See the section "Ideas in this folder" in `../README.md` for the whole conflict check.
