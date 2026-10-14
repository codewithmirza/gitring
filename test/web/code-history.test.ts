/**
 * "Why line N?" and "History" in the code view: the addresses of the REST twins and the words of the
 * panels (plain words, ASD-STE100).
 */
import { describe, expect, it } from "vitest";
import { changeText, historyUrl, requestStatusText, shortGoal, stepMeta, testsText, whyUrl, type HistoryStep } from "../../web/src/views/code/history";
import { steViolations } from "../coord/ste";

const merge: HistoryStep = {
  sha: "a".repeat(40),
  parent: "b".repeat(40),
  kind: "merge",
  at: 1,
  subject: "Add a discount",
  files: 2,
  merge: { landingId: "ld_1", intentId: "in_1", attemptId: "a_1", callsign: "Robin-4", method: "merge", tests: { passed: 3, failed: 1 } },
  change: { status: "M", additions: 4, deletions: 1 },
};

describe("addresses", () => {
  it("asks about a line of a version, and the changes of a file", () => {
    expect(whyUrl("shop", "main", "src/a b.js", 12, "abc")).toBe("/api/projects/shop/why?path=src%2Fa+b.js&ref=main&line=12&v=abc");
    expect(whyUrl("shop", "a_1", "src/a.js", null)).toBe("/api/projects/shop/why?path=src%2Fa.js&ref=a_1");
    expect(historyUrl("shop", "src", 30, "v1")).toBe("/api/projects/shop/history?path=src&limit=30&v=v1");
  });
});

describe("words", () => {
  it("says who made a change, what it did to the file, and the tests", () => {
    expect(stepMeta(merge)).toBe("Work of Robin-4 · 3-way merge · commit aaaaaaa");
    expect(stepMeta({ ...merge, kind: "outside", merge: undefined })).toBe("Main moved without a merge · commit aaaaaaa");
    expect(stepMeta({ ...merge, kind: "root", merge: undefined })).toBe("The start of the history · commit aaaaaaa");
    expect(changeText(merge)).toBe("+4 −1");
    expect(changeText({ ...merge, change: { status: "A", additions: 9, deletions: 0 } })).toBe("added, +9");
    expect(changeText({ ...merge, change: { status: "D", additions: 0, deletions: 9 } })).toBe("deleted");
    expect(changeText({ ...merge, change: { status: "M", additions: 2, deletions: 2, paths: 3 } })).toBe("+2 −2 in 3 files");
    expect(changeText({ ...merge, kind: "root", change: undefined })).toBe("on main at the start");
    expect(testsText({ passed: 3, failed: 1 })).toBe("3 of 4 tests pass");
    expect(testsText({ passed: 0, failed: 0 })).toBe("No test ran");
  });

  it("names the state of each change request, closed requests too", () => {
    const words = ["acknowledged", "delivered", "pending", "superseded", "closed"].map(requestStatusText);
    expect(words).toEqual(["The agent applied it", "Sent to the agent", "Not sent", "Replaced by a newer request", "Closed at merge"]);
    for (const w of words) expect(steViolations(`${w}.`)).toEqual([]);
  });

  it("keeps the first paragraph of a goal, short", () => {
    expect(shortGoal("# Discount\nPrices get 10% off.\n\nMore text.")).toBe("Discount\nPrices get 10% off.");
    expect(shortGoal("x".repeat(300))).toHaveLength(220);
  });
});
