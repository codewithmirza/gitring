/**
 * The inbox of a person (src/core/inbox.ts): which items of one project wait for this person, who may answer a
 * question, and the plain words of an escalation question.
 */
import { describe, expect, it } from "vitest";
import type { Approval, Attempt, Intent, PairFacts, Question } from "../../src/core/types";
import { canAnswerQuestion, escalationFacts, escalationOptions, inboxOf, REDO_OPTIONS, type InboxInput } from "../../src/core/inbox";
import { cleanPrefs, DEFAULT_PREFS } from "../../src/core/accounts";
import { steViolations } from "../coord/ste";

const ROBIN = { id: "u_robin", name: "Robin" };
const SAM = { id: "u_sam", name: "Sam" };

function ask(over: Partial<Approval> = {}): Approval {
  return { id: "ap_1", status: "waiting", reason: "project-asks", why: ["This project asks a person before every merge."], digest: "d", askedAt: 100, ...over };
}

function attempt(id: string, over: Partial<Attempt> = {}): Attempt {
  return { id, intentId: "i1", agentId: "g1", status: "ready", stats: { filesChanged: 2, additions: 9, deletions: 1, steps: 3 }, createdAt: 1, updatedAt: 1, ...over } as Attempt;
}

function input(over: Partial<InboxInput> = {}): InboxInput {
  return {
    project: "shop",
    rule: "sender",
    intents: [{ id: "i1", title: "Add a search box", status: "judging", updatedAt: 50 } as Intent],
    attempts: [],
    agents: [{ id: "g1", callsign: "PETREL-2" }],
    questions: [],
    ...over,
  };
}

function question(over: Partial<Question> = {}): Question {
  return {
    id: "q_1",
    kind: "escalation",
    status: "open",
    intentId: "i1",
    attemptIds: ["a1", "a2"],
    facts: ["PETREL-2 works on \"A\". KESTREL-7 works on \"B\"."],
    options: escalationOptions("PETREL-2", "KESTREL-7"),
    askedAt: 200,
    updatedAt: 200,
    ...over,
  };
}

describe("the inbox of one project", () => {
  it("lists a merge that waits for this person, with the two answers", () => {
    const items = inboxOf(input({ attempts: [attempt("a1", { approval: ask({ approver: ROBIN }), sender: ROBIN })] }), { id: ROBIN.id, role: "member" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "ap:ap_1",
      kind: "approval",
      project: "shop",
      title: "Add a search box",
      headline: "Merge this work into main?",
      attemptId: "a1",
      approvalId: "ap_1",
      agent: "PETREL-2",
      link: "/approve/a1?project=shop",
      at: 100,
    });
    expect(items[0].line).toMatch(/^2 files, \+9 -1\./);
    expect(items[0].actions.map((a) => a.id)).toEqual(["approve", "send-back"]);
  });

  it("leaves out a merge of another sender for a member, and shows it to an owner", () => {
    const i = input({ attempts: [attempt("a1", { approval: ask({ approver: SAM }), sender: SAM })] });
    expect(inboxOf(i, { id: ROBIN.id, role: "member" })).toEqual([]);
    expect(inboxOf(i, { id: ROBIN.id, role: "owner" })).toHaveLength(1);
    expect(inboxOf(i, { id: ROBIN.id, role: "viewer" })).toEqual([]);
    expect(inboxOf(i, { id: null, role: "owner" })).toEqual([]);
  });

  it("names a merge that stopped, and its yes starts the merge again", () => {
    const items = inboxOf(input({ attempts: [attempt("a1", { approval: ask({ reason: "merge-stopped", why: ["The merge stopped 4 times."] }) })] }), { id: ROBIN.id, role: "owner" });
    expect(items[0]).toMatchObject({ kind: "stopped", headline: "The merge stopped" });
    expect(items[0].actions.map((a) => a.label)).toEqual(["Merge again", "Send back"]);
  });

  it("lists an open question with its options, for the people who may answer", () => {
    const attempts = [attempt("a1", { status: "underway", sender: SAM }), attempt("a2", { status: "underway" })];
    const i = input({ attempts, questions: [question()], intents: [{ id: "i1", title: "Add a search box", status: "underway", updatedAt: 50 } as Intent] });
    const items = inboxOf(i, { id: SAM.id, role: "member" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "q:q_1", kind: "question", headline: "Which work adapts?", questionId: "q_1", link: "/tasks/i1?project=shop" });
    expect(items[0].actions).toEqual([
      { id: "first", label: "PETREL-2 continues, KESTREL-7 adapts", primary: true, note: true },
      { id: "second", label: "KESTREL-7 continues, PETREL-2 adapts", note: true },
      { id: "both", label: "No conflict: both continue" },
    ]);
    expect(inboxOf(i, { id: ROBIN.id, role: "member" })).toEqual([]);
    expect(inboxOf({ ...i, questions: [question({ status: "answered" })] }, { id: SAM.id, role: "member" })).toEqual([]);
  });

  it("lists a task that waits for a person when no question names it", () => {
    const items = inboxOf(input(), { id: ROBIN.id, role: "member" });
    expect(items).toEqual([expect.objectContaining({ key: "task:i1", kind: "task", actions: [{ id: "open", label: "Open the task", primary: true }] })]);
    // A redo question covers the task: one item, not two.
    const withQuestion = inboxOf(input({ questions: [question({ kind: "redo", attemptIds: ["a1"], options: [...REDO_OPTIONS] })] }), { id: ROBIN.id, role: "member" });
    expect(withQuestion.map((x) => x.kind)).toEqual(["question"]);
    expect(withQuestion[0].headline).toBe("The work did not merge");
  });

  it("sorts the items oldest first", () => {
    const items = inboxOf(
      input({ attempts: [attempt("a1", { approval: ask({ askedAt: 300 }) }), attempt("a3", { intentId: "i2", approval: ask({ id: "ap_3", askedAt: 10 }) })], intents: [{ id: "i1", title: "A", status: "judging", updatedAt: 1 } as Intent, { id: "i2", title: "B", status: "judging", updatedAt: 1 } as Intent] }),
      { id: ROBIN.id, role: "owner" },
    );
    expect(items.map((x) => x.at)).toEqual([10, 300]);
  });
});

