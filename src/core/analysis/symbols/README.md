# src/core/analysis/symbols

The symbol reader: it reads one JavaScript or TypeScript file and tells which symbols the file declares, exports, imports and uses. The code graph, the real changes of a work copy (footprint) and the conflict check all depend on it.

The front door is `../symbols.ts`. It exports `analyzeModule`, `extractSymbols`, `isAnalyzable`, `resolveImport`, `pathAliasesOf`, `ownEntry` and `stripTypeScript`. Import from there, not from a file in this folder.

## How a file is read

1. A TypeScript file goes through the type strip first. The strip blanks every type with spaces, so no offset and no line number moves.
2. acorn parses the result (acorn-jsx for JSX). If the parse fails, the regex scanner reads the original text instead and sets `parseError`.
3. The syntax tree gives the declarations, the exports, the imports, the names that each declaration uses, and the members of top-level classes and objects.

## The files

Reading order: types, the parse, the tree analysis, then the two fallbacks.

| File | What it is for |
|---|---|
| `types.ts` | The types of the result: `DeclInfo`, `ImportInfo`, `ModuleSymbols`, `MemberInfo`, `ModuleAnalysis`, `PathAliases`. |
| `helpers.ts` | Small shared helpers: records without a prototype, line lookup, the empty result. |
| `paths.ts` | Import specifiers to repository paths, and path aliases from tsconfig.json or jsconfig.json. |
| `acorn-parse.ts` | The acorn parse: module first, then script, with a JSX variant. |
| `references.ts` | Scopes and `RefCollector`, which collects the names that a piece of code uses. |
| `ast-analysis.ts` | `analyzeProgram`: declarations, exports, imports, references and members from the syntax tree. |
| `masking.ts` | Blanks comments and string contents without moving an offset. Finds matching brackets. |
| `regex-analysis.ts` | The fallback for a file that does not parse: a scanner of lines and brackets. |
| `ts-tokens.ts` | Tokens of TypeScript source for the strip, and the blanking of decorators. |
| `ts-cursor.ts` | Strip layer 1: bracket pairs, token lookups, the list of cuts and the output text. |
| `ts-type-skip.ts` | Strip layer 2: finds where a type ends. |
| `ts-statement-skip.ts` | Strip layer 3: finds where a type-only statement ends. |
| `ts-scan-heads.ts` | Strip layer 4: class member heads, object keys and parameter starts. Holds the scan state. |
| `ts-scan-declarations.ts` | Strip layer 5: the keywords function, class, import, export, const, var and names. |
| `ts-scan.ts` | Strip layer 6: the main scan (`run`, `scanToken`). |
| `ts-strip.ts` | `stripTypeScript`: puts the layers together. |

## The type strip is a class chain

The strip is one class that grew too big for one file. Each layer extends the one before and adds one job: `TsCursor`, `TsTypeSkipper`, `TsStatementSkipper`, `TsHeadReader`, `TsDeclarationReader`, `TsStripper`. A method that a later layer calls is `protected`.

## Rules for this folder

- The reader never throws. A file that it cannot understand gives an approximate result and a `parseError`.
- It is a pure module: acorn and acorn-jsx only. It runs in Node and in workerd.
- A line number is 1-based and comes from a character offset with the line model of `lineDiff` (a line ends at `\n`). Ranges and diff hunks must always agree.
