/** The merges that wait for a yes: the queue that the tray and the decisions list show, and the words for them. */
import { describe, expect, it } from "vitest";
import type { Approval, Attempt, CheckRun, Intent, Landing, Person, ProjectState } from "../../src/core/types";
import { INTENT_GROUPS, selectIntentGroups, selectJudgmentQueue, type ApprovalItem, type Who } from "../../web/src/state/selectors";
import { INTENT_STATUS_TEXT } from "../../web/src/state/format";
import { announceText, answerKind, cannotAnswerText, describeOutcome, phaseOf, tabTitle, waitsFor } from "../../web/src/state/approvals";

const run = (over: Partial<CheckRun> = {}): CheckRun => ({ id: "c1", subject: "s", scope: "attempt", ok: true, passed: 12, failed: 0, cases: [], ms: 1, at: 1, ran: 12, ...over });
const person = (id: string, name = id): Person => ({ id, name });

function asking(id: string, askedAt: number, over: Partial<Approval> = {}): Approval {
  return { id: `ap_${id}`, status: "waiting", reason: "project-asks", why: ["This project asks a person before every merge."], digest: "d", askedAt, ...over };
}

function attempt(id: string, over: Partial<Attempt> = {}): Attempt {
  return {
    id,
    intentId: "i1",
    agentId: "g1",
    status: "ready",
    checks: run(),
    stats: { filesChanged: 3, additions: 20, deletions: 4, steps: 5 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as Attempt;
}

function project(attempts: Attempt[], opts: { approver?: "sender" | "owner"; intents?: Partial<Intent>[] } = {}): ProjectState {
  return {
    project: { id: "shop", settings: { approver: opts.approver ?? "sender" } },
    intents: opts.intents ?? [{ id: "i1", title: "Add a search box", status: "judging", updatedAt: 9 }],
    attempts,
    checks: [],
    agents: [
      { id: "g1", callsign: "PETREL-2", color: 3 },
      { id: "g2", callsign: "KESTREL-7", color: 5 },
    ],
  } as unknown as ProjectState;
}

const owner = { id: "u1", role: "owner" as const };

function approvals(st: ProjectState, who: Who = owner): ApprovalItem[] {
  return selectJudgmentQueue(st, who).filter((x): x is ApprovalItem => x.kind === "approval");
}

describe("the queue of questions", () => {
  it("makes one item for each ready work copy that waits for a yes, oldest first", () => {
    const st = project([
      attempt("a2", { agentId: "g2", approval: asking("a2", 20) }),
      attempt("a1", { approval: asking("a1", 10), sender: person("u1", "Robin") }),
      attempt("a3", { approval: asking("a3", 5, { status: "approved" }) }),
      attempt("a4", { approval: asking("a4", 6, { status: "sent-back" }) }),
      attempt("a5", { approval: asking("a5", 7, { status: "withdrawn", closed: "The agent changed the work." }) }),
      // The Worker withdraws a question when the work is not ready. A stale copy must not show a chip.
      attempt("a6", { status: "underway", approval: asking("a6", 8) }),
    ]);
    const items = approvals(st);
    expect(items.map((x) => x.key)).toEqual(["ap:ap_a1", "ap:ap_a2"]);
    const [first, second] = items;
    expect(first).toMatchObject({
      kind: "approval",
      attemptId: "a1",
      approvalId: "ap_a1",
      intentId: "i1",
      title: "Add a search box",
      callsign: "PETREL-2",
      color: 3,
      line: "3 files, +20 -4. 12 of 12 tests pass.",
      why: ["This project asks a person before every merge."],
      reason: "project-asks",
      askedAt: 10,
      attemptIds: ["a1"],
    });
    expect(second.callsign).toBe("KESTREL-7");
  });

  it("sorts questions together with the other items by the time they began", () => {
    const st = project([attempt("a1", { approval: asking("a1", 50) })], {
      intents: [
        { id: "i1", title: "Add a search box", status: "judging", updatedAt: 9 },
        { id: "i2", title: "Dark mode", status: "judging", updatedAt: 30 },
      ],
    });
    expect(selectJudgmentQueue(st, owner).map((x) => x.key)).toEqual(["stuck:i2", "ap:ap_a1"]);
  });

  it("shows the questions of two work copies that compete, and no choice besides them", () => {
    const st = project([attempt("a1", { approval: asking("a1", 10, { reason: "competing", why: ["2 work copies compete on this task. A person chooses one."] }) }), attempt("a2", { agentId: "g2", approval: asking("a2", 11, { reason: "competing", why: ["2 work copies compete on this task. A person chooses one."] }) })]);
    expect(selectJudgmentQueue(st, owner).map((x) => x.kind)).toEqual(["approval", "approval"]);
  });

  it("leaves the work out once somebody answered", () => {
    const st = project([attempt("a1", { approval: asking("a1", 10, { status: "approved" }) })]);
    // The task is still "judging" while the merge waits in the queue: no second item may come from it.
    expect(selectJudgmentQueue(st, owner)).toEqual([]);
  });
});

describe("who may answer a question", () => {
  const sam = person("u2", "Sam");
  const st = (rule: "sender" | "owner" = "sender") => project([attempt("a1", { sender: sam, approval: asking("a1", 10, { approver: sam }) }), attempt("a2", { agentId: "g2", approval: asking("a2", 11) })], { approver: rule });
  const may = (who: { id?: string | null; role?: "owner" | "member" | "viewer" | null }, rule: "sender" | "owner" = "sender") => approvals(st(rule), who).map((x) => x.mayAnswer);

  it("lets an owner answer every question", () => {
    expect(may({ id: "u1", role: "owner" })).toEqual([true, true]);
    expect(may({ id: "u1", role: "owner" }, "owner")).toEqual([true, true]);
  });

  it("lets a member answer the questions of the work that they sent, and the ones that have no sender", () => {
    expect(may({ id: "u2", role: "member" })).toEqual([true, true]);
    expect(may({ id: "u3", role: "member" })).toEqual([false, true]);
  });

  it("lets only an owner answer when the project says so", () => {
    expect(may({ id: "u2", role: "member" }, "owner")).toEqual([false, false]);
  });

  it("lets nobody answer who views the project or is not signed in", () => {
    expect(may({ id: "u4", role: "viewer" })).toEqual([false, false]);
    expect(may({ id: null, role: "viewer" })).toEqual([false, false]);
    expect(may({})).toEqual([false, false]);
  });
});

describe("the queue keeps its memory", () => {
  it("gives the same list for the same state and person", () => {
    const state = project([attempt("a1", { approval: asking("a1", 10) })]);
    const a = selectJudgmentQueue(state, { id: "u1", role: "owner" });
    // A new object with the same values is the same person.
    expect(selectJudgmentQueue(state, { id: "u1", role: "owner" })).toBe(a);
    expect(selectJudgmentQueue(state, { id: "u1", role: "member" })).not.toBe(a);
  });

  it("makes a new list when an attempt changes", () => {
    const first = project([attempt("a1", { approval: asking("a1", 10) })]);
    const a = selectJudgmentQueue(first, owner);
    const next = { ...first, attempts: [attempt("a1", { approval: asking("a1", 10, { status: "approved" }) })] };
    expect(selectJudgmentQueue(next, owner)).not.toBe(a);
    expect(selectJudgmentQueue(next, owner)).toEqual([]);
  });
});

describe("work without a question, and other items", () => {
  it("keeps the item for old work that is ready and has no question", () => {
    const [item] = selectJudgmentQueue(project([attempt("a1")]), owner);
    expect(item).toMatchObject({ kind: "pick", key: "pick:i1", intentId: "i1", attemptIds: ["a1"] });
  });

  it("makes no choice for work that has a question or an answer", () => {
    expect(selectJudgmentQueue(project([attempt("a1", { approval: asking("a1", 10, { status: "approved" }) })]), owner)).toEqual([]);
    expect(selectJudgmentQueue(project([attempt("a1"), attempt("a2", { approval: asking("a2", 10) })]), owner).map((x) => x.kind)).toEqual(["approval"]);
  });

  it("keeps the item for a task that could not merge", () => {
    const [item] = selectJudgmentQueue(project([attempt("a1", { status: "stale" })]), owner);
    expect(item).toMatchObject({ kind: "escalation", key: "stuck:i1" });
  });

  it("keeps the item for a conflict check that asks for a person", () => {
    const st = { ...project([attempt("a1", { status: "underway" })], { intents: [{ id: "i1", title: "Add a search box", status: "underway", updatedAt: 9 }] }), checks: [{ id: "ck1", attemptId: "a1", verdict: "escalate", at: 15 }] } as unknown as ProjectState;
    const [item] = selectJudgmentQueue(st, owner);
    expect(item).toMatchObject({ kind: "escalation", key: "esc:ck1", title: "Add a search box" });
  });
});

describe("words for a task that needs a yes", () => {
  it("says that the task needs a yes, not a choice", () => {
    expect(INTENT_STATUS_TEXT.judging).toBe("Needs a yes");
    expect(INTENT_GROUPS.find((g) => g.id === "judging")?.label).toBe("Needs a yes");
    const groups = selectIntentGroups(project([]));
    expect(groups.map((g) => g.label)).toEqual(["Needs a yes"]);
  });
});

describe("words for a question", () => {
  it("says who a question waits for", () => {
    expect(waitsFor(person("u2", "Sam"), "sender")).toBe("Sam");
    expect(waitsFor(person("u2", "Sam"), "owner")).toBe("an owner");
    expect(waitsFor(undefined, "owner")).toBe("an owner");
    expect(waitsFor(undefined, "sender")).toBe("a member");
  });

  it("says why a person may not answer, in the words of the Worker", () => {
    const sam = person("u2", "Sam");
    expect(cannotAnswerText({ signedIn: false, role: null }, sam, "sender")).toBe("Sign in to answer.");
    expect(cannotAnswerText({ signedIn: true, role: "viewer" }, sam, "sender")).toMatch(/^You can view this project\./);
    expect(cannotAnswerText({ signedIn: true, role: "member" }, sam, "sender")).toBe("Only Sam (who sent the agent) or an owner of the project can answer this.");
    expect(cannotAnswerText({ signedIn: true, role: "member" }, sam, "owner")).toBe("Only an owner of the project can answer this.");
    expect(cannotAnswerText({ signedIn: true, role: "owner" }, sam, "owner")).toBe("");
    expect(cannotAnswerText({ signedIn: true, role: "member" }, undefined, "sender")).toBe("");
  });

  it("announces new questions with the count and the first title", () => {
    expect(announceText(1, ["Add a search box"])).toBe("1 merge waits for you: Add a search box");
    expect(announceText(3, ["Add a search box", "Dark mode"])).toBe("3 merges wait for you: Add a search box and 1 more");
    expect(announceText(2, [])).toBe("");
  });

  it("puts the count in front of the tab title", () => {
    expect(tabTitle(2, "Tasks · shop · gitring")).toBe("(2) gitring");
    expect(tabTitle(0, "Tasks · shop · gitring")).toBe("Tasks · shop · gitring");
  });
});

describe("what an answer did", () => {
  const landing = { id: "l1", attemptId: "a1", mainAfter: "abcdef1234567890", method: "fast-forward" } as Landing;

  it("tells merged work, waiting work and work that did not merge apart", () => {
    expect(answerKind({ outcome: "approved", landing })).toBe("merged");
    expect(answerKind({ outcome: "approved", waits: { until: 5 } })).toBe("waits");
    expect(answerKind({ outcome: "approved" })).toBe("not-merged");
    expect(answerKind({ outcome: "sent-back" })).toBe("sent-back");
    expect(answerKind({ outcome: "already" })).toBe("already");
    expect(answerKind({ outcome: "withdrawn" })).toBe("old");
    expect(answerKind({ outcome: "refused" })).toBe("refused");
  });
});

describe("where a question stands", () => {
  const landing = { id: "l1", attemptId: "a1", mainAfter: "abcdef1234567890", method: "merge" } as Landing;

  it("finds the phase from the work copy and its question", () => {
    expect(phaseOf(attempt("a1", { approval: asking("a1", 1) }))).toEqual({ kind: "waiting" });
    expect(phaseOf(attempt("a1", { status: "underway", approval: asking("a1", 1) })).kind).toBe("closed");
    expect(phaseOf(attempt("a1", { approval: asking("a1", 1, { status: "approved" }) })).kind).toBe("queued");
    expect(phaseOf(attempt("a1", { status: "landed", approval: asking("a1", 1, { status: "approved" }) }), landing)).toEqual({ kind: "merged", landing });
    expect(phaseOf(attempt("a1", { status: "stale", approval: asking("a1", 1, { status: "approved" }) })).kind).toBe("redo");
    expect(phaseOf(attempt("a1", { status: "underway", approval: asking("a1", 1, { status: "sent-back" }) })).kind).toBe("sent-back");
    expect(phaseOf(attempt("a1", { status: "alternate", approval: asking("a1", 1, { status: "withdrawn", closed: "Another work copy of this task merged first." }) }))).toEqual({
      kind: "closed",
      text: "Another work copy of this task merged first.",
    });
    expect(phaseOf(attempt("a1"))).toEqual({ kind: "none" });
  });

  it("describes each phase in plain words", () => {
    const now = 1_000_000;
    const yes = asking("a1", 1, { status: "approved", answer: { by: person("u1", "Robin"), how: "app", at: now - 120_000 } });
    const me = "u1";
    const merged = describeOutcome({ phase: { kind: "merged", landing }, approval: yes, me, builtin: false, now });
    expect(merged).toMatchObject({ tone: "clear", headline: "Merged into main abcdef1", landingId: "l1" });
    expect(merged?.lines).toEqual(["You said yes 2 min ago.", "Method: 3-way merge."]);
    // Somebody else answered first: the page says so.
    const other = describeOutcome({ phase: { kind: "merged", landing }, approval: yes, me: "u9", builtin: false, now });
    expect(other?.lines.slice(0, 2)).toEqual(["Already answered by Robin.", "Robin said yes 2 min ago."]);
    const waits = describeOutcome({ phase: { kind: "queued" }, approval: yes, me, builtin: false, mergeUntil: now + 600_000, now });
    expect(waits?.headline).toBe("Approved. The merge waits.");
    expect(waits?.lines[1]).toMatch(/^The test budget for this hour is used\. gitring tries again at /);
    expect(describeOutcome({ phase: { kind: "queued" }, approval: yes, me, builtin: false, now })?.headline).toBe("Approved. The merge is in the queue.");
    expect(describeOutcome({ phase: { kind: "redo" }, approval: yes, me, builtin: false, now })?.lines.at(-1)).toBe("gitring does the task again on the new main.");
    const back = asking("a1", 1, { status: "sent-back", answer: { by: person("u1", "Robin"), how: "app", note: "Keep the old name.", at: now - 5000 } });
    const sentBack = describeOutcome({ phase: { kind: "sent-back" }, approval: back, me, builtin: false, now });
    expect(sentBack).toMatchObject({ tone: "correction", headline: "Sent back", note: "Keep the old name." });
    expect(sentBack?.lines).toEqual(["You sent this work back 5 s ago.", "The agent changes the work and submits again."]);
    expect(describeOutcome({ phase: { kind: "sent-back" }, approval: back, me, builtin: true, now })?.lines[1]).toBe("A built-in agent does the task again and reads the note.");
    expect(describeOutcome({ phase: { kind: "closed", text: "The agent changed the work." }, now, me, builtin: false })).toMatchObject({ headline: "This question is closed", lines: ["The agent changed the work."] });
    expect(describeOutcome({ phase: { kind: "waiting" }, now, me, builtin: false })).toBeNull();
  });
});
