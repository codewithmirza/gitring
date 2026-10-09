import { describe, expect, it } from "vitest";
import {
  buildClefRequest,
  CLEF_MAX_QUESTIONS,
  parseClefResponse,
  resolveGiveWay,
  type ClefAnswer,
  type ClefResponse,
} from "../../src/core/coord/clef";
import { buildPairFacts, type VesselView } from "../../src/core/coord/facts";
import { rulesAssessment } from "../../src/core/coord/rules";
import { INTERFERENCE_LEVELS } from "../../src/core/types";
import {
  currencyVessel,
  darkModeVessel,
  graph,
  makeAgent,
  makeIntent,
  searchVessel,
  staffPicksVessel,
  T0,
} from "./fixtures";

const legend = Object.fromEntries(INTERFERENCE_LEVELS.map((l, i) => [String(i), l]));

function score(probs: number[], confidence: number): ClefAnswer {
  const probabilities = Object.fromEntries(probs.map((p, i) => [String(i), p]));
  return { type: "score", score: probs.reduce((s, p, i) => s + p * i, 0), legend, probabilities, confidence };
}
function choice(probabilities: Record<string, number>, confidence: number): ClefAnswer {
  const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { type: "choice", choice: best, probabilities, confidence };
}
const noul = (p: number): ClefAnswer => ({ type: "noul", noul: p });

/** (a) The incoming vessel is OSPREY-2 (staff picks); traffic: HERON-3 (currency) and KESTREL-7 (dark mode). */
function scenarioA() {
  const incoming = staffPicksVessel();
  const cands = [currencyVessel(), darkModeVessel()].map((view) => ({ view, facts: buildPairFacts(incoming, view, graph) }));
  return { incoming, cands };
}

/** A realistic Clef-flash answer for scenario (a). */
function realisticResponse(): ClefResponse {
  return {
    model: "clef-flash",
    answers: {
      "collide.v0": noul(0.83),
      "interfere.v0": score([0.02, 0.05, 0.08, 0.79, 0.06], 0.72),
      "giveway.v0": choice({ incoming: 0.91, other: 0.09 }, 0.82),
      "collide.v1": noul(0.18),
      "interfere.v1": score([0.31, 0.52, 0.12, 0.04, 0.01], 0.47),
      "giveway.v1": choice({ incoming: 0.58, other: 0.42 }, 0.16),
      duplicate: noul(0.04),
      "duplicate.of": choice({ none: 0.93, v0: 0.04, v1: 0.03 }, 0.86),
    },
    usage: { input_tokens: 1873, output_tokens: 61 },
  };
}

