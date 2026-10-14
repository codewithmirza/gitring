/**
 * Builds the request to the conflict-check model (Clef) and reads its answer, with the rules as the fallback.
 *
 * Called by the project coordinator. The model never replaces the facts of `facts.ts`.
 * Read `rules.ts` for the fallback and `policy.ts` for what the answers decide.
 */

/*
 * Clef request/response for the course check.
 *
 * Clef (`@cf/cloudflare/clef`, 27B) and Clef-flash (`@cf/cloudflare/clef-flash`, 9B, ~39 ms) are
 * decision models: a state plus typed questions in, a probability for every allowed answer out.
 * Up to 64 questions per request.
 *
 * Per candidate v<i> (i = 0…19) we ask three questions:
 *   collide.v<i>    noul    Will the incoming work and v<i> conflict if both continue unchanged?
 *   interfere.v<i>  score   INTERFERENCE_LEVELS (0 none … 4 contradictory)
 *   giveway.v<i>    choice  incoming | other — who adapts, citing the rules of the road
 * and globally:
 *   duplicate       noul    Does the incoming intent duplicate any traffic intent?
 *   duplicate.of    choice  none | v0 … v<n-1>  (only with 2+ candidates; attributes the duplicate)
 * 20 candidates → 60 + 2 = 62 questions (≤ 64, enforced).
 *
 * Parsing (documented choices):
 *  - Every field falls back to the rules assessment when its answer is missing or malformed.
 *  - Give-way: Clef picks the side; the rules of the road bound the choice and name it.
 *      · R1/R2 (hard rules) always win: landed work cannot adapt, waiting work has stopped.
 *      · Clef agrees with the first deciding rule → that rule.
 *      · Clef disagrees: if P(Clef's side) ≥ 0.6 and a later soft rule (R3, R5, R4, R6) supports
 *        Clef's side → Clef's side, labeled with the first supporting rule. Else the rules decide
 *        (a near tie is broken by the rules, and every give-way stays explainable by a rule).
 *  - Per-candidate confidence: mean of the score and choice confidences that Clef returned
 *    (rules confidence when neither came back). Overall confidence: aggregateConfidence() —
 *    the minimum over candidates that carry risk, else the mean.
 *  - Duplicate: the global noul. Per candidate: noul × P(duplicate.of = v<i>) / P(any v);
 *    without duplicate.of, the most similar intent gets the noul and the others
 *    min(noul, rules duplicate).
 */

import { INTERFERENCE_LEVELS, type CourseAssessment, type PairFacts, type RuleOfTheRoad } from "../types";
import type { VesselView } from "./facts";
import {
  HARD_RULES,
  aggregateConfidence,
  evaluateRules,
  rulesAssessment,
  rulesOfTheRoad,
  type Side,
} from "./rules";

export type ClefQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface ClefRequest {
  model: "clef" | "clef-flash";
  state: unknown;
  questions: Record<string, ClefQuestion>;
}

export type ClefAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface ClefResponse {
  model: string;
  answers: Record<string, ClefAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Workers AI model ids. */
export const CLEF_MODEL_IDS = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
} as const;

export const CLEF_MAX_CANDIDATES = 20;
export const CLEF_MAX_QUESTIONS = 64;
/** Clef's side needs at least this probability to overrule the first deciding (soft) rule. */
export const CLEF_OVERRULE_PROBABILITY = 0.6;

/** Rules of the road as Clef reads them, in order of application. */
export const RULES_TEXT: readonly string[] = [
  "R1 landed-has-way: work that landed on main has the right of way. Work in flight adapts.",
  "R2 waiting-stands-on: work that waits to land stands on. Active work adapts.",
  "R3 producer-stands-on: the side that changes an interface (a function signature) stands on. Consumers adapt.",
  "R5 priority-stands-on: an intent with high priority stands on.",
  "R4 first-declared-stands-on: the course declared first stands on.",
  "R6 smaller-gives-way: the smaller change adapts, because it costs less.",
  "Apply the rules in this order: R1, R2, R3, R5, R4, R6. The first rule that decides wins.",
];

export function clefQuestionIds(i: number): { collide: string; interfere: string; giveway: string } {
  return { collide: `collide.v${i}`, interfere: `interfere.v${i}`, giveway: `giveway.v${i}` };
}

/* ───────────────────────────── state ───────────────────────────── */

const truncate = (s: string | undefined, max: number): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};
const cap = <T>(xs: readonly T[] | undefined, n: number): T[] => (xs ?? []).slice(0, n);
const r2 = (x: number) => Math.round(x * 100) / 100;

