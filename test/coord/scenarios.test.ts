/**
 * End-to-end course checks on the catalog app: candidates → facts → (rules | Clef) → policy →
 * correction text. This is the pipeline the HarborMaster runs.
 */
import { describe, expect, it } from "vitest";
import { buildClefRequest, parseClefResponse, type ClefRequest, type ClefResponse } from "../../src/core/coord/clef";
import { draftCorrection, draftDuplicateCorrection } from "../../src/core/coord/corrections";
import { buildPairFacts, selectCandidates, type VesselView } from "../../src/core/coord/facts";
import { decide } from "../../src/core/coord/policy";
import { assessWithRules, rulesAssessment } from "../../src/core/coord/rules";
import { DEFAULT_THRESHOLDS, type Range } from "../../src/core/types";
import {
  apiItemVessel,
  currencyVessel,
  darkModeVessel,
  darkThemeVessel,
  graph,
  makeAgent,
  makeIntent,
  searchVessel,
  staffPicksVessel,
  vessel,
} from "./fixtures";
import { expectSTE } from "./ste";

type Clef = (req: ClefRequest) => ClefResponse;

function courseCheck(incoming: VesselView, traffic: VesselView[], opts: { clef?: Clef; previous?: Map<string, Range> } = {}) {
  const cands = selectCandidates(incoming, traffic, graph, 3, opts.previous);
  const pairs = cands.map((c) => ({ view: c.view, facts: buildPairFacts(incoming, c.view, graph, opts.previous?.get(c.view.attempt.id)) }));
  if (!pairs.length) return { verdict: "clear" as const, pairs, outcome: undefined, corrections: [], modelCalls: 0 };
  const parsed = opts.clef ? parseClefResponse(opts.clef(buildClefRequest("clef-flash", incoming, pairs)), incoming, pairs) : assessWithRules(incoming, pairs);
  const outcome = decide(parsed.assessments, pairs.map((p) => p.facts), DEFAULT_THRESHOLDS, parsed.duplicate, parsed.confidence);
  const corrections = outcome.corrections.map((c) => {
    const other = pairs.find((p) => p.view.attempt.id === c.otherAttemptId)!.view;
    const [giveWay, standOn] = c.giveWay === "incoming" ? [incoming, other] : [other, incoming];
    return { to: giveWay.agent.callsign, from: standOn.agent.callsign, rule: c.rule, ...draftCorrection(giveWay, standOn, c.facts, c.rule, c.giveWay) };
  });
  return { verdict: outcome.verdict, pairs, outcome, corrections, modelCalls: opts.clef ? 1 : 0 };
}

/** A fake Clef that answers only the collision questions (0.5); every other field falls back to the rules. */
const partialClef: Clef = (req) => {
  const answers: ClefResponse["answers"] = {};
  for (const id of Object.keys(req.questions)) if (id.startsWith("collide.")) answers[id] = { type: "noul", noul: 0.5 };
  return { model: "clef-flash", answers, usage: { input_tokens: 900, output_tokens: 40 } };
};

