/** The decisions queue says so when no test ran: nothing is verified, and a person must decide to merge. */
import { describe, expect, it } from "vitest";
import type { Attempt, CheckRun, Intent, ProjectState } from "../../src/core/types";
import { selectJudgmentQueue } from "../../web/src/state/selectors";

const run = (over: Partial<CheckRun>): CheckRun => ({ id: "c1", subject: "s", scope: "attempt", ok: true, passed: 0, failed: 0, cases: [], ms: 1, at: 1, ...over });

function state(attempts: Pick<Attempt, "id" | "checks" | "composedChecks">[]): ProjectState {
  const intent = { id: "i1", title: "Add a greeting", status: "judging", updatedAt: 5 } as Intent;
  const full = attempts.map((a) => ({ intentId: "i1", agentId: "g1", status: "ready", ...a }) as Attempt);
  return { intents: [intent], attempts: full, checks: [], agents: [] } as unknown as ProjectState;
}

describe("the decisions queue when no test ran", () => {
  it("says that no test ran and that a person must decide", () => {
    const [item] = selectJudgmentQueue(state([{ id: "a1", checks: run({ ran: 0 }) }]));
    expect(item.kind).toBe("pick");
    // The decision row adds the full stop.
    expect(item.detail).toBe("No test ran. A person must decide to merge");
  });

  it("keeps the choice of one work copy when several ran no test", () => {
    const [item] = selectJudgmentQueue(state([{ id: "a1", checks: run({ ran: 0 }) }, { id: "a2", checks: run({ ran: 0 }) }]));
    expect(item.detail).toBe("No test ran. A person must decide to merge. Choose 1 of 2 work copies");
  });

  it("uses the usual text when a test ran", () => {
    const [one] = selectJudgmentQueue(state([{ id: "a1", checks: run({ passed: 3, ran: 3 }) }]));
    expect(one.detail).toBe("Choose 1 of 1 ready work copies");
    // One work copy with a test and one without: the usual text.
    const [mixed] = selectJudgmentQueue(state([{ id: "a1", checks: run({ ran: 0 }) }, { id: "a2", checks: run({ passed: 2, ran: 2 }) }]));
    expect(mixed.detail).toBe("Choose 1 of 2 ready work copies");
  });

  it("looks at the tests of main plus the work copy when it has them", () => {
    const [item] = selectJudgmentQueue(state([{ id: "a1", checks: run({ ran: 0 }), composedChecks: run({ passed: 4, ran: 4, scope: "composed" }) }]));
    expect(item.detail).toBe("Choose 1 of 1 ready work copies");
  });
});
