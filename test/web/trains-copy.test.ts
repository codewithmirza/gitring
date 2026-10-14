import { describe, expect, it } from "vitest";
import { parseMaxTrain, methodSentence, testsSentence, testsWhenHelp, trainText, TESTS_WHEN_OPTIONS } from "../../web/src/views/trains-copy";
import { steViolations } from "../coord/ste";

describe("trains copy", () => {
  it("names the two test modes", () => {
    expect(TESTS_WHEN_OPTIONS.map((o) => o.label)).toEqual(["Before each merge", "After merge, with automatic revert"]);
    for (const w of ["before", "after"] as const) expect(steViolations(testsWhenHelp(w))).toEqual([]);
  });

  it("reads the size of a train", () => {
    expect(parseMaxTrain("8")).toBe(8);
    expect(parseMaxTrain("1")).toBe(1);
    expect(parseMaxTrain("16")).toBe(16);
    for (const bad of ["0", "17", "2.5", "", "x"]) expect(parseMaxTrain(bad)).toBeUndefined();
  });

  it("says the train, the revert and the test mode of a merge", () => {
    expect(trainText({ train: { id: "tr_1", place: 2, size: 5 } })).toBe("Train 2 of 5");
    expect(trainText({})).toBeUndefined();
    expect(methodSentence("revert")).toContain("reverted");
    const checks = { passed: 3, failed: 0, ok: true } as never;
    expect(testsSentence({ method: "merge", testsWhen: "after", checks }, 3)).toContain("gitring tests main after the merge");
    expect(testsSentence({ method: "merge", testsWhen: "before", checks }, 3)).toBe("3/3 tests pass on main.");
    expect(testsSentence({ method: "revert", checks }, 3)).toContain("after the revert");
  });
});
