/**
 * Replay: the mapping from timeline records to steps (kind, stage, caption), the world after each step,
 * the playback schedule and the map effects. All pure functions, so the same history always plays the
 * same way. The fixture is the history of a real run (test/harbor/timeline.test.ts): two agents on one
 * file, a change request, a merge and the other work moved onto the new main.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentInfo, Attempt, CheckRun, Correction, CourseCheck, Landing, LogEntry } from "../../src/core/types";
import { timelineCursor, type TimelineIntent, type TimelineRecord } from "../../src/core/timeline";
import {
  buildScript,
  DWELL_MS,
  effectOf,
  effectsAt,
  EFFECT_MS,
  firstSentences,
  holdOf,
  indexAt,
  MAX_GAP_MS,
  OUTRO_MS,
  progressOf,
  retime,
  scheduleOf,
  stageOf,
  worldAt,
  type ReplayScript,
} from "../../web/src/views/replay/model";
import { checkCaption, fileList, nameList, STAGE_LINE, STAGE_NAME, STAGES, testsCaption } from "../../web/src/views/replay/captions";
import { steViolations } from "../coord/ste";

/* ───────────── the fixture ───────────── */

const MAIN0 = "2944fa8".padEnd(40, "0");
const MAIN1 = "d07b40d".padEnd(40, "1");
const SHOUT = ["src/shout.js", "tests/shout.test.js"];

const agents: AgentInfo[] = [
  { id: "robin-a", callsign: "KESTREL-4", kind: "mcp", client: "test", color: 0, status: "idle", lastSeen: 0 },
  { id: "robin-b", callsign: "HERON-2", kind: "mcp", client: "test", color: 1, status: "underway", lastSeen: 0 },
];

function intent(id: string, title: string, at: number, by: string): TimelineIntent {
  return {
    id,
    title,
    goal: `${title}.`,
    constraints: [],
    checks: [],
    priority: "normal",
    status: "open",
    version: 1,
    amendments: [],
    createdBy: { kind: "agent", id: by, name: agents.find((g) => g.id === by)!.callsign },
    createdAt: at,
    updatedAt: at,
    source: { kind: "mcp" },
  };
}

function run(id: string, scope: CheckRun["scope"], at: number, ms: number): CheckRun {
  return {
    id,
    subject: id,
    scope,
    ok: true,
    passed: 2,
    failed: 0,
    cases: [
      { file: "tests/greet.test.js", name: "greets", ok: true, ms: 1 },
      { file: "tests/shout.test.js", name: "shouts", ok: true, ms: 1 },
    ],
    ms,
    at,
    ran: 2,
  };
}

function attempt(id: string, agentId: string, intentId: string, at: number, files: string[], extra: Partial<Attempt> = {}): Attempt {
  return {
    id,
    intentId,
    agentId,
    fork: { repo: `shop-${id}` },
    mode: "api",
    baseSha: MAIN0,
    baseTree: "t0",
    status: "declared",
    course: { plan: ["Add shout"], files, symbols: ["src/shout.js#shout"], approach: "New file.", declaredAt: at },
    footprint: { files: {}, symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] }, computedAt: at },
    corrections: [],
    lineage: { generation: 1 },
    stats: { filesChanged: 0, additions: 0, deletions: 0, steps: 0 },
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

const log = (seq: number, at: number, kind: LogEntry["kind"], message: string, extra: Partial<LogEntry> = {}): LogEntry => ({ id: `lg_${seq}`, at, kind, message, ...extra });

