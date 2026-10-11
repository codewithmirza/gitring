/**
 * The merge queue survives an eviction. The project object can stop at any await: its memory is gone, its
 * storage and the repository stay. A new object starts from them and must land the task exactly once.
 *
 * The stop points (see crash-world.ts):
 *   queued         the work copy is in the queue; the merge has not started
 *   before-tests   the merge started; the tests of main plus the work do not run
 *   before-commit  the tests ran; the commit to main is not made
 *   after-commit   main has the commit; gitring has not written its record
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrashWorld, type StopPoint } from "./crash-world";

const LEASE = 5 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const POINTS: { point: StopPoint; label: string }[] = [
  { point: "queued", label: "before the work copy leaves the queue" },
  { point: "before-tests", label: "after the merge starts and before the tests run" },
  { point: "before-commit", label: "after the tests and before the commit to main" },
  { point: "after-commit", label: "after the commit to main and before gitring writes its record" },
];

describe.each(POINTS)("the object stops $label", ({ point }) => {
  it("lands the task exactly once and leaves no work copy stuck", async () => {
    const w = new CrashWorld();
    await w.start();
    const t = await w.submitTask("alpha", { stop: point });
    expect(t.next).toBe("landing-queue");
    if (point !== "queued") await w.reached();

    // What the new object finds in storage: the queue entry, and a marker once the merge started.
    expect(w.inner.db.queue()).toEqual([t.attemptId]);
    expect(w.status(t.attemptId)).toBe(point === "queued" ? "ready" : "landing");
    const marker = w.inner.db.getMeta<{ id: string; startedAt: number; tries: number }>("landing");
    if (point === "queued") expect(marker).toBeUndefined();
    else expect(marker).toMatchObject({ id: t.attemptId, tries: 1 });
    expect(w.mainCommits).toHaveLength(point === "after-commit" ? 1 : 0);

    const h = w.restart();
    await w.settle();

    if (point !== "queued") {
      // The marker is new: the old object may still run. The new object waits for the lease, and the alarm wakes it.
      expect(w.status(t.attemptId)).toBe("landing");
      expect(w.mainCommits).toHaveLength(point === "after-commit" ? 1 : 0);
      expect(w.alarm).toBe(marker!.startedAt + LEASE);
      await h.alarm();
      expect(w.status(t.attemptId)).toBe("landing");
      expect(w.alarm).toBe(marker!.startedAt + LEASE);
      // The lease ends. The alarm starts the merge again.
      vi.setSystemTime(marker!.startedAt + LEASE + 1000);
      await h.alarm();
      await w.settle();
    }

    expect(w.status(t.attemptId)).toBe("landed");
    expect(w.inner.intents.get(t.intentId)?.status).toBe("landed");
    // One commit on main for this work copy, one landing, one count.
    expect(await w.mergesOf(t.attemptId)).toHaveLength(1);
    expect(w.mainCommits).toHaveLength(point === "after-commit" ? 1 : 1);
    expect(w.inner.landings.filter((l) => l.attemptId === t.attemptId)).toHaveLength(1);
    expect(w.inner.stats.landings).toBe(1);
    expect(await h.file("main", "src/alpha.js")).toBe("export const alpha = 1;\n");
    // gitring's main is the main of the repository.
    expect((await h.state()).project.mainSha).toBe(await w.repo.resolve(w.mainRepo, "main"));
    // Nothing is stuck: no queue entry, no marker, no work copy in the middle of a merge.
    expect(w.inner.db.queue()).toEqual([]);
    expect(w.inner.db.getMeta("landing")).toBeUndefined();
    for (const a of w.inner.attempts.values()) expect(["ready", "landing", "submitted"]).not.toContain(a.status);
  });
});

describe("a stop after the commit", () => {
  it("writes the record from main and does not commit a second time", async () => {
    const w = new CrashWorld();
    await w.start();
    const t = await w.submitTask("alpha", { stop: "after-commit" });
    await w.reached();
    const [commit] = await w.mergesOf(t.attemptId);
    const h = w.restart();
    vi.setSystemTime(Date.now() + LEASE + 1000);
    await h.alarm();
    await w.settle();
    // The record points at the commit that the first run made.
    const landing = w.inner.landings.find((l) => l.attemptId === t.attemptId)!;
    expect(landing.mainAfter).toBe(commit.hash);
    expect(w.mainCommits).toHaveLength(1);
    expect(w.inner.logs.some((l) => /Main has the merge of the work of .* already/.test(l.message))).toBe(true);
    // Tests did not run again: the merge was done.
    expect(w.testRuns.filter((s) => s === "composed")).toHaveLength(1);
  });
});

describe("the queue wakes by itself", () => {
  it("sets an alarm at the end of the lease when a merge starts", async () => {
    const w = new CrashWorld();
    await w.start();
    const before = Date.now();
    await w.submitTask("alpha", { stop: "before-tests" });
    await w.reached();
    expect(w.alarm).toBe(before + LEASE);
  });

  it("starts the queue when the object starts, without a request", async () => {
    const w = new CrashWorld();
    await w.start();
    const t = await w.submitTask("alpha", { stop: "queued" });
    expect(w.status(t.attemptId)).toBe("ready");
    w.restart();
    await w.settle();
    expect(w.status(t.attemptId)).toBe("landed");
  });

  it("queues a work copy that an older version left in the landing status without a queue entry", async () => {
    const w = new CrashWorld();
    await w.start();
    const t = await w.submitTask("alpha", { stop: "queued" });
    const a = w.inner.attempts.get(t.attemptId)!;
    a.status = "landing";
    w.inner.db.putAttempt(a);
    w.inner.db.dequeue(t.attemptId);
    expect(w.inner.db.queue()).toEqual([]);
    w.restart();
    await w.settle();
    expect(w.status(t.attemptId)).toBe("landed");
    expect(await w.mergesOf(t.attemptId)).toHaveLength(1);
  });

  it("drops a queue entry of a work copy that is gone, and clears its marker", async () => {
    const w = new CrashWorld();
    await w.start();
    const t = await w.submitTask("alpha", { stop: "before-tests" });
    await w.reached();
    const a = w.inner.attempts.get(t.attemptId)!;
    a.status = "abandoned";
    w.inner.db.putAttempt(a);
    const h = w.restart();
    vi.setSystemTime(Date.now() + LEASE + 1000);
    await h.alarm();
    await w.settle();
    expect(w.inner.db.queue()).toEqual([]);
    expect(w.inner.db.getMeta("landing")).toBeUndefined();
    expect(w.mainCommits).toHaveLength(0);
  });
});

describe("a merge that never finishes", () => {
  it("goes to a person after four starts, and the person can still land it", async () => {
    const w = new CrashWorld();
    await w.start();
    const t = await w.submitTask("alpha", { stop: "before-tests" });
    await w.reached();
    // Starts 2, 3 and 4: each new object waits for the lease, starts the merge, and stops again.
    for (let start = 2; start <= 4; start++) {
      const h = w.restart();
      vi.setSystemTime(Date.now() + LEASE + 1000);
      w.armed = "before-tests";
      void h.alarm();
      await w.reached();
      expect(w.inner.db.getMeta<{ tries: number }>("landing")?.tries).toBe(start);
    }
    // The fifth start does not happen: a person decides.
    const h = w.restart();
    vi.setSystemTime(Date.now() + LEASE + 1000);
    await h.alarm();
    await w.settle();
    expect(w.status(t.attemptId)).toBe("ready");
    expect(w.inner.intents.get(t.intentId)?.status).toBe("judging");
    expect(w.inner.db.queue()).toEqual([]);
    expect(w.inner.db.getMeta("landing")).toBeUndefined();
    expect(w.inner.stats.escalations).toBe(1);
    expect(w.inner.logs.map((l) => l.message)).toContain('The merge of the work of ' + (await h.state()).agents[0].callsign + ' did not finish after 4 tries. A person must decide on "Add alpha".');
    expect(w.mainCommits).toHaveLength(0);

    // The person picks it. It lands once.
    const picked = await h.land(t.attemptId, "Robin picks this work copy.");
    expect(picked.status).toBe("landed");
    expect(await w.mergesOf(t.attemptId)).toHaveLength(1);
  });
});

describe("a merge that fails with an error", () => {
  it("keeps the old behaviour: the work copy is ready again and the log says to try again", async () => {
    const w = new CrashWorld();
    await w.start();
    const t = await w.submitTask("alpha", { stop: "queued" });
    // The commit fails with an error that is not a conflict.
    const real = w.repo.commit.bind(w.repo);
    (w.repo as { commit: typeof w.repo.commit }).commit = async (input) => {
      if (input.repo === w.mainRepo && input.parent !== "") throw new Error("The repository is not available.");
      return real(input);
    };
    w.restart();
    await w.settle();
    expect(w.status(t.attemptId)).toBe("ready");
    expect(w.inner.db.queue()).toEqual([]);
    expect(w.inner.db.getMeta("landing")).toBeUndefined();
    expect(w.inner.logs.some((l) => /stopped: Error: The repository is not available.*Try again\./.test(l.message))).toBe(true);
  });
});
