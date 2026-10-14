/**
 * Parses JavaScript with acorn: as a module first, then as a script, with a variant for JSX.
 *
 * Called by the front door `../symbols`. It throws the module error when both parses fail. The caller catches it.
 */

import { Parser, parse, type Options } from "acorn";
import jsx from "acorn-jsx";
import type { AnyNode } from "./helpers";

const ACORN_MODULE: Options = { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true };

const ACORN_SCRIPT: Options = {
  ecmaVersion: "latest",
  sourceType: "script",
  locations: true,
  allowHashBang: true,
  allowReturnOutsideFunction: true,
};

/** acorn with JSX (acorn-jsx): for .jsx and .tsx files, and for .js files with JSX. */
export const JsxParser = Parser.extend(jsx());

/** A comment of the source, as character offsets [start, end). */
export type CommentSpan = [number, number];

/**
 * Parse as a module; if that fails, try a (CommonJS-style) script. Throws the module error.
 * Gives the comments too (members keep the comments right above them).
 */
export function parseProgram(code: string, withJsx = false): { program: AnyNode; comments: CommentSpan[] } {
  const run = (base: Options): { program: AnyNode; comments: CommentSpan[] } => {
    const comments: CommentSpan[] = [];
    const options: Options = { ...base, onComment: (_block: boolean, _text: string, start: number, end: number) => void comments.push([start, end]) };
    return { program: withJsx ? JsxParser.parse(code, options) : parse(code, options), comments };
  };
  try {
    return run(ACORN_MODULE);
  } catch (e) {
    try {
      return run(ACORN_SCRIPT);
    } catch {
      throw e;
    }
  }
}
