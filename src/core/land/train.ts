/**
 * Trains: several independent work copies merge in one go, and the tests run once for all of them.
 *
 * Pure module: the project coordinator gives the facts (files, distances) and the test runs.
 */

/*
 * Trains: several independent work copies merge in one go.
 *
 * When the merge queue holds more than one ready work copy, gitring takes the largest set that is
 * pairwise independent (no shared file, no shared task, range ≥ 3: the files do not import each other
 * directly), composes them onto main in order, runs the tests ONCE on main plus all of them, and commits
 * them one after the other, one commit per task with its own why-record. The first work copy of the
 * queue always rides: no work copy waits forever behind trains of other work.
 *
 * A failed train is split: each half is tested alone, and the halves that fail are split again, until the
 * work that fails is found. The rest merges. Work that passes alone but fails with the others waits for
 * the next train.
 *
 * Pure module: the project object gives the facts (files, ranges) and the test runs.
 */

import type { Range } from "../types";

export interface TrainCandidate {
  /** The work copy. */
  id: string;
  /** The task of the work copy: two work copies of one task never ride together (they compete). */
  intentId: string;
  /** The files that the work changes (the footprint and the plan). */
  files: readonly string[];
  /** The place in the merge queue (a lower number goes first). */
  order: number;
}

/** The largest train, when the project settings say nothing. */
export const DEFAULT_MAX_TRAIN = 8;
/** The largest train that a project may set. */
export const MAX_TRAIN_LIMIT = 16;
/** Pairs closer than this (same lines, shared function, same file, one import) are not independent. */
export const TRAIN_MIN_RANGE: Range = 3;
/** The queue window that a train is chosen from (the search is exact inside the window). */
export const TRAIN_WINDOW = 24;
/** The search for the largest train stops after this many steps and keeps the best train found. */
const SEARCH_BUDGET = 20_000;

/** The range between two work copies, from the conflict-check facts. `undefined`: gitring does not know. */
export type RangeOf = (a: TrainCandidate, b: TrainCandidate) => Range | undefined;

/** True when two work copies can merge in one train: different tasks, no shared file, and far apart in the code. */
export function independent(a: TrainCandidate, b: TrainCandidate, rangeOf: RangeOf): boolean {
  if (a.id === b.id || a.intentId === b.intentId) return false;
  const files = new Set(a.files);
  for (const f of b.files) if (files.has(f)) return false;
  const range = rangeOf(a, b);
  return range !== undefined && range >= TRAIN_MIN_RANGE;
}

function byQueue(x: TrainCandidate, y: TrainCandidate): number {
  return x.order - y.order || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
}

/**
 * The train for the queue: the first work copy, plus the largest set of other work copies that are pairwise
 * independent (of the first one and of each other), at most `maxSize` in all. Among trains of the same size,
 * the one with the earlier work copies wins. In queue order.
 */
export function selectTrain(queue: readonly TrainCandidate[], rangeOf: RangeOf, opts: { maxSize?: number; window?: number } = {}): TrainCandidate[] {
  const maxSize = Math.max(1, Math.min(MAX_TRAIN_LIMIT, Math.floor(opts.maxSize ?? DEFAULT_MAX_TRAIN)));
  const sorted = [...queue].sort(byQueue).slice(0, Math.max(1, opts.window ?? TRAIN_WINDOW));
  if (!sorted.length) return [];
  const head = sorted[0];
  if (maxSize === 1 || sorted.length === 1) return [head];
  const rest = sorted.slice(1).filter((c) => independent(head, c, rangeOf));
  const n = rest.length;
  const adj: boolean[][] = rest.map(() => new Array<boolean>(n).fill(false));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) adj[i][j] = adj[j][i] = independent(rest[i], rest[j], rangeOf);
  // The largest clique of `rest`, with a bound of maxSize - 1 (branch and bound; earlier work first).
  const want = maxSize - 1;
  let best: number[] = [];
  let budget = SEARCH_BUDGET;
  const grow = (chosen: number[], candidates: number[]): void => {
    if (chosen.length > best.length) best = [...chosen];
    if (best.length >= want || budget <= 0) return;
    for (let i = 0; i < candidates.length; i++) {
      if (chosen.length + (candidates.length - i) <= best.length) return;
      if (--budget <= 0) return;
      const c = candidates[i];
      grow([...chosen, c], candidates.slice(i + 1).filter((d) => adj[c][d]));
      if (best.length >= want) return;
    }
  };
  grow([], rest.map((_, i) => i));
  return [head, ...best.map((i) => rest[i])].sort(byQueue);
}

