/**
 * Questions for a person (contract C4): a conflict check that escalates asks a person which work adapts, and work
 * that did not merge with no agent left to try again asks a person what happens next. One mechanism: a question
 * in the inbox, a webhook, and an answer that acts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attempt, Correction, Question } from "../../src/core/types";
import { steViolations } from "../coord/ste";
import { CrashWorld } from "./crash-world";

const FILES = [
  { path: "src/price.js", text: "export function price(n) {\n  return n;\n}\n" },
  { path: "tests/a.test.js", text: 'import { test, expect } from "../harness/test.js";\ntest("a", () => expect(1).toBe(1));\n' },
];

/** A decision model that cannot decide: a coin-flip collision, a semantic risk, and no side that clearly adapts. */
function unsureModel() {
  return {
    run: async (_name: string, req: { questions?: Record<string, unknown> }) => {
      if (!req.questions) return { response: "" };
      const answers: Record<string, unknown> = { duplicate: { type: "noul", noul: 0.05 } };
      for (const id of Object.keys(req.questions)) {
        if (id.startsWith("collide.")) answers[id] = { type: "noul", noul: 0.5 };
        else if (id.startsWith("interfere.")) answers[id] = { type: "score", score: 4, confidence: 0.9 };
        else if (id.startsWith("giveway.")) answers[id] = { type: "choice", choice: "incoming", probabilities: { incoming: 0.5, other: 0.5 }, confidence: 0.5 };
      }
      return { answers };
    },
  };
}

type Internals = {
  attempts: Map<string, Attempt>;
  corrections: Map<string, Correction>;
  questions: Map<string, Question>;
  markStale(a: Attempt, reason: string): Promise<void>;
  returnTimedOut(a: Attempt): Promise<void>;
  putAttempt(a: Attempt): void;
};

const OWNER = { id: "u_robin", name: "Robin", role: "owner" as const };

let world: CrashWorld;
const hooks: { event: string; body: Record<string, unknown> }[] = [];

