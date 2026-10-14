/**
 * Small helpers that the files of the symbol reader share: records without a prototype, line lookup, empty results.
 *
 * Every file of this folder may import this file. It imports nothing from its folder.
 */

import type { ModuleAnalysis } from "./types";

/** Own property lookup (safe for keys such as "constructor" or "toString"). */
export function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

// The AST is walked generically; acorn's node types are too narrow for that, so nodes are `any`.
export type AnyNode = any;

function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function emptyAnalysis(path: string, parseError?: string): ModuleAnalysis {
  const a: ModuleAnalysis = {
    path,
    decls: dict(),
    exports: dict(),
    imports: [],
    references: dict(),
    topLevelReferences: [],
    bindings: dict(),
    statements: [],
    members: dict(),
    memberReferences: dict(),
    memberOwners: [],
  };
  if (parseError !== undefined) a.parseError = parseError;
  return a;
}

/** 1-based line of a character offset (lines end at "\n"). */
export function lineIndex(src: string): (offset: number) => number {
  const starts = [0];
  for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** An owner with more members than this (a large table of data, for example) keeps its members unrecorded. */
export const MAX_MEMBERS = 200;

export const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

export const sortedArray = (s: Iterable<string>): string[] => [...new Set(s)].sort();
