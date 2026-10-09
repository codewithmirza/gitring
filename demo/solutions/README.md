# Reference solutions for the seed intents

Scripted vessels use these files for the offline, deterministic demo. Each folder holds the full content of every file that an intent changes. The check files are not here: Bearing writes them into each attempt from `demo/intents.json`.

| Variant | Base (the tree the files were written on) | Use |
|---|---|---|
| `<slug>/files/` | the seed (`demo/repo`) | The first attempt of the intent. |
| `<slug>/adapted/` | the seed + `currency` landed (`currency/files/` + `tests/currency.test.js`) | `search` and `staff-picks` only: the attempt after the interface correction, or the re-derive on the new main. They call `formatPrice(p.cents, currency)` and keep the `currency` parameter flowing (`renderItem(p, currency)`, a hidden `currency` field in the search form). |

## How to land a solution

Land a variant with a line-based 3-way merge for each file: `base` = the base of the variant (table above), `ours` = main, `theirs` = the solution file. Add the check files of the intent. `demo/tools/compose.mjs` does this (`land()`, `applyChange()`, `treeAlone()`); Bearing's own `merge3` (`src/core/text/merge3.ts`) gives the same result.

## Validated landing order

```
currency → api-item → dark-mode → search (adapted/) → staff-picks (adapted/)
```

`test/checks/demo.test.ts` validates it:

- Every step merges with no conflict (node-diff3 and `src/core/text/merge3.ts`). The edits of two intents are always at least 2 unchanged lines apart, one more than git needs.
- The composed checks pass after every step. At the end, 6 test files and 39 tests pass (app + the five intents).
- Each intent alone (`files/` on the seed) passes `tests/app.test.js` and its own check. Each check fails on the seed.
- Once `currency` has landed, the other four land cleanly in any of the 24 orders.

`currency` must land first in this set: no solution adapts `currency` to a consumer that landed before it.

## Designed collisions (the `files/` variants, with no correction)

| Pair | Course check (symbols) | Text merge | Why |
|---|---|---|---|
| currency × search | `renderPage` changed by both; currency changes `formatPrice(cents)` → `formatPrice(cents, currency)` | conflict: `src/render.js` (import line, `renderPage`), `src/products.js` (both append at the end) | Interface producer and consumer. |
| currency × staff-picks | `renderItem` changed by both; its price line calls `formatPrice` | conflict: `src/render.js` (the price line) | Interface producer and consumer. |
| dark-mode × search | `renderHeader` and `HEADER` changed by both | clean, in both orders | Both put controls into the header. The solutions keep apart: the toggle goes at the end of the nav, the search form goes in a `<div class="search">` below the tagline. In CSS, the toggle rules follow the nav rules, the search rules follow `.tagline`. |
| api-item × all | `src/index.js` only (`apiResponse`, `productResponse`) | clean | The clear course of the demo. |
| all other pairs | same file, different symbols | clean, checks pass | Near, no collision. |

## Change a solution

The files are plain sources. After a change to `demo/repo`, a solution or a check, run:

```sh
node demo/build.mjs                         # regenerate demo/intents.json and demo/bundle.json
npx vitest run test/checks/demo.test.ts     # validate the solutions and the landing order
```

`demo/bundle.json` holds the seed, the intents, these solutions and the landed tree in one JSON file, so a Worker can import the whole demo.
