import { describe, expect, it } from "vitest";
import { buildPairFacts } from "../../src/core/coord/facts";
import {
  assessWithRules,
  duplicateFromSimilarity,
  evaluateRules,
  riskFromFacts,
  RULE_ORDER,
  rulesAssessment,
  rulesOfTheRoad,
} from "../../src/core/coord/rules";
import type { PairFacts } from "../../src/core/types";
import {
  apiItemVessel,
  currencyVessel,
  darkModeVessel,
  darkThemeVessel,
  graph,
  intents,
  searchVessel,
  staffPicksVessel,
  T0,
} from "./fixtures";
import { steViolations } from "./ste";

const baseFacts = (over: Partial<PairFacts> = {}): PairFacts => ({
  otherAttemptId: "att_x",
  otherAgentId: "agt_x",
  otherIntentId: "int_x",
  otherState: "active",
  sharedFiles: [],
  sharedSymbols: [],
  interfaceHits: [],
  hunkOverlaps: [],
  range: 5,
  closing: false,
  intentSimilarity: 0,
  ...over,
});

describe("rules of the road", () => {
  it("(a) R3: the consumer of a changed signature gives way, from both sides", () => {
    const sp = staffPicksVessel();
    const cur = currencyVessel();
    const fromConsumer = rulesOfTheRoad(sp, cur, buildPairFacts(sp, cur, graph));
    expect(fromConsumer).toEqual({
      giveWay: "incoming",
      rule: "R3-producer-stands-on",
      reason: "HERON-3 changes the signature of formatPrice. The producer stands on.",
    });
    const fromProducer = rulesOfTheRoad(cur, sp, buildPairFacts(cur, sp, graph));
    expect(fromProducer.giveWay).toBe("other");
    expect(fromProducer.rule).toBe("R3-producer-stands-on");
  });

  it("(e) R2: active work gives way to work that waits to land", () => {
    const waiting = darkModeVessel({ status: "ready" });
    const active = searchVessel();
    expect(waiting.state).toBe("waiting");
    const d1 = rulesOfTheRoad(active, waiting, buildPairFacts(active, waiting, graph));
    expect(d1).toMatchObject({ giveWay: "incoming", rule: "R2-waiting-stands-on" });
    expect(d1.reason).toBe("KESTREL-7 waits to land. Active work gives way.");
    const d2 = rulesOfTheRoad(waiting, active, buildPairFacts(waiting, active, graph));
    expect(d2).toMatchObject({ giveWay: "other", rule: "R2-waiting-stands-on" });
  });

  it("(e) R1: landed traffic has the right of way, even over R2 and R3", () => {
    const landed = staffPicksVessel({ status: "landed", state: "landed" });
    const producer = currencyVessel({ status: "ready" }); // waiting producer
    const facts = buildPairFacts(producer, landed, graph);
    expect(facts.otherState).toBe("landed");
    expect(rulesOfTheRoad(producer, landed, facts)).toEqual({
      giveWay: "incoming",
      rule: "R1-landed-has-way",
      reason: "OSPREY-2 landed on main. Landed work has the right of way.",
    });
  });

  it("R5 before R4: high priority stands on even when declared later", () => {
    const urgent = searchVessel({ intent: { ...intents.search, priority: "high" } });
    const early = darkModeVessel();
    const d = rulesOfTheRoad(urgent, early, buildPairFacts(urgent, early, graph));
    expect(d).toMatchObject({ giveWay: "other", rule: "R5-priority-stands-on" });
  });

  it("R4: the earlier course stands on; R6: the smaller change gives way; tie → incoming", () => {
    const later = searchVessel({ declaredAt: T0 + 20_000 });
    const earlier = darkModeVessel({ declaredAt: T0 + 10_000 });
    expect(rulesOfTheRoad(later, earlier, buildPairFacts(later, earlier, graph)).rule).toBe("R4-first-declared-stands-on");
    const same1 = searchVessel({ declaredAt: T0 });
    const same2 = darkModeVessel({ declaredAt: T0 });
    const d = rulesOfTheRoad(same2, same1, buildPairFacts(same2, same1, graph));
    // dark mode: 13 + 8 lines ×2 + 2 files = 44; search: 9 + 3 + 1 = 13 → search is smaller.
    expect(d).toMatchObject({ giveWay: "other", rule: "R6-smaller-gives-way" });
    const tie = rulesOfTheRoad(same1, { ...same1, attempt: { ...same1.attempt, id: "att_twin" } }, baseFacts());
    expect(tie).toMatchObject({ giveWay: "incoming", rule: "R6-smaller-gives-way" });
  });

  it("evaluates every rule in order with STE reasons", () => {
    const sp = staffPicksVessel();
    const cur = currencyVessel();
    const verdicts = evaluateRules(sp, cur, buildPairFacts(sp, cur, graph));
    expect(verdicts.map((v) => v.rule)).toEqual([...RULE_ORDER]);
    // R6 alone would pick HERON-3 (14 < 19): the order of the rules matters.
    expect(verdicts.map((v) => v.giveWay)).toEqual([null, null, "incoming", null, "incoming", "other"]);
    for (const v of verdicts) expect(steViolations(v.reason)).toEqual([]);
  });
});