async function start(settings: Record<string, unknown> = {}) {
  hooks.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    hooks.push({ event: body.event, body });
    return new Response("ok");
  });
  // Built-in agents start in a Vessel object: here a stand-in that only takes the call.
  const vessel = { idFromName: (n: string) => n, get: () => ({ start: async () => undefined, stop: async () => undefined }) };
  world = new CrashWorld({ AI: unsureModel(), VESSEL: vessel });
  await world.start({ files: FILES, settings: { decisionModel: "clef-flash", webhooks: [{ id: "wh", url: "https://hooks.example.org/gitring", events: ["question"], format: "json", enabled: true }], ...settings } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An agent sends a plan for a new task that edits src/price.js. */
async function plan(title: string): Promise<string> {
  const d = await world.harbor.declare({ agent: { client: "test" }, newIntent: { title, goal: `${title} in src/price.js.` }, plan: ["Edit price"], files: ["src/price.js"], symbols: [], approach: "Edit price." });
  await world.settle();
  return d.attemptId;
}

const inner = () => world.harbor as unknown as Internals;
const open = () => [...inner().questions.values()].filter((q) => q.status === "open");

describe("an escalated conflict check asks a person which work adapts", () => {
  it("makes one question with the facts and three answers, and tells both agents to continue", async () => {
    await start();
    const a = await plan("Round the price");
    const b = await plan("Add a tax to the price");
    const st = await world.harbor.state();
    const check = st.checks.filter((c) => c.attemptId === b).at(-1)!;
    expect(check.verdict).toBe("escalate");
    const qs = open();
    expect(qs).toHaveLength(1);
    const q = qs[0];
    expect(q).toMatchObject({ kind: "escalation", attemptIds: [b, a], checkId: check.id });
    expect(q.id).toMatch(/^q_/);
    const [nameB, nameA] = [b, a].map((id) => st.agents.find((g) => g.id === st.attempts.find((x) => x.id === id)!.agentId)!.callsign);
    expect(q.options).toEqual([
      { id: "first", label: `${nameB} continues, ${nameA} adapts` },
      { id: "second", label: `${nameA} continues, ${nameB} adapts` },
      { id: "both", label: "No conflict: both continue" },
    ]);
    expect(q.facts[0]).toContain('works on "Add a tax to the price"');
    expect(q.facts.at(-1)).toBe("gitring is not sure which work must adapt. A person decides. Both agents continue until then.");
    for (const f of q.facts) expect(steViolations(f.replace(/"[^"]*"/g, "")), f).toEqual([]);
    // The project state has the question, and the webhook "question" fired.
    expect(st.questions?.map((x) => x.id)).toContain(q.id);
    await world.settle();
    expect(hooks.filter((h) => h.event === "question")).toHaveLength(1);
    // Both agents read that a person decides, and that they continue. No change request yet.
    for (const id of [a, b]) {
      const clr = await world.harbor.log({ attemptId: id, message: "Still on it." });
      expect(clr.advice).toContain("A person decides how your work and the work of");
      expect(clr.advice).toContain("Continue your work.");
      expect(clr.corrections).toEqual([]);
    }
  });

  it("updates the open question when the same pair escalates again: one pair, one question", async () => {
    await start();
    const a = await plan("Round the price");
    const b = await plan("Add a tax to the price");
    const first = open()[0];
    await world.harbor.write({ attemptId: a, files: [{ path: "src/price.js", content: "export function price(n) {\n  return Math.round(n);\n}\n" }] });
    await world.settle();
    const qs = open();
    expect(qs).toHaveLength(1);
    expect(qs[0].id).toBe(first.id);
    // The order of the question stays: b asked first.
    expect(qs[0].attemptIds).toEqual([b, a]);
    expect(hooks.filter((h) => h.event === "question")).toHaveLength(1);
  });

  it("sends the change request to the side that adapts when a person answers", async () => {
    await start();
    const a = await plan("Round the price");
    const b = await plan("Add a tax to the price");
    const q = open()[0];
    const res = await world.harbor.answerQuestion(q.id, { option: "first", note: "Keep the rounding out of price." }, OWNER);
    expect(res.outcome).toBe("answered");
    expect(res.question).toMatchObject({ status: "answered", answer: { option: "first", by: { id: OWNER.id }, note: "Keep the rounding out of price." } });
    // "first": b continues, a adapts.
    const toA = [...inner().corrections.values()].filter((c) => c.attemptId === a);
    expect(toA).toHaveLength(1);
    expect(toA[0]).toMatchObject({ rule: "human", standOnAttemptId: b, status: "pending" });
    expect(toA[0].message).toMatch(/^A person decided: \S+ continues, and your work adapts\. Note: Keep the rounding out of price\./);
    expect([...inner().corrections.values()].filter((c) => c.attemptId === b)).toEqual([]);
    const st = await world.harbor.state();
    expect(st.decisions.at(-1)).toMatchObject({ kind: "resolve-escalation", attemptIds: [b, a], by: { id: OWNER.id } });
    // The agent that adapts gets it in the answer of its next call.
    const clr = await world.harbor.log({ attemptId: a, message: "Next step." });
    expect(clr.corrections.map((c) => c.id)).toEqual([toA[0].id]);
    // A second answer changes nothing.
    const again = await world.harbor.answerQuestion(q.id, { option: "second" }, OWNER);
    expect(again.outcome).toBe("already");
    expect([...inner().corrections.values()].filter((c) => c.attemptId === b)).toEqual([]);
  });

  it("changes nothing for \"No conflict: both continue\"", async () => {
    await start();
    await plan("Round the price");
    await plan("Add a tax to the price");
    const q = open()[0];
    const res = await world.harbor.answerQuestion(q.id, { option: "both" }, OWNER);
    expect(res).toMatchObject({ outcome: "answered", message: "Both agents continue. Nothing changes." });
    expect([...inner().corrections.values()]).toEqual([]);
    expect(open()).toEqual([]);
  });

  it("refuses a viewer, a member who sent neither agent, and an unknown answer", async () => {
    await start();
    const a = await plan("Round the price");
    await plan("Add a tax to the price");
    const q = open()[0];
    // The work copy of a has a sender: only that person (or an owner) may answer now.
    const at = inner().attempts.get(a)!;
    at.sender = { id: "u_sam", name: "Sam" };
    expect((await world.harbor.answerQuestion(q.id, { option: "both" }, { id: "u_eve", name: "Eve", role: "viewer" })).outcome).toBe("refused");
    expect((await world.harbor.answerQuestion(q.id, { option: "both" }, { id: "u_kim", name: "Kim", role: "member" })).outcome).toBe("refused");
    await expect(world.harbor.answerQuestion(q.id, { option: "maybe" }, OWNER)).rejects.toThrow(/Give one of these answers: first, second, both\./);
    expect((await world.harbor.answerQuestion(q.id, { option: "both" }, { id: "u_sam", name: "Sam", role: "member" })).outcome).toBe("answered");
  });

  it("closes the question when one of the two work copies closes", async () => {
    await start();
    const a = await plan("Round the price");
    await plan("Add a tax to the price");
    const q = open()[0];
    await world.harbor.giveUp(a, "Not needed.");
    const closed = inner().questions.get(q.id)!;
    expect(closed.status).toBe("closed");
    expect(closed.closed).toMatch(/^The work of \S+ closed\. /);
    expect((await world.harbor.answerQuestion(q.id, { option: "both" }, OWNER)).outcome).toBe("closed");
  });

  it("is in the inbox of the people who may answer, with the answers as actions", async () => {
    await start();
    await plan("Round the price");
    await plan("Add a tax to the price");
    const q = open()[0];
    const items = await world.harbor.inbox({ id: OWNER.id, role: "owner" });
    const item = items.find((x) => x.questionId === q.id)!;
    expect(item).toMatchObject({ kind: "question", headline: "Which work adapts?", title: "Add a tax to the price", link: `/tasks/${q.intentId}?project=p_crash` });
    expect(item.actions.map((x) => x.id)).toEqual(["first", "second", "both"]);
    expect(await world.harbor.inbox({ id: "u_eve", role: "viewer" })).toEqual([]);
  });
});

describe("push notifications for a new question", () => {
  it("ask the Directory to send a push to the senders, only when the deployment has the push keys", async () => {
    const calls: unknown[][] = [];
    const k = { VAPID_PUBLIC_KEY: `B${"A".repeat(86)}`, VAPID_PRIVATE_KEY: "A".repeat(43), VAPID_SUBJECT: "mailto:robin@example.org" };
    const directory = { idFromName: (n: string) => n, get: () => ({ budgetTake: async () => ({ granted: 1, retryAt: 0 }), pushInbox: async (...args: unknown[]) => (calls.push(args), 1) }) };
    for (const keys of [{}, k]) {
      calls.length = 0;
      vi.stubGlobal("fetch", async () => new Response("ok"));
      world = new CrashWorld({ AI: unsureModel(), DIRECTORY: directory, ...keys });
      await world.start({ files: FILES, settings: { decisionModel: "clef-flash" } });
      const a = await plan("Round the price");
      inner().attempts.get(a)!.sender = { id: "u_sam", name: "Sam" };
      await plan("Add a tax to the price");
      await world.settle();
      expect(open()).toHaveLength(1);
      expect(calls).toEqual(keys === k ? [["p_crash", { users: ["u_sam"], need: "member", kind: "question" }]] : []);
    }
  });

  it("ask the Directory to send a push when a merge waits for a yes", async () => {
    const calls: unknown[][] = [];
    const k = { VAPID_PUBLIC_KEY: `B${"A".repeat(86)}`, VAPID_PRIVATE_KEY: "A".repeat(43), VAPID_SUBJECT: "mailto:robin@example.org" };
    const directory = { idFromName: (n: string) => n, get: () => ({ budgetTake: async () => ({ granted: 1, retryAt: 0 }), pushInbox: async (...args: unknown[]) => (calls.push(args), 1) }) };
    vi.stubGlobal("fetch", async () => new Response("ok"));
    world = new CrashWorld({ AI: unsureModel(), DIRECTORY: directory, ...k });
    await world.start({ files: FILES, settings: { decisionModel: "clef-flash", landing: "ask" } });
    const t = await world.submitTask("alpha");
    expect(t.next).toBe("awaiting-approval");
    await world.settle();
    // No person sent this agent: every member of the project may answer, so the Directory finds them.
    expect(calls).toEqual([["p_crash", { users: [], need: "member", kind: "approval" }]]);
  });
});

describe("work that did not merge and no agent tries again: a person decides", () => {
  /** A work copy of an outside agent that is ready to merge. */
  async function readyWork(): Promise<Attempt> {
    const t = await world.submitTask("alpha");
    await world.settle();
    return inner().attempts.get(t.attemptId)!;
  }

  it("asks a redo question after two failed redos, stops the work copy, and fires the webhook", async () => {
    await start({ redo: "builtin" });
    const t = await world.startTask("beta");
    const a = inner().attempts.get(t.attemptId)!;
    a.lineage = { generation: 3 };
    await inner().markStale(a, "Main changed the same lines.");
    expect(a.status).toBe("stale");
    expect(a.stoppedFor).toBe("Two redos failed: Main changed the same lines.");
    const qs = open();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ kind: "redo", attemptIds: [a.id], intentId: a.intentId, options: [{ id: "redo" }, { id: "park" }] });
    expect((await world.harbor.state()).intents.find((i) => i.id === a.intentId)?.status).toBe("judging");
    await world.settle();
    expect(hooks.filter((h) => h.event === "question")).toHaveLength(1);
    // The agent reads that the work stopped and that a person decides.
    const st = await world.harbor.status(a.id);
    expect(st.message).toContain("Two redos failed: Main changed the same lines. A person decides what happens next.");
    const items = await world.harbor.inbox({ id: OWNER.id, role: "owner" });
    expect(items.map((x) => [x.kind, x.headline])).toEqual([["question", "The work did not merge"]]);
  });

  it("asks a person when the outside agent did not answer in time (agent-only): the work copy leaves 'underway'", async () => {
    await start({ redo: "agent-only" });
    const t = await world.startTask("gamma");
    const a = inner().attempts.get(t.attemptId)!;
    a.status = "underway";
    a.returned = { at: Date.now() - 60_000, until: Date.now() - 1, reason: "The tests fail on the new main.", policy: "agent-only" };
    inner().putAttempt(a);
    await inner().returnTimedOut(a);
    expect(a.status).toBe("stale");
    expect(a.stoppedFor).toMatch(/did not answer in \d+ minutes after the work came back\. The tests fail on the new main\.$/);
    expect(open().map((q) => q.kind)).toEqual(["redo"]);
  });

  it("asks a person after three returns to an outside agent (agent-only)", async () => {
    await start({ redo: "agent-only" });
    const t = await world.startTask("delta");
    const a = inner().attempts.get(t.attemptId)!;
    a.returns = 3;
    await inner().markStale(a, "Main changed the same lines.");
    expect(a.status).toBe("stale");
    expect(open().map((q) => q.kind)).toEqual(["redo"]);
  });

  it("starts a redo on the new main when a person says so", async () => {
    await start({ redo: "builtin" });
    const t = await world.startTask("beta");
    const a = inner().attempts.get(t.attemptId)!;
    a.lineage = { generation: 3 };
    await inner().markStale(a, "Main changed the same lines.");
    const q = open()[0];
    const res = await world.harbor.answerQuestion(q.id, { option: "redo" }, OWNER);
    expect(res.outcome).toBe("answered");
    expect(res.message).toMatch(/^A built-in agent does "Add beta" again on the new main\./);
    const redo = [...inner().attempts.values()].find((x) => x.lineage.rederivedFrom === a.id);
    expect(redo).toBeDefined();
    const st = await world.harbor.state();
    expect(st.intents.find((i) => i.id === a.intentId)?.status).not.toBe("judging");
    expect(st.decisions.at(-1)).toMatchObject({ kind: "rederive", by: { id: OWNER.id } });
    expect(open()).toEqual([]);
  });

  it("lets the question wait again when the redo cannot start, and the person sees why", async () => {
    await start({ redo: "builtin" });
    const t = await world.startTask("beta");
    const a = inner().attempts.get(t.attemptId)!;
    a.lineage = { generation: 3 };
    await inner().markStale(a, "Main changed the same lines.");
    const q = open()[0];
    // The repository does not answer: no redo starts.
    const h = world.harbor as unknown as { loadMain: () => Promise<unknown> };
    const loadMain = h.loadMain;
    h.loadMain = () => Promise.reject(new Error("The repository did not answer. Try again."));
    await expect(world.harbor.answerQuestion(q.id, { option: "redo" }, OWNER)).rejects.toThrow("The repository did not answer. Try again.");
    expect(inner().questions.get(q.id)?.status).toBe("open");
    expect([...inner().attempts.values()].some((x) => x.lineage.rederivedFrom === a.id)).toBe(false);
    h.loadMain = loadMain;
    expect((await world.harbor.state()).intents.find((i) => i.id === a.intentId)?.status).toBe("judging");
    // The next answer works.
    expect((await world.harbor.answerQuestion(q.id, { option: "redo" }, OWNER)).outcome).toBe("answered");
    expect([...inner().attempts.values()].some((x) => x.lineage.rederivedFrom === a.id)).toBe(true);
  });

  it("pauses the task when a person says so", async () => {
    await start({ redo: "builtin" });
    const t = await world.startTask("beta");
    const a = inner().attempts.get(t.attemptId)!;
    a.lineage = { generation: 3 };
    await inner().markStale(a, "Main changed the same lines.");
    const q = open()[0];
    expect((await world.harbor.answerQuestion(q.id, { option: "park" }, OWNER)).message).toBe("The task is paused.");
    expect((await world.harbor.state()).intents.find((i) => i.id === a.intentId)?.status).toBe("parked");
  });

  it("closes the redo question when somebody acts on the task another way", async () => {
    await start({ redo: "builtin" });
    const t = await world.startTask("beta");
    const a = inner().attempts.get(t.attemptId)!;
    a.lineage = { generation: 3 };
    await inner().markStale(a, "Main changed the same lines.");
    const q = open()[0];
    await world.harbor.rederive(a.id, "A person asked for a redo.");
    expect(inner().questions.get(q.id)?.status).toBe("closed");
  });

  it("keeps an approval of a ready work copy apart from the questions", async () => {
    await start({ landing: "ask" });
    const a = await readyWork();
    expect(a.approval?.status).toBe("waiting");
    const items = await world.harbor.inbox({ id: OWNER.id, role: "owner" });
    expect(items.map((x) => [x.kind, x.attemptId, x.actions.map((y) => y.id)])).toEqual([["approval", a.id, ["approve", "send-back"]]]);
    expect(open()).toEqual([]);
  });
});
