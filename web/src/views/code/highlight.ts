/**
 * A small syntax highlighter for the code view: eight languages and no packages.
 * Languages: JavaScript, TypeScript (also JSX and TSX), JSON, CSS, HTML, Markdown, Python and Go.
 * It works one line at a time and carries a state from line to line (block comments, template strings,
 * JSX children, code fences in Markdown), so only the lines on screen need tokens.
 * A line gives a flat number array [end0, class0, end1, class1, ...]. Class 0 is plain text.
 * This file is the front door. One file for each language is in highlight/ (read highlight/README.md).
 */
export { CLASS_NAMES } from "./highlight/classes";
export type { Highlighter } from "./highlight/emit";
export { languageOf } from "./highlight/language";
export type { Lang, LangInfo } from "./highlight/language";
export { tokenizeAll, runsOf, LineHighlighter } from "./highlight/lines";
export { highlighterFor } from "./highlight/registry";
