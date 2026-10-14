/**
 * The steward (src/harbor/steward.ts): pure counters over the records of a project, the one plain sentence
 * of the model, and the loop in the project object: a note in the inbox once per fact, "Seen" closes it.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Attempt, Correction, LogEntry, Question } from "../../src/core/types";
import { inboxOf, questionHeadline, STEWARD_OPTIONS } from "../../src/core/inbox";
import { SHORT_JOB_MODEL } from "../../src/platform/ai/models";
import {
  BOUNCE_FLIPS,
  bouncingRequests,
  FLAP_FLIPS,
  flappingTests,
  HOT_REQUESTS,
  hotLines,
  plainSentence,
  QUEUE_STILL_MS,
  STUCK_RUNS,
  stewardFindings,
  stuckQueue,
  stuckTests,
  testRuns,
  WINDOW_MS,
  wordFinding,
  type Finding,
  type StewardInput,
} from "../../src/harbor/steward";
import { steViolations } from "../coord/ste";
import { CrashWorld } from "./crash-world";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

/** The STE rules on a sentence, with quoted text (test names, task titles) out. */
const ste = (s: string) => steViolations(s.replace(/"[^"]*"/g, ""));

function attempt(id: string, agentId: string, over: Partial<Attempt> = {}): Attempt {
  return { id, intentId: `i_${id}`, agentId, status: "underway", stats: { filesChanged: 1, additions: 1, deletions: 0, steps: 1 }, createdAt: 1, updatedAt: 1, ...over } as Attempt;
}

let logSeq = 0;

/** A test run of a work copy, as the project object logs it: the names of the tests that failed. */
function run(attemptId: string, at: number, failed: string[]): LogEntry {
  logSeq += 1;
  return { id: `l${logSeq}`, at, kind: "check", attemptId, agentId: "g", intentId: `i_${attemptId}`, message: "tests", data: { checkRunId: `r${logSeq}`, ok: failed.length === 0, failed: failed.map((name) => ({ file: "tests/a.test.js", name })) } };
}

let corrSeq = 0;

function request(attemptId: string, standOnAttemptId: string | undefined, createdAt: number, avoid?: { path: string; lines: [number, number] }[]): Correction {
  corrSeq += 1;
  return { id: `c${corrSeq}`, attemptId, ...(standOnAttemptId ? { standOnAttemptId } : {}), kind: "region", rule: "R4-first-declared-stands-on", message: "Keep out.", constraints: avoid ? { avoidRegions: avoid } : {}, checkId: "ck", status: "delivered", createdAt };
}

function input(over: Partial<StewardInput> = {}): StewardInput {
  return {
    now: NOW,
    attempts: [attempt("a1", "g1"), attempt("a2", "g2"), attempt("a3", "g3")],
    agents: [
      { id: "g1", callsign: "KESTREL-7" },
      { id: "g2", callsign: "PETREL-2" },
      { id: "g3", callsign: "TERN-4" },
    ],
    intents: [
      { id: "i_a1", title: "Add a search box" },
      { id: "i_a2", title: "Round the price" },
      { id: "i_a3", title: "Add a tax" },
    ],
    corrections: [],
    logs: [],
    landings: [],
    queue: [],
    ...over,
  };
}

/** Every sentence of a finding is plain. */
function expectPlain(f: Finding) {
  for (const s of f.facts) expect(ste(s), s).toEqual([]);
}

describe("an agent stuck on the same failing test", () => {
  it("finds a test that failed in the last STUCK_RUNS runs in a row, and names the work copy", () => {
    const logs = [run("a1", NOW - 9 * MIN, ["works"]), run("a1", NOW - 6 * MIN, ["works", "other"]), run("a1", NOW - 3 * MIN, ["works"])];
    const [f, ...rest] = stuckTests(input({ logs }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ key: "stuck-test:a1", kind: "stuck-test", measure: STUCK_RUNS, attemptIds: ["a1"], intentId: "i_a1" });
    expect(f.facts[0]).toBe('KESTREL-7 ran the tests 3 times in a row. The test "works" in tests/a.test.js failed each time.');
    expect(f.facts[1]).toContain('"Add a search box"');
    expectPlain(f);
  });

  it("does not count a test that passed in between, fewer runs, or a work copy that closed", () => {
    const passedBetween = [run("a1", NOW - 9 * MIN, ["works"]), run("a1", NOW - 6 * MIN, []), run("a1", NOW - 3 * MIN, ["works"])];
    expect(stuckTests(input({ logs: passedBetween }))).toEqual([]);
    const two = [run("a1", NOW - 6 * MIN, ["works"]), run("a1", NOW - 3 * MIN, ["works"])];
    expect(stuckTests(input({ logs: two }))).toEqual([]);
    const three = [run("a1", NOW - 9 * MIN, ["works"]), run("a1", NOW - 6 * MIN, ["works"]), run("a1", NOW - 3 * MIN, ["works"])];
    expect(stuckTests(input({ logs: three, attempts: [attempt("a1", "g1", { status: "landed" })] }))).toEqual([]);
    // Runs older than the window do not count.
    const old = [run("a1", NOW - WINDOW_MS - 9 * MIN, ["works"]), run("a1", NOW - WINDOW_MS - 6 * MIN, ["works"]), run("a1", NOW - 3 * MIN, ["works"])];
    expect(stuckTests(input({ logs: old }))).toEqual([]);
  });

  it("names up to three tests, and the measure is the longest row", () => {
    const logs = [run("a1", NOW - 12 * MIN, ["works"]), run("a1", NOW - 9 * MIN, ["works", "b", "c", "d"]), run("a1", NOW - 6 * MIN, ["works", "b", "c", "d"]), run("a1", NOW - 3 * MIN, ["works", "b", "c", "d"])];
    const [f] = stuckTests(input({ logs }));
    expect(f.measure).toBe(4);
    expect(f.facts[0]).toBe('KESTREL-7 ran the tests 4 times in a row. 4 tests "works" in tests/a.test.js, "b" in tests/a.test.js, "c" in tests/a.test.js and 1 more failed each time.');
    expectPlain(f);
  });

  it("reads only the log entries of test runs", () => {
    const other: LogEntry = { id: "x", at: NOW, kind: "check", attemptId: "a1", message: "Conflict check", data: { checkId: "ck" } };
    expect(testRuns([other, run("a1", NOW - MIN, ["works"])])).toHaveLength(1);
  });
});

describe("change requests that bounce between the same two agents", () => {
  it("finds a pair whose side that adapts changed BOUNCE_FLIPS times", () => {
    const corrections = [request("a1", "a2", NOW - 20 * MIN), request("a2", "a1", NOW - 15 * MIN), request("a1", "a2", NOW - 10 * MIN), request("a2", "a1", NOW - 5 * MIN)];
    const [f, ...rest] = bouncingRequests(input({ corrections }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ key: "bounce:g1|g2", kind: "bounce", measure: BOUNCE_FLIPS, attemptIds: ["a2", "a1"], intentId: "i_a2" });
    expect(f.facts[0]).toBe("PETREL-2 and KESTREL-7 got 4 change requests about each other in 15 minutes. The side that adapts changed 3 times.");
    expectPlain(f);
  });

  it("does not count requests in one direction, requests with no other side, or old requests", () => {
    const oneWay = [request("a1", "a2", NOW - 20 * MIN), request("a1", "a2", NOW - 15 * MIN), request("a1", "a2", NOW - 10 * MIN), request("a1", "a2", NOW - 5 * MIN)];
    expect(bouncingRequests(input({ corrections: oneWay }))).toEqual([]);
    const alone = [request("a1", undefined, NOW - 20 * MIN), request("a2", undefined, NOW - 15 * MIN), request("a1", undefined, NOW - 10 * MIN), request("a2", undefined, NOW - 5 * MIN)];
    expect(bouncingRequests(input({ corrections: alone }))).toEqual([]);
    const old = [request("a1", "a2", NOW - WINDOW_MS - 20 * MIN), request("a2", "a1", NOW - WINDOW_MS - 15 * MIN), request("a1", "a2", NOW - 10 * MIN), request("a2", "a1", NOW - 5 * MIN)];
    expect(bouncingRequests(input({ corrections: old }))).toEqual([]);
  });
});

describe("a hot line range", () => {
  it("joins the ranges of HOT_REQUESTS requests that touch, and keys the place by the oldest request", () => {
    const corrections = [
      request("a1", "a2", NOW - 9 * MIN, [{ path: "src/price.js", lines: [12, 20] }]),
      request("a2", "a1", NOW - 6 * MIN, [{ path: "src/price.js", lines: [10, 14] }]),
      request("a3", "a1", NOW - 3 * MIN, [{ path: "src/price.js", lines: [21, 30] }]),
      // Another place in the same file, and another file: not hot.
      request("a1", "a3", NOW - 2 * MIN, [{ path: "src/price.js", lines: [80, 90] }]),
      request("a1", "a3", NOW - MIN, [{ path: "src/tax.js", lines: [1, 5] }]),
    ];
    const [f, ...rest] = hotLines(input({ corrections }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ key: "hot-lines:src/price.js:12", kind: "hot-lines", measure: HOT_REQUESTS, intentId: "i_a1" });
    expect(new Set(f.attemptIds)).toEqual(new Set(["a1", "a2", "a3"]));
    expect(f.facts[0]).toBe("3 change requests in 6 minutes name lines 10–30 of src/price.js.");
    expect(f.facts[1]).toBe("3 work copies change these lines: KESTREL-7, PETREL-2 and TERN-4. A smaller task for these lines may help.");
    expectPlain(f);
  });

  it("does not join ranges that are apart", () => {
    const corrections = [
      request("a1", "a2", NOW - 9 * MIN, [{ path: "src/price.js", lines: [1, 5] }]),
      request("a2", "a1", NOW - 6 * MIN, [{ path: "src/price.js", lines: [8, 12] }]),
      request("a3", "a1", NOW - 3 * MIN, [{ path: "src/price.js", lines: [15, 20] }]),
    ];
    expect(hotLines(input({ corrections }))).toEqual([]);
  });
});

describe("a flapping test", () => {
  it("finds a test whose result changed FLAP_FLIPS times in the runs of one work copy", () => {
    const logs = [run("a1", NOW - 12 * MIN, ["works"]), run("a1", NOW - 9 * MIN, []), run("a1", NOW - 6 * MIN, ["works"]), run("a1", NOW - 3 * MIN, [])];
    const [f, ...rest] = flappingTests(input({ logs }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ key: "flap:a1", kind: "flap", measure: FLAP_FLIPS, attemptIds: ["a1"], intentId: "i_a1" });
    expect(f.facts[0]).toBe("A test of KESTREL-7 passed and failed by turns in the last 4 test runs.");
    expect(f.facts[1]).toBe('The result of "works" in tests/a.test.js changed 3 times. A test that depends on time or order may be the cause.');
    expectPlain(f);
  });

  it("does not count a test that an agent fixed, or a test that is stuck", () => {
    const fixed = [run("a1", NOW - 12 * MIN, ["works"]), run("a1", NOW - 9 * MIN, ["works"]), run("a1", NOW - 6 * MIN, []), run("a1", NOW - 3 * MIN, [])];
    expect(flappingTests(input({ logs: fixed }))).toEqual([]);
    const stuck = [run("a1", NOW - 12 * MIN, ["works"]), run("a1", NOW - 9 * MIN, ["works"]), run("a1", NOW - 6 * MIN, ["works"]), run("a1", NOW - 3 * MIN, ["works"])];
    expect(flappingTests(input({ logs: stuck }))).toEqual([]);
  });
});

describe("a merge queue that does not move", () => {
  const ready = () => [attempt("a1", "g1", { status: "ready" }), attempt("a2", "g2", { status: "landing" })];

  it("finds work that waits longer than QUEUE_STILL_MS with no merge in that time", () => {
    const queue = [{ attemptId: "a1", at: NOW - 11 * MIN }, { attemptId: "a2", at: NOW - 2 * MIN }];
    const [f, ...rest] = stuckQueue(input({ attempts: ready(), queue, landings: [{ at: NOW - 12 * MIN }] }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ key: "queue", kind: "queue", measure: 11, attemptIds: ["a1", "a2"], intentId: "i_a1" });
    expect(f.facts[0]).toBe("The merge queue has 2 work copies. No merge happened in the last 11 minutes.");
    expect(f.facts[1]).toBe('The oldest is the work of KESTREL-7 on "Add a search box". A merge or a test run may be stuck.');
    expectPlain(f);
  });

  it("is quiet when a merge happened, when the work waits for the test budget, or when the wait is short", () => {
    const queue = [{ attemptId: "a1", at: NOW - 11 * MIN }];
    expect(stuckQueue(input({ attempts: ready(), queue, landings: [{ at: NOW - 5 * MIN }] }))).toEqual([]);
    const waits = [attempt("a1", "g1", { status: "ready", mergeWait: { until: NOW + 5 * MIN, message: "The test budget is used." } })];
    expect(stuckQueue(input({ attempts: waits, queue }))).toEqual([]);
    expect(stuckQueue(input({ attempts: ready(), queue: [{ attemptId: "a1", at: NOW - QUEUE_STILL_MS + MIN }] }))).toEqual([]);
    // A queue entry of work that left the queue states does not count.
    expect(stuckQueue(input({ attempts: [attempt("a1", "g1", { status: "landed" })], queue }))).toEqual([]);
  });
});

describe("all findings of a sweep", () => {
  it("joins the five counters, each fact with its own key", () => {
    const logs = [run("a1", NOW - 9 * MIN, ["works"]), run("a1", NOW - 6 * MIN, ["works"]), run("a1", NOW - 3 * MIN, ["works"]), run("a2", NOW - 12 * MIN, ["t"]), run("a2", NOW - 9 * MIN, []), run("a2", NOW - 6 * MIN, ["t"]), run("a2", NOW - 3 * MIN, [])];
    const corrections = [request("a1", "a2", NOW - 20 * MIN), request("a2", "a1", NOW - 15 * MIN), request("a1", "a2", NOW - 10 * MIN), request("a2", "a1", NOW - 5 * MIN)];
    const all = stewardFindings(input({ logs, corrections }));
    expect(all.map((f) => f.kind)).toEqual(["stuck-test", "bounce", "flap"]);
    expect(new Set(all.map((f) => f.key)).size).toBe(all.length);
    for (const f of all) expectPlain(f);
  });
});

describe("the one sentence of the model", () => {
  it("takes one plain sentence and gives it a period", () => {
    expect(plainSentence("KESTREL-7 fails the same test three times in a row")).toBe("KESTREL-7 fails the same test three times in a row.");
    expect(plainSentence('"The test works in tests/a.test.js fails each time."\n\nMore text.')).toBe("The test works in tests/a.test.js fails each time.");
  });

  it("refuses an empty answer, two sentences, more than 20 words, or an -ing word", () => {
    expect(plainSentence(null)).toBeNull();
    expect(plainSentence("   ")).toBeNull();
    expect(plainSentence("The test fails. The agent is stuck.")).toBeNull();
    expect(plainSentence(`The agent ${"ran ".repeat(20)}the tests.`)).toBeNull();
    expect(plainSentence("The agent keeps failing the same test.")).toBeNull();
    // An identifier or a quoted name that ends in -ing is not a word.
    expect(plainSentence('The test "parsing" in tests/parsing.test.js fails each time.')).not.toBeNull();
  });

  it("words a finding with the model, and stands back when the model fails", async () => {
    const f: Finding = { key: "k", kind: "stuck-test", measure: 3, attemptIds: ["a1"], intentId: "i", facts: ["KESTREL-7 ran the tests 3 times in a row."] };
    const asked: unknown[] = [];
    const good = async (messages: unknown) => {
      asked.push(messages);
      return "KESTREL-7 fails the same test in three runs.";
    };
    expect(await wordFinding(good, f)).toBe("KESTREL-7 fails the same test in three runs.");
    expect(JSON.stringify(asked[0])).toContain("KESTREL-7 ran the tests 3 times in a row.");
    expect(await wordFinding(async () => "I am thinking about it. The agent is failing.", f)).toBeNull();
    expect(await wordFinding(async () => null, f)).toBeNull();
    expect(
      await wordFinding(async () => {
        throw new Error("no model");
      }, f),
    ).toBeNull();
    expect(await wordFinding(undefined, f)).toBeNull();
  });
});

describe("a note of the steward in the inbox", () => {
  it("has the headline of the steward and the one answer Seen", () => {
    const q: Question = { id: "q_1", kind: "steward", status: "open", intentId: "i1", attemptIds: ["a1"], fact: "stuck-test:a1", measure: 3, facts: ["KESTREL-7 ran the tests 3 times in a row."], options: [...STEWARD_OPTIONS], askedAt: 40, updatedAt: 40 };
    const items = inboxOf({ project: "shop", rule: "sender", intents: [{ id: "i1", title: "Add a search box", status: "underway", updatedAt: 9 }] as never, attempts: [attempt("a1", "g1")], agents: [{ id: "g1", callsign: "KESTREL-7" }], questions: [q] }, { id: "u_robin", role: "owner" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "q:q_1", kind: "question", headline: "A note from the steward", why: q.facts, questionId: "q_1", actions: [{ id: "seen", label: "Seen", primary: true }] });
    expect(questionHeadline("steward")).toBe("A note from the steward");
    expect(ste(items[0].headline)).toEqual([]);
  });
});

/* ───────────────────────── the loop in the project object ───────────────────────── */

const OWNER = { id: "u_robin", name: "Robin", role: "owner" as const };
const REPLY = "KESTREL-7 fails the same test in three runs.";

type Internals = {
  attempts: Map<string, Attempt>;
  questions: Map<string, Question>;
  logs: { message: string }[];
  putAttempt(a: Attempt): void;
  stewardSweep(force?: boolean): Promise<void>;
};

let world: CrashWorld;
let asked: { model: string; input: Record<string, unknown> }[];

/** The test runner: the test "works" of every test file fails. */
const FAILING_LOADER = {
  get: (_id: string, getCode: () => unknown) => ({
    getEntrypoint: () => ({
      fetch: async () => {
        const code = (await getCode()) as { modules: Record<string, unknown> };
        const files = Object.keys(code.modules).filter((m) => /^tests\/.+\.test\.m?js$/.test(m));
        return Response.json(files.map((file) => ({ file, name: "works", ok: false, error: "expected 2, got 1", ms: 1 })));
      },
    }),
  }),
};

async function start(opts: { model?: "ok" | "fails"; steward?: boolean } = {}) {
  asked = [];
  const ai = {
    run: async (model: string, input: Record<string, unknown>) => {
      asked.push({ model, input });
      if (opts.model === "fails") throw new Error("the model is down");
      return { choices: [{ message: { role: "assistant", content: REPLY }, finish_reason: "stop" }] };
    },
  };
  world = new CrashWorld({ AI: ai, LOADER: FAILING_LOADER });
  await world.start({ settings: { decisionModel: "rules", ...(opts.steward === false ? {} : { steward: true }) } });
}

const inner = () => world.harbor as unknown as Internals;
const inbox = () => world.harbor.inbox(OWNER);
const notes = () => [...inner().questions.values()].filter((q) => q.kind === "steward");

afterEach(async () => {
  await world?.settle();
});

describe("the steward in the project object", () => {
  it("puts one note in the inbox for a stuck test, once, and Seen closes it", async () => {
    await start();
    const t = await world.startTask("alpha");
    for (let n = 0; n < STUCK_RUNS; n++) await world.harbor.check(t.attemptId);
    // The alarm runs the sweep. The model words the finding with little reasoning.
    await world.harbor.alarm();
    await world.settle();
    const items = await inbox();
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toMatchObject({ kind: "question", headline: "A note from the steward", intentId: t.intentId, attemptId: t.attemptId, actions: [{ id: "seen", label: "Seen", primary: true }] });
    expect(item.why[0]).toBe(REPLY);
    expect(item.why[1]).toMatch(/ran the tests 3 times in a row\. The test "works" in tests\/a\.test\.js failed each time\./);
    expect(asked).toHaveLength(1);
    expect(asked[0].model).toBe(SHORT_JOB_MODEL);
    expect(asked[0].input.reasoning_effort).toBe("low");
    expect(inner().logs.some((l) => l.message === `The steward noticed: ${REPLY}`)).toBe(true);
    // The same fact again: no second note, and no second model call.
    await inner().stewardSweep(true);
    expect(await inbox()).toHaveLength(1);
    expect(asked).toHaveLength(1);
    // Seen: the note closes, and nothing else changes.
    const res = await world.harbor.answerQuestion(item.questionId!, { option: "seen" }, OWNER);
    expect(res).toMatchObject({ outcome: "answered", message: "The note is closed." });
    expect(steViolations(res.message)).toEqual([]);
    expect(await inbox()).toEqual([]);
    expect(world.status(t.attemptId)).toBe("underway");
    // The fact stays: no new note until the measure doubles.
    await inner().stewardSweep(true);
    expect(await inbox()).toEqual([]);
    for (let n = 0; n < STUCK_RUNS; n++) await world.harbor.check(t.attemptId);
    await inner().stewardSweep(true);
    const again = await inbox();
    expect(again).toHaveLength(1);
    expect(again[0].why[1]).toContain("ran the tests 6 times in a row");
    expect(notes()).toHaveLength(2);
  });

  it("shows the finding with the template sentence when the model fails", async () => {
    await start({ model: "fails" });
    const t = await world.startTask("beta");
    for (let n = 0; n < STUCK_RUNS; n++) await world.harbor.check(t.attemptId);
    await inner().stewardSweep(true);
    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0].why[0]).toMatch(/^[A-Z]+-\d+ ran the tests 3 times in a row\./);
    expect(asked).toHaveLength(1);
  });

  it("does nothing while the setting is off, and the setting takes only true or false", async () => {
    await start({ steward: false });
    const t = await world.startTask("gamma");
    for (let n = 0; n < STUCK_RUNS; n++) await world.harbor.check(t.attemptId);
    await world.harbor.alarm();
    await inner().stewardSweep(true);
    expect(await inbox()).toEqual([]);
    expect(asked).toEqual([]);
    expect((await world.harbor.state()).project.settings.steward).toBe(false);
    await world.harbor.updateSettings({ steward: "yes" as never });
    expect((await world.harbor.state()).project.settings.steward).toBe(false);
    await world.harbor.updateSettings({ steward: true });
    expect((await world.harbor.state()).project.settings.steward).toBe(true);
    // On: the alarm is set for the first sweep.
    expect(world.alarm).not.toBeNull();
    await inner().stewardSweep(true);
    expect(await inbox()).toHaveLength(1);
  });

  it("closes the note when the work copy of the fact closes", async () => {
    await start();
    const t = await world.startTask("delta");
    for (let n = 0; n < STUCK_RUNS; n++) await world.harbor.check(t.attemptId);
    await inner().stewardSweep(true);
    expect(await inbox()).toHaveLength(1);
    const a = inner().attempts.get(t.attemptId)!;
    a.status = "abandoned";
    inner().putAttempt(a);
    expect(await inbox()).toEqual([]);
    expect(notes()[0]).toMatchObject({ status: "closed", closed: "The work of this note closed." });
  });
});