describe("buildClefRequest", () => {
  it("(a) asks three questions per candidate plus the duplicate questions", () => {
    const { incoming, cands } = scenarioA();
    const req = buildClefRequest("clef-flash", incoming, cands);
    expect(req.model).toBe("clef-flash");
    expect(Object.keys(req.questions).sort()).toEqual(
      ["collide.v0", "collide.v1", "duplicate", "duplicate.of", "giveway.v0", "giveway.v1", "interfere.v0", "interfere.v1"].sort(),
    );
    expect(req.questions["collide.v0"]).toMatchObject({
      type: "noul",
      instructions: "Will the incoming work and v0 conflict (text or behavior) if both continue unchanged?",
    });
    expect(req.questions["interfere.v0"]).toEqual({
      type: "score",
      instructions: "Rate the interference between the incoming work and v0.",
      criteria: [...INTERFERENCE_LEVELS],
    });
    const gw = req.questions["giveway.v0"];
    expect(gw.type).toBe("choice");
    if (gw.type === "choice") {
      expect(gw.criteria).toEqual({ incoming: "The incoming agent adapts its plan", other: "v0 adapts its plan" });
      expect(gw.instructions).toContain("R1, R2, R3, R5, R4, R6");
    }
    expect(req.questions.duplicate).toMatchObject({ type: "noul", instructions: "Does the incoming intent duplicate any traffic intent?" });

    const state = req.state as {
      incoming: { callsign: string; intent: { title: string }; footprint: { files: Record<string, number[][]>; referenced: string[] } };
      traffic: { id: string; callsign: string; facts: { range: number; interfaceHits: unknown[] }; footprint: { signatures?: unknown } }[];
      rules: string[];
    };
    expect(state.incoming.callsign).toBe("OSPREY-2");
    expect(state.incoming.footprint.files["src/render.js"]).toEqual([[40, 41], [45, 45]]);
    expect(state.incoming.footprint.referenced).toContain("src/products.js#formatPrice");
    expect(state.traffic.map((t) => [t.id, t.callsign, t.facts.range])).toEqual([
      ["v0", "HERON-3", 1],
      ["v1", "KESTREL-7", 2],
    ]);
    expect(state.traffic[0].facts.interfaceHits).toEqual([{ changedBy: "other", symbol: "src/products.js#formatPrice", usedAt: ["src/render.js"] }]);
    expect(state.traffic[0].footprint.signatures).toEqual({
      "src/products.js#formatPrice": { before: "formatPrice(cents)", after: "formatPrice(cents, currency)" },
    });
    expect(state.rules[0]).toMatch(/^R1 /);
    // R4 and R6 need the declaration time and the size of each vessel.
    const full = req.state as { incoming: { size: number; course: { declaredAt: string } }; traffic: { size: number; course: { declaredAt: string } }[] };
    expect(full.incoming.size).toBe(19);
    expect(full.traffic[0].size).toBe(14);
    expect(full.incoming.course.declaredAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(full.traffic[0].course.declaredAt < full.incoming.course.declaredAt).toBe(true);
    // The state is plain JSON.
    expect(JSON.parse(JSON.stringify(req.state))).toEqual(req.state);
  });

  it("(g) stays within 64 questions for 20 candidates, and caps the candidates at 20", () => {
    const incoming = staffPicksVessel({ intent: makeIntent("int_long", "Add staff picks", "x ".repeat(2000)) });
    const many = Array.from({ length: 25 }, (_, i) => {
      const view = searchVessel({ attemptId: `att_${i}`, agent: makeAgent(`agt_${i}`, `WREN-${i}`), intent: makeIntent(`int_${i}`, `Search ${i}`, "Search.") });
      return { view, facts: buildPairFacts(incoming, view, graph) };
    });
    const req20 = buildClefRequest("clef", incoming, many.slice(0, 20));
    expect(Object.keys(req20.questions)).toHaveLength(62);
    expect(Object.keys(req20.questions).length).toBeLessThanOrEqual(CLEF_MAX_QUESTIONS);
    const req25 = buildClefRequest("clef", incoming, many);
    expect(Object.keys(req25.questions)).toHaveLength(62);
    expect((req25.state as { traffic: unknown[] }).traffic).toHaveLength(20);
    expect((req25.state as { incoming: { intent: { goal: string } } }).incoming.intent.goal.length).toBeLessThanOrEqual(600);
    // Question ids follow the Clef id rules.
    for (const id of Object.keys(req25.questions)) expect(id).toMatch(/^[A-Za-z0-9_.-]{1,100}$/);
    // One candidate: no duplicate.of question.
    const one = buildClefRequest("clef-flash", incoming, many.slice(0, 1));
    expect(Object.keys(one.questions).sort()).toEqual(["collide.v0", "duplicate", "giveway.v0", "interfere.v0"]);
  });
});

describe("parseClefResponse", () => {
  it("(a) maps a realistic response to assessments", () => {
    const { incoming, cands } = scenarioA();
    const out = parseClefResponse(realisticResponse(), incoming, cands);
    expect(out.missing).toEqual([]);
    expect(out.assessments[0]).toEqual({
      otherAttemptId: "att_currency",
      collision: 0.83,
      interference: 2.82,
      duplicate: expect.closeTo(0.04 * (0.04 / 0.07), 3),
      giveWay: "incoming",
      giveWayConfidence: 0.82,
      rule: "R3-producer-stands-on",
    });
    // v1: Clef leans "incoming" with P = 0.58 (< 0.6). The rules agree (R4: KESTREL-7 declared first).
    expect(out.assessments[1]).toMatchObject({ otherAttemptId: "att_darkmode", collision: 0.18, giveWay: "incoming", rule: "R4-first-declared-stands-on" });
    expect(out.assessments[1].interference).toBe(0.92);
    // Overall confidence: the minimum among risky candidates (v0 only): mean(0.72, 0.82).
    expect(out.confidence).toBe(0.77);
    expect(out.duplicate).toBe(0.04);
  });

  it("(g) falls back to the rules for missing or malformed answers", () => {
    const { incoming, cands } = scenarioA();
    const res = realisticResponse();
    delete res.answers["interfere.v1"];
    delete res.answers["giveway.v1"];
    res.answers["collide.v0"] = { type: "noul", noul: 7 } as ClefAnswer; // out of range
    delete res.answers.duplicate;
    const out = parseClefResponse(res, incoming, cands);
    expect(out.missing.sort()).toEqual(["collide.v0", "duplicate", "giveway.v1", "interfere.v1"].sort());
    const rules0 = rulesAssessment(incoming, cands[0].view, cands[0].facts);
    const rules1 = rulesAssessment(incoming, cands[1].view, cands[1].facts);
    expect(out.assessments[0].collision).toBe(rules0.collision);
    expect(out.assessments[0].interference).toBe(2.82); // still from Clef
    expect(out.assessments[1]).toMatchObject({
      collision: 0.18,
      interference: rules1.interference,
      giveWay: rules1.giveWay,
      rule: rules1.rule,
      giveWayConfidence: rules1.giveWayConfidence,
    });
    expect(out.duplicate).toBe(Math.max(rules0.duplicate, rules1.duplicate));

    const empty = parseClefResponse({ model: "clef-flash", answers: {} }, incoming, cands);
    expect(empty.assessments).toEqual([rules0, rules1]);
    expect(empty.missing).toHaveLength(7);
    const broken = parseClefResponse(null as unknown as ClefResponse, incoming, cands);
    expect(broken.assessments).toEqual([rules0, rules1]);
  });

  it("attributes the global duplicate with duplicate.of, else to the most similar intent", () => {
    const { incoming, cands } = scenarioA();
    const res = realisticResponse();
    res.answers.duplicate = noul(0.9);
    res.answers["duplicate.of"] = choice({ none: 0.1, v0: 0.05, v1: 0.85 }, 0.8);
    const out = parseClefResponse(res, incoming, cands);
    expect(out.duplicate).toBe(0.9);
    expect(out.assessments[1].duplicate).toBe(0.85);
    expect(out.assessments[0].duplicate).toBe(0.05);
    res.answers["duplicate.of"] = choice({ none: 1 }, 1);
    const none = parseClefResponse(res, incoming, cands);
    expect(none.missing).toEqual([]);
    expect(none.assessments[0].duplicate).toBe(0.9); // falls back to the most similar intent
    delete res.answers["duplicate.of"];
    const out2 = parseClefResponse(res, incoming, cands);
    expect(out2.missing).toEqual(["duplicate.of"]);
    // Staff picks is more similar to currency ("prices") than to dark mode.
    expect(out2.assessments[0].duplicate).toBe(0.9);
    expect(out2.assessments[1].duplicate).toBeLessThan(0.1);
  });
});

describe("give-way resolution", () => {
  const pair = (incoming: VesselView, other: VesselView) => buildPairFacts(incoming, other, graph);

  it("never lets the model overrule R1 (landed) or R2 (waiting)", () => {
    const landed = staffPicksVessel({ status: "landed", state: "landed" });
    const incoming = currencyVessel();
    const r = resolveGiveWay(incoming, landed, pair(incoming, landed), { choice: "other", probability: 0.99 });
    expect(r).toEqual({ giveWay: "incoming", rule: "R1-landed-has-way", source: "rules" });
    const waiting = darkModeVessel({ status: "ready" });
    const active = searchVessel();
    expect(resolveGiveWay(active, waiting, pair(active, waiting), { choice: "other", probability: 0.95 })).toEqual({
      giveWay: "incoming",
      rule: "R2-waiting-stands-on",
      source: "rules",
    });
  });

  it("lets a confident model pick a side that a later soft rule supports", () => {
    // Search (WREN-5) vs dark mode (KESTREL-7): R4 says WREN-5 gives way; R6 says KESTREL-7 (bigger) stands on…
    // Make dark mode the smaller change so that R6 supports "other".
    const small = darkModeVessel({ files: { "src/render.js": { hunks: [[8, 9]] } } });
    const incoming = searchVessel({ declaredAt: T0 + 20_000 });
    const facts = pair(incoming, small);
    expect(resolveGiveWay(incoming, small, facts, { choice: "other", probability: 0.8 })).toEqual({
      giveWay: "other",
      rule: "R6-smaller-gives-way",
      source: "clef",
    });
    // A near tie is broken by the rules.
    expect(resolveGiveWay(incoming, small, facts, { choice: "other", probability: 0.55 })).toEqual({
      giveWay: "incoming",
      rule: "R4-first-declared-stands-on",
      source: "rules",
    });
    // No soft rule supports the model's side: the rules decide.
    const big = darkModeVessel();
    expect(resolveGiveWay(incoming, big, pair(incoming, big), { choice: "other", probability: 0.9 })).toMatchObject({
      giveWay: "incoming",
      source: "rules",
    });
  });
});