const iso = (ms: number | undefined): string | undefined => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

function courseState(v: VesselView) {
  const c = v.attempt.course;
  const out: Record<string, unknown> = {
    plan: cap(c?.plan, 8).map((p) => truncate(p, 160)),
    files: cap(c?.files, 16),
    symbols: cap(c?.symbols, 24),
    approach: truncate(c?.approach, 240),
  };
  const declaredAt = iso(c?.declaredAt ?? v.attempt.createdAt); // for R4
  if (declaredAt) out.declaredAt = declaredAt;
  return out;
}

function footprintState(v: VesselView) {
  const fp = v.attempt.footprint;
  const files: Record<string, number[][]> = {};
  for (const path of cap(Object.keys(fp?.files ?? {}).sort(), 16)) {
    files[path] = cap(v.shape.hunks[path] ?? fp.files[path]?.hunks ?? [], 6).map((h) => [h[0], h[1]]);
  }
  const sym = fp?.symbols;
  const out: Record<string, unknown> = {
    files,
    signatureChanged: cap(sym?.signatureChanged, 12),
    changed: cap([...(sym?.defined ?? []), ...(sym?.modified ?? []), ...(sym?.removed ?? [])], 24),
    referenced: cap(sym?.referenced, 24),
  };
  if (v.shape.signatures && Object.keys(v.shape.signatures).length) out.signatures = v.shape.signatures;
  return out;
}

function factsState(f: PairFacts) {
  const out: Record<string, unknown> = {
    range: f.range,
    closing: f.closing,
    sharedFiles: cap(f.sharedFiles, 12),
    sharedSymbols: cap(f.sharedSymbols, 12),
    interfaceHits: cap(f.interfaceHits, 8),
    hunkOverlaps: cap(f.hunkOverlaps, 8),
    intentSimilarity: r2(f.intentSimilarity),
  };
  if (f.previousRange !== undefined) out.previousRange = f.previousRange;
  return out;
}

/** Build the Clef request for one course check (≤ 20 candidates, ≤ 64 questions). */
export function buildClefRequest(
  model: "clef" | "clef-flash",
  incoming: VesselView,
  cands: { view: VesselView; facts: PairFacts }[],
): ClefRequest {
  const list = cands.slice(0, CLEF_MAX_CANDIDATES);
  const state = clefState(incoming, list);
  const questions: Record<string, ClefQuestion> = {};
  addCandidateQuestions(questions, list);
  addDuplicateQuestions(questions, list);
  const n = Object.keys(questions).length;
  if (n > CLEF_MAX_QUESTIONS) throw new Error(`Clef request has ${n} questions; the limit is ${CLEF_MAX_QUESTIONS}.`);
  return { model, state, questions };
}

/** The state that the model reads: the incoming work, the traffic near it, and the rules of the road. */
function clefState(incoming: VesselView, list: { view: VesselView; facts: PairFacts }[]) {
  return {
    task:
      "gitring course check. Many coding agents (vessels) change one repository at the same time. " +
      "Judge whether the incoming vessel's work collides with each traffic vessel v<i>. " +
      "Range: 0 same lines or symbol, 1 interface use, 2 same file, 3 one import apart, 4 two imports apart, 5 unrelated. " +
      "Hunks are [first, last] base line ranges. Size is changed lines plus files.",
    incoming: {
      callsign: incoming.agent.callsign,
      state: incoming.state,
      size: incoming.footprintSize, // for R6
      intent: {
        title: truncate(incoming.intent.title, 140),
        goal: truncate(incoming.intent.goal, 600),
        constraints: cap(incoming.intent.constraints, 8).map((c) => truncate(c, 200)),
        priority: incoming.intent.priority,
      },
      course: courseState(incoming),
      footprint: footprintState(incoming),
    },
    traffic: list.map((c, i) => ({
      id: `v${i}`,
      callsign: c.view.agent.callsign,
      state: c.view.state,
      size: c.view.footprintSize,
      intent: {
        title: truncate(c.view.intent.title, 140),
        goal: truncate(c.view.intent.goal, 280),
        priority: c.view.intent.priority,
      },
      course: courseState(c.view),
      footprint: footprintState(c.view),
      facts: factsState(c.facts),
    })),
    rules: RULES_TEXT,
  };
}