/* ───────────────────────────── the split of a failed train ───────────────────────────── */

export interface SplitResult<M> {
  /** Work whose smallest tested set fails: it does not merge. */
  bad: M[];
  /** Work that passes (alone, or in a set that passes). */
  good: M[];
  /** Work that passes alone but fails with the others: it waits for the next train. */
  later: M[];
}

/** A memo of test runs over sets of members, keyed by their places in the train. */
class TestMemo<M> {
  readonly results = new Map<string, boolean>();
  runs = 0;
  constructor(
    private readonly members: readonly M[],
    private readonly test: (set: readonly M[]) => Promise<boolean>,
  ) {}
  key(set: readonly M[]): string {
    return set
      .map((m) => this.members.indexOf(m))
      .sort((a, b) => a - b)
      .join(",");
  }
  async ok(set: readonly M[]): Promise<boolean> {
    const key = this.key(set);
    const known = this.results.get(key);
    if (known !== undefined) return known;
    this.runs += 1;
    const ok = await this.test(set);
    this.results.set(key, ok);
    return ok;
  }
}

/** Split a set that fails (known) into the work that fails and the work that passes. */
async function split<M>(set: readonly M[], memo: TestMemo<M>): Promise<SplitResult<M>> {
  if (set.length <= 1) return { bad: [...set], good: [], later: [] };
  const mid = Math.ceil(set.length / 2);
  const a = set.slice(0, mid);
  const b = set.slice(mid);
  const okA = await memo.ok(a);
  const okB = await memo.ok(b);
  if (okA && okB) return { bad: [], good: a, later: b };
  const ra = okA ? { bad: [], good: a, later: [] } : await split(a, memo);
  const rb = okB ? { bad: [], good: b, later: [] } : await split(b, memo);
  return { bad: [...ra.bad, ...rb.bad], good: [...ra.good, ...rb.good], later: [...ra.later, ...rb.later] };
}

/**
 * The train failed its tests as a whole. Find the largest part of it that passes: split the train, test the
 * halves alone, and go into the halves that fail. The work that passes is tested together again before it
 * merges, so the tree that merges is a tree that was tested. `test` answers true when the tests pass on main
 * plus the given work. `runs`: the test runs that this took.
 */
export async function findPassingTrain<M>(members: readonly M[], test: (set: readonly M[]) => Promise<boolean>): Promise<SplitResult<M> & { runs: number }> {
  const memo = new TestMemo(members, test);
  memo.results.set(memo.key(members), false);
  const bad: M[] = [];
  const later: M[] = [];
  let pool: M[] = [...members];
  for (let round = 0; round <= members.length && pool.length; round++) {
    if (await memo.ok(pool)) break;
    const r = await split(pool, memo);
    bad.push(...r.bad);
    later.push(...r.later);
    pool = r.good;
  }
  return { bad, good: pool, later, runs: memo.runs };
}

/* ───────────────────────────── the search after a failed main ───────────────────────────── */

/**
 * Tests fail on main. `test(k)` answers true when the tests pass on main with the newest `k` merges undone
 * (k = 0 is main itself, known to fail). The smallest k that passes names the merge that broke main: the
 * k-th newest one. `undefined` when main fails with all `n` merges undone: no merge is the cause.
 */
export async function firstPassingUndo(n: number, test: (k: number) => Promise<boolean>): Promise<number | undefined> {
  if (n <= 0 || !(await test(n))) return undefined;
  let bad = 0; // fails
  let good = n; // passes
  while (good - bad > 1) {
    const mid = bad + Math.floor((good - bad) / 2);
    if (await test(mid)) good = mid;
    else bad = mid;
  }
  return good;
}
