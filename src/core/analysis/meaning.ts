/**
 * Meaning of a change: what kind of change it is, from the version of each file before and after.
 *
 *   comment-only     JS/TS whose tokens without comments are the same before and after
 *   formatting-only  only white space differs (any text file)
 *   docs-only        a documentation file (Markdown, text, licenses) differs
 *   test-only        a test file differs (a `tests/` or `__tests__/` folder, `*.test.*`, `*.spec.*`)
 *   logic            anything else: the code itself differs, a file is new or gone, a binary file differs
 *
 * JS and TS are compared by their token streams (acorn's tokenizer, which skips comments): a change that
 * keeps every token is a change of comments or white space only. A file that the tokenizer cannot read
 * counts as logic unless only white space differs: a doubt makes the change need more care, never less.
 *
 * Pure module: runs in Node and in workerd. Never throws.
 */
import { Parser, tokenizer, type Options } from "acorn";
import jsx from "acorn-jsx";
import type { ChangeKind, ChangeMeaning } from "../types";
import type { FileVersions } from "./footprint";

/** The kinds, from the safest to the one that needs the most care. */
export const CHANGE_KINDS: readonly ChangeKind[] = ["comment-only", "formatting-only", "docs-only", "test-only", "logic"];

/** Kinds that change no behavior: "looks risky" ignores them, and no sign of risk applies. */
export const SAFE_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>(["comment-only", "formatting-only", "docs-only"]);

const JS_EXT = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i;
const JSX_EXT = /\.(?:jsx|tsx)$/i;
const DOCS_EXT = /\.(?:md|mdx|markdown|txt|rst|adoc|asciidoc)$/i;
/** Documentation files without an extension, by name. */
const DOCS_NAME = /^(?:readme|license|licence|changelog|changes|history|authors|contributors|contributing|notice|copying)(?:\.[a-z0-9]+)?$/i;
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|spec|specs|__snapshots__|__mocks__|fixtures?)\//i;
const TEST_NAME = /(?:[._-](?:test|spec)\.[a-z0-9]+$|\.snap$|^(?:test|spec)[._-])/i;

const TOKEN_OPTIONS: Options = { ecmaVersion: "latest", sourceType: "module", allowHashBang: true };
const JsxParser = Parser.extend(jsx());

/** What the path says about a file: documentation, a test, or code. */
export function pathKind(path: string): "docs" | "test" | "code" {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (DOCS_EXT.test(name) || DOCS_NAME.test(name)) return "docs";
  if (TEST_DIR.test(path) || TEST_NAME.test(name)) return "test";
  return "code";
}

/** True when the two texts differ only in white space. */
function whitespaceOnly(a: string, b: string): boolean {
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

/**
 * The tokens of JS or TS source as strings, without comments, or null when the tokenizer cannot read it.
 * A JSX file is read with the JSX tokenizer first. TypeScript reads as JavaScript at the token level
 * (types are names and punctuation); decorators and a few constructs cannot be read.
 */
export function tokensOf(source: string, path: string): string[] | null {
  const withJsx = JSX_EXT.test(path);
  return (withJsx ? read(source, true) : null) ?? read(source, false);
}

function read(source: string, withJsx: boolean): string[] | null {
  const out: string[] = [];
  try {
    for (const tok of withJsx ? JsxParser.tokenizer(source, TOKEN_OPTIONS) : tokenizer(source, TOKEN_OPTIONS)) {
      if (tok.type.label === "eof") break;
      // The raw text of the token: a string that changes its quotes, or a number its form, counts as logic.
      out.push(`${tok.type.label}\u0000${source.slice(tok.start, tok.end)}`);
    }
  } catch {
    return null;
  }
  return out;
}

/** True when both sources have the same tokens (comments and white space aside); null when one cannot be read. */
export function sameTokens(before: string, after: string, path: string): boolean | null {
  const a = tokensOf(before, path);
  if (!a) return null;
  const b = tokensOf(after, path);
  if (!b) return null;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The kind of the change of one file. */
export function fileChangeKind(f: FileVersions): ChangeKind {
  const where = pathKind(f.path);
  if (where === "docs") return "docs-only";
  if (f.base === null || f.head === null) return where === "test" ? "test-only" : "logic";
  if (f.base === f.head) return "formatting-only";
  if (whitespaceOnly(f.base, f.head)) return "formatting-only";
  if (JS_EXT.test(f.path)) {
    const same = sameTokens(f.base, f.head, f.path);
    // The tokens are the same, and more than white space differs: the comments differ.
    if (same) return "comment-only";
  }
  return where === "test" ? "test-only" : "logic";
}

/** The kind that needs the most care of two. */
function worse(a: ChangeKind, b: ChangeKind): ChangeKind {
  return CHANGE_KINDS.indexOf(a) >= CHANGE_KINDS.indexOf(b) ? a : b;
}

/**
 * The meaning of a whole change. `changed` are the text files with their versions; `opaque` are the paths
 * of binary files (and other files without text) that differ: those are logic, or tests by their path.
 * No changed file at all: formatting-only (nothing differs).
 */
export function changeMeaning(changed: FileVersions[], opaque: string[] = []): ChangeMeaning {
  const files: Record<string, ChangeKind> = {};
  let kind: ChangeKind | undefined;
  for (const f of changed) {
    files[f.path] = fileChangeKind(f);
    kind = kind ? worse(kind, files[f.path]) : files[f.path];
  }
  for (const path of opaque) {
    files[path] = pathKind(path) === "test" ? "test-only" : "logic";
    kind = kind ? worse(kind, files[path]) : files[path];
  }
  return { kind: kind ?? "formatting-only", files };
}

/** One plain sentence for people about the kind of a change. */
export function kindWords(kind: ChangeKind): string {
  switch (kind) {
    case "comment-only":
      return "Only comments change.";
    case "formatting-only":
      return "Only white space changes.";
    case "docs-only":
      return "Only documentation changes.";
    case "test-only":
      return "Only tests change.";
    default:
      return "The code logic changes.";
  }
}

/** The kind as a short label for a card or a list: "comment-only" gives "comments only". */
export const KIND_LABEL: Record<ChangeKind, string> = {
  "comment-only": "comments only",
  "formatting-only": "white space only",
  "docs-only": "documentation only",
  "test-only": "tests only",
  logic: "code logic",
};