/** Three questions for each candidate: do the two collide, how much do they interfere, who adapts. */
function addCandidateQuestions(questions: Record<string, ClefQuestion>, list: { view: VesselView; facts: PairFacts }[]): void {
  list.forEach((_c, i) => {
    const id = clefQuestionIds(i);
    const v = `v${i}`;
    questions[id.collide] = {
      type: "noul",
      instructions: `Will the incoming work and ${v} conflict (text or behavior) if both continue unchanged?`,
      criteria: {
        true: `The two changes edit the same lines, or one change breaks code or behavior that the other uses.`,
        false: `Both changes can land in any order and all checks still pass.`,
      },
    };
    questions[id.interfere] = {
      type: "score",
      instructions: `Rate the interference between the incoming work and ${v}.`,
      criteria: [...INTERFERENCE_LEVELS],
    };
    questions[id.giveway] = {
      type: "choice",
      instructions:
        `If the incoming work and ${v} conflict, which vessel must adapt its plan? ` +
        `Apply the rules of the road in the state in order: R1, R2, R3, R5, R4, R6. ` +
        `R1: landed work has the right of way. R2: work that waits to land stands on. ` +
        `R3: the producer of an interface change stands on. R5: high priority stands on. ` +
        `R4: the earlier course stands on. R6: the smaller change gives way.`,
      criteria: { incoming: "The incoming agent adapts its plan", other: `${v} adapts its plan` },
    };
  });
}

/** Is the incoming task a duplicate of a task in the traffic, and which one. */
function addDuplicateQuestions(questions: Record<string, ClefQuestion>, list: { view: VesselView; facts: PairFacts }[]): void {
  questions.duplicate = {
    type: "noul",
    instructions: "Does the incoming intent duplicate any traffic intent?",
    criteria: {
      true: "A traffic intent has the same goal. One of the two intents is not necessary.",
      false: "Every traffic intent has a different goal, even when the code overlaps.",
    },
  };
  if (list.length >= 2) {
    const criteria: Record<string, string> = { none: "No traffic intent duplicates the incoming intent" };
    list.forEach((c, i) => {
      criteria[`v${i}`] = `The intent of v${i} (${truncate(c.view.intent.title, 80)}) duplicates the incoming intent`;
    });
    questions["duplicate.of"] = {
      type: "choice",
      instructions: "If the incoming intent duplicates a traffic intent, which traffic intent is it?",
      criteria,
    };
  }
}

/* ───────────────────────────── response ───────────────────────────── */

const isProb = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function noulOf(a: unknown): number | undefined {
  const x = a as { type?: string; noul?: unknown } | undefined;
  if (!x || typeof x !== "object") return undefined;
  if (x.type !== undefined && x.type !== "noul") return undefined;
  return isProb(x.noul) ? x.noul : undefined;
}

function scoreOf(a: unknown, levels: number): { score: number; confidence?: number } | undefined {
  const x = a as { type?: string; score?: unknown; confidence?: unknown } | undefined;
  if (!x || typeof x !== "object") return undefined;
  if (x.type !== undefined && x.type !== "score") return undefined;
  if (typeof x.score !== "number" || !Number.isFinite(x.score)) return undefined;
  return { score: clamp(x.score, 0, levels - 1), confidence: isProb(x.confidence) ? x.confidence : undefined };
}

function choiceOf(a: unknown): { choice: string; probabilities: Record<string, number>; confidence?: number } | undefined {
  const x = a as { type?: string; choice?: unknown; probabilities?: unknown; confidence?: unknown } | undefined;
  if (!x || typeof x !== "object") return undefined;
  if (x.type !== undefined && x.type !== "choice") return undefined;
  const probabilities: Record<string, number> = {};
  if (x.probabilities && typeof x.probabilities === "object") {
    for (const [k, v] of Object.entries(x.probabilities as Record<string, unknown>)) if (isProb(v)) probabilities[k] = v;
  }
  let choice = typeof x.choice === "string" ? x.choice : undefined;
  if (!choice) {
    const best = Object.entries(probabilities).sort((p, q) => q[1] - p[1])[0];
    choice = best?.[0];
  }
  if (!choice) return undefined;
  return { choice, probabilities, confidence: isProb(x.confidence) ? x.confidence : undefined };
}

/** Resolve the give-way side from Clef's choice and the rules of the road (see the header). */
export function resolveGiveWay(
  incoming: VesselView,
  other: VesselView,
  facts: PairFacts,
  clef: { choice: Side; probability: number } | undefined,
): { giveWay: Side; rule: RuleOfTheRoad; source: "clef" | "rules" } {
  const verdicts = evaluateRules(incoming, other, facts);
  const first = rulesOfTheRoad(incoming, other, facts);
  if (!clef) return { giveWay: first.giveWay, rule: first.rule, source: "rules" };
  if (clef.choice === first.giveWay) return { giveWay: first.giveWay, rule: first.rule, source: "clef" };
  if (HARD_RULES.has(first.rule)) return { giveWay: first.giveWay, rule: first.rule, source: "rules" };
  if (clef.probability >= CLEF_OVERRULE_PROBABILITY) {
    const support = verdicts.find((v) => !HARD_RULES.has(v.rule) && v.giveWay === clef.choice);
    if (support) return { giveWay: clef.choice, rule: support.rule, source: "clef" };
  }
  return { giveWay: first.giveWay, rule: first.rule, source: "rules" };
}

