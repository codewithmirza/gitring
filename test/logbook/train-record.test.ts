import { describe, expect, it } from "vitest";
import { landingMessage, landingNote, parseTrailers, revertMessage, revertNote } from "../../src/core/logbook";
import type { CheckRun } from "../../src/core/types";
import { agents, currencyVessel, intents, T0 } from "../coord/fixtures";

const checks: CheckRun = { id: "chk_1", subject: "c".repeat(40), scope: "composed", ok: true, passed: 7, failed: 0, cases: [{ file: "tests/a.test.js", name: "works", ok: true, ms: 1 }], ms: 41, at: T0 };
const train = { id: "tr_9", place: 2, size: 3, attemptIds: ["att_a", "att_b", "att_c"] };

describe("trains and reverts in the why-record", () => {
  it("puts the train and the test mode into the message and the note", () => {
    const args = { intent: intents.currency, attempt: currencyVessel().attempt, agent: agents.heron, method: "merge" as const, corrections: [], checks, train, testsAfter: true };
    const msg = landingMessage(args);
    expect(msg).toContain("(train 2 of 3)");
    expect(msg).toContain("Gitring-Train: tr_9 2/3");
    expect(msg).toContain("Gitring-Tests: after");
    expect(parseTrailers(msg)["Gitring-Train"]).toBe("tr_9 2/3");
    const note = JSON.parse(landingNote({ ...args, courseChecks: [] }));
    expect(note.train).toMatchObject({ id: "tr_9", place: 2, size: 3 });
    expect(note.checks.when).toBe("after");
    const alone = JSON.parse(landingNote({ ...args, train: undefined, testsAfter: false, courseChecks: [] }));
    expect(alone.train).toBeUndefined();
    expect(alone.checks.when).toBeUndefined();
  });

  it("writes the revert as its own record", () => {
    const bad = { ...checks, ok: false, failed: 1, passed: 6, cases: [{ file: "tests/x.test.js", name: "breaks", ok: false, ms: 1, error: "boom" }] };
    const base = { intent: intents.currency, attempt: currencyVessel().attempt, agent: agents.heron, mergeSha: "a".repeat(40), checks: bad };
    const msg = revertMessage({ ...base, failed: ["tests/x.test.js: breaks"] });
    expect(msg).toContain("Gitring-Method: revert");
    expect(msg).toContain(`Gitring-Revert: ${"a".repeat(40)}`);
    expect(msg).toContain("tests failed on main");
    const note = JSON.parse(revertNote({ ...base, landingId: "ld_1", approvedBy: "Robin" }));
    expect(note.method).toBe("revert");
    expect(note.revert).toMatchObject({ reason: "reverted: tests failed on main", of: { landing: "ld_1" }, approvedBy: "Robin" });
    expect(note.checks.cases).toHaveLength(1);
  });
});
