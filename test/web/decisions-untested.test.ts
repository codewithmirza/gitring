/** The decisions queue says so when no test ran: nothing is verified, and a person must decide to merge. */
import { describe, expect, it } from "vitest";
import type { Approval, Attempt, CheckRun, Intent, ProjectState } from "../../src/core/types";
import { selectJudgmentQueue, type OtherJudgmentItem } from "../../web/src/state/selectors";

const run = (over: Partial<CheckRun>): CheckRun => ({ id: "c1", subject: "s", scope: "attempt", ok: true, passed: 0, failed: 0, cases: [], ms: 1, at: 1, ...over });

const stats = { filesChanged: 2, additions: 10, deletions: 3, steps: 4 };

function state(attempts: Pick<Attempt, "id" | "checks" | "composedChecks" | "approval">[]): ProjectState {
  const intent = { id: "i1", title: "Add a greeting", status: "judging", updatedAt: 5 } as Intent;
  const full = attempts.map((a) => ({ intentId: "i1", agentId: "g1", status: "ready", stats, ...a }) as Attempt);
  return { intents: [intent], attempts: full, checks: [], agents: [] } as unknown as ProjectState;
}

/** Work that is ready and has no question: the Worker did not ask one, so the person opens the task. */
function pick(attempts: Parameters<typeof state>[0]): OtherJudgmentItem {
  const [item] = selectJudgmentQueue(state(attempts));
  expect(item.kind).toBe("pick");
  return item as OtherJudgmentItem;
}

describe("the decisions queue for work without a question, when no test ran", () => {
  it("says that no test ran and that a person must decide", () => {
    // The decision row adds the full stop.
    expect(pick([{ id: "a1", checks: run({ ran: 0 }) }]).detail).toBe("No test ran. A person must decide to merge");
  });

  it("says how many work copies are ready when several ran no test", () => {
    expect(pick([{ id: "a1", checks: run({ ran: 0 }) }, { id: "a2", checks: run({ ran: 0 }) }]).detail).toBe("No test ran. A person must decide to merge. 2 work copies are ready");
  });

  it("uses the usual text when a test ran", () => {
    expect(pick([{ id: "a1", checks: run({ passed: 3, ran: 3 }) }]).detail).toBe("The work is ready. A person must merge it");
    // One work copy with a test and one without: the usual text.
    expect(pick([{ id: "a1", checks: run({ ran: 0 }) }, { id: "a2", checks: run({ passed: 2, ran: 2 }) }]).detail).toBe("2 work copies are ready. A person must merge one");
  });

  it("looks at the tests of main plus the work copy when it has them", () => {
    expect(pick([{ id: "a1", checks: run({ ran: 0 }), composedChecks: run({ passed: 4, ran: 4, scope: "composed" }) }]).detail).toBe("The work is ready. A person must merge it");
  });
});

describe("the decisions queue for a question that asks for a yes, when no test ran", () => {
  const asked = (over: Partial<Approval> = {}): Approval => ({
    id: "ap1",
    status: "waiting",
    reason: "no-test-ran",
    why: ["No test ran. The work is not verified."],
    digest: "d1",
    askedAt: 7,
    ...over,
  });

  it("shows the facts of the work and the first reason, not a choice", () => {
    const [item] = selectJudgmentQueue(state([{ id: "a1", checks: run({ ran: 0 }), approval: asked() }]), { id: "u1", role: "owner" });
    expect(item.kind).toBe("approval");
    if (item.kind !== "approval") return;
    expect(item.line).toBe("2 files, +10 -3. No test ran.");
    expect(item.why[0]).toBe("No test ran. The work is not verified.");
    expect(item.reason).toBe("no-test-ran");
  });

  it("makes no second item from the task that is waiting", () => {
    const q = selectJudgmentQueue(state([{ id: "a1", checks: run({ ran: 0 }), approval: asked() }]), { id: "u1", role: "owner" });
    expect(q.map((x) => x.kind)).toEqual(["approval"]);
  });
});
