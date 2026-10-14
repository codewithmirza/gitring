/**
 * The pure parts of the history answers: line blame as runs, the line maps of a diff, the why-record of
 * a merge, and the plain words of each answer.
 */
import { describe, expect, it } from "vitest";
import {
  applyHunks,
  compareWords,
  historyWords,
  newLineOf,
  oldLineOf,
  oneRun,
  parseWhyRecord,
  runsLength,
  searchWords,
  stepAt,
  stepWords,
  versionWords,
  whyFileWords,
  whyLineWords,
  type BlameRuns,
  type HistoryStep,
} from "../../src/core/history";
import { diffHunks } from "../../src/core/text/diff";
import { landingNote } from "../../src/core/logbook";
import { mulberry32 } from "../harbor/world";
import { steViolations } from "../coord/ste";
import type * as T from "../../src/core/types";

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");

/** The blame of every line, one step per line (for easy comparison). */
function expand(runs: BlameRuns): number[] {
  return runs.flatMap(([s, c]) => Array<number>(c).fill(s));
}

describe("blame runs", () => {
  it("finds the step of a line, and nothing outside the file", () => {
    const runs: BlameRuns = [[1, 3], [4, 2], [2, 1]];
    expect(runsLength(runs)).toBe(6);
    expect([1, 2, 3, 4, 5, 6].map((n) => stepAt(runs, n))).toEqual([1, 1, 1, 4, 4, 2]);
    expect(stepAt(runs, 0)).toBeUndefined();
    expect(stepAt(runs, 7)).toBeUndefined();
    expect(stepAt(runs, 1.5)).toBeUndefined();
    expect(oneRun(3, 0)).toEqual([]);
  });

  it("keeps the old lines and gives the changed lines to the new step", () => {
    const a = lines("a", "b", "c", "d");
    // Replace b, insert x after d, delete nothing else.
    const b = lines("a", "B", "c", "d", "x");
    expect(expand(applyHunks(oneRun(1, 4), diffHunks(a, b), 2))).toEqual([1, 2, 1, 1, 2]);
    // Insert at the top, delete c.
    const c = lines("top", "a", "B", "d", "x");
    expect(expand(applyHunks([[1, 1], [2, 1], [1, 2], [2, 1]], diffHunks(b, c), 3))).toEqual([3, 1, 2, 1, 2]);
    // Delete everything.
    expect(applyHunks([[1, 4]], diffHunks(a, ""), 5)).toEqual([]);
    // Same text: the same blame, runs joined.
    expect(applyHunks([[1, 2], [1, 2]], diffHunks(a, a), 9)).toEqual([[1, 4]]);
  });

  it("matches a line-by-line trace for random edits", () => {
    const rng = mulberry32(42);
    let text: string[] = Array.from({ length: 12 }, (_, i) => `s1:${i}`);
    let runs: BlameRuns = oneRun(1, text.length);
    let id = 0;
    for (let step = 2; step < 80; step++) {
      const next = [...text];
      const ops = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < ops; k++) {
        const at = Math.floor(rng() * (next.length + 1));
        const del = Math.floor(rng() * Math.min(3, next.length - at + 1));
        const add = Math.floor(rng() * 3);
        next.splice(at, del, ...Array.from({ length: add }, () => `s${step}:${id++}`));
      }
      runs = applyHunks(runs, diffHunks(text.map((l) => `${l}\n`).join(""), next.map((l) => `${l}\n`).join("")), step);
      text = next;
      // Every line names the step that wrote it: the blame must say the same.
      expect(expand(runs), `step ${step}`).toEqual(text.map((l) => Number(l.slice(1, l.indexOf(":")))));
    }
  });
});

describe("line maps of a diff", () => {
  const old = lines("a", "b", "c", "d", "e");
  const now = lines("a", "x", "y", "c", "e", "f");

  it("maps each new line to its old line, or says that the change wrote it", () => {
    const h = diffHunks(old, now);
    expect([1, 2, 3, 4, 5, 6].map((n) => oldLineOf(h, n))).toEqual([
      { added: false, line: 1 },
      { added: true },
      { added: true },
      { added: false, line: 3 },
      { added: false, line: 5 },
      { added: true },
    ]);
  });

  it("maps each old line to its new line, or says that the change removed it", () => {
    const h = diffHunks(old, now);
    expect([1, 2, 3, 4, 5].map((n) => newLineOf(h, n))).toEqual([
      { removed: false, line: 1 },
      { removed: true },
      { removed: false, line: 4 },
      { removed: true },
      { removed: false, line: 5 },
    ]);
  });

  it("handles an insertion at the top and a deletion at the end", () => {
    const h = diffHunks(lines("a", "b", "c"), lines("t", "a", "b"));
    expect(oldLineOf(h, 1)).toEqual({ added: true });
    expect(oldLineOf(h, 3)).toEqual({ added: false, line: 2 });
    expect(newLineOf(h, 3)).toEqual({ removed: true });
    expect(newLineOf(h, 1)).toEqual({ removed: false, line: 2 });
  });
});

