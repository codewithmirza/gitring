/**
 * Composes a work copy onto main: a fast-forward, or a merge of each file that both sides changed.
 *
 * Rungs 1 and 2 of the merge ladder. It returns the file changes to apply on main and never changes its inputs.
 * Pure (I/O only through callbacks). Read `text/merge3.ts` for the merge of one file.
 */

/*
 * Landing ladder, rungs 1 and 2: compose an attempt onto main.
 *
 *   main == base                    → fast-forward: the attempt's changes relative to base
 *   else, per path the attempt changed (base → attempt):
 *     main did not change it        → take the attempt version (or delete)
 *     main has the same result      → nothing to do
 *     both changed text             → merge3(base, main, attempt)  (conflict: "both-modified")
 *     added on both, different      → merge3 with an empty base    (conflict: "add-add")
 *     one deleted, one modified     → conflict "modify-delete"
 *     binary on both sides          → conflict "binary"
 *
 * Returns FileChange[] to apply on MAIN. Never mutates the inputs. Pure (I/O only via callbacks).
 */

import type { FileChange } from "../../platform/repo/backend";
import type { Snapshot } from "../git/snapshot";
import { merge3 } from "../text/merge3";

export interface ComposeInput {
  base: Snapshot;
  main: Snapshot;
  attempt: Snapshot;
  readText(sha: string): Promise<string | null>; // null for binary
  /**
   * Extension (optional): raw bytes of a blob. Needed to carry a binary file that only the
   * attempt changed. Without it, such a file is reported as a "binary" conflict.
   */
  readBytes?(sha: string): Promise<Uint8Array | null>;
}

export interface ComposeConflict {
  path: string;
  reason: "both-modified" | "modify-delete" | "add-add" | "binary";
  detail?: string;
}

export interface ComposeResult {
  method: "fast-forward" | "merge";
  clean: boolean;
  changes: FileChange[]; // to apply on MAIN to get the landing tree
  conflicts: ComposeConflict[];
  touched: string[]; // paths the attempt changed
}

interface Entry {
  sha: string;
  mode: string;
}

const DEFAULT_MODE = "100644";
const GITLINK_MODE = "160000";

function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.sha === b.sha && a.mode === b.mode;
}

function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [path, entry] of a) if (!sameEntry(entry, b.get(path))) return false;
  return true;
}

/** Paths whose entry differs between two snapshots, sorted. */
function changedPaths(from: Snapshot, to: Snapshot): string[] {
  const out = new Set<string>();
  for (const [path, entry] of from) if (!sameEntry(entry, to.get(path))) out.add(path);
  for (const [path, entry] of to) if (!sameEntry(from.get(path), entry)) out.add(path);
  return [...out].sort();
}

type Outcome = { change?: FileChange; conflict?: ComposeConflict };

/** The attempt's version of `path` as a FileChange (null entry = delete). */
async function takeEntry(input: ComposeInput, path: string, entry: Entry | undefined): Promise<Outcome> {
  if (!entry) return { change: { path, content: null } };
  if (entry.mode === GITLINK_MODE) return { conflict: { path, reason: "binary", detail: "Submodule entries are not supported." } };
  const text = await input.readText(entry.sha);
  if (text !== null) return { change: { path, content: text, mode: entry.mode || DEFAULT_MODE } };
  const bytes = input.readBytes ? await input.readBytes(entry.sha) : null;
  if (bytes) return { change: { path, content: bytes, mode: entry.mode || DEFAULT_MODE } };
  return { conflict: { path, reason: "binary", detail: "The binary content is not readable." } };
}

function describeConflicts(conflicts: { baseRange: [number, number] }[]): string {
  const ranges = conflicts.slice(0, 6).map(({ baseRange: [a, b] }) => (a === b ? `${a}` : `${a}–${b}`));
  const more = conflicts.length > 6 ? ` and ${conflicts.length - 6} more` : "";
  return `${conflicts.length} conflict region${conflicts.length === 1 ? "" : "s"} at base lines ${ranges.join(", ")}${more}.`;
}

async function mergePath(input: ComposeInput, path: string): Promise<Outcome> {
  const b = input.base.get(path);
  const m = input.main.get(path);
  const a = input.attempt.get(path);

  if (sameEntry(m, b)) return takeEntry(input, path, a); // main did not change this path
  if (sameEntry(m, a)) return {}; // both sides reached the same result
  if (!a) return { conflict: { path, reason: "modify-delete", detail: "Main changed the file. The attempt deleted it." } };
  if (!m) return { conflict: { path, reason: "modify-delete", detail: "Main deleted the file. The attempt changed it." } };

  // Mode: the side that changed it from base wins (attempt first).
  const mode = b && a.mode === b.mode ? m.mode : a.mode;
  if (a.sha === m.sha) return mode === m.mode ? {} : takeEntry(input, path, { sha: m.sha, mode });
  if (a.mode === GITLINK_MODE || m.mode === GITLINK_MODE) return { conflict: { path, reason: "binary", detail: "Submodule entries differ." } };

  const [baseText, mainText, attemptText] = await Promise.all([
    b ? input.readText(b.sha) : Promise.resolve(""),
    input.readText(m.sha),
    input.readText(a.sha),
  ]);
  if (mainText === null || attemptText === null || baseText === null) {
    return { conflict: { path, reason: "binary", detail: "Both sides changed a binary file." } };
  }
  const result = merge3(baseText, mainText, attemptText);
  if (!result.clean) {
    return { conflict: { path, reason: b ? "both-modified" : "add-add", detail: describeConflicts(result.conflicts) } };
  }
  if (result.content === mainText && mode === m.mode) return {};
  return { change: { path, content: result.content, mode } };
}

/** Parallel map with at most `limit` tasks in flight; results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Blob reads in flight at once. */
const READ_CONCURRENCY = 16;

export async function compose(input: ComposeInput): Promise<ComposeResult> {
  const touched = changedPaths(input.base, input.attempt);
  const fastForward = snapshotsEqual(input.main, input.base);
  const outcomes = await mapLimit(touched, READ_CONCURRENCY, (path) =>
    fastForward ? takeEntry(input, path, input.attempt.get(path)) : mergePath(input, path),
  );
  const changes: FileChange[] = [];
  const conflicts: ComposeConflict[] = [];
  for (const o of outcomes) {
    if (o.change) changes.push(o.change);
    if (o.conflict) conflicts.push(o.conflict);
  }
  return {
    method: fastForward ? "fast-forward" : "merge",
    clean: conflicts.length === 0,
    changes,
    conflicts,
    touched,
  };
}
