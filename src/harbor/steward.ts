/**
 * The steward: a watch on a project while agents work. Every few minutes the project object counts the
 * facts in its records (the test runs, the change requests, the merge queue) and reports a real anomaly to
 * the inbox in plain words (a Question of kind "steward", with the one answer "Seen"):
 *
 *   stuck-test   a work copy ran its tests again and again, and the same test failed each time
 *   bounce       change requests go back and forth between the same two agents
 *   hot-lines    many change requests name the same lines of one file
 *   flap         a test of one work copy passes and fails by turns
 *   queue        the merge queue has work, and no merge happened for a long time
 *
 * Facts first: the counters here are pure and decide alone. A model (GLM 5.3 Flash) only words a finding
 * into one plain sentence; when it fails, the template sentence stands. Everything a person reads follows
 * ASD-STE100: short sentences, one meaning per word.
 */
import type { AgentInfo, Attempt, Correction, Intent, Landing, LineRange, LogEntry } from "../core/types";
import { chat, SHORT_JOB_MODEL, type AiLike, type ChatMessage } from "../platform/ai/models";

export type StewardKind = "stuck-test" | "bounce" | "hot-lines" | "flap" | "queue";

export interface Finding {
  /** The same fact gives the same key: one open note for one fact. */
  key: string;
  kind: StewardKind;
  /** How large the fact is: a count of runs or requests, or minutes. A note that a person saw comes back when this doubles. */
  measure: number;
  /** The work copies of the fact. The first one names the task of the note. */
  attemptIds: string[];
  intentId: string;
  /** Plain sentences: what gitring counted. The first one is the template sentence of the note. */
  facts: string[];
}

/** A test that failed in a test run, as the log of the run records it (`data.failed`). */
export interface FailedCase {
  file: string;
  name: string;
}

/** One test run of a work copy, read from the log. */
export interface TestRun {
  attemptId: string;
  at: number;
  ok: boolean;
  failed: FailedCase[];
}

export interface StewardInput {
  now: number;
  attempts: Attempt[];
  agents: Pick<AgentInfo, "id" | "callsign">[];
  intents: Pick<Intent, "id" | "title">[];
  corrections: Correction[];
  /** The recent log. A test run of a work copy is an entry of kind "check" with `data.failed` (see testRuns). */
  logs: LogEntry[];
  landings: Pick<Landing, "at">[];
  /** The merge queue, oldest first: the work copy and when it entered. */
  queue: { attemptId: string; at: number }[];
}

/* ───────────────────────── the limits ───────────────────────── */

/** The same test failed in this many test runs of a work copy in a row. */
export const STUCK_RUNS = 3;
/** The side that adapts changed this many times between two agents (four requests). */
export const BOUNCE_FLIPS = 3;
/** This many change requests name the same lines of one file. */
export const HOT_REQUESTS = 3;
/** A test went from pass to fail or back this many times in the runs of one work copy. */
export const FLAP_FLIPS = 3;
/** The merge queue has work, and no merge happened in this time. */
export const QUEUE_STILL_MS = 10 * 60_000;
/** Older facts do not count. */
export const WINDOW_MS = 2 * 3600_000;
/** How many tests of a work copy one note names. */
const NAMED_TESTS = 3;

/* ───────────────────────── small helpers ───────────────────────── */

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** `"works" in tests/a.test.js` */
function testName(c: FailedCase): string {
  return `"${c.name}" in ${c.file}`;
}

