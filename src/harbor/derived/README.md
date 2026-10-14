# src/harbor/derived: derived data of main and the history questions

Derived data lives in the SQLite of the project object. gitring computes it for each change of main from the values of the parent change. The cost of a change grows with the size of the change, not with the size of the repository.

The tables:

- `dd_steps`: the changes of main in order: the first one ("root"), the merges, and moves of main without a merge ("outside": an import, a pull, a seed).
- `dd_paths`: the path history. For each path, the changes that touched it, with the line counts.
- `dd_blame`: the line blame. For each change and each text file that it touched, the change that wrote each line (run-length coded). The blame of a change is the blame of its parent plus the diff of the change. A file with no row has the blame of the root: all its lines are older than the history.
- `dd_text`: the text files of main, with an FTS5 index (trigram tokens: any part of a name matches). It changes only for the touched files. Without FTS5, search scans `dd_text`.

The tree diff never opens a subtree whose id did not change. A small merge is computed when it lands (`HarborMergeRecord.recordLanding` calls `landed`). A big merge, a move of main without a merge, and the merges from before this module are computed at the first question (`catchUp`).

`DerivedHistory` is one class cut into a chain of abstract classes, called layers. Each layer extends the one before it. `../derived.ts` is the front door: it holds the class `DerivedHistory` and re-exports what other files import. A layer may call methods of the layers below it only.

The layers, from the bottom to the top:

1. `storage.ts`: the tables, the lookups of changes, and the reading of trees and text.
2. `update.ts`: computes each change from its parent, and keeps the search index.
3. `answers.ts`: why a line is there, the changes of a path, and the text search.
4. `compare.ts`: compares two versions (main, a commit or a work copy).

The other files:

- `constants.ts`: the tables and the limits, with the reason for each.
- `types.ts`: what the derived data reads from the project object, and its rows.
- `helpers.ts`: line counts, paths, limits and a parallel map with a bound.
- `tree-diff.ts`: the file changes between two trees.
