/**
 * Turns TypeScript into JavaScript by blanking the types in place, so that offsets and line numbers do not move.
 *
 * Called by the front door `../symbols`. It returns null for source that it cannot read.
 */

import { TsStripper } from "./ts-scan";
import { blankDecorators, tokenizeTs } from "./ts-tokens";

/**
 * Best-effort TypeScript → JavaScript by blanking types in place (same length, same line breaks).
 * Handles annotations, generics, `as`/`satisfies`/`!`, interfaces, type aliases, `declare`,
 * `import type`/`export type`, overloads, class modifiers, parameter properties, enums and
 * namespaces (as `var X;`). Returns null when the source cannot be tokenized or a construct is
 * not understood; the caller then parses the original and falls back to the regex scanner.
 */
export function stripTypeScript(source: string, tsx = false): string | null {
  return stripTypeScriptDetailed(source, tsx)?.code ?? null;
}

/**
 * `stripTypeScript` plus a map of the positions it blanked (1 = removed). TSX is read with the JSX
 * tokenizer first; a .tsx file that it cannot read (a generic arrow `<T,>(x: T) => x`, for example)
 * gets the plain tokenizer.
 */
export function stripTypeScriptDetailed(source: string, tsx: boolean): { code: string; removed: Uint8Array } | null {
  return tsx ? (stripWith(source, true, true) ?? stripWith(source, true, false)) : stripWith(source, false, false);
}

function stripWith(source: string, tsx: boolean, withJsx: boolean): { code: string; removed: Uint8Array } | null {
  const removed = new Uint8Array(source.length);
  let src = source;
  let toks = tokenizeTs(src, withJsx);
  if (toks === null && source.includes("@")) {
    // decorators are the one TypeScript construct the tokenizer cannot read
    src = blankDecorators(source, removed);
    toks = tokenizeTs(src, withJsx);
  }
  if (toks === null) return null;
  const s = new TsStripper(src, toks, tsx);
  if (!s.pair()) return null;
  s.collectTypeOnlyNames();
  s.run();
  if (s.failed) return null;
  return { code: s.output(removed), removed };
}