/** "a, b and c" for up to three items, then "and N more". */
function listOf(items: string[], max = 3): string {
  if (items.length <= max) return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

function caseKey(c: FailedCase): string {
  return `${c.file}\u0000${c.name}`;
}

/** The test runs in the log (kind "check" with `data.failed`), oldest first. */
export function testRuns(logs: LogEntry[]): TestRun[] {
  const out: TestRun[] = [];
  for (const l of logs) {
    if (l.kind !== "check" || !l.attemptId || !Array.isArray(l.data?.failed)) continue;
    const failed = (l.data.failed as unknown[])
      .filter((c): c is FailedCase => Boolean(c) && typeof (c as FailedCase).file === "string" && typeof (c as FailedCase).name === "string")
      .map((c) => ({ file: c.file, name: c.name }));
    out.push({ attemptId: l.attemptId, at: l.at, ok: l.data!.ok === true, failed });
  }
  return out.sort((a, b) => a.at - b.at);
}

interface Names {
  callsign: (attemptId: string) => string;
  title: (intentId: string) => string;
  intentOf: (attemptId: string) => string;
}

function namesOf(i: StewardInput): Names {
  const attempt = new Map(i.attempts.map((a) => [a.id, a]));
  const agent = new Map(i.agents.map((g) => [g.id, g.callsign]));
  const intent = new Map(i.intents.map((t) => [t.id, t.title]));
  return {
    callsign: (id) => {
      const a = attempt.get(id);
      return (a && agent.get(a.agentId)) ?? "An agent";
    },
    title: (id) => intent.get(id) ?? "a task",
    intentOf: (id) => attempt.get(id)?.intentId ?? "",
  };
}

const ENDED: ReadonlySet<Attempt["status"]> = new Set(["landed", "abandoned", "alternate", "failed", "stale"]);

/** The work copies that still work, and their runs inside the window, grouped by work copy. */
function runsByCopy(i: StewardInput): Map<string, TestRun[]> {
  const live = new Set(i.attempts.filter((a) => !ENDED.has(a.status)).map((a) => a.id));
  const out = new Map<string, TestRun[]>();
  for (const r of testRuns(i.logs)) {
    if (!live.has(r.attemptId) || r.at < i.now - WINDOW_MS) continue;
    const list = out.get(r.attemptId) ?? [];
    list.push(r);
    out.set(r.attemptId, list);
  }
  return out;
}

/* ───────────────────────── the counters ───────────────────────── */

/**
 * A work copy that ran its tests at least STUCK_RUNS times, and one test failed in every one of the last
 * runs in a row. The measure is the length of that row.
 */
export function stuckTests(i: StewardInput): Finding[] {
  const n = namesOf(i);
  const out: Finding[] = [];
  for (const [attemptId, runs] of runsByCopy(i)) {
    if (runs.length < STUCK_RUNS) continue;
    // How many runs from the end each failed test failed in a row.
    const rows = new Map<string, { c: FailedCase; row: number }>();
    for (const c of runs.at(-1)!.failed) rows.set(caseKey(c), { c, row: 0 });
    for (let k = runs.length - 1; k >= 0 && rows.size; k--) {
      const failed = new Set(runs[k].failed.map(caseKey));
      for (const [key, r] of rows) {
        if (failed.has(key) && r.row === runs.length - 1 - k) r.row += 1;
      }
    }
    const stuck = [...rows.values()].filter((r) => r.row >= STUCK_RUNS).sort((a, b) => b.row - a.row);
    if (!stuck.length) continue;
    const row = stuck[0].row;
    const names = stuck.map((r) => testName(r.c));
    const intentId = n.intentOf(attemptId);
    out.push({
      key: `stuck-test:${attemptId}`,
      kind: "stuck-test",
      measure: row,
      attemptIds: [attemptId],
      intentId,
      facts: [
        `${n.callsign(attemptId)} ran the tests ${row} times in a row. ${stuck.length === 1 ? "The test" : `${stuck.length} tests`} ${listOf(names, NAMED_TESTS)} failed each time.`,
        `The agent works on "${n.title(intentId)}". The same error may need a person.`,
      ],
    });
  }
  return out;
}

/**
 * Change requests that bounce: between the same two agents, the side that adapts changed direction at least
 * BOUNCE_FLIPS times inside the window. The measure is the number of changes of direction.
 */
export function bouncingRequests(i: StewardInput): Finding[] {
  const n = namesOf(i);
  const attempt = new Map(i.attempts.map((a) => [a.id, a]));
  const pairs = new Map<string, Correction[]>();
  for (const c of [...i.corrections].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!c.standOnAttemptId || c.createdAt < i.now - WINDOW_MS) continue;
    const give = attempt.get(c.attemptId)?.agentId;
    const stand = attempt.get(c.standOnAttemptId)?.agentId;
    if (!give || !stand || give === stand) continue;
    const key = [give, stand].sort().join("|");
    pairs.set(key, [...(pairs.get(key) ?? []), c]);
  }
  const out: Finding[] = [];
  for (const [key, list] of pairs) {
    let flips = 0;
    for (let k = 1; k < list.length; k++) if (list[k].attemptId !== list[k - 1].attemptId || list[k].standOnAttemptId !== list[k - 1].standOnAttemptId) flips += 1;
    if (flips < BOUNCE_FLIPS) continue;
    const last = list.at(-1)!;
    const a = n.callsign(last.attemptId);
    const b = n.callsign(last.standOnAttemptId!);
    const span = minutes(last.createdAt - list[0].createdAt);
    out.push({
      key: `bounce:${key}`,
      kind: "bounce",
      measure: flips,
      attemptIds: [last.attemptId, last.standOnAttemptId!],
      intentId: n.intentOf(last.attemptId),
      facts: [`${a} and ${b} got ${list.length} change requests about each other in ${span} minutes. The side that adapts changed ${flips} times.`, "The two agents may undo the work of each other. A person can decide which work continues."],
    });
  }
  return out;
}