describe("the why-record", () => {
  const intent = { id: "in_1", title: "Add a discount", goal: "Prices get 10% off.", constraints: ["Keep the API."], version: 1, amendments: [] } as unknown as T.Intent;
  const attempt = {
    id: "a_1",
    baseSha: "b".repeat(40),
    baseTree: "c".repeat(40),
    lineage: { generation: 1 },
    course: { plan: ["Change priceOf"], files: ["src/price.js"], symbols: [], approach: "One function.", declaredAt: 1 },
    footprint: { files: {}, symbols: { defined: [], modified: [], removed: [], signatureChanged: [] } },
    stats: {},
    summary: "Discount added.",
  } as unknown as T.Attempt;
  const agent = { id: "ag_1", callsign: "Robin-4", kind: "mcp", model: "claude-test" } as unknown as T.AgentInfo;

  it("reads the note of a merge: task, plan, change requests, checks, tests and the decision", () => {
    const note = landingNote({
      intent,
      attempt,
      agent,
      method: "merge",
      corrections: [{ id: "cr_1", kind: "region", rule: "R2", message: "Keep out of lines 3-5.", status: "acknowledged", ackNote: "Moved it.", constraints: {} } as unknown as T.Correction],
      courseChecks: [{ id: "k1", trigger: "declare", verdict: "clear", source: "rules", confidence: 1, latencyMs: 2, assessments: [] } as unknown as T.CourseCheck],
      checks: { id: "ck", subject: "t", scope: "composed", ok: false, passed: 2, failed: 1, cases: [{ file: "tests/a.test.js", name: "rounds", ok: false, error: "no" }], ms: 1, at: 1 } as unknown as T.CheckRun,
      decision: { id: "dc_1", kind: "pick", intentId: "in_1", attemptIds: ["a_1"], by: { kind: "human", id: "u_1", name: "Robin" }, rationale: "Looks right.", at: 1 } as T.Decision,
    });
    const r = parseWhyRecord(note)!;
    expect(r.task).toEqual({ id: "in_1", title: "Add a discount", goal: "Prices get 10% off.", constraints: ["Keep the API."] });
    expect(r.plan).toEqual({ steps: ["Change priceOf"], files: ["src/price.js"], approach: "One function." });
    expect(r.summary).toBe("Discount added.");
    expect(r.agent).toEqual({ callsign: "Robin-4", model: "claude-test" });
    expect(r.method).toBe("merge");
    expect(r.changeRequests).toEqual([{ id: "cr_1", kind: "region", message: "Keep out of lines 3-5.", status: "acknowledged", ackNote: "Moved it." }]);
    expect(r.conflictChecks).toEqual(["clear"]);
    expect(r.tests).toEqual({ passed: 2, failed: 1, failures: ["tests/a.test.js: rounds"] });
    expect(r.decision).toEqual({ kind: "pick", by: "Robin", rationale: "Looks right." });
  });

  it("gives null for no note or a note that is not JSON, and survives missing parts", () => {
    expect(parseWhyRecord(null)).toBeNull();
    expect(parseWhyRecord("not json")).toBeNull();
    const r = parseWhyRecord("{}")!;
    expect(r.task.title).toBe("");
    expect(r.changeRequests).toEqual([]);
    expect(r.decision).toBeNull();
    expect(r.method).toBe("merge");
  });
});

describe("words", () => {
  const merge: HistoryStep = {
    sha: "a".repeat(40),
    parent: "b".repeat(40),
    kind: "merge",
    at: Date.UTC(2026, 9, 13),
    subject: "Add a discount",
    files: 2,
    merge: { landingId: "ld_1", intentId: "in_1", attemptId: "a_1", callsign: "Robin-4", method: "merge", tests: { passed: 3, failed: 0 } },
  };
  const outside: HistoryStep = { sha: "c".repeat(40), parent: "a".repeat(40), kind: "outside", at: Date.UTC(2026, 9, 14), subject: "Task README.md", files: 1 };
  const root: HistoryStep = { sha: "d".repeat(40), parent: "", kind: "root", at: Date.UTC(2026, 9, 1), subject: "Start shop", files: 0 };

  it("names the version", () => {
    expect(versionWords("main")).toBe("main");
    expect(versionWords("abcdef1234")).toBe("commit abcdef1");
    expect(versionWords("a_x7k2", "Robin-4")).toBe("the work copy of Robin-4");
  });

  it("says who wrote a line, in plain words", () => {
    const texts = [
      whyLineWords({ path: "src/price.js", line: 4, version: "main", step: merge }),
      whyLineWords({ path: "src/price.js", line: 4, version: "main", step: outside }),
      whyLineWords({ path: "src/price.js", line: 4, version: "main", step: root }),
      whyLineWords({ path: "src/price.js", line: 4, version: "main" }),
      whyLineWords({ path: "src/price.js", line: 4, version: "the work copy of Robin-4", work: { attemptId: "a_1", callsign: "Robin-4", title: "Add a discount", status: "underway", approach: "", plan: [] } }),
      whyFileWords("src/price.js", "main", [merge, outside, root], false),
      whyFileWords("src/price.js", "main", [root], false),
      historyWords("src/price.js", [merge, root], true),
      historyWords(undefined, [], false),
      historyWords("src/x.js", [], false),
      searchWords("priceOf", 3, 2, false),
      searchWords("priceOf", 1, 1, false, "src"),
      searchWords("priceOf", 0, 0, false),
      compareWords("main", "commit abcdef1", 2, 10, 4, false),
      compareWords("main", "main", 0, 0, 0, false),
      stepWords(merge),
    ];
    expect(texts[0]).toBe('Line 4 of src/price.js on main. It came from the task "Add a discount". Robin-4 merged it on 2026-10-13 (commit aaaaaaa).');
    expect(texts[2]).toContain("before gitring recorded history");
    expect(texts[4]).toContain("It is not merged yet.");
    expect(texts[5]).toBe('2 changes of main touched src/price.js. The last is the task "Add a discount". Give a line to see the change that wrote it.');
    expect(texts[6]).toBe("No change of main touched src/price.js after the start of the history. Give a line to see where it came from.");
    for (const t of texts) expect(steViolations(t), t).toEqual([]);
  });
});