describe("course check scenarios (rules path)", () => {
  it("(a) staff picks writes code that calls formatPrice; currency changes its signature → interface correction to OSPREY-2", () => {
    const check = courseCheck(staffPicksVessel(), [currencyVessel(), apiItemVessel()]);
    expect(check.verdict).toBe("correct");
    expect(check.corrections).toHaveLength(1);
    const c = check.corrections[0];
    expect(c).toMatchObject({ to: "OSPREY-2", from: "HERON-3", rule: "R3-producer-stands-on", kind: "interface" });
    expect(c.message).toContain("HERON-3 changes formatPrice(cents) to formatPrice(cents, currency) in src/products.js.");
    expectSTE(c.message);
  });

  it("(a) from the producer's side the correction goes to the other vessel", () => {
    const check = courseCheck(currencyVessel(), [staffPicksVessel()]);
    expect(check.verdict).toBe("correct");
    expect(check.corrections[0]).toMatchObject({ to: "OSPREY-2", from: "HERON-3", kind: "interface" });
    expect(check.outcome!.corrections[0].giveWay).toBe("other");
  });

  it("(b) dark mode and search both edit the header → region correction to the later course", () => {
    const check = courseCheck(searchVessel(), [darkModeVessel()]);
    expect(check.pairs[0].facts.range).toBe(0);
    expect(check.verdict).toBe("correct");
    expect(check.corrections[0]).toMatchObject({ to: "WREN-5", from: "KESTREL-7", kind: "region", rule: "R4-first-declared-stands-on" });
    expect(check.corrections[0].constraints.avoidRegions).toEqual([{ path: "src/render.js", lines: [8, 20] }]);
    expectSTE(check.corrections[0].message);
  });

  it("(c) api item (index.js) vs dark mode (render.js, styles.js): range 3 → clear", () => {
    const check = courseCheck(apiItemVessel(), [darkModeVessel()]);
    expect(check.pairs.map((p) => p.facts.range)).toEqual([3]);
    expect(check.verdict).toBe("clear");
    expect(check.corrections).toEqual([]);
  });

  it("no candidate → clear without any model call", () => {
    const readme = vessel({ attemptId: "att_readme", intent: makeIntent("int_readme", "Update the README", "Explain setup."), agent: makeAgent("agt_t", "TERN-1"), files: { "README.md": { hunks: [[1, 3]] } } });
    const check = courseCheck(readme, [darkModeVessel(), currencyVessel()], { clef: () => { throw new Error("no call expected"); } });
    expect(check).toMatchObject({ verdict: "clear", modelCalls: 0 });
  });

  it("(d) closing: a course that moves from range 3 to range 2 is checked with more risk", () => {
    const banner = (files: string[]) =>
      vessel({ attemptId: "att_banner", intent: makeIntent("int_banner", "Add a sale banner", "Show a sale banner above the list."), agent: makeAgent("agt_g", "GULL-2"), course: { files } });
    const first = courseCheck(banner(["src/index.js"]), [staffPicksVessel()]);
    expect(first.pairs[0].facts.range).toBe(3);
    expect(first.verdict).toBe("clear");
    const previous = new Map<string, Range>([["att_staffpicks", 3]]);
    const second = courseCheck(banner(["src/index.js", "src/render.js"]), [staffPicksVessel()], { previous });
    expect(second.pairs[0].facts).toMatchObject({ range: 2, previousRange: 3, closing: true });
    expect(second.outcome!.corrections[0].assessment.collision).toBe(0.55); // 0.45 + 0.10 closing
    expect(second.verdict).toBe("correct");
  });

  it("(e) a vessel that waits to land stands on (R2); landed traffic has the right of way (R1)", () => {
    const waiting = courseCheck(searchVessel({ declaredAt: 0 }), [darkModeVessel({ status: "ready" })]);
    expect(waiting.corrections[0]).toMatchObject({ to: "WREN-5", rule: "R2-waiting-stands-on" });
    const landed = courseCheck(currencyVessel(), [staffPicksVessel({ status: "landed", state: "landed" })]);
    expect(landed.corrections[0]).toMatchObject({ to: "HERON-3", from: "OSPREY-2", rule: "R1-landed-has-way", kind: "interface" });
    expect(landed.corrections[0].message).toContain("Update each call to formatPrice in src/render.js to formatPrice(cents, currency).");
    expectSTE(landed.corrections[0].message);
  });

  it("(f) 'Add a dark theme toggle' duplicates 'Add dark mode' → merge-intents", () => {
    const incoming = darkThemeVessel();
    const check = courseCheck(incoming, [darkModeVessel(), searchVessel()]);
    expect(check.verdict).toBe("merge-intents");
    expect(check.outcome!.duplicateOf).toBe("att_darkmode");
    const dup = draftDuplicateCorrection(incoming, darkModeVessel());
    expect(dup.kind).toBe("duplicate");
    expectSTE(dup.message);
  });
});