interface Cluster {
  path: string;
  from: number;
  to: number;
  /** The first (oldest) request in the cluster: its start line keys the cluster, and its work copy names the task. */
  firstFrom: number;
  firstAttempt: string;
  requests: Set<string>;
  attemptIds: Set<string>;
  first: number;
  last: number;
}

/**
 * Hot lines: at least HOT_REQUESTS change requests inside the window name the same lines of one file (the
 * avoidRegions of the requests, joined where they touch). The measure is the number of requests.
 */
export function hotLines(i: StewardInput): Finding[] {
  const n = namesOf(i);
  const regions: { path: string; lines: LineRange; c: Correction }[] = [];
  for (const c of i.corrections) {
    if (c.createdAt < i.now - WINDOW_MS) continue;
    for (const r of c.constraints.avoidRegions ?? []) {
      if (Array.isArray(r.lines) && r.lines.length === 2) regions.push({ path: r.path, lines: r.lines, c });
    }
  }
  regions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.lines[0] - b.lines[0] || a.c.createdAt - b.c.createdAt));
  const clusters: Cluster[] = [];
  let cur: Cluster | undefined;
  for (const r of regions) {
    // Ranges that touch (one line between them at most) are the same hot place.
    if (cur && cur.path === r.path && r.lines[0] <= cur.to + 2) {
      cur.to = Math.max(cur.to, r.lines[1]);
      if (r.c.createdAt < cur.first) {
        cur.first = r.c.createdAt;
        cur.firstFrom = r.lines[0];
        cur.firstAttempt = r.c.attemptId;
      }
      cur.last = Math.max(cur.last, r.c.createdAt);
      cur.requests.add(r.c.id);
      cur.attemptIds.add(r.c.attemptId);
      continue;
    }
    cur = { path: r.path, from: r.lines[0], to: r.lines[1], firstFrom: r.lines[0], firstAttempt: r.c.attemptId, requests: new Set([r.c.id]), attemptIds: new Set([r.c.attemptId]), first: r.c.createdAt, last: r.c.createdAt };
    clusters.push(cur);
  }
  const out: Finding[] = [];
  for (const k of clusters) {
    if (k.requests.size < HOT_REQUESTS) continue;
    const copies = [k.firstAttempt, ...[...k.attemptIds].filter((id) => id !== k.firstAttempt)];
    const names = [...new Set(copies.map((id) => n.callsign(id)))];
    out.push({
      key: `hot-lines:${k.path}:${k.firstFrom}`,
      kind: "hot-lines",
      measure: k.requests.size,
      attemptIds: copies,
      intentId: n.intentOf(copies[0]),
      facts: [
        `${k.requests.size} change requests in ${minutes(Math.max(k.last - k.first, 60_000))} minutes name lines ${k.from}–${k.to} of ${k.path}.`,
        `${copies.length === 1 ? "One work copy changes" : `${copies.length} work copies change`} these lines: ${listOf(names)}. A smaller task for these lines may help.`,
      ],
    });
  }
  return out;
}

/**
 * A test that flaps: in the runs of one work copy, its result went from pass to fail or back at least
 * FLAP_FLIPS times. The measure is the largest number of changes of one test.
 */
export function flappingTests(i: StewardInput): Finding[] {
  const n = namesOf(i);
  const out: Finding[] = [];
  for (const [attemptId, runs] of runsByCopy(i)) {
    if (runs.length < FLAP_FLIPS + 1) continue;
    const cases = new Map<string, FailedCase>();
    for (const r of runs) for (const c of r.failed) cases.set(caseKey(c), c);
    const flaps: { c: FailedCase; flips: number }[] = [];
    for (const [key, c] of cases) {
      let flips = 0;
      let was: boolean | undefined;
      for (const r of runs) {
        const failed = r.failed.some((x) => caseKey(x) === key);
        if (was !== undefined && failed !== was) flips += 1;
        was = failed;
      }
      if (flips >= FLAP_FLIPS) flaps.push({ c, flips });
    }
    if (!flaps.length) continue;
    flaps.sort((a, b) => b.flips - a.flips);
    const names = flaps.map((f) => testName(f.c));
    const intentId = n.intentOf(attemptId);
    out.push({
      key: `flap:${attemptId}`,
      kind: "flap",
      measure: flaps[0].flips,
      attemptIds: [attemptId],
      intentId,
      facts: [
        `${flaps.length === 1 ? "A test" : `${flaps.length} tests`} of ${n.callsign(attemptId)} passed and failed by turns in the last ${runs.length} test runs.`,
        `The result of ${listOf(names, NAMED_TESTS)} changed ${flaps[0].flips} times. A test that depends on time or order may be the cause.`,
      ],
    });
  }
  return out;
}

