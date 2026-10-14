/**
 * The human loop in the web app: questions in the decisions list, the live events of questions, the inbox
 * route and words, the choice "where do you answer merge questions", line requests on a diff, and the service
 * worker that shows push notifications.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Attempt, CourseCheck, Intent, ProjectState, Question } from "../../src/core/types";
import { escalationOptions, REDO_OPTIONS } from "../../src/core/inbox";
import { selectJudgmentQueue, type QuestionItem } from "../../web/src/state/selectors";
import { reduce } from "../../web/src/state/store";
import { inSelection, lineRequestProblem, linesText, pickLine } from "../../web/src/design/components/LineRequest";
import { mayRequestLines } from "../../web/src/app/lineRequest";
import { ruleLabel } from "../../web/src/state/format";
import { steViolations } from "../coord/ste";

beforeAll(() => {
  (globalThis as { location?: unknown }).location = { pathname: "/inbox", search: "", hash: "" };
});

const SAM = { id: "u_sam", name: "Sam" };

function attempt(id: string, over: Partial<Attempt> = {}): Attempt {
  return { id, intentId: "i1", agentId: "g1", status: "underway", stats: { filesChanged: 1, additions: 1, deletions: 0, steps: 1 }, createdAt: 1, updatedAt: 1, ...over } as Attempt;
}

function question(over: Partial<Question> = {}): Question {
  return { id: "q_1", kind: "escalation", status: "open", intentId: "i1", attemptIds: ["a1", "a2"], facts: ["Both change src/a.js."], options: escalationOptions("PETREL-2", "KESTREL-7"), askedAt: 40, updatedAt: 40, ...over };
}

function state(over: Partial<ProjectState> = {}): ProjectState {
  return {
    project: { id: "shop", settings: { approver: "sender" } },
    intents: [{ id: "i1", title: "Add a search box", status: "underway", updatedAt: 9 } as Intent],
    attempts: [attempt("a1", { sender: SAM }), attempt("a2")],
    checks: [],
    agents: [
      { id: "g1", callsign: "PETREL-2", color: 3 },
      { id: "g2", callsign: "KESTREL-7", color: 5 },
    ],
    decisions: [],
    ...over,
  } as unknown as ProjectState;
}

describe("questions in the decisions list", () => {
  it("shows an open question once, and no old escalation item for its work copies", () => {
    const check = { id: "cc_1", attemptId: "a1", verdict: "escalate", at: 30 } as CourseCheck;
    const q = selectJudgmentQueue(state({ questions: [question()], checks: [check] }), { id: SAM.id, role: "member" });
    expect(q.map((x) => x.key)).toEqual(["q:q_1"]);
    const item = q[0] as QuestionItem;
    expect(item).toMatchObject({ kind: "question", title: "Add a search box", mayAnswer: true, attemptIds: ["a1", "a2"] });
    expect(item.detail).toBe("Which work adapts? A person decides");
    // Without the question (an old project object), the check still shows as before.
    expect(selectJudgmentQueue(state({ checks: [check] }), { id: SAM.id, role: "member" }).map((x) => x.key)).toEqual(["esc:cc_1"]);
  });

  it("says who may answer: another member waits", () => {
    const q = selectJudgmentQueue(state({ questions: [question()] }), { id: "u_kim", role: "member" });
    expect((q[0] as QuestionItem).mayAnswer).toBe(false);
  });

  it("shows a redo question in place of the item 'the work could not merge'", () => {
    const st = state({ intents: [{ id: "i1", title: "Add a search box", status: "judging", updatedAt: 9 } as Intent], attempts: [attempt("a1", { status: "stale" })] });
    expect(selectJudgmentQueue(st, { id: SAM.id, role: "owner" }).map((x) => x.key)).toEqual(["stuck:i1"]);
    const withQ = selectJudgmentQueue({ ...st, questions: [question({ kind: "redo", attemptIds: ["a1"], options: [...REDO_OPTIONS] })] }, { id: SAM.id, role: "owner" });
    expect(withQ.map((x) => x.key)).toEqual(["q:q_1"]);
    expect((withQ[0] as QuestionItem).detail).toBe("The work did not merge. A person decides what happens next");
  });

  it("leaves out answered and closed questions", () => {
    const q = selectJudgmentQueue(state({ questions: [question({ status: "answered" }), question({ id: "q_2", status: "closed" })] }), { id: SAM.id, role: "member" });
    expect(q).toEqual([]);
  });

  it("shows no old escalation item after a person answered: the check that asked is still the latest one", () => {
    const check = { id: "cc_1", attemptId: "a1", verdict: "escalate", at: 30 } as CourseCheck;
    for (const status of ["answered", "closed"] as const) {
      expect(selectJudgmentQueue(state({ questions: [question({ status })], checks: [check] }), { id: SAM.id, role: "member" }), status).toEqual([]);
    }
  });
});

describe("live events of questions", () => {
  it("adds and replaces a question by its id", () => {
    const st = state();
    const one = reduce(st, { type: "question", question: question() });
    expect(one.questions?.map((x) => x.status)).toEqual(["open"]);
    const two = reduce(one, { type: "question", question: question({ status: "answered" }) });
    expect(two.questions?.map((x) => x.status)).toEqual(["answered"]);
    expect(reduce(two, { type: "question", question: question({ status: "answered" }) })).toBe(two);
  });
});

describe("the inbox page", async () => {
  const { parseRoute, isProjectRoute } = await import("../../web/src/app/router");
  const { APPROVALS_IN_TEXT, badgeText, inboxLede, itemMeta, keyBytes } = await import("../../web/src/state/inbox");

  it("has its own route, without a project", () => {
    expect(parseRoute("/inbox")).toEqual({ name: "inbox" });
    expect(isProjectRoute({ name: "inbox" })).toBe(false);
  });

  it("says how many things wait, in plain words", () => {
    expect(inboxLede(0)).toBe("Nothing waits for you.");
    expect(inboxLede(1)).toBe("1 thing waits for you.");
    expect(inboxLede(3)).toBe("3 things wait for you.");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(120)).toBe("99+");
    expect(itemMeta({ project: "shop-1x2y", projectName: "Shop" }, "5 min")).toBe("Shop · 5 min");
    expect(itemMeta({ project: "shop-1x2y" }, "now")).toBe("shop-1x2y · now");
  });

  it("explains each place to answer merge questions in short sentences", () => {
    expect(Object.keys(APPROVALS_IN_TEXT)).toEqual(["agent", "app", "both"]);
    // The Directory sends no merge push to a person who answers in the chat only: the help says so.
    expect(APPROVALS_IN_TEXT.agent.help).toContain("You get no push notification for merge questions.");
    for (const { label, help } of Object.values(APPROVALS_IN_TEXT)) {
      expect(steViolations(label)).toEqual([]);
      expect(steViolations(help)).toEqual([]);
    }
  });

  it("gives the push key to the browser as bytes", () => {
    expect([...keyBytes("AQID")]).toEqual([1, 2, 3]);
    expect(keyBytes(`B${"A".repeat(86)}`)).toHaveLength(65);
  });
});

describe("line requests on a diff", () => {
  it("selects one line, then a range with Shift, in one file", () => {
    const one = pickLine(null, "src/a.js", 12, false);
    expect(one).toEqual({ path: "src/a.js", from: 12, to: 12, anchor: 12 });
    const range = pickLine(one, "src/a.js", 8, true);
    expect(range).toEqual({ path: "src/a.js", from: 8, to: 12, anchor: 12 });
    expect(pickLine(range, "src/b.js", 3, true)).toEqual({ path: "src/b.js", from: 3, to: 3, anchor: 3 });
    expect(pickLine(range, "src/a.js", 20, false)).toEqual({ path: "src/a.js", from: 20, to: 20, anchor: 20 });
    expect(inSelection(range, "src/a.js", 10)).toBe(true);
    expect(inSelection(range, "src/a.js", 13)).toBe(false);
    expect(inSelection(range, "src/b.js", 10)).toBe(false);
    expect(inSelection(range, "src/a.js", undefined)).toBe(false);
  });

  it("says the lines and refuses a request without words or with bad lines", () => {
    expect(linesText(4, 4)).toBe("line 4");
    expect(linesText(4, 7)).toBe("lines 4–7");
    expect(lineRequestProblem({ path: "a", from: 2, to: 3, text: "Rename it." })).toBeNull();
    expect(lineRequestProblem({ path: "a", from: 2, to: 3, text: " " })).toBe("Write what the agent must change.");
    expect(lineRequestProblem({ path: "a", from: 0, to: 3, text: "x" })).toMatch(/^Give the lines/);
    expect(lineRequestProblem({ path: "a", from: 5, to: 3, text: "x" })).toMatch(/^Give the lines/);
  });

  it("is only for a work copy that the agent still works on", () => {
    for (const status of ["declared", "underway", "submitted", "checking", "ready", "landing", "rederiving"] as const) expect(mayRequestLines({ status }), status).toBe(true);
    // A stale copy is over on the server: a redo or a person decides. The other states are over too.
    for (const status of ["stale", "landed", "abandoned", "alternate", "failed"] as const) expect(mayRequestLines({ status }), status).toBe(false);
  });

  it("shows the change request of a person with the label 'A person decided'", () => {
    expect(ruleLabel("human")).toBe("A person decided");
    expect(steViolations(ruleLabel("human"))).toEqual([]);
  });
});

describe("the service worker (public/sw.js)", () => {
  /** Run the service worker with a fake `self`; answers its listeners and the notifications it showed. */
  function load(inbox: unknown, ok = true, windows: unknown[] = []) {
    const listeners = new Map<string, (e: unknown) => void>();
    const shown: { title: string; options: Record<string, unknown> }[] = [];
    const opened: string[] = [];
    const self = {
      location: { origin: "https://gitring.test" },
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      skipWaiting: () => undefined,
      clients: { claim: async () => undefined, matchAll: async () => windows, openWindow: async (u: string) => void opened.push(u) },
      registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    };
    const fetcher = async (url: string) => {
      expect(url).toBe("/api/me/inbox");
      return { ok, json: async () => inbox };
    };
    const code = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
    new Function("self", "fetch", code)(self, fetcher);
    const fire = async (type: string, event: Record<string, unknown> = {}) => {
      let wait: Promise<unknown> = Promise.resolve();
      listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
      await wait;
    };
    return { fire, shown, opened };
  }

  it("shows how many things wait, and the newest one", async () => {
    const sw = load({ items: [{ headline: "Which work adapts?", title: "Old", projectName: "Shop" }, { headline: "Merge this work into main?", title: "Add a search box", projectName: "Shop" }] });
    await sw.fire("push");
    expect(sw.shown).toEqual([{ title: "2 things wait for you in gitring", options: expect.objectContaining({ body: "Merge this work into main?: Add a search box (Shop)", tag: "gitring-inbox", data: { url: "/inbox" } }) }]);
    for (const s of sw.shown) expect(steViolations(s.title)).toEqual([]);
  });

  it("still shows a notification when the inbox does not answer, and a tap opens /inbox", async () => {
    const sw = load(null, false);
    await sw.fire("push");
    expect(sw.shown[0]).toMatchObject({ title: "gitring", options: { body: "Open the inbox to see what waits for you." } });
    await sw.fire("notificationclick", { notification: { close: () => undefined, data: { url: "/inbox" } } });
    expect(sw.opened).toEqual(["/inbox"]);
  });

  it("shows /inbox in an open window of gitring, or in a new window when that window cannot go there", async () => {
    const went: string[] = [];
    const tap = { notification: { close: () => undefined, data: { url: "/inbox" } } };
    const open = { url: "https://gitring.test/tasks", focus: async () => undefined, navigate: async (u: string) => (went.push(u), {}) };
    const sw = load(null, false, [{ url: "https://other.test/", focus: async () => undefined, navigate: async () => ({}) }, open]);
    await sw.fire("notificationclick", tap);
    expect([went, sw.opened]).toEqual([["/inbox"], []]);
    // A window that this worker does not control refuses to navigate: a new window opens.
    const stuck = { url: "https://gitring.test/tasks", focus: async () => undefined, navigate: async () => Promise.reject(new TypeError("Not controlled.")) };
    const sw2 = load(null, false, [stuck]);
    await sw2.fire("notificationclick", tap);
    expect(sw2.opened).toEqual(["/inbox"]);
  });
});