describe("course check scenarios (Clef path)", () => {
  it("(a) Clef-flash answers: same verdict, model probabilities, rule from the rules of the road", () => {
    const clef: Clef = () => ({
      model: "clef-flash",
      answers: {
        "collide.v0": { type: "noul", noul: 0.86 },
        "interfere.v0": { type: "score", score: 2.9, legend: {}, probabilities: { "0": 0.02, "1": 0.04, "2": 0.12, "3": 0.74, "4": 0.08 }, confidence: 0.74 },
        "giveway.v0": { type: "choice", choice: "incoming", probabilities: { incoming: 0.9, other: 0.1 }, confidence: 0.8 },
        "collide.v1": { type: "noul", noul: 0.06 },
        "interfere.v1": { type: "score", score: 0.6, legend: {}, probabilities: { "0": 0.5, "1": 0.42, "2": 0.06, "3": 0.02, "4": 0 }, confidence: 0.4 },
        "giveway.v1": { type: "choice", choice: "other", probabilities: { incoming: 0.45, other: 0.55 }, confidence: 0.1 },
        duplicate: { type: "noul", noul: 0.02 },
        "duplicate.of": { type: "choice", choice: "none", probabilities: { none: 0.97, v0: 0.02, v1: 0.01 }, confidence: 0.9 },
      },
      usage: { input_tokens: 2100, output_tokens: 70 },
    });
    const check = courseCheck(staffPicksVessel(), [currencyVessel(), apiItemVessel()], { clef });
    expect(check.verdict).toBe("correct");
    expect(check.outcome!.confidence).toBe(0.77);
    expect(check.corrections.map((c) => [c.to, c.rule, c.kind])).toEqual([["OSPREY-2", "R3-producer-stands-on", "interface"]]);
  });

  it("(h) an uncertain Clef call on a semantic conflict escalates to a human", () => {
    const clef: Clef = () => ({
      model: "clef",
      answers: {
        "collide.v0": { type: "noul", noul: 0.7 },
        "interfere.v0": { type: "score", score: 3.4, legend: {}, probabilities: { "3": 0.6, "4": 0.4 }, confidence: 0.3 },
        "giveway.v0": { type: "choice", choice: "incoming", probabilities: { incoming: 0.52, other: 0.48 }, confidence: 0.04 },
        duplicate: { type: "noul", noul: 0.05 },
      },
    });
    const check = courseCheck(staffPicksVessel(), [currencyVessel()], { clef });
    expect(check.verdict).toBe("escalate");
    expect(check.outcome!.confidence).toBeLessThan(DEFAULT_THRESHOLDS.minConfidence);
  });

  it("(g) a Clef response with missing answers falls back to the rules per field", () => {
    const check = courseCheck(searchVessel(), [darkModeVessel()], { clef: partialClef });
    const rules = rulesAssessment(searchVessel(), darkModeVessel(), check.pairs[0].facts);
    expect(check.outcome!.corrections[0].assessment).toMatchObject({ collision: 0.5, interference: rules.interference, rule: rules.rule });
    expect(check.verdict).toBe("correct");
  });

  it("(g) 20 candidates in one Clef call, ≤ 64 questions", () => {
    const traffic = Array.from({ length: 24 }, (_, i) =>
      searchVessel({ attemptId: `att_${i}`, agent: makeAgent(`agt_${i}`, `WREN-${i}`), intent: makeIntent(`int_${i}`, `Search variant ${i}`, "Filter.") }),
    );
    let questions = 0;
    const check = courseCheck(darkModeVessel(), traffic, {
      clef: (req) => {
        questions = Object.keys(req.questions).length;
        return { model: "clef-flash", answers: {} };
      },
    });
    expect(check.pairs).toHaveLength(20);
    expect(questions).toBe(62);
    expect(check.verdict).toBe("correct");
  });
});
