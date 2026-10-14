/**
 * The token classes of the highlighter: a number for each kind of text and the CSS class that the number maps to.
 */
/**
 * A small syntax highlighter for the code view: JavaScript, TypeScript (also JSX and TSX), JSON, CSS,
 * HTML, Markdown, Python and Go. No packages.
 *
 * It works one line at a time and carries a state from line to line (block comments, template
 * strings, triple-quoted strings, JSX children, code fences in Markdown, <script> in HTML), so a file
 * can be highlighted in small steps and only the lines on screen need tokens.
 *
 * Tokens of a line are a flat number array: [end0, class0, end1, class1, …]. Text before end0 has
 * class0, and so on. Class 0 is plain text. CLASS_NAMES maps a class to its CSS class.
 */

export const CLASS_NAMES = [
  "",
  "tk-com",
  "tk-str",
  "tk-num",
  "tk-kw",
  "tk-lit",
  "tk-type",
  "tk-fn",
  "tk-prop",
  "tk-op",
  "tk-punc",
  "tk-tag",
  "tk-attr",
  "tk-re",
  "tk-head",
  "tk-em",
  "tk-strong",
  "tk-code",
  "tk-link",
  "tk-key",
  "tk-sel",
  "tk-var",
  "tk-esc",
  "tk-meta",
] as const;

export const PLAIN = 0;
export const COM = 1;
export const STR = 2;
export const NUM = 3;
export const KW = 4;
export const LIT = 5;
export const TYPE = 6;
export const FN = 7;
export const PROP = 8;
export const OP = 9;
export const PUNC = 10;
export const TAG = 11;
export const ATTR = 12;
export const RE = 13;
export const HEAD = 14;
export const EM = 15;
export const STRONG = 16;
export const CODE = 17;
export const LINK = 18;
export const KEY = 19;
export const SEL = 20;
export const VAR = 21;
export const ESC = 22;
export const META = 23;
