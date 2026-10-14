# Code style: how a file stays easy to read

A person opens a file. In 30 seconds the person must know three things: what the file does, where it fits, and what to read next. These rules make that true for every file. The test `test/structure.test.ts` checks rules 1 and 2, so the rules cannot decay.

## The rules

1. **Size.** A source file has at most 600 lines (`.ts`, `.tsx`, `.mjs`) or 500 lines (`.css`). Aim for 150 to 400. A file may be longer only if it is one cohesive table (for example the keyword lists of a highlighter) or one cohesive state machine, and it has a reason written in its header and an entry in the allow list of `test/structure.test.ts`.
2. **Header.** Each source file starts with a comment. Line 1 says what the file does in one sentence of at most 20 words. Up to 6 more lines say who calls it, what it must never do, and which file to read next.
3. **Folder map.** A folder with 4 or more source files has a `README.md`. It has one line for each file: the name, and what the file is for.
4. **One job for each function.** A function has at most 60 lines and at most 3 levels of nesting. Use an early `return` and not a deep `else`. Do not nest ternaries.
5. **Names say what.** A function is a verb (`readTree`). A value is a noun (`mergeQueue`). A boolean starts with `is`, `has`, `can` or `should`. Do not abbreviate, except `id`, `url`, `ms` and `sha`.
6. **Sections.** A long file has dividers in this order: types, constants, public functions, helpers. Use `// ───── Title ─────` in `.ts` and `/* ───── Title ───── */` in `.css`.
7. **Comments say why.** Do not repeat what the code says. Delete commented-out code. Use the plain names (see the glossary) in comments.
8. **Imports.** Order: Node built-ins, packages, other folders, the same folder. Use `import type` for types.
9. **Public surface.** A folder that other folders import has one `index.ts` that re-exports its public parts. Files inside the folder import each other directly.
10. **Move code, do not change it.** A refactor keeps the behavior. The same tests pass. No new feature. No renamed field in an API, an event, a stored value or a message: other programs and old data depend on them.

## Code names and plain names

Some names in the code are older than the plain names that people read. The API and the stored data use the code names, so they stay in identifiers. Comments, UI text and documents use the plain names.

| Code name | Plain name | What it is |
|---|---|---|
| intent | task | The goal of a piece of work. |
| attempt | work copy | One agent's copy of main for one task. |
| course | plan | The files and symbols an agent says it will change. |
| footprint | real changes | The files and symbols a work copy really changes. |
| courseCheck | conflict check | The comparison of one plan with the nearest other plans. |
| range | distance (0 to 5) | How close two plans are. 0 is the same lines. 5 is no link. |
| correction | change request | What gitring sends to one agent so that two plans do not collide. |
| clearance | check result | The part of an answer that says the plan is clear or not. |
| landing | merge | Work joins main. |
| replot | rebase by gitring | gitring moves a work copy onto the new main. |
| rederive | redo | An agent does the work again on the new main. |
| logbook | merge record | The record of why each merge happened. The page that lists merges is called History. |
| HarborMaster (harbor) | project coordinator | The one Durable Object of a project. |
| Vessel | agent runner | The Durable Object that runs a built-in agent. |
| Directory | registry | The global Durable Object for people, projects and settings. |
| Drydock | test container | The Durable Object that starts a container for the tests. |
| Clef | conflict-check model | The model that reads the facts of a conflict check. |

## How to split a big file

1. Read the whole file. List its jobs, for example "read", "decide", "write", "format".
2. Make one file for each job. Name it for the job (`tree-read.ts`), not for the size (`part2.ts`).
3. Move whole functions. Move the types they use with them, or to a `types.ts` of the folder.
4. Keep the old file as the front door when other files import it: it re-exports the public parts, or it stays as the one class that calls the new files.
5. After each move run `npm run typecheck` and the tests of the folder. Commit when both pass.
6. Add the header (rule 2) and the folder `README.md` (rule 3).
