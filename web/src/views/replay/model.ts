/**
 * Replay model: the history of a project (timeline records, see src/core/timeline.ts) as a script of
 * steps, the world at each step, a playback schedule and the short map effects of each step.
 *
 *   buildScript(records, agents)  records → steps, oldest first, one caption and one stage each
 *   worldAt(script, i)            what the map and the panels show after step i
 *   scheduleOf(steps, speed)      when each step starts on the wall clock (idle time compressed)
 *   effectsAt(script, s, wall)    the map effects that run at a wall time, with their progress
 *
 * Pure module (no React, no DOM). test/web/replay.test.ts checks the mapping step by step.
 */
import type {
  AgentInfo,
  Attempt,
  AttemptStatus,
  CheckRun,
  Correction,
  CorrectionKind,
  CourseAssessment,
  CourseCheck,
  Decision,
  Landing,
  LandingMethod,
  LogEntry,
  PairFacts,
  Range,
  Verdict,
} from "../../../../src/core/types";
import type { TimelineIntent, TimelineRecord } from "../../../../src/core/timeline";
import { correctionFile, rangeTone, type RangeLine, type RangeLink, type VesselModel } from "../../state/selectors";
import { hullName } from "../../design/icons";
import { RANGE_TEXT } from "../../state/format";
import * as C from "./captions";
import type { Stage, SubmitOutcome } from "./captions";

export type { Stage } from "./captions";

/* ───────────── steps ───────────── */

export type StepKind =
  | "task"
  | "launch"
  | "plan"
  | "check"
  | "request"
  | "deliver"
  | "ack"
  | "work"
  | "tests"
  | "submit"
  | "decision"
  | "lease"
  | "compose"
  | "composed"
  | "commit"
  | "replot"
  | "stale"
  | "end"
  | "note";

/** The order of kinds at the same time: a lease before its compose, the tests of main plus the work before the commit. */
const KIND_ORDER: Record<StepKind, number> = {
  task: 0,
  launch: 1,
  plan: 2,
  check: 3,
  request: 4,
  deliver: 5,
  ack: 6,
  work: 7,
  tests: 8,
  submit: 9,
  decision: 10,
  lease: 11,
  compose: 12,
  composed: 13,
  commit: 14,
  replot: 15,
  stale: 16,
  end: 17,
  note: 18,
};

const STAGE_OF: Record<StepKind, Stage> = {
  task: "task",
  launch: "task",
  plan: "plan",
  check: "check",
  request: "request",
  deliver: "request",
  ack: "request",
  work: "work",
  tests: "tests",
  submit: "queue",
  decision: "queue",
  lease: "queue",
  compose: "compose",
  composed: "composed",
  commit: "commit",
  replot: "replot",
  stale: "replot",
  end: "work",
  note: "note",
};

export function stageOf(kind: StepKind): Stage {
  return STAGE_OF[kind];
}

export interface TestSummary {
  scope: "attempt" | "composed";
  passed: number;
  total: number;
  ok: boolean;
  /** The cases, when the run is known in full (the latest run of a work copy, or the run of a merge). */
  cases?: CheckRun["cases"];
  ms?: number;
  /** The tests did not run: the hourly test budget is used. */
  waits?: boolean;
}

export interface ReplayStep {
  /** Unique and stable for the same history. */
  id: string;
  /** History time (ms). */
  at: number;
  kind: StepKind;
  stage: Stage;
  /** One plain sentence or two (STE). */
  caption: string;
  /** How long the step holds the screen: 1 short, 2 normal, 3 long. */
  weight: 1 | 2 | 3;
  attemptId?: string;
  intentId?: string;
  /** Files that the step touches on the map. */
  files?: string[];
  check?: CourseCheck;
  correction?: Correction;
  tests?: TestSummary;
  landing?: Landing;
  submit?: SubmitOutcome;
  /** A replot: the work copies that move onto the new main. */
  others?: string[];
  /** The words of an agent or a person (data, shown as a quote). */
  quote?: string;
  /** The sentence of gitring behind the step, when it says more than the caption. */
  detail?: string;
}

export interface ReplayScript {
  steps: ReplayStep[];
  intents: Map<string, TimelineIntent>;
  attempts: Map<string, Attempt>;
  agents: Map<string, AgentInfo>;
  corrections: Map<string, Correction>;
  checks: Map<string, CourseCheck>;
  landings: Landing[];
  /** Work copy → the work copy that redid it. */
  redoOf: Map<string, string>;
  /** History time of the first and the last step. */
  start: number;
  end: number;
}

