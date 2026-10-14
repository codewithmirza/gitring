/**
 * Turns the timeline records of a project into replay steps, oldest first, one caption and one stage each.
 * Pure. Records may come in any order. The captions come from ../captions.ts.
 */
import type {
  AgentInfo,
  Attempt,
  CheckRun,
  Correction,
  CourseAssessment,
  CourseCheck,
  Decision,
  Landing,
  LogEntry,
  PairFacts,
} from "../../../../../src/core/types";
import type { TimelineIntent, TimelineRecord } from "../../../../../src/core/timeline";
import { correctionFile } from "../../../state/selectors";
import * as C from "../captions";
import type { SubmitOutcome } from "../captions";
import { KIND_ORDER, type ReplayScript, type ReplayStep, STAGE_OF, type TestSummary } from "./steps";

/* ───────────── constants ───────────── */

const MOVE_KINDS = new Set<LogEntry["kind"]>(["write", "log", "push"]);
const RUN_SUMMARY = /(\d+)\/(\d+) pass/;
const CALLSIGN = /\b[A-Z][A-Z]+-\d+\b/g;

/* ───────────── the script builder ───────────── */

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

/* ───────────── one log line ───────────── */

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

/* ───────────── helpers ───────────── */

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
