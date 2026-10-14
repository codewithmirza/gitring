/**
 * Computes the real changes (footprint) of a work copy from the old and the new version of each changed file.
 *
 * Called by the project coordinator when an agent writes or pushes. Pure module: runs in Node and in workerd.
 * This file does the files (status, hunks, line counts). The symbols of each file are in `footprint-symbols.ts`.
 */

/*
 * Footprint: what an attempt actually touched, computed from real file versions.
 *
 *   files     status (A/M/D), base hunks, additions, deletions        (every changed file)
 *   symbols   defined / modified / removed / signatureChanged / referenced, as `path#name` keys
 *             (analyzable JS/TS files only; binary files get a whole-file touch and no symbols)
 */
import type { FileTouch, Footprint, LineRange, SymbolKey, SymbolTouches } from "../types";
import { diffHunks } from "../text/diff";
import { symbolTouches } from "./footprint-symbols";
import { isAnalyzable } from "./symbols";
import type { PathAliases } from "./symbols";

export interface FileVersions {
  path: string;
  /** Text on the attempt's base; null = the file did not exist. */
  base: string | null;
  /** Text in the attempt's head; null = the file is deleted. */
  head: string | null;
}

/** Signature of one function symbol before (base) and after (head) the change. */
export interface SignatureChange {
  before?: string;
  after?: string;
}

/** Extension: the footprint plus the signatures of the function symbols it touches. */
export interface FootprintAnalysis {
  footprint: Footprint;
  /** `path#name` → base/head signature, for defined, modified, removed and signature-changed functions. */
  signatures: Record<SymbolKey, SignatureChange>;
  /** Import edges [file, imported file] of the changed files in head (a deleted file has none), from the same parse. */
  imports: [string, string][];
}

/** Extension: what the footprint knows about the repository beyond the changed files. */
export interface FootprintOptions {
  /** Path aliases (tsconfig.json or jsconfig.json): aliased imports resolve too. */
  aliases?: PathAliases;
  /**
   * True for a member key of the repository (`src/cart.js#Cart.add`). With it, `Cart.add(…)` on an
   * imported class or object becomes a use of that member.
   */
  knownMember?: (key: SymbolKey) => boolean;
}

/**
 * Footprint of a set of file versions. `allFiles` is every path of the head tree (used to resolve
 * relative imports). Identical versions are skipped. All symbol arrays are sorted and unique.
 *
 * Symbol rules (per analyzable file, `path#name` keys; an exported alias `export { a as b }` or a
 * named default export also adds `path#b` / `path#default`):
 *   defined           declarations in head that are not in base
 *   removed           declarations in base that are not in head
 *   modified          declarations in both whose text changed, or whose BASE range a hunk touches
 *                     (a pure insertion counts only when it lands strictly inside the declaration)
 *   signatureChanged  exported functions (incl. arrow functions) in both whose parameters changed
 *   referenced        what defined/modified declarations use in head, plus what changed top-level
 *                     statements use: imports resolve to `target#imported` (`ns.fn` → `target#fn`),
 *                     local declarations to `path#name`; globals and packages are skipped
 *
 * Members (`path#Class.method`, `path#api.list`): for a top-level class or object in both versions,
 * the same rules apply to each member, with its own lines and parameters. The class or object
 * itself is "modified" only when its text outside the members changes (the class head, for
 * example). A changed constructor signature is a signature change of the class. `this.x` in a
 * member, and `Owner.x` for a local owner, use `path#Owner.x`. Both versions must parse: with the
 * regex scanner, the whole class counts as one symbol, as before.
 */
export function computeFootprint(files: FileVersions[], allFiles: Set<string>, now: number = Date.now(), opts: FootprintOptions = {}): Footprint {
  return analyzeFootprint(files, allFiles, now, opts).footprint;
}

/** `computeFootprint` plus before/after signatures of the touched function symbols (one parse per version). */
export function analyzeFootprint(files: FileVersions[], allFiles: Set<string>, now: number = Date.now(), opts: FootprintOptions = {}): FootprintAnalysis {
  const touches = new Map<string, FileTouch>();
  const signatures = new Map<SymbolKey, SignatureChange>();
  const acc = {
    defined: new Set<SymbolKey>(),
    modified: new Set<SymbolKey>(),
    removed: new Set<SymbolKey>(),
    signatureChanged: new Set<SymbolKey>(),
    referenced: new Set<SymbolKey>(),
  };
  const referencedIn = new Map<SymbolKey, Set<string>>();
  const imports: [string, string][] = [];
  const list = files.filter((f) => f && typeof f.path === "string").sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  for (const f of list) {
    const base = typeof f.base === "string" ? f.base : null;
    const head = typeof f.head === "string" ? f.head : null;
    if (base === head) continue;
    const status: FileTouch["status"] = base === null ? "A" : head === null ? "D" : "M";
    if (looksBinary(base) || looksBinary(head)) {
      const lines = base === null ? 0 : countLines(base);
      touches.set(f.path, { status, hunks: status === "A" ? [[0, 0]] : [[1, Math.max(1, lines)]], additions: 0, deletions: 0 });
      continue;
    }
    // Same numbers as lineDiff (same engine); the per-hunk detail also tells insertions from replacements.
    const hunks = diffHunks(base ?? "", head ?? "");
    const touch: FileTouch = { status, hunks: [], additions: 0, deletions: 0 };
    const changedNewLines: LineRange[] = [];
    for (const h of hunks) {
      touch.hunks.push(h.oldLines > 0 ? [h.oldStart, h.oldStart + h.oldLines - 1] : [h.oldStart, h.oldStart]);
      if (h.newLines > 0) changedNewLines.push([h.newStart, h.newStart + h.newLines - 1]);
      touch.additions += h.newLines;
      touch.deletions += h.oldLines;
    }
    touches.set(f.path, touch);
    if (isAnalyzable(f.path)) {
      const local = new Set<SymbolKey>();
      symbolTouches(f.path, base, head, hunks, changedNewLines, allFiles, acc, signatures, local, opts, imports);
      for (const k of local) {
        const set = referencedIn.get(k) ?? new Set<string>();
        set.add(f.path);
        referencedIn.set(k, set);
      }
    }
  }
  const sorted = (s: Set<string>): SymbolKey[] => [...s].sort();
  const symbols: SymbolTouches = {
    defined: sorted(acc.defined),
    modified: sorted(acc.modified),
    removed: sorted(acc.removed),
    signatureChanged: sorted(acc.signatureChanged),
    referenced: sorted(acc.referenced),
  };
  if (referencedIn.size) {
    symbols.referencedIn = Object.fromEntries([...referencedIn].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, [...v].sort()]));
  }
  return {
    footprint: { files: Object.fromEntries(touches), symbols, computedAt: now },
    signatures: Object.fromEntries(signatures),
    imports,
  };
}

/* ───────────────────────────── internals ───────────────────────────── */

/** Text with NUL in the first 8000 characters is binary (git's rule, applied to decoded text). */
function looksBinary(text: string | null): boolean {
  return text !== null && text.slice(0, 8000).includes("\u0000");
}

function countLines(text: string): number {
  if (text === "") return 0;
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