const checkClear: CourseCheck = { id: "cc_1", attemptId: "a_one", trigger: "declare", verdict: "clear", assessments: [], facts: [], source: "rules", confidence: 1, latencyMs: 7, at: 1020 };
const checkHit: CourseCheck = {
  id: "cc_2",
  attemptId: "a_two",
  trigger: "declare",
  verdict: "correct",
  facts: [
    {
      otherAttemptId: "a_one",
      otherAgentId: "robin-a",
      otherIntentId: "i_shout",
      otherState: "active",
      sharedFiles: ["src/shout.js"],
      sharedSymbols: ["src/shout.js#shout"],
      interfaceHits: [],
      hunkOverlaps: [{ path: "src/shout.js", incoming: [1, 3], other: [1, 4] }],
      range: 0,
      closing: false,
      intentSimilarity: 0.2,
    },
  ],
  assessments: [{ otherAttemptId: "a_one", collision: 0.9, interference: 2, duplicate: 0.1, giveWay: "incoming", giveWayConfidence: 0.9, rule: "R4-first-declared-stands-on" }],
  source: "rules",
  confidence: 0.9,
  latencyMs: 15,
  at: 1196,
};
const sameLines: Correction = {
  id: "cr_1",
  attemptId: "a_two",
  standOnAttemptId: "a_one",
  kind: "region",
  rule: "R4-first-declared-stands-on",
  message: "KESTREL-4 edits line 1 of src/shout.js. Do not edit this line. Continue your work.",
  constraints: { avoidRegions: [{ path: "src/shout.js", lines: [1, 3] }] },
  checkId: "cc_2",
  status: "acknowledged",
  createdAt: 1202,
  deliveredAt: 1203,
  acknowledgedAt: 1400,
};
const upstream: Correction = {
  id: "cr_2",
  attemptId: "a_two",
  standOnAttemptId: "a_one",
  kind: "upstream",
  rule: "R1-landed-has-way",
  message: 'The task "Shout" merged into main. Read src/shout.js again before your next edit. Continue your work.',
  constraints: {},
  checkId: "landing",
  status: "pending",
  createdAt: 2850,
};
const landing: Landing = {
  id: "ld_1",
  attemptId: "a_one",
  intentId: "i_shout",
  agentId: "robin-a",
  method: "fast-forward",
  mainBefore: MAIN0,
  mainAfter: MAIN1,
  checks: run("chk_2", "composed", 2694, 76),
  correctionsApplied: 0,
  at: 2823,
  message: "Shout",
};

function records(): TimelineRecord[] {
  const one = attempt("a_one", "robin-a", "i_shout", 1002, SHOUT, {
    status: "landed",
    checks: run("chk_1", "attempt", 2599, 1200),
    composedChecks: landing.checks,
    footprint: { files: { "src/shout.js": { status: "A", hunks: [], additions: 4, deletions: 0 }, "tests/shout.test.js": { status: "A", hunks: [], additions: 3, deletions: 0 } }, symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] }, computedAt: 1115 },
    updatedAt: 2823,
    landedAt: 2823,
  });
  const two = attempt("a_two", "robin-b", "i_whisper", 1180, ["src/shout.js"]);
  const logs: LogEntry[] = [
    log(1, 900, "system", "Project ready. Main is 2944fa8 in Cloudflare Artifacts (shop)."),
    log(2, 905, "system", "Settings change: landing."),
    log(3, 1001, "intent", 'KESTREL-4 opens the task "Shout" (from mcp KESTREL-4).', { intentId: "i_shout" }),
    log(4, 1004, "declare", 'KESTREL-4 sends a plan for "Shout": New file.', { attemptId: "a_one", files: SHOUT }),
    log(5, 1021, "check", "Conflict check (plan): clear.", { attemptId: "a_one", data: { checkId: "cc_1" } }),
    log(6, 1115, "write", "KESTREL-4 writes src/shout.js, tests/shout.test.js: Add shout.", { attemptId: "a_one", intentId: "i_shout", files: SHOUT }),
    log(7, 1197, "check", "Conflict check (plan): change request.", { attemptId: "a_two", data: { checkId: "cc_2" } }),
    log(8, 1202, "correction", "Change request for HERON-2.", { attemptId: "a_two", data: { correctionId: "cr_1" } }),
    log(9, 1272, "push", "The work of KESTREL-4 is in its work copy shop-a_one at 40c56b7.", { attemptId: "a_one", intentId: "i_shout", files: SHOUT }),
    log(10, 1400, "ack", "HERON-2 acknowledges cr_1: I moved my change below line 3.", { attemptId: "a_two", intentId: "i_whisper" }),
    log(11, 2599, "check", "KESTREL-4 tests: 2/2 pass.", { attemptId: "a_one", intentId: "i_shout", data: { checkRunId: "chk_1", ok: true } }),
    log(12, 2603, "submit", 'KESTREL-4 submits "Shout": All tests pass. The work copy is in the merge queue.', { attemptId: "a_one", intentId: "i_shout" }),
    log(13, 2842, "land", '"Shout" merged into main by fast-forward (d07b40d).', { attemptId: "a_one", files: SHOUT }),
    log(14, 2851, "replot", "gitring rebases the work of HERON-2 onto main d07b40d. Their files do not overlap the merged change."),
  ];
  const out: TimelineRecord[] = [
    { kind: "intent", at: 1000, cursor: "", intent: intent("i_shout", "Shout", 1000, "robin-a") },
    { kind: "intent", at: 1179, cursor: "", intent: intent("i_whisper", "Whisper", 1179, "robin-b") },
    { kind: "attempt", at: 1002, cursor: "", attempt: one },
    { kind: "attempt", at: 1180, cursor: "", attempt: two },
    { kind: "check", at: 1020, cursor: "", check: checkClear },
    { kind: "check", at: 1196, cursor: "", check: checkHit },
    { kind: "correction", at: 1202, cursor: "", correction: sameLines },
    { kind: "correction", at: 2850, cursor: "", correction: upstream },
    { kind: "landing", at: 2823, cursor: "", landing },
    ...logs.map((l, i): TimelineRecord => ({ kind: "log", at: l.at, cursor: "", log: l })),
  ];
  return out.map((r) => ({ ...r, cursor: timelineCursor(r.at, r.kind, r.kind === "log" ? String(r.log.id) : "x") }));
}

