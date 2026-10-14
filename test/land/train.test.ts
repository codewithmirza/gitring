import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TRAIN, findPassingTrain, firstPassingUndo, independent, selectTrain, type RangeOf, type TrainCandidate } from "../../src/core/land/train";

const c = (id: string, files: string[], order: number, intentId = `i_${id}`): TrainCandidate => ({ id, intentId, files, order });
const far: RangeOf = () => 5;

describe("independent work", () => {
  it("needs different tasks, no shared file and range 3 or more", () => {
    expect(independent(c("a", ["x.js"], 0), c("b", ["y.js"], 1), far)).toBe(true);
    expect(independent(c("a", ["x.js"], 0), c("b", ["x.js"], 1), far)).toBe(false);
    expect(independent(c("a", ["x.js"], 0, "same"), c("b", ["y.js"], 1, "same"), far)).toBe(false);
    expect(independent(c("a", ["x.js"], 0), c("b", ["y.js"], 1), () => 2)).toBe(false);
    expect(independent(c("a", ["x.js"], 0), c("b", ["y.js"], 1), () => undefined)).toBe(false);
  });
});

describe("selectTrain", () => {
  it("always starts with the first work copy and keeps the queue order", () => {
    const q = [c("a", ["a.js"], 0), c("b", ["b.js"], 1), c("c", ["c.js"], 2)];
    expect(selectTrain(q, far).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(selectTrain([], far)).toEqual([]);
    expect(selectTrain([q[0]], far).map((x) => x.id)).toEqual(["a"]);
  });

  it("leaves out work that shares a file with the first one, and takes the largest set of the rest", () => {
    const q = [c("a", ["a.js"], 0), c("b", ["a.js"], 1), c("c", ["c.js", "d.js"], 2), c("d", ["d.js"], 3), c("e", ["e.js"], 4)];
    // c and d share d.js: only one of them rides with e. The earlier one wins.
    expect(selectTrain(q, far).map((x) => x.id)).toEqual(["a", "c", "e"]);
  });

  it("uses the range of each pair", () => {
    const q = [c("a", ["a.js"], 0), c("b", ["b.js"], 1), c("c", ["c.js"], 2)];
    const range: RangeOf = (x, y) => ([x.id, y.id].sort().join("") === "bc" ? 1 : 5);
    expect(selectTrain(q, range).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("keeps the train at the maximum size (default 8) and a size of 1 is no train", () => {
    const q = Array.from({ length: 12 }, (_, i) => c(`w${i}`, [`f${i}.js`], i));
    expect(DEFAULT_MAX_TRAIN).toBe(8);
    expect(selectTrain(q, far)).toHaveLength(8);
    expect(selectTrain(q, far, { maxSize: 3 })).toHaveLength(3);
    expect(selectTrain(q, far, { maxSize: 1 })).toHaveLength(1);
    expect(selectTrain(q, far, { maxSize: 99 })).toHaveLength(12);
  });
});

describe("findPassingTrain", () => {
  const run = (bad: Set<number>, together: (set: number[]) => boolean = () => true) => async (set: readonly number[]) => !set.some((m) => bad.has(m)) && together([...set]);

  it("finds the one work copy that fails and keeps the rest", async () => {
    const r = await findPassingTrain([0, 1, 2, 3, 4, 5], run(new Set([3])));
    expect(r.bad).toEqual([3]);
    expect([...r.good].sort()).toEqual([0, 1, 2, 4, 5]);
    expect(r.later).toEqual([]);
  });

  it("finds several, and a train where all fail gives nothing", async () => {
    const r = await findPassingTrain([0, 1, 2, 3], run(new Set([0, 3])));
    expect([...r.bad].sort()).toEqual([0, 3]);
    expect([...r.good].sort()).toEqual([1, 2]);
    const all = await findPassingTrain([0, 1], run(new Set([0, 1])));
    expect(all.good).toEqual([]);
    expect([...all.bad].sort()).toEqual([0, 1]);
  });

  it("sends work that passes alone but fails with the other work to the next train", async () => {
    const together = (s: number[]) => !(s.includes(0) && s.includes(2));
    const r = await findPassingTrain([0, 1, 2], run(new Set(), together));
    expect(r.bad).toEqual([]);
    expect(r.good.length + r.later.length).toBe(3);
    expect(r.later.length).toBeGreaterThan(0);
    expect(await run(new Set(), together)(r.good)).toBe(true);
  });

  it("uses few test runs for one bad work copy", async () => {
    const r = await findPassingTrain(Array.from({ length: 8 }, (_, i) => i), run(new Set([5])));
    expect(r.runs).toBeLessThanOrEqual(8);
  });
});

describe("firstPassingUndo", () => {
  it("names the newest merge whose undo makes main pass", async () => {
    expect(await firstPassingUndo(5, async (k) => k >= 2)).toBe(2);
    expect(await firstPassingUndo(5, async (k) => k >= 1)).toBe(1);
    expect(await firstPassingUndo(5, async (k) => k >= 5)).toBe(5);
  });

  it("gives nothing when main fails with every merge undone, or there is no merge", async () => {
    expect(await firstPassingUndo(3, async () => false)).toBeUndefined();
    expect(await firstPassingUndo(0, async () => true)).toBeUndefined();
  });
});
