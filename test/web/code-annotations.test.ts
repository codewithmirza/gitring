import { describe, expect, it } from "vitest";
import type { AgentInfo, Attempt, Correction, Intent, Landing, ProjectState } from "../../src/core/types";
import { annoList, folderMarks, headChanges, lanesFor, marksByLine, selectLastMerges, selectMarks, selectWorkCopies } from "../../web/src/views/code/annotations";
import { resolveRef } from "../../web/src/views/code/data";

const NOW = 1_760_000_000_000;
const MAIN = "a".repeat(40);

function attempt(id: string, intentId: string, agentId: string, status: Attempt["status"], files: Attempt["footprint"]["files"], planned: string[], extra: Partial<Attempt> = {}): Attempt {
  return {
    id,
    intentId,
    agentId,
    fork: { repo: `f-${id}` },
    mode: "api",
    baseSha: MAIN,
    baseTree: "t",
    status,
    course: { plan: ["Do the thing"], files: planned, symbols: [], approach: "Change the cart.", declaredAt: NOW },
    footprint: { files, symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] }, computedAt: NOW },
    corrections: [],
    lineage: { generation: 1 },
    stats: { filesChanged: Object.keys(files).length, additions: 3, deletions: 1, steps: 2 },
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

const intent = (id: string, title: string): Intent => ({
  id,
  title,
  goal: title,
  constraints: [],
  checks: [],
  priority: "normal",
  status: "underway",
  version: 1,
  amendments: [],
  createdBy: { kind: "human", id: "u", name: "Robin" },
  createdAt: NOW,
  updatedAt: NOW,
  source: { kind: "ui" },
});

const agent = (id: string, callsign: string, color: number): AgentInfo => ({ id, callsign, kind: "builtin", color, status: "underway", lastSeen: NOW });

function state(): ProjectState {
  const attempts = [
    attempt("at_1", "i_1", "g1", "underway", { "src/cart.js": { status: "M", hunks: [[10, 18]], additions: 4, deletions: 2 } }, ["src/cart.js", "src/ui.js"]),
    attempt("at_2", "i_2", "g2", "ready", { "src/cart.js": { status: "M", hunks: [[40, 44]], additions: 2, deletions: 1 }, "src/new.js": { status: "A", hunks: [], additions: 9, deletions: 0 } }, ["src/cart.js"], { baseSha: "b".repeat(40) }),
    attempt("at_3", "i_3", "g3", "landed", { "README.md": { status: "M", hunks: [[1, 2]], additions: 1, deletions: 1 } }, ["README.md"], { landedAt: NOW }),
    attempt("at_4", "i_1", "g3", "stale", { "src/old.js": { status: "M", hunks: [[1, 1]], additions: 1, deletions: 0 } }, []),
    attempt("at_5", "i_1", "g3", "rederiving", {}, ["src/old.js"], { lineage: { generation: 2, rederivedFrom: "at_4" } }),
  ];
  const corrections: Correction[] = [
    {
      id: "c1",
      attemptId: "at_2",
      standOnAttemptId: "at_1",
      kind: "region",
      rule: "R4-first-declared-stands-on",
      message: "Keep out of src/cart.js lines 10–18.",
      constraints: { avoidRegions: [{ path: "src/cart.js", lines: [10, 18] }] },
      checkId: "k1",
      status: "delivered",
      createdAt: NOW,
    },
    { id: "c2", attemptId: "at_3", kind: "region", rule: "human", message: "old", constraints: { avoidRegions: [{ path: "README.md", lines: [1, 1] }] }, checkId: "k2", status: "delivered", createdAt: NOW },
  ];
  const landings: Landing[] = [
    { id: "l1", attemptId: "at_3", intentId: "i_3", agentId: "g3", method: "fast-forward", mainBefore: "c".repeat(40), mainAfter: MAIN, checks: { id: "r", subject: "s", scope: "composed", ok: true, passed: 3, failed: 0, cases: [], ms: 1, at: NOW }, correctionsApplied: 0, at: NOW, message: "m" },
  ];
  return {
    project: { id: "p", name: "Shop", repo: { backend: "artifacts", namespace: "n", name: "r", defaultBranch: "main" }, mainSha: MAIN, mainTree: "t", createdAt: NOW, settings: {} as ProjectState["project"]["settings"] },
    intents: [intent("i_1", "Add a cart total"), intent("i_2", "Add a coupon"), intent("i_3", "Fix the readme")],
    attempts,
    agents: [agent("g1", "PETREL-2", 0), agent("g2", "KESTREL-7", 3), agent("g3", "WREN-4", 6)],
    corrections,
    checks: [],
    landings,
    decisions: [],
    logs: [],
    radar: [],
    files: [],
    imports: [],
    stats: { courseChecks: 0, clear: 0, corrections: 0, correctionsAcknowledged: 0, escalations: 0, landings: 1, landedByMethod: { "fast-forward": 1, merge: 0, rederive: 0 }, rederives: 0, medianCheckLatencyMs: 0 },
  };
}

