/**
 * A plan (code name course) and the real changes (code name footprint) of a work copy.
 *
 * The files and symbols of a plan feed the conflict check in `conflict-check.ts`.
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Millis } from "./basics";

/** A symbol key is `<path>#<name>`, for example `src/products.js#formatPrice`. */
export type SymbolKey = string;

export interface Course {
  /** Short plan steps, in order. */
  plan: string[];
  /** Files the agent intends to touch. */
  files: string[];
  /** Symbols the agent intends to define or change. */
  symbols: SymbolKey[];
  /**
   * Symbols the plan will call but not change (`path#name`). The check compares them with the changes of
   * other plans, so two plans can be at range 1 before any code exists.
   */
  uses?: SymbolKey[];
  /** One-sentence approach. */
  approach: string;
  /** When the work copy sent its first plan. A new plan for the same work copy, and a redo, keep it (R4). */
  declaredAt: Millis;
}

export type FileChangeStatus = "A" | "M" | "D";

/** Inclusive 1-based line range in the BASE version of the file. */
export type LineRange = [number, number];

export interface FileTouch {
  status: FileChangeStatus;
  /** Ranges of base lines that the change replaces or removes (empty for pure inserts at a point). */
  hunks: LineRange[];
  additions: number;
  deletions: number;
}

export interface SymbolTouches {
  /** New symbols. */
  defined: SymbolKey[];
  /** Existing symbols whose body changed. */
  modified: SymbolKey[];
  /** Existing symbols removed. */
  removed: SymbolKey[];
  /** Existing exported symbols whose parameter list changed (interface change). */
  signatureChanged: SymbolKey[];
  /** Symbols the changed code uses (calls or reads), resolved through imports when possible. */
  referenced: SymbolKey[];
  /** Optional: for each referenced symbol, the files where the changed code uses it. */
  referencedIn?: Record<SymbolKey, string[]>;
}

export interface Footprint {
  files: Record<string, FileTouch>;
  symbols: SymbolTouches;
  computedAt: Millis;
}

/**
 * What a change means (see core/analysis/meaning.ts), from the safest kind to the one that needs care:
 *   comment-only     only comments differ (JS/TS: the tokens without comments are the same)
 *   formatting-only  only white space differs
 *   docs-only        only documentation files differ (Markdown, text)
 *   test-only        only test files differ
 *   logic            the code itself differs
 */
export type ChangeKind = "comment-only" | "formatting-only" | "docs-only" | "test-only" | "logic";

export interface ChangeMeaning {
  /** The kind of the whole change: the kind of its file that needs the most care. */
  kind: ChangeKind;
  /** The kind of each changed file. */
  files: Record<string, ChangeKind>;
}