const MOVE_KINDS = new Set<LogEntry["kind"]>(["write", "log", "push"]);
const RUN_SUMMARY = /(\d+)\/(\d+) pass/;
const CALLSIGN = /\b[A-Z][A-Z]+-\d+\b/g;

/** The first sentences of a text, at most `max` characters. */
export function firstSentences(text: string, n = 1, max = 220): string {
  const parts = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const out = parts.slice(0, n).join(" ");
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** Records → steps. Records may come in any order; steps come out in history order. */
export function buildScript(records: TimelineRecord[], agentList: AgentInfo[]): ReplayScript {
  const intents = new Map<string, TimelineIntent>();
  const attempts = new Map<string, Attempt>();
  const corrections = new Map<string, Correction>();
  const checks = new Map<string, CourseCheck>();
  const landings: Landing[] = [];
  const decisions: Decision[] = [];
  const logs: LogEntry[] = [];
  for (const r of records) {
    if (r.kind === "intent") intents.set(r.intent.id, r.intent);
    else if (r.kind === "attempt") attempts.set(r.attempt.id, r.attempt);
    else if (r.kind === "correction") corrections.set(r.correction.id, r.correction);
    else if (r.kind === "check") checks.set(r.check.id, r.check);
    else if (r.kind === "landing") landings.push(r.landing);
    else if (r.kind === "decision") decisions.push(r.decision);
    else if (r.kind === "log") logs.push(r.log);
  }
  const agents = new Map(agentList.map((g) => [g.id, g]));
  const redoOf = new Map<string, string>();
  for (const a of attempts.values()) if (a.lineage?.rederivedFrom) redoOf.set(a.lineage.rederivedFrom, a.id);

  const nameOf = (attemptId?: string): string => {
    const a = attemptId ? attempts.get(attemptId) : undefined;
    return (a && agents.get(a.agentId)?.callsign) ?? "An agent";
  };
  const titleOf = (intentId?: string): string => (intentId ? intents.get(intentId)?.title : undefined) ?? "a task";
  const landedRun = new Set(landings.map((l) => l.checks.id));

  const steps: ReplayStep[] = [];
  const push = (s: Omit<ReplayStep, "stage">) => steps.push({ ...s, stage: STAGE_OF[s.kind] });

  for (const i of intents.values()) {
    push({ id: `task:${i.id}`, at: i.createdAt, kind: "task", weight: 2, intentId: i.id, caption: C.taskCaption(i.createdBy?.name || "A person", i.title) });
  }

  for (const a of attempts.values()) {
    const name = nameOf(a.id);
    const title = titleOf(a.intentId);
    const redo = (a.lineage?.generation ?? 1) > 1;
    push({
      id: `plan:${a.id}`,
      at: a.course?.declaredAt && a.course.declaredAt >= a.createdAt ? a.course.declaredAt : a.createdAt,
      kind: "plan",
      weight: 2,
      attemptId: a.id,
      intentId: a.intentId,
      files: a.course?.files ?? [],
      caption: C.planCaption(name, title, a.course?.files.length ?? 0, redo),
      quote: a.course?.approach || undefined,
    });
    // A work copy that ended without a merge leaves the map when it ended (its last change).
    if (a.status === "alternate" || a.status === "abandoned" || a.status === "failed") {
      push({ id: `end:${a.id}`, at: a.updatedAt, kind: "end", weight: 1, attemptId: a.id, intentId: a.intentId, caption: C.endCaption(name, title, a.status) });
    }
    // The last run on main plus the work, when it failed and no merge used it.
    const comp = a.composedChecks;
    if (comp && !comp.ok && !comp.wait && !landedRun.has(comp.id)) {
      const lease = comp.at - Math.max(1, comp.ms) - 2;
      push({ id: `lease:${comp.id}`, at: lease, kind: "lease", weight: 2, attemptId: a.id, intentId: a.intentId, caption: C.leaseCaption(name) });
      const t = summary(comp, "composed");
      push({ id: `composed:${comp.id}`, at: comp.at, kind: "composed", weight: 3, attemptId: a.id, intentId: a.intentId, tests: t, caption: C.testsCaption(name, "composed", t.passed, t.total, t.ok) });
    }
  }

  for (const c of corrections.values()) {
    const to = nameOf(c.attemptId);
    const from = c.standOnAttemptId ? nameOf(c.standOnAttemptId) : undefined;
    const target = attempts.get(c.attemptId);
    push({
      id: `request:${c.id}`,
      at: c.createdAt,
      kind: "request",
      weight: 3,
      attemptId: c.attemptId,
      intentId: target?.intentId,
      correction: c,
      files: correctionFiles(c, target, checks.get(c.checkId)),
      caption: C.requestCaption(c.kind, to, from),
      detail: firstSentences(c.message, 2),
    });
    // A change request that waited for the next call of the agent: the moment it reaches the agent.
    if (c.deliveredAt && c.deliveredAt - c.createdAt > 50) {
      push({ id: `deliver:${c.id}`, at: c.deliveredAt, kind: "deliver", weight: 1, attemptId: c.attemptId, intentId: target?.intentId, correction: c, caption: C.deliverCaption(to) });
    }
  }

  for (const k of checks.values()) {
    const a = attempts.get(k.attemptId);
    const near = nearest(k);
    const other = near ? nameOf(near.facts.otherAttemptId) : undefined;
    const adapts = near?.assessment ? (near.assessment.giveWay === "incoming" ? nameOf(k.attemptId) : other) : undefined;
    push({
      id: `check:${k.id}`,
      at: k.at,
      kind: "check",
      weight: k.verdict !== "clear" ? 3 : near ? 2 : 1,
      attemptId: k.attemptId,
      intentId: a?.intentId,
      check: k,
      files: near ? near.facts.sharedFiles : undefined,
      caption: C.checkCaption({ agent: nameOf(k.attemptId), verdict: k.verdict, range: near?.facts.range, other, adapts }),
    });
  }

  for (const l of landings) {
    const a = attempts.get(l.attemptId);
    const name = nameOf(l.attemptId);
    const run = summary(l.checks, "composed");
    const submitted = lastBefore(logs, (g) => g.kind === "submit" && g.attemptId === l.attemptId, l.at);
    const lease = Math.max((submitted?.at ?? -Infinity) + 1, l.checks.at - Math.max(1, l.checks.ms) - 2);
    const files = a ? touched(a) : [];
    const base = { attemptId: l.attemptId, intentId: l.intentId, landing: l };
    push({ ...base, id: `lease:${l.id}`, at: lease, kind: "lease", weight: 2, caption: C.leaseCaption(name) });
    push({ ...base, id: `compose:${l.id}`, at: lease + 1, kind: "compose", weight: 2, caption: C.composeCaption(name, l.method) });
    push({ ...base, id: `composed:${l.id}`, at: Math.max(lease + 2, l.checks.at), kind: "composed", weight: 2, tests: run, caption: C.testsCaption(name, "composed", run.passed, run.total, run.ok) });
    push({ ...base, id: `commit:${l.id}`, at: Math.max(lease + 3, l.at), kind: "commit", weight: 3, files, caption: C.commitCaption(titleOf(l.intentId), l.mainAfter) });
  }

  for (const d of decisions) {
    const name = nameOf(d.attemptIds[0]);
    if (d.kind === "pick") push({ id: `decision:${d.id}`, at: d.at, kind: "decision", weight: 2, attemptId: d.attemptIds[0], intentId: d.intentId, caption: C.pickCaption(d.by.name, name), quote: d.rationale || undefined });
    else if (d.kind === "rederive" && d.by.kind === "human") push({ id: `decision:${d.id}`, at: d.at, kind: "note", weight: 2, intentId: d.intentId, caption: C.redoAskCaption(d.by.name, titleOf(d.intentId)), quote: d.rationale || undefined });
  }

  for (const g of logs) {
    const step = logStep(g, { attempts, agents, nameOf, titleOf });
    if (step) push(step);
  }

  steps.sort((x, y) => x.at - y.at || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {
    steps,
    intents,
    attempts,
    agents,
    corrections,
    checks,
    landings: landings.sort((x, y) => x.at - y.at),
    redoOf,
    start: steps[0]?.at ?? 0,
    end: steps[steps.length - 1]?.at ?? 0,
  };
}

interface LogContext {
  attempts: Map<string, Attempt>;
  agents: Map<string, AgentInfo>;
  nameOf: (attemptId?: string) => string;
  titleOf: (intentId?: string) => string;
}

/** One log line → a step, or null when another record tells the same thing (plans, checks, merges). */
function logStep(g: LogEntry, x: LogContext): Omit<ReplayStep, "stage"> | null {
  const base = { id: `log:${g.id}:${g.at}`, at: g.at, attemptId: g.attemptId, intentId: g.intentId };
  const name = x.nameOf(g.attemptId);
  switch (g.kind) {
    case "write":
    case "log":
    case "push": {
      const byGitring = g.kind === "push" && /^The work of /.test(g.message);
      // gitring's own commit to the work copy lists main's changes too (after a move onto a new main): the agent does not go there.
      const files = byGitring ? [] : (g.files ?? []);
      // The words of the agent follow its callsign: "KESTREL-4: added the parser".
      const said = g.kind === "log" ? g.message.replace(/^[^:]*:\s*/, "") : g.kind === "write" ? (g.message.split(": ").slice(1).join(": ") || undefined) : undefined;
      return { ...base, kind: "work", weight: 1, files, caption: C.workCaption(g.kind, name, files, byGitring), quote: said ? firstSentences(said, 2, 160) : undefined };
    }
    case "check": {
      const runId = typeof g.data?.checkRunId === "string" ? g.data.checkRunId : undefined;
      if (!runId) return null; // a conflict check: its record is the step
      if (g.data?.retryAt) return { ...base, kind: "tests", weight: 1, tests: { scope: "attempt", passed: 0, total: 0, ok: false, waits: true }, caption: C.testsWaitCaption(name) };
      const known = g.attemptId ? x.attempts.get(g.attemptId)?.checks : undefined;
      const tests: TestSummary = known && known.id === runId ? summary(known, "attempt") : parsedRun(g.message, g.data?.ok === true);
      return { ...base, kind: "tests", weight: 2, tests, caption: C.testsCaption(name, "attempt", tests.passed, tests.total, tests.ok) };
    }
    case "ack": {
      const note = g.message.includes(": ") ? g.message.slice(g.message.indexOf(": ") + 2) : undefined;
      const id = /\b(cr_\w+)/.exec(g.message)?.[1];
      return { ...base, id: `ack:${id ?? g.id}:${g.at}`, kind: "ack", weight: 2, caption: C.ackCaption(name), quote: note ? firstSentences(note, 2, 160) : undefined, detail: id };
    }
    case "submit": {
      const outcome: SubmitOutcome = /say yes/.test(g.message) ? "approval" : /Fix the code|fail/i.test(g.message) && !/merge queue/.test(g.message) ? "fix" : "queue";
      return { ...base, kind: "submit", weight: 2, submit: outcome, caption: C.submitCaption(name, x.titleOf(g.intentId), outcome), detail: firstSentences(g.message.replace(/^[^:]*:\s*/, ""), 2) };
    }
    case "replot": {
      const others = g.attemptId ? [g.attemptId] : attemptsNamed(g.message, g.at, x);
      if (!others.length) return null;
      return { ...base, kind: "replot", weight: 2, others, files: others.flatMap((id) => touched(x.attempts.get(id))), caption: C.replotCaption(others.map((id) => x.nameOf(id))), detail: firstSentences(g.message, 2) };
    }
    case "stale":
      return { ...base, kind: "stale", weight: 2, caption: C.staleCaption(name), detail: firstSentences(g.message, 2) };
    case "decision":
      return { ...base, kind: "decision", weight: 2, caption: firstSentences(g.message, 2) };
    case "intent":
      if (/ opens the task /.test(g.message)) return null; // the task record is the step
      if (/ starts \d+ built-in agent/.test(g.message)) return { ...base, kind: "launch", weight: 2, caption: firstSentences(g.message, 1) };
      return { ...base, kind: "note", weight: 2, caption: firstSentences(g.message, 2) };
    case "rederive":
      return { ...base, kind: "note", weight: 2, caption: firstSentences(g.message, 2) };
    case "system":
      // Work copy news (a stop, a merge that waits) and the start of the project. Settings and tokens are not history.
      if (g.attemptId || /^(Project ready|Import done|Push received)/.test(g.message)) return { ...base, kind: "note", weight: 1, caption: firstSentences(g.message, 2) };
      return null;
    default:
      // declare, correction, land: their records are the steps.
      return null;
  }
}

/** Work copies named by callsign in a log line: the latest copy of that agent that started before the line. */
function attemptsNamed(message: string, at: number, x: LogContext): string[] {
  const names = new Set(message.match(CALLSIGN) ?? []);
  const out: string[] = [];
  for (const name of names) {
    let best: Attempt | undefined;
    for (const a of x.attempts.values()) {
      if (x.agents.get(a.agentId)?.callsign !== name || a.createdAt > at) continue;
      if (!best || a.createdAt > best.createdAt) best = a;
    }
    if (best) out.push(best.id);
  }
  return out;
}

function lastBefore<X extends { at: number }>(list: X[], ok: (x: X) => boolean, at: number): X | undefined {
  let best: X | undefined;
  for (const x of list) if (ok(x) && x.at <= at && (!best || x.at >= best.at)) best = x;
  return best;
}

function summary(run: CheckRun, scope: TestSummary["scope"]): TestSummary {
  const total = run.passed + run.failed || run.cases.length;
  return { scope, passed: run.passed, total, ok: run.ok, cases: run.cases, ms: run.ms, waits: Boolean(run.wait) };
}

function parsedRun(message: string, ok: boolean): TestSummary {
  const m = RUN_SUMMARY.exec(message);
  return { scope: "attempt", passed: m ? Number(m[1]) : 0, total: m ? Number(m[2]) : 0, ok };
}

/** The files a work copy touched (its footprint), or its plan when it touched none. */
function touched(a: Attempt | undefined): string[] {
  if (!a) return [];
  const fp = Object.keys(a.footprint?.files ?? {});
  return fp.length ? fp : (a.course?.files ?? []);
}

function correctionFiles(c: Correction, a: Attempt | undefined, k: CourseCheck | undefined): string[] {
  const f = correctionFile(c, a, k);
  return f ? [f] : [];
}

/** The nearest other work of a conflict check: its facts and the assessment of the pair. */
export function nearest(k: CourseCheck): { facts: PairFacts; assessment?: CourseAssessment } | undefined {
  if (!k.facts?.length) return undefined;
  const facts = [...k.facts].sort((a, b) => a.range - b.range || (a.otherAttemptId < b.otherAttemptId ? -1 : 1))[0];
  return { facts, assessment: k.assessments?.find((s) => s.otherAttemptId === facts.otherAttemptId) };
}

/* ───────────── the world after a step ───────────── */

export type TaskState = "open" | "working" | "merged" | "paused";

export interface WorldTask {
  id: string;
  title: string;
  state: TaskState;
  at: number;
}

export interface WorldBuoy {
  id: string;
  attemptId: string;
  file: string;
  kind: CorrectionKind;
  done: boolean;
  correction: Correction;
  callsign: string;
  fromCallsign?: string;
}

export interface WorldCommit {
  sha: string;
  title: string;
  method: LandingMethod;
  attemptId: string;
  at: number;
}

export interface World {
  /** The index of the step, -1 before the first step. */
  index: number;
  at: number;
  tasks: WorldTask[];
  vessels: VesselModel[];
  ranges: RangeLine[];
  buoys: WorldBuoy[];
  /** Work copies that wait in the merge queue, in order. */
  queue: string[];
  /** The work copy that holds the merge lease. */
  lease: string | null;
  mainSha: string | null;
  commits: WorldCommit[];
  counts: { tasks: number; plans: number; checks: number; requests: number; acks: number; tests: number; merges: number };
}

const SHOWN: ReadonlySet<AttemptStatus> = new Set<AttemptStatus>(["declared", "underway", "submitted", "checking", "ready", "landing", "stale", "rederiving"]);

interface Live {
  status: AttemptStatus;
  track: string[];
  failing: boolean;
  lastVerdict?: Verdict;
  checked: boolean;
  updatedAt: number;
  hidden: boolean;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** What the map and the panels show after step `index` (-1: before the first step). */
export function worldAt(script: ReplayScript, index: number): World {
  const last = Math.min(index, script.steps.length - 1);
  const live = new Map<string, Live>();
  const taskState = new Map<string, TaskState>();
  const taskAt = new Map<string, number>();
  const pairs = new Map<string, { a: string; b: string; range: Range; closing: boolean; verdict: Verdict }>();
  const issued: Correction[] = [];
  const acked = new Set<string>();
  const queue: string[] = [];
  let lease: string | null = null;
  const commits: WorldCommit[] = [];
  let mainSha: string | null = script.landings[0]?.mainBefore ?? null;
  const counts = { tasks: 0, plans: 0, checks: 0, requests: 0, acks: 0, tests: 0, merges: 0 };
  const dequeue = (id?: string) => {
    if (!id) return;
    const n = queue.indexOf(id);
    if (n >= 0) queue.splice(n, 1);
  };
  const setTask = (id: string | undefined, s: TaskState) => {
    if (!id || !taskState.has(id)) return;
    if (taskState.get(id) === "merged" && s !== "merged") return;
    taskState.set(id, s);
  };

  for (let i = 0; i <= last; i++) {
    const s = script.steps[i];
    const v = s.attemptId ? live.get(s.attemptId) : undefined;
    const touch = (patch: Partial<Live>) => v && Object.assign(v, patch, { updatedAt: s.at });
    switch (s.kind) {
      case "task":
        if (s.intentId) {
          taskState.set(s.intentId, "open");
          taskAt.set(s.intentId, s.at);
        }
        counts.tasks++;
        break;
      case "plan":
        if (s.attemptId) {
          live.set(s.attemptId, { status: "declared", track: [], failing: false, checked: false, updatedAt: s.at, hidden: false });
          // The work copy that this one redoes leaves the map.
          for (const [old, redo] of script.redoOf) if (redo === s.attemptId && live.has(old)) live.get(old)!.hidden = true;
        }
        setTask(s.intentId, "working");
        counts.plans++;
        break;
      case "check":
        if (s.check) {
          touch({ checked: true, lastVerdict: s.check.verdict });
          for (const f of s.check.facts ?? []) pairs.set(pairKey(s.check.attemptId, f.otherAttemptId), { a: s.check.attemptId, b: f.otherAttemptId, range: f.range, closing: f.closing, verdict: s.check.verdict });
        }
        counts.checks++;
        break;
      case "request":
        if (s.correction) issued.push(s.correction);
        counts.requests++;
        break;
      case "ack": {
        const id = s.detail ?? issued.filter((c) => c.attemptId === s.attemptId && !acked.has(c.id)).pop()?.id;
        if (id) acked.add(id);
        counts.acks++;
        break;
      }
      case "work":
        if (v) {
          for (const f of s.files ?? []) if (v.track[v.track.length - 1] !== f) v.track.push(f);
          if (v.status === "declared") v.status = "underway";
          touch({});
        }
        break;
      case "tests":
        if (s.tests && !s.tests.waits) {
          touch({ failing: !s.tests.ok });
          counts.tests++;
        }
        break;
      case "submit":
        if (s.submit === "fix") touch({ status: "underway", failing: true });
        else {
          touch({ status: "ready", failing: false });
          if (s.submit === "queue" && s.attemptId && !queue.includes(s.attemptId)) queue.push(s.attemptId);
        }
        break;
      case "decision":
        if (s.attemptId && v?.status === "ready" && /chooses|says yes/.test(s.caption) && !queue.includes(s.attemptId)) queue.push(s.attemptId);
        break;
      case "lease":
        dequeue(s.attemptId);
        lease = s.attemptId ?? null;
        touch({ status: "landing" });
        break;
      case "composed":
        if (s.tests && !s.tests.ok) {
          lease = null;
          touch({ status: "stale" });
        }
        counts.tests++;
        break;
      case "commit":
        if (s.landing) {
          mainSha = s.landing.mainAfter;
          commits.push({ sha: s.landing.mainAfter, title: script.intents.get(s.landing.intentId)?.title ?? "a task", method: s.landing.method, attemptId: s.landing.attemptId, at: s.at });
        }
        dequeue(s.attemptId);
        if (lease === s.attemptId) lease = null;
        touch({ status: "landed" });
        setTask(s.intentId, "merged");
        // Corrections that this work applied count as answered at the merge.
        for (const c of issued) if (c.attemptId === s.attemptId) acked.add(c.id);
        counts.merges++;
        break;
      case "stale":
        dequeue(s.attemptId);
        if (lease === s.attemptId) lease = null;
        touch({ status: "stale" });
        break;
      case "end":
        dequeue(s.attemptId);
        touch({ status: s.attemptId ? (script.attempts.get(s.attemptId)?.status ?? "abandoned") : "abandoned" });
        break;
      case "note":
        if (/ pauses /.test(s.caption)) setTask(s.intentId, "paused");
        break;
      default:
        break;
    }
  }

  const at = last >= 0 ? script.steps[last].at : script.start;
  const shown = [...live.entries()].filter(([, l]) => SHOWN.has(l.status) && !l.hidden);
  const shownIds = new Set(shown.map(([id]) => id));

  // Pairs with a change request between them show as corrected (magenta) on the map.
  const corrected = new Set(issued.filter((c) => c.standOnAttemptId).map((c) => pairKey(c.attemptId, c.standOnAttemptId!)));
  const linksBy = new Map<string, RangeLink[]>();
  const ranges: RangeLine[] = [];
  for (const [key, p] of pairs) {
    if (!shownIds.has(p.a) || !shownIds.has(p.b)) continue;
    const isCorrected = corrected.has(key);
    const add = (from: string, to: string) => linksBy.set(from, [...(linksBy.get(from) ?? []), { other: to, range: p.range, closing: p.closing, verdict: p.verdict, corrected: isCorrected }]);
    add(p.a, p.b);
    add(p.b, p.a);
    if (p.range <= 2) ranges.push({ key, a: p.a, b: p.b, range: p.range, closing: p.closing, tone: rangeTone(p.range, isCorrected), label: `${RANGE_TEXT[p.range]}${p.closing ? " · closer now" : ""}` });
  }

  // The newest change request of a work copy replaces the older ones that it supersedes.
  const latestFor = new Map<string, Correction>();
  for (const c of issued) latestFor.set(c.attemptId, c);
  const correctionsBy = new Map<string, Correction[]>();
  for (const c of issued) {
    if (c.status === "superseded" && latestFor.get(c.attemptId) !== c) continue;
    correctionsBy.set(c.attemptId, [...(correctionsBy.get(c.attemptId) ?? []), { ...c, status: acked.has(c.id) ? "acknowledged" : "delivered" }]);
  }

  const vessels: VesselModel[] = shown
    .map(([id, l]) => {
      const a = script.attempts.get(id)!;
      const agent = script.agents.get(a.agentId);
      const color = agent?.color ?? 0;
      return {
        attemptId: id,
        agentId: a.agentId,
        callsign: agent?.callsign ?? "AGENT",
        model: agent?.model ?? agent?.client ?? "unknown",
        client: agent?.client,
        kind: agent?.kind ?? "builtin",
        color,
        hull: hullName(color),
        intentId: a.intentId,
        intentTitle: script.intents.get(a.intentId)?.title ?? "a task",
        status: l.status,
        generation: a.lineage?.generation ?? 1,
        file: l.track.length ? l.track[l.track.length - 1] : null,
        track: [...l.track],
        course: (a.course?.files ?? []).filter((f) => !l.track.includes(f)),
        courseFiles: a.course?.files ?? [],
        checked: l.checked,
        failing: l.failing,
        lastVerdict: l.lastVerdict,
        corrections: correctionsBy.get(id) ?? [],
        ranges: (linksBy.get(id) ?? []).sort((x, y) => x.range - y.range),
        updatedAt: l.updatedAt,
      } satisfies VesselModel;
    })
    .sort((x, y) => (script.attempts.get(x.attemptId)!.createdAt - script.attempts.get(y.attemptId)!.createdAt));

  const byId = new Map(vessels.map((v) => [v.attemptId, v]));
  const buoys: WorldBuoy[] = [];
  for (const v of vessels) {
    for (const c of v.corrections) {
      const file = correctionFile(c, script.attempts.get(c.attemptId), script.checks.get(c.checkId));
      if (!file) continue;
      buoys.push({ id: c.id, attemptId: c.attemptId, file, kind: c.kind, done: c.status === "acknowledged", correction: c, callsign: v.callsign, fromCallsign: c.standOnAttemptId ? byId.get(c.standOnAttemptId)?.callsign : undefined });
    }
  }

  const tasks: WorldTask[] = [...taskState.entries()]
    .map(([id, state]) => ({ id, title: script.intents.get(id)?.title ?? "a task", state, at: taskAt.get(id) ?? 0 }))
    .sort((x, y) => x.at - y.at);

  return { index: last, at, tasks, vessels, ranges, buoys, queue, lease, mainSha, commits, counts };
}

/* ───────────── playback schedule ───────────── */

/** Idle time longer than this (history ms) is cut to this length. */
export const MAX_GAP_MS = 20_000;
/** The least wall time a step holds the screen at 1×, by weight. */
export const DWELL_MS: Record<1 | 2 | 3, number> = { 1: 420, 2: 1100, 3: 2200 };
export const SPEEDS = [1, 2, 5, 10, 30, 60, 120] as const;
export const OUTRO_MS = 1200;

export interface Schedule {
  speed: number;
  /** Wall time (ms from the start of the replay) at which each step starts. */
  starts: number[];
  /** Wall time of the end: the last step plus its hold and the outro. */
  end: number;
  /** Wall time of the title card before the first step. */
  intro: number;
}

/** Fast speeds shorten the holds too, but less than the history time: captions stay readable. */
export function pace(speed: number): number {
  return 1 + Math.log2(Math.max(1, speed)) * 0.45;
}

export function holdOf(step: ReplayStep, speed: number): number {
  return DWELL_MS[step.weight] / pace(speed);
}

/** When each step starts: history gaps divided by the speed (idle gaps cut), never shorter than the hold of the step before. */
export function scheduleOf(steps: ReplayStep[], speed: number, intro = 0): Schedule {
  const sp = Math.max(1, Math.min(SPEEDS[SPEEDS.length - 1], speed));
  const starts: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (i === 0) {
      starts.push(intro);
      continue;
    }
    const gap = Math.max(0, Math.min(MAX_GAP_MS, steps[i].at - steps[i - 1].at));
    starts.push(starts[i - 1] + Math.max(gap / sp, holdOf(steps[i - 1], sp)));
  }
  const end = steps.length ? starts[steps.length - 1] + holdOf(steps[steps.length - 1], sp) + OUTRO_MS : intro;
  return { speed: sp, starts, end, intro };
}

/** The step that runs at a wall time: the last step that started (-1 during the title card). */
export function indexAt(s: Schedule, wall: number): number {
  let lo = 0;
  let hi = s.starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.starts[mid] <= wall) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** How far the step at `index` is, 0–1, at a wall time. */
export function progressOf(s: Schedule, index: number, wall: number): number {
  if (index < 0) return s.intro > 0 ? Math.max(0, Math.min(1, wall / s.intro)) : 0;
  const from = s.starts[index];
  const to = index + 1 < s.starts.length ? s.starts[index + 1] : s.end - OUTRO_MS;
  if (to <= from) return 1;
  return Math.max(0, Math.min(1, (wall - from) / (to - from)));
}

/** The same place in the history on another schedule (a new speed): same step, same progress. */
export function retime(from: Schedule, to: Schedule, wall: number): number {
  const i = indexAt(from, wall);
  if (i < 0) return Math.min(wall, to.intro);
  if (wall >= from.end) return to.end;
  const p = progressOf(from, i, wall);
  const a = to.starts[i];
  const b = i + 1 < to.starts.length ? to.starts[i + 1] : to.end - OUTRO_MS;
  return a + p * Math.max(0, b - a);
}

/* ───────────── map effects ───────────── */

export type EffectKind = "course" | "sweep" | "flight" | "pop" | "ack" | "wake" | "ring" | "lease" | "commit" | "replot";

export interface Effect {
  /** The step id: the same effect keeps its key from frame to frame. */
  id: string;
  kind: EffectKind;
  step: ReplayStep;
  /** 0–1. */
  p: number;
  tone: "accent" | "magenta" | "clear" | "danger" | "caution";
  /** The effect shows its tag. A newer tag at the same work copy replaces it, so two tags never overlap. */
  labelled: boolean;
}

/** Effects with a tag next to the work copy (tests, an answer, the lease). */
const TAGGED: ReadonlySet<EffectKind> = new Set<EffectKind>(["pop", "ack", "ring", "lease"]);

/** Wall duration of each effect (ms). */
export const EFFECT_MS: Record<EffectKind, number> = { course: 1300, sweep: 1500, flight: 1400, pop: 700, ack: 900, wake: 800, ring: 1000, lease: 1100, commit: 1800, replot: 1400 };
const LONGEST_EFFECT = Math.max(...Object.values(EFFECT_MS));

/** The map effect of a step, or null. */
export function effectOf(step: ReplayStep): Pick<Effect, "kind" | "tone"> | null {
  switch (step.kind) {
    case "plan":
      return { kind: "course", tone: "accent" };
    case "check":
      return { kind: "sweep", tone: step.check?.verdict === "clear" ? "accent" : "magenta" };
    case "request":
      return { kind: "flight", tone: "magenta" };
    case "deliver":
      return { kind: "pop", tone: "magenta" };
    case "ack":
      return { kind: "ack", tone: "clear" };
    case "work":
      return step.files?.length ? { kind: "wake", tone: "accent" } : null;
    case "tests":
      return step.tests?.waits ? null : { kind: "ring", tone: step.tests?.ok ? "clear" : "danger" };
    case "composed":
      return { kind: "ring", tone: step.tests?.ok ? "clear" : "danger" };
    case "lease":
      return { kind: "lease", tone: "accent" };
    case "commit":
      return { kind: "commit", tone: "clear" };
    case "replot":
      return { kind: "replot", tone: "caution" };
    case "stale":
      return { kind: "ring", tone: "danger" };
    default:
      return null;
  }
}

/** The effects that run at a wall time, oldest first, each with its progress. */
export function effectsAt(script: ReplayScript, s: Schedule, wall: number): Effect[] {
  const out: Effect[] = [];
  // Work copies with a newer tag (also one that ended): an older tag does not come back.
  const tagged = new Set<string>();
  const last = indexAt(s, wall);
  for (let i = last; i >= 0 && s.starts[i] > wall - LONGEST_EFFECT; i--) {
    const step = script.steps[i];
    const e = effectOf(step);
    if (!e) continue;
    const owner = TAGGED.has(e.kind) ? (step.attemptId ?? "") : null;
    const labelled = owner === null || !tagged.has(owner);
    if (owner !== null) tagged.add(owner);
    const p = (wall - s.starts[i]) / EFFECT_MS[e.kind];
    if (p < 0 || p >= 1) continue;
    out.push({ id: step.id, kind: e.kind, tone: e.tone, step, p, labelled });
  }
  return out.reverse();
}

/* ───────────── easing ───────────── */

export const easeOut = (t: number) => 1 - (1 - t) ** 3;
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