describe("code marks from the live state", () => {
  it("lists active work copies only (no merged ones, no work copy a redo replaced)", () => {
    const wcs = selectWorkCopies(state());
    expect(wcs.map((w) => w.id)).toEqual(["at_1", "at_2", "at_5"]);
    expect(wcs[0].callsign).toBe("PETREL-2");
    expect(wcs[0].intentTitle).toBe("Add a cart total");
  });

  it("marks changed and planned files, and change requests of active work only", () => {
    const st = state();
    const marks = selectMarks(st);
    const cart = marks.get("src/cart.js")!;
    expect(cart.work.map((w) => [w.wc.id, Boolean(w.touch)])).toEqual([
      ["at_1", true],
      ["at_2", true],
    ]);
    expect(cart.keepOut).toHaveLength(1);
    expect(cart.keepOut[0].to?.callsign).toBe("KESTREL-7");
    expect(cart.keepOut[0].from?.callsign).toBe("PETREL-2");
    expect(marks.get("src/ui.js")!.work[0].touch).toBeUndefined();
    // The merged work copy's change request does not show.
    expect(marks.get("README.md")).toBeUndefined();
    // Memoized: the same state gives the same map.
    expect(selectMarks(st)).toBe(marks);
  });

  it("sums marks per folder", () => {
    const f = folderMarks(selectMarks(state())).get("src")!;
    expect(f.work).toBe(3);
    expect(f.keepOut).toBe(1);
  });

  it("builds gutter lanes and line marks", () => {
    const st = state();
    const lanes = lanesFor(selectMarks(st).get("src/cart.js"), MAIN);
    expect(lanes.map((l) => [l.kind, l.ranges, l.approx])).toEqual([
      ["change", [[10, 18]], false],
      ["change", [[40, 44]], true],
      ["keepout", [[10, 18]], false],
    ]);
    const byLine = marksByLine(lanes, 42);
    expect(byLine.get(10)!.map((m) => [m.lane, m.first])).toEqual([
      [0, true],
      [2, true],
    ]);
    expect(byLine.get(18)!.every((m) => m.last)).toBe(true);
    expect(byLine.get(42)!.map((m) => m.last)).toEqual([true]);
    expect(byLine.has(43)).toBe(false);
    expect(annoList(lanes, 42).map((a) => a.range)).toEqual([
      [10, 18],
      [10, 18],
      [40, 42],
    ]);
  });

  it("finds the last merge of a file", () => {
    const last = selectLastMerges(state()).get("README.md")!;
    expect(last.landing.id).toBe("l1");
    expect(last.intentTitle).toBe("Fix the readme");
    expect(last.callsign).toBe("WREN-4");
  });

  it("resolves refs", () => {
    const st = state();
    const wcs = selectWorkCopies(st);
    expect(resolveRef("main", MAIN, st.attempts, wcs).kind).toBe("main");
    expect(resolveRef(MAIN, MAIN, st.attempts, wcs).kind).toBe("main");
    expect(resolveRef("d".repeat(40), MAIN, st.attempts, wcs).kind).toBe("commit");
    expect(resolveRef("at_1", MAIN, st.attempts, wcs).kind).toBe("work");
    expect(resolveRef("at_3", MAIN, st.attempts, wcs).kind).toBe("ended");
    expect(resolveRef("nope", MAIN, st.attempts, wcs).kind).toBe("unknown");
    const main = resolveRef("main", MAIN, st.attempts, wcs);
    expect(main.kind === "main" && main.fileRef).toBe(MAIN);
    const short = resolveRef("main", "abc", st.attempts, wcs);
    expect(short.kind === "main" && short.fileRef).toBe("main");
  });
});

describe("a work copy's own changes", () => {
  it("reads added lines and removal points of a unified diff", () => {
    const diff = ["--- a/x.js", "+++ b/x.js", "@@ -1,5 +1,6 @@", " a", "-b", "+B", "+B2", " c", "-d", " e", "@@ -20,2 +21,3 @@", " t", "+u", " v"].join("\n");
    const h = headChanges(diff);
    expect(h.added).toEqual([
      [2, 3],
      [22, 22],
    ]);
    // "-b" is a change of line 2 (the bar shows it); "-d" after line 4 is a removal.
    expect(h.removedAfter).toEqual([4]);
  });
});