/**
 * A merge queue that does not move: work waits in the queue (not for the test budget) since more than
 * QUEUE_STILL_MS, and no merge happened in that time. The measure is the wait in minutes.
 */
export function stuckQueue(i: StewardInput): Finding[] {
  const n = namesOf(i);
  const attempt = new Map(i.attempts.map((a) => [a.id, a]));
  const waiting = i.queue.filter((q) => {
    const a = attempt.get(q.attemptId);
    return a && (a.status === "ready" || a.status === "landing") && !(a.mergeWait && a.mergeWait.until > i.now);
  });
  if (!waiting.length) return [];
  const oldest = waiting.reduce((x, y) => (y.at < x.at ? y : x));
  const still = i.now - oldest.at;
  if (still < QUEUE_STILL_MS) return [];
  if (i.landings.some((l) => l.at > i.now - QUEUE_STILL_MS)) return [];
  const copies = waiting.map((q) => q.attemptId);
  return [
    {
      key: "queue",
      kind: "queue",
      measure: minutes(still),
      attemptIds: copies.slice(0, 3),
      intentId: n.intentOf(oldest.attemptId),
      facts: [
        `The merge queue has ${copies.length} work ${copies.length === 1 ? "copy" : "copies"}. No merge happened in the last ${minutes(still)} minutes.`,
        `The oldest is the work of ${n.callsign(oldest.attemptId)} on "${n.title(n.intentOf(oldest.attemptId))}". A merge or a test run may be stuck.`,
      ],
    },
  ];
}

/** Every finding of a sweep: the five counters, in a stable order. */
export function stewardFindings(i: StewardInput): Finding[] {
  return [...stuckTests(i), ...bouncingRequests(i), ...hotLines(i), ...flappingTests(i), ...stuckQueue(i)];
}

/* ───────────────────────── the words of the model ───────────────────────── */

/** The model answers a list of messages with text, or null when it fails (as core/guess.ts AskModel). */
export type AskSteward = (messages: ChatMessage[]) => Promise<string | null>;

/** A short job: little reasoning, and time for the reasoning tokens of GLM 5.3 Flash. */
export const STEWARD_CALL = { maxTokens: 200, timeoutMs: 15_000, temperature: 0.2, reasoning: "low" as const };

export function stewardModel(ai: unknown): AskSteward | undefined {
  if (!ai) return undefined;
  return async (messages) => {
    const res = await chat(ai as AiLike, SHORT_JOB_MODEL, messages, STEWARD_CALL);
    return res?.message.content ?? null;
  };
}

const STEWARD_PROMPT = [
  "You are the steward of a software project where AI agents write code. A person reads your note on a phone.",
  "Write ONE plain sentence of at most 20 words that says what the facts show. Present tense, active voice.",
  "Use no word that ends in -ing. Use no jargon. Do not give advice. Answer with the sentence only.",
].join(" ");

/** The part of a word that decides: no identifier (a path, a test name, a callsign) counts as a word. */
function isIdentifier(raw: string): boolean {
  const core = raw.replace(/[.,;:!?]+$/, "");
  return /[./#()_\d]/.test(core) || /[a-z][A-Z]/.test(core) || /^[A-Z][A-Z0-9]*-\d+$/.test(core);
}

/**
 * The sentence of the model, when it is one plain sentence: one line, at most 20 words, no "-ing" word
 * outside quotes and identifiers. Else null, and the template sentence stands.
 */
export function plainSentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  let s = line.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!s || s.length > 200) return null;
  if (!/[.!?]$/.test(s)) s += ".";
  if (/[.!?]\s+\S/.test(s.replace(/"[^"]*"/g, ""))) return null; // more than one sentence
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 20) return null;
  for (const raw of s.replace(/"[^"]*"/g, " ").split(/\s+/).filter(Boolean)) {
    const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (/ing$/i.test(word) && !isIdentifier(raw) && word.toLowerCase() !== "gitring") return null;
  }
  return s;
}

/** Ask the model to word a finding. Null when there is no model, when it fails, or when its answer is not one plain sentence. */
export async function wordFinding(ask: AskSteward | undefined, f: Finding): Promise<string | null> {
  if (!ask) return null;
  try {
    const text = await ask([
      { role: "system", content: STEWARD_PROMPT },
      { role: "user", content: `Facts:\n${f.facts.map((x) => `- ${x}`).join("\n")}` },
    ]);
    return plainSentence(text);
  } catch {
    return null;
  }
}