describe("who may answer a question", () => {
  it("follows the rules of approvals", () => {
    expect(canAnswerQuestion([SAM, undefined], { id: SAM.id, role: "member" })).toBe(true);
    expect(canAnswerQuestion([SAM, undefined], { id: ROBIN.id, role: "member" })).toBe(false);
    expect(canAnswerQuestion([undefined, undefined], { id: ROBIN.id, role: "member" })).toBe(true);
    expect(canAnswerQuestion([SAM], { id: ROBIN.id, role: "owner" })).toBe(true);
    expect(canAnswerQuestion([SAM], { id: SAM.id, role: "member" }, "owner")).toBe(false);
    expect(canAnswerQuestion([], { id: ROBIN.id, role: "viewer" })).toBe(false);
  });
});

describe("the words of an escalation question", () => {
  const facts = (over: Partial<PairFacts> = {}): PairFacts => ({
    otherAttemptId: "a2",
    otherAgentId: "g2",
    otherIntentId: "i2",
    otherState: "active",
    sharedFiles: [],
    sharedSymbols: [],
    interfaceHits: [],
    hunkOverlaps: [],
    range: 2,
    closing: false,
    intentSimilarity: 0,
    ...over,
  });
  const names = { a: "PETREL-2", b: "KESTREL-7", taskA: "Round the price", taskB: "Add a tax" };

  it("says the facts in short sentences, with the lines, the parameters and the names", () => {
    const out = escalationFacts(
      facts({
        hunkOverlaps: [{ path: "src/price.js", incoming: [10, 14], other: [12, 16] }],
        interfaceHits: [{ changedBy: "other", symbol: "src/price.js#price", usedAt: ["src/cart.js"] }],
        sharedSymbols: ["src/price.js#price"],
      }),
      names,
    );
    expect(out).toEqual([
      'PETREL-2 works on "Round the price". KESTREL-7 works on "Add a tax".',
      "Both change the same lines: src/price.js lines 10–14.",
      "KESTREL-7 changes the parameters of price. PETREL-2 uses it in src/cart.js.",
      "Both change price.",
      "gitring is not sure which work must adapt. A person decides. Both agents continue until then.",
    ]);
    for (const line of out) expect(steViolations(line), line).toEqual([]);
  });

  it("names the files when nothing more is known", () => {
    expect(escalationFacts(facts({ sharedFiles: ["src/a.js"] }), names)[1]).toBe("Both change src/a.js.");
    expect(escalationFacts(facts({ range: 3 }), names)[1]).toBe("The two changes are in files that import each other.");
  });

  it("has plain options", () => {
    for (const o of [...escalationOptions("PETREL-2", "KESTREL-7"), ...REDO_OPTIONS]) expect(steViolations(o.label), o.label).toEqual([]);
  });
});

describe("the preferences of a person", () => {
  it("keep a known value and use the default for anything else", () => {
    expect(cleanPrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(cleanPrefs({ approvalsIn: "app" })).toEqual({ approvalsIn: "app" });
    expect(cleanPrefs({ approvalsIn: "nowhere" })).toEqual({ approvalsIn: "both" });
    expect(cleanPrefs("x")).toEqual({ approvalsIn: "both" });
  });
});