describe("rules assessment", () => {
  it("follows the heuristics table", () => {
    expect(riskFromFacts(baseFacts({ range: 0, hunkOverlaps: [{ path: "a", incoming: [1, 2], other: [2, 3] }] }))).toEqual({ collision: 0.9, interference: 2.3 });
    expect(riskFromFacts(baseFacts({ range: 0, interfaceHits: [{ changedBy: "other", symbol: "a#f", usedAt: ["b"] }] }))).toEqual({ collision: 0.92, interference: 2.9 });
    expect(riskFromFacts(baseFacts({ range: 1, interfaceHits: [{ changedBy: "other", symbol: "a#f", usedAt: ["b"] }] }))).toEqual({ collision: 0.75, interference: 3 });
    expect(riskFromFacts(baseFacts({ range: 1 }))).toEqual({ collision: 0.5, interference: 1.8 });
    expect(riskFromFacts(baseFacts({ range: 2 }))).toEqual({ collision: 0.45, interference: 1.6 });
    expect(riskFromFacts(baseFacts({ range: 3 }))).toEqual({ collision: 0.2, interference: 0.9 });
    expect(riskFromFacts(baseFacts({ range: 4 }))).toEqual({ collision: 0.08, interference: 0.4 });
    expect(riskFromFacts(baseFacts({ range: 5 }))).toEqual({ collision: 0.02, interference: 0.1 });
  });

  it("adds risk for closing pairs, landed traffic and extra overlaps", () => {
    expect(riskFromFacts(baseFacts({ range: 2, closing: true, previousRange: 3 }))).toEqual({ collision: 0.55, interference: 1.7 });
    expect(riskFromFacts(baseFacts({ range: 2, otherState: "landed" })).collision).toBe(0.5);
    const three = [1, 2, 3].map((i) => ({ path: "a", incoming: [i, i] as [number, number], other: [i, i] as [number, number] }));
    expect(riskFromFacts(baseFacts({ range: 0, hunkOverlaps: three, sharedSymbols: ["a#f"] })).interference).toBe(2.6);
  });

  it("maps intent similarity to P(duplicate)", () => {
    expect(duplicateFromSimilarity(1, false)).toBe(0.9);
    expect(duplicateFromSimilarity(0.6, true)).toBe(0.9);
    expect(duplicateFromSimilarity(0.5, false)).toBe(0.55);
    expect(duplicateFromSimilarity(0.3, true)).toBe(0.25);
    expect(duplicateFromSimilarity(0.1, false)).toBe(0.05);
  });

  it("(a) currency vs staff picks", () => {
    const sp = staffPicksVessel();
    const cur = currencyVessel();
    expect(rulesAssessment(sp, cur, buildPairFacts(sp, cur, graph))).toEqual({
      otherAttemptId: "att_currency",
      collision: 0.75,
      interference: 3,
      duplicate: 0.032,
      giveWay: "incoming",
      giveWayConfidence: 0.85,
      rule: "R3-producer-stands-on",
    });
  });

  it("(c) api item vs dark mode is low risk; (f) dark theme vs dark mode is a duplicate", () => {
    const api = apiItemVessel();
    const dm = darkModeVessel();
    const low = rulesAssessment(api, dm, buildPairFacts(api, dm, graph));
    expect(low.collision).toBe(0.2);
    expect(low.interference).toBe(0.9);
    const dt = darkThemeVessel();
    const dup = rulesAssessment(dt, dm, buildPairFacts(dt, dm, graph));
    expect(dup.duplicate).toBeGreaterThanOrEqual(0.8);
  });

  it("assesses a whole check offline with the Clef output shape", () => {
    const sp = staffPicksVessel();
    const cands = [currencyVessel(), apiItemVessel()].map((view) => ({ view, facts: buildPairFacts(sp, view, graph) }));
    const out = assessWithRules(sp, cands);
    expect(out.assessments).toHaveLength(2);
    // Only the currency pair carries risk → the overall confidence is its confidence.
    expect(out.confidence).toBe(0.85);
    expect(out.duplicate).toBe(Math.max(...out.assessments.map((a) => a.duplicate)));
  });
});