/**
 * Map Clef answers back to assessments. `missing` (addition) lists question ids that had no
 * usable answer and fell back to the rules assessment.
 */
export function parseClefResponse(
  res: ClefResponse,
  incoming: VesselView,
  cands: { view: VesselView; facts: PairFacts }[],
): { assessments: CourseAssessment[]; confidence: number; duplicate: number; missing: string[] } {
  const list = cands.slice(0, CLEF_MAX_CANDIDATES);
  const answers: Record<string, unknown> = res && typeof res === "object" && res.answers && typeof res.answers === "object" ? res.answers : {};
  const missing: string[] = [];
  const items: { assessment: CourseAssessment; confidence: number }[] = [];

  list.forEach((c, i) => {
    const id = clefQuestionIds(i);
    const fallback = rulesAssessment(incoming, c.view, c.facts);
    const collide = noulOf(answers[id.collide]);
    const score = scoreOf(answers[id.interfere], INTERFERENCE_LEVELS.length);
    const choice = choiceOf(answers[id.giveway]);
    const side = choice && (choice.choice === "incoming" || choice.choice === "other") ? (choice.choice as Side) : undefined;
    if (collide === undefined) missing.push(id.collide);
    if (!score) missing.push(id.interfere);
    if (!side) missing.push(id.giveway);

    const gw = resolveGiveWay(
      incoming,
      c.view,
      c.facts,
      side ? { choice: side, probability: choice!.probabilities[side] ?? choice!.confidence ?? 0.5 } : undefined,
    );
    // Clef decided → its choice confidence; the rules decided → the rule's confidence.
    const giveWayConfidence =
      gw.source === "clef" ? (choice!.confidence ?? choice!.probabilities[side!] ?? fallback.giveWayConfidence) : fallback.giveWayConfidence;

    const assessment: CourseAssessment = {
      otherAttemptId: c.facts.otherAttemptId,
      collision: round3(collide ?? fallback.collision),
      interference: round3(score ? score.score : fallback.interference),
      duplicate: fallback.duplicate, // replaced below
      giveWay: gw.giveWay,
      giveWayConfidence: round3(clamp(giveWayConfidence, 0, 1)),
      rule: gw.rule,
    };
    const confs = [score?.confidence, side ? choice!.confidence : undefined].filter((x): x is number => x !== undefined);
    const confidence = confs.length ? confs.reduce((s, x) => s + x, 0) / confs.length : fallback.giveWayConfidence;
    items.push({ assessment, confidence });
  });

  // Duplicate: global noul, attributed per candidate.
  const fallbackDup = items.reduce((m, x) => Math.max(m, x.assessment.duplicate), 0);
  const dupNoul = noulOf(answers.duplicate);
  if (dupNoul === undefined && list.length) missing.push("duplicate");
  const duplicate = round3(dupNoul ?? fallbackDup);
  if (dupNoul !== undefined && items.length) {
    const of = list.length >= 2 ? choiceOf(answers["duplicate.of"]) : undefined;
    const pv = items.map((_x, i) => (of ? (of.probabilities[`v${i}`] ?? (of.choice === `v${i}` ? 1 : 0)) : 0));
    const mass = pv.reduce((s, x) => s + x, 0);
    if (of && mass > 0) {
      items.forEach((x, i) => (x.assessment.duplicate = round3(clamp((dupNoul * pv[i]) / mass, 0, 1))));
    } else {
      if (!of && list.length >= 2) missing.push("duplicate.of");
      // No attribution (single candidate, no answer, or "none"): the most similar intent gets the noul.
      let best = 0;
      list.forEach((c, i) => {
        if (c.facts.intentSimilarity > list[best].facts.intentSimilarity) best = i;
      });
      items.forEach((x, i) => (x.assessment.duplicate = i === best ? dupNoul : round3(Math.min(dupNoul, x.assessment.duplicate))));
    }
  }

  return {
    assessments: items.map((x) => x.assessment),
    confidence: aggregateConfidence(items),
    duplicate,
    missing,
  };
}
