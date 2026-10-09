# Reference solutions for the sample intents

Test fixtures. Bearing does not use these files at runtime: built-in agents write their own code.
The tests use them to prove that every sample intent can pass its checks, and that the changes compose.

Each folder holds the full content of every file that an intent changes. The check files are not here: they come from `sample/intents.json`.

| Variant | Base (the tree the files were written on) | Use |
|---|---|---|
| `<slug>/files/` | the seed (`sample/repo`) | The intent alone on the seed. |
| `<slug>/adapted/` | the seed + `currency` landed (`currency/files/` + `tests/currency.test.js`) | `search` and `staff-picks` only: the same intent on a main that already has the new `formatPrice(cents, currency)`. |

## How the tests land a solution

A line-based 3-way merge for each file: `base` = the base of the variant (table above), `ours` = main, `theirs` = the solution file, plus the check files of the intent. `test/fixtures/compose.mjs` does this (`land()`, `applyChange()`, `treeAlone()`); Bearing's own `merge3` (`src/core/text/merge3.ts`) gives the same result.

`test/checks/sample.test.ts` checks that:

- each intent alone passes `tests/app.test.js` and its own check, and each check fails on the seed;
- the landing order `currency → api-item → dark-mode → search (adapted/) → staff-picks (adapted/)` merges with no conflict, and all checks pass after every step;
- some pairs conflict as text when nothing coordinates them (for example `currency` and `search`), which is the case Bearing's course checks and corrections handle.

## Change a solution

The files are plain sources. After a change to `sample/repo`, a solution or a check, run:

```sh
node sample/build.mjs                      # regenerate sample/intents.json and sample/bundle.json
npx vitest run test/checks/sample.test.ts  # validate the solutions and the landing order
```
