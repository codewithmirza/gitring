import { describe, expect, it } from "vitest";
import type { ProjectState } from "../../src/core/types";
import { reconcile, reduce, sameJson, shareList, store } from "../../web/src/state/store";

function base(): ProjectState {
  return {
    project: { id: "p", name: "Shop", repo: { backend: "artifacts", namespace: "n", name: "r", defaultBranch: "main" }, mainSha: "s1", mainTree: "t1", createdAt: 1, settings: { autoLand: true } as ProjectState["project"]["settings"] },
    intents: [{ id: "i1", title: "A", goal: "g", constraints: [], checks: [], priority: "normal", status: "open", version: 1, amendments: [], createdBy: { kind: "human", id: "u", name: "R" }, createdAt: 1, updatedAt: 1, source: { kind: "ui" } }],
    attempts: [],
    agents: [{ id: "g1", callsign: "PETREL-2", kind: "builtin", color: 0, status: "idle", lastSeen: 5 }],
    corrections: [],
    checks: [],
    landings: [],
    decisions: [],
    logs: [{ id: "l1", at: 1, kind: "system", message: "hi" }],
    radar: [],
    files: [{ path: "a.js", size: 10, lang: "js" }],
    imports: [],
    stats: { courseChecks: 0, clear: 0, corrections: 0, correctionsAcknowledged: 0, escalations: 0, landings: 0, landedByMethod: { "fast-forward": 0, merge: 0, rederive: 0 }, rederives: 0, medianCheckLatencyMs: 0 },
  };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("structural sharing", () => {
  it("compares JSON data deeply", () => {
    expect(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson(null, {})).toBe(false);
  });

  it("keeps equal items and the old array when nothing changed", () => {
    const a = [{ id: "1", v: 1 }, { id: "2", v: 2 }];
    expect(shareList(a, clone(a), (x) => x.id)).toBe(a);
    const b = clone(a);
    b[1].v = 3;
    const s = shareList(a, b, (x) => x.id);
    expect(s).not.toBe(a);
    expect(s[0]).toBe(a[0]);
    expect(s[1]).toBe(b[1]);
  });

  it("gives back the old state for an equal snapshot (a resync after a reconnect)", () => {
    const st = base();
    expect(reconcile(st, clone(st))).toBe(st);
  });

  it("shares every slice that did not change", () => {
    const st = base();
    const next = clone(st);
    next.agents[0].lastSeen = 9;
    const r = reconcile(st, next);
    expect(r).not.toBe(st);
    expect(r.intents).toBe(st.intents);
    expect(r.files).toBe(st.files);
    expect(r.project).toBe(st.project);
    expect(r.agents).not.toBe(st.agents);
  });

  it("an event that changes nothing returns the same state", () => {
    const st = base();
    expect(reduce(st, { type: "agent", agent: clone(st.agents[0]) })).toBe(st);
    expect(reduce(st, { type: "stats", stats: clone(st.stats) })).toBe(st);
    expect(reduce(st, { type: "main", sha: "s1", tree: "t1", files: clone(st.files), imports: [] })).toBe(st);
    const moved = reduce(st, { type: "main", sha: "s2", tree: "t2", files: clone(st.files), imports: [] });
    expect(moved.project.mainSha).toBe("s2");
    expect(moved.files).toBe(st.files);
  });

  it("the store does not wake subscribers for a snapshot that brings nothing new", async () => {
    const st = base();
    store.dispatch({ type: "snapshot", state: st });
    await Promise.resolve();
    let wakes = 0;
    const off = store.subscribe(() => wakes++);
    store.dispatch({ type: "snapshot", state: clone(st) });
    store.dispatch({ type: "agent", agent: clone(st.agents[0]) });
    await Promise.resolve();
    expect(wakes).toBe(0);
    store.dispatch({ type: "log", log: { id: "l2", at: 2, kind: "system", message: "x" } });
    await Promise.resolve();
    expect(wakes).toBe(1);
    expect(store.get().state!.intents).toBe(st.intents);
    off();
  });
});
