/**
 * Reads a JavaScript or TypeScript file and tells which symbols it declares, exports, imports and uses.
 *
 * The front door of the symbol reader. Callers: footprint.ts, graph.ts, the project coordinator and the views.
 * Pure module (acorn and acorn-jsx only): it runs in Node and in workerd. It never throws.
 * The parts are in `symbols/`. Read `symbols/README.md` first.
 */

/*
 *   .js .mjs .cjs           acorn (ecmaVersion "latest", sourceType "module"; a script retry for
 *                           CommonJS-style files; a JSX retry for a .js file with JSX)
 *   .jsx                    acorn with acorn-jsx
 *   .ts .tsx .mts .cts      best-effort type strip (types are blanked in place, so offsets and line
 *                           numbers do not move), then acorn (acorn-jsx for .tsx)
 *   parse failure           regex scanner; `parseError` is set (top-level declarations only)
 *
 * Imports: `import` declarations, `export … from`, and `require("…")` calls with a literal string.
 * Specifiers resolve relative to the file, and through the path aliases of tsconfig.json or
 * jsconfig.json (`compilerOptions.paths` and `baseUrl`) when the caller gives them.
 *
 * Line numbers are 1-based and come from character offsets with the line model of `lineDiff`
 * (lines end at "\n"), so ranges and diff hunks always agree.
 */

import { parseProgram } from "./symbols/acorn-parse";
import type { CommentSpan } from "./symbols/acorn-parse";
import { analyzeProgram } from "./symbols/ast-analysis";
import { emptyAnalysis, errorMessage } from "./symbols/helpers";
import type { AnyNode } from "./symbols/helpers";
import { resolveImport } from "./symbols/paths";
import { regexAnalysis } from "./symbols/regex-analysis";
import { stripTypeScriptDetailed } from "./symbols/ts-strip";
import type { ModuleAnalysis, ModuleSymbols, PathAliases } from "./symbols/types";

export type { DeclInfo, ImportBinding, ImportInfo, MemberInfo, ModuleAnalysis, ModuleSymbols, PathAliases } from "./symbols/types";
export { ownEntry } from "./symbols/helpers";
export { pathAliasesOf, resolveImport } from "./symbols/paths";
export { stripTypeScript } from "./symbols/ts-strip";

// ───── Constants ─────

const JS_EXT = /\.(?:js|mjs|cjs|jsx)$/i;
const TS_EXT = /\.(?:ts|tsx|mts|cts)$/i;
const JSX_EXT = /\.(?:jsx|tsx)$/i;

// ───── Public functions ─────

/** True for .js .mjs .cjs .jsx .ts .tsx .mts .cts. */
export function isAnalyzable(path: string): boolean {
  return JS_EXT.test(path) || TS_EXT.test(path);
}

/**
 * Symbols of one module. Never throws. On a parse failure the regex scanner gives approximate
 * results and `parseError` holds the parser message.
 * Extension: pass `files` (all repo paths) to fill `imports[].resolved`, and `aliases` to resolve
 * aliased specifiers (`@/lib/x`) too.
 */
export function extractSymbols(path: string, source: string, files?: Set<string>, aliases?: PathAliases): ModuleSymbols {
  const a = analyzeModule(path, source, files, aliases);
  const out: ModuleSymbols = {
    path: a.path,
    decls: a.decls,
    exports: a.exports,
    imports: a.imports,
    references: a.references,
    topLevelReferences: a.topLevelReferences,
  };
  if (a.parseError !== undefined) out.parseError = a.parseError;
  return out;
}

/**
 * `extractSymbols` plus statement-level references, import bindings and the members of top-level
 * classes and objects (used by footprints). Never throws.
 */
export function analyzeModule(path: string, source: string, files?: Set<string>, aliases?: PathAliases): ModuleAnalysis {
  let result: ModuleAnalysis;
  const ts = TS_EXT.test(path);
  const jsxFile = JSX_EXT.test(path);
  try {
    let code = source;
    let removed: Uint8Array | undefined;
    if (ts) {
      const stripped = stripTypeScriptDetailed(source, /\.tsx$/i.test(path));
      if (stripped !== null) ({ code, removed } = stripped);
    }
    let parsed: { program: AnyNode; comments: CommentSpan[] } | undefined;
    let parseError: string | undefined;
    try {
      parsed = parseProgram(code, jsxFile);
    } catch (e) {
      parseError = errorMessage(e);
    }
    // A .js file can hold JSX (a React project without a build step for the extension).
    if (!parsed && !ts && !jsxFile && /<[A-Za-z>]/.test(code)) {
      try {
        parsed = parseProgram(code, true);
      } catch {
        /* keep the first error */
      }
    }
    result = parsed ? analyzeProgram(path, code, parsed.program, removed, parsed.comments) : regexAnalysis(path, source, ts, parseError ?? "parse failed");
  } catch (e) {
    try {
      result = regexAnalysis(path, source, ts, errorMessage(e));
    } catch (e2) {
      result = emptyAnalysis(path, errorMessage(e2));
    }
  }
  if (files) {
    for (const imp of result.imports) {
      const r = resolveImport(path, imp.from, files, aliases);
      if (r !== undefined) imp.resolved = r;
    }
  }
  // Records are built prototype-free (a declaration may be called "toString"); hand out plain objects.
  result.decls = plainRecord(result.decls);
  result.exports = plainRecord(result.exports);
  result.references = plainRecord(result.references);
  result.bindings = plainRecord(result.bindings);
  result.members = plainRecord(result.members);
  result.memberReferences = plainRecord(result.memberReferences);
  return result;
}

// ───── Helpers ─────

/** A plain object with the same own entries (`Object.fromEntries` also keeps a "__proto__" key as data). */
function plainRecord<T>(d: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(d));
}