let script: ReplayScript;
const at = (id: string) => script.steps.findIndex((s) => s.id === id);

beforeAll(() => {
  script = buildScript(records(), agents);
});

/* ───────────── records → steps ───────────── */

describe("steps", () => {
  it("come in history order, one per event, without the records that another record tells", () => {
    expect(script.steps.map((s) => s.kind)).toEqual([
      "note", // the project is ready
      "task",
      "plan",
      "check",
      "work",
      "task",
      "plan",
      "check",
      "request",
      "work",
      "ack",
      "tests",
      "submit",
      "lease",
      "compose",
      "composed",
      "commit",
      "request",
      "replot",
    ]);
    // Plans, conflict checks, change requests and merges come from their records, not from the log lines.
    expect(script.steps.filter((s) => s.id.startsWith("log:")).map((s) => s.kind)).toEqual(["note", "work", "work", "tests", "submit", "replot"]);
    const times = script.steps.map((s) => s.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("puts each step on its stage of the pipeline", () => {
    for (const s of script.steps) expect(s.stage).toBe(stageOf(s.kind));
    const stage = (kind: string) => script.steps.find((s) => s.kind === kind)!.stage;
    expect([stage("task"), stage("plan"), stage("check"), stage("request"), stage("work"), stage("tests")]).toEqual(["task", "plan", "check", "request", "work", "tests"]);
    expect([stage("submit"), stage("lease"), stage("composed"), stage("compose"), stage("commit"), stage("replot")]).toEqual(["queue", "queue", "composed", "compose", "commit", "replot"]);
  });

  it("derives the merge: the lease after the submit, compose, tests on main plus the work, then the commit", () => {
    const [submit, lease, compose, composed, commit] = ["submit", "lease", "compose", "composed", "commit"].map((k) => script.steps.find((s) => s.kind === k)!);
    expect(lease.at).toBe(2694 - 76 - 2);
    expect(lease.at).toBeGreaterThan(submit.at);
    expect(compose.at).toBe(lease.at + 1);
    expect(composed.at).toBe(2694);
    expect(commit.at).toBe(2823);
    expect(composed.tests).toMatchObject({ scope: "composed", passed: 2, total: 2, ok: true });
    expect(commit.files).toEqual(SHOUT);
    expect(commit.landing?.mainAfter).toBe(MAIN1);
  });

  it("says each step in one plain caption", () => {
    const caption = (id: string) => script.steps[at(id)].caption;
    expect(caption("task:i_shout")).toBe('KESTREL-4 opens the task "Shout".');
    expect(caption("plan:a_one")).toBe('KESTREL-4 sends a plan for "Shout". The plan names 2 files.');
    expect(caption("check:cc_1")).toBe("Conflict check for KESTREL-4: no other work is near. The plan is clear.");
    expect(caption("check:cc_2")).toBe("Conflict check for HERON-2: distance 0, same lines with KESTREL-4. HERON-2 must adapt.");
    expect(caption("request:cr_1")).toBe("gitring sends a change request to HERON-2: keep out of the same lines. KESTREL-4 continues.");
    expect(caption("request:cr_2")).toBe("Main moved. gitring sends a change request to HERON-2: read the merged change.");
    expect(caption("lease:ld_1")).toBe("The merge queue gives the lease to KESTREL-4. One merge runs at a time.");
    expect(caption("compose:ld_1")).toBe("Main did not move. gitring puts the work of KESTREL-4 on top of main: a fast-forward.");
    expect(caption("composed:ld_1")).toBe("gitring tests main plus the work of KESTREL-4: 2 of 2 tests pass.");
    expect(caption("commit:ld_1")).toBe('"Shout" is on main now as commit d07b40d. Its why-record goes into git notes.');
    const kinds = (k: string) => script.steps.filter((s) => s.kind === k).map((s) => s.caption);
    expect(kinds("work")).toEqual(["KESTREL-4 writes src/shout.js and tests/shout.test.js.", "gitring saves the work of KESTREL-4 as a commit in its work copy."]);
    expect(kinds("ack")).toEqual(["HERON-2 applies the change request and confirms it."]);
    expect(kinds("tests")).toEqual(["gitring tests the work of KESTREL-4 alone: 2 of 2 tests pass."]);
    expect(kinds("submit")).toEqual(['KESTREL-4 submits "Shout". The work goes into the merge queue.']);
    expect(kinds("replot")).toEqual(["Main moved. gitring moves the work of HERON-2 onto the new main."]);
  });

  it("keeps the words of agents as quotes, apart from the caption", () => {
    const ack = script.steps.find((s) => s.kind === "ack")!;
    expect(ack.quote).toBe("I moved my change below line 3.");
    expect(ack.detail).toBe("cr_1");
    expect(script.steps.find((s) => s.kind === "work")!.quote).toBe("Add shout.");
    expect(script.steps[at("plan:a_one")].quote).toBe("New file.");
  });

  it("follows ASD-STE100 in every caption and in the stage texts", () => {
    const problems = [...script.steps.map((s) => s.caption), ...STAGES.map((s) => STAGE_LINE[s]), ...STAGES.map((s) => STAGE_NAME[s])].flatMap((t) => steViolations(t));
    expect(problems).toEqual([]);
    // Other verdicts, distances and test results too.
    const more = [
      checkCaption({ agent: "TERN-3", verdict: "merge-intents", other: "SKUA-5" }),
      checkCaption({ agent: "TERN-3", verdict: "escalate", range: 1, other: "SKUA-5" }),
      ...([0, 1, 2, 3, 4, 5] as const).map((range) => checkCaption({ agent: "TERN-3", verdict: "clear", range, other: "SKUA-5" })),
      testsCaption("TERN-3", "attempt", 1, 3, false),
      testsCaption("TERN-3", "composed", 0, 1, false),
    ];
    expect(more.flatMap((t) => steViolations(t))).toEqual([]);
  });

  it("names lists of files and agents in plain words", () => {
    expect(fileList([])).toBe("no file");
    expect(fileList(["a.js", "b.js", "c.js", "d.js"])).toBe("a.js, b.js and 2 more files");
    expect(nameList(["TERN-3", "SKUA-5", "AUK-2"])).toBe("TERN-3, SKUA-5 and AUK-2");
    expect(firstSentences("One. Two. Three.", 2)).toBe("One. Two.");
  });

  it("is the same script for the same records, in any order", () => {
    const again = buildScript([...records()].reverse(), [...agents].reverse());
    expect(again.steps).toEqual(script.steps);
  });
});

/* ───────────── the world after a step ───────────── */

describe("world", () => {
  it("is empty before the first step", () => {
    const w = worldAt(script, -1);
    expect(w).toMatchObject({ index: -1, vessels: [], tasks: [], buoys: [], queue: [], lease: null, commits: [] });
    expect(w.mainSha).toBe(MAIN0);
  });

  it("shows a plan offshore, then the agent on the files it writes", () => {
    let w = worldAt(script, at("plan:a_one"));
    expect(w.vessels.map((v) => [v.callsign, v.status, v.file, v.course])).toEqual([["KESTREL-4", "declared", null, SHOUT]]);
    expect(w.tasks).toEqual([{ id: "i_shout", title: "Shout", state: "working", at: 1000 }]);
    w = worldAt(script, script.steps.findIndex((s) => s.kind === "work"));
    expect(w.vessels[0]).toMatchObject({ status: "underway", file: "tests/shout.test.js", track: SHOUT, course: [] });
  });

  it("draws the distance of a conflict, then marks it as handled by a change request", () => {
    let w = worldAt(script, at("check:cc_2"));
    expect(w.ranges).toEqual([expect.objectContaining({ a: "a_two", b: "a_one", range: 0, tone: "danger" })]);
    expect(w.vessels.find((v) => v.attemptId === "a_two")!.lastVerdict).toBe("correct");
    w = worldAt(script, at("request:cr_1"));
    expect(w.ranges[0].tone).toBe("correction");
    expect(w.buoys).toEqual([expect.objectContaining({ id: "cr_1", attemptId: "a_two", file: "src/shout.js", done: false, fromCallsign: "KESTREL-4" })]);
    w = worldAt(script, script.steps.findIndex((s) => s.kind === "ack"));
    expect(w.buoys[0].done).toBe(true);
    expect(w.counts).toMatchObject({ checks: 2, requests: 1, acks: 1 });
  });

  it("moves the work through the merge queue: queued, the lease, merged", () => {
    let w = worldAt(script, script.steps.findIndex((s) => s.kind === "submit"));
    expect(w.queue).toEqual(["a_one"]);
    expect(w.lease).toBeNull();
    expect(w.vessels.find((v) => v.attemptId === "a_one")!.status).toBe("ready");
    w = worldAt(script, at("lease:ld_1"));
    expect(w.queue).toEqual([]);
    expect(w.lease).toBe("a_one");
    expect(w.vessels.find((v) => v.attemptId === "a_one")!.status).toBe("landing");
    w = worldAt(script, at("commit:ld_1"));
    expect(w.lease).toBeNull();
    expect(w.vessels.map((v) => v.attemptId)).toEqual(["a_two"]);
    expect(w.mainSha).toBe(MAIN1);
    expect(w.commits).toEqual([{ sha: MAIN1, title: "Shout", method: "fast-forward", attemptId: "a_one", at: 2823 }]);
    expect(w.tasks.map((t) => [t.title, t.state])).toEqual([
      ["Shout", "merged"],
      ["Whisper", "working"],
    ]);
    expect(w.counts.merges).toBe(1);
    // The other work stays on the map, with the change request that main moved.
    w = worldAt(script, script.steps.length - 1);
    expect(w.buoys.map((b) => b.id)).toEqual(["cr_1", "cr_2"]);
  });
});

/* ───────────── schedule ───────────── */

describe("schedule", () => {
  it("starts after the title card and moves forward at every step", () => {
    const s = scheduleOf(script.steps, 10, 2000);
    expect(s.starts[0]).toBe(2000);
    for (let i = 1; i < s.starts.length; i++) expect(s.starts[i]).toBeGreaterThan(s.starts[i - 1]);
    expect(s.end).toBe(s.starts[s.starts.length - 1] + holdOf(script.steps[script.steps.length - 1], 10) + OUTRO_MS);
  });

  it("holds each step long enough to read, and cuts idle time", () => {
    const steps = [
      { ...script.steps[1], at: 0, weight: 3 as const },
      { ...script.steps[2], at: 1, weight: 1 as const },
      { ...script.steps[3], at: 1 + 10 * 60_000, weight: 1 as const },
    ];
    const s = scheduleOf(steps, 1);
    expect(s.starts[1] - s.starts[0]).toBe(DWELL_MS[3]);
    expect(s.starts[2] - s.starts[1]).toBe(MAX_GAP_MS);
    // Faster plays the same history in less time, and the holds shrink less than the gaps.
    const fast = scheduleOf(steps, 120);
    expect(fast.end).toBeLessThan(s.end);
    expect(fast.starts[1] - fast.starts[0]).toBeGreaterThan(DWELL_MS[3] / 120);
  });

  it("finds the step at a wall time, its progress, and the same place at another speed", () => {
    const s = scheduleOf(script.steps, 5, 1000);
    expect(indexAt(s, 0)).toBe(-1);
    expect(indexAt(s, 1000)).toBe(0);
    const i = at("check:cc_2");
    const mid = (s.starts[i] + s.starts[i + 1]) / 2;
    expect(indexAt(s, mid)).toBe(i);
    expect(progressOf(s, i, mid)).toBeCloseTo(0.5, 5);
    const fast = scheduleOf(script.steps, 60, 1000);
    const there = retime(s, fast, mid);
    expect(indexAt(fast, there)).toBe(i);
    expect(progressOf(fast, i, there)).toBeCloseTo(0.5, 5);
    expect(retime(s, fast, s.end)).toBe(fast.end);
  });
});

/* ───────────── map effects ───────────── */

describe("effects", () => {
  it("gives each kind of step its effect and tone", () => {
    const of = (id: string) => effectOf(script.steps[at(id)]);
    expect(of("plan:a_one")).toEqual({ kind: "course", tone: "accent" });
    expect(of("check:cc_1")).toEqual({ kind: "sweep", tone: "accent" });
    expect(of("check:cc_2")).toEqual({ kind: "sweep", tone: "magenta" });
    expect(of("request:cr_1")).toEqual({ kind: "flight", tone: "magenta" });
    expect(of("composed:ld_1")).toEqual({ kind: "ring", tone: "clear" });
    expect(of("lease:ld_1")).toEqual({ kind: "lease", tone: "accent" });
    expect(of("commit:ld_1")).toEqual({ kind: "commit", tone: "clear" });
    expect(of("task:i_shout")).toBeNull();
    expect(effectOf({ ...script.steps[at("composed:ld_1")], tests: { scope: "composed", passed: 1, total: 2, ok: false } })).toEqual({ kind: "ring", tone: "danger" });
  });

  it("runs a change request flight from its start for its duration, then ends it", () => {
    const s = scheduleOf(script.steps, 1, 0);
    const i = at("request:cr_1");
    const flight = (wall: number) => effectsAt(script, s, wall).find((e) => e.id === "request:cr_1");
    expect(flight(s.starts[i] - 1)).toBeUndefined();
    expect(flight(s.starts[i])?.p).toBe(0);
    expect(flight(s.starts[i] + EFFECT_MS.flight / 2)?.p).toBeCloseTo(0.5, 5);
    expect(flight(s.starts[i] + EFFECT_MS.flight)).toBeUndefined();
    // Effects come oldest first.
    const list = effectsAt(script, s, s.starts[i] + 10);
    expect(list.map((e) => script.steps.findIndex((x) => x.id === e.id))).toEqual([...list.map((e) => script.steps.findIndex((x) => x.id === e.id))].sort((a, b) => a - b));
  });
});

/* ───────────── route and speed ───────────── */

describe("route", () => {
  beforeAll(() => {
    (globalThis as { location?: unknown }).location = { pathname: "/replay", search: "?project=shop&autoplay=1", hash: "" };
  });

  it("opens /replay as a project view and keeps the project in links", async () => {
    const { parseRoute, isProjectRoute, href } = await import("../../web/src/app/router");
    expect(parseRoute("/replay")).toEqual({ name: "replay" });
    expect(parseRoute("/replay/")).toEqual({ name: "replay" });
    expect(isProjectRoute({ name: "replay" })).toBe(true);
    expect(href("/replay")).toBe("/replay?project=shop");
  });

  it("reads the speed of the address as the nearest speed of the controls", async () => {
    const { nearestSpeed } = await import("../../web/src/views/replay/clock");
    expect(nearestSpeed("25")).toBe(30);
    expect(nearestSpeed("120")).toBe(120);
    expect(nearestSpeed("1000")).toBe(120);
    expect(nearestSpeed("abc")).toBe(10);
    expect(nearestSpeed(null)).toBe(10);
  });
});
