import { describe, expect, it } from "vitest";
import {
  buildPairFacts,
  buildVesselView,
  footprintSize,
  intentSimilarity,
  measureTraffic,
  pickCandidates,
  selectCandidates,
  stateOfAttempt,
  tokenize,
  usedAtFiles,
  MAX_CANDIDATES,
} from "../../src/core/coord/facts";
import { emptyShape } from "../../src/core/analysis/range";
import {
  agents,
  apiItemVessel,
  currencyVessel,
  darkModeVessel,
  darkThemeVessel,
  graph,
  intents,
  makeAgent,
  makeIntent,
  searchVessel,
  staffPicksVessel,
  T0,
  vessel,
} from "./fixtures";

describe("selectCandidates", () => {
  it("keeps traffic in range ≤ 3, sorted by range, then by the latest update", () => {
    const incoming = searchVessel();
    const traffic = [apiItemVessel(), currencyVessel(), darkModeVessel(), staffPicksVessel()];
    const got = selectCandidates(incoming, traffic, graph).map((c) => [c.view.agent.callsign, c.range]);
    // dark mode: same header lines (0); staff picks and currency: same file render.js (2);
    // api item: index.js imports render.js (3).
    expect(got).toEqual([
      ["KESTREL-7", 0],
      ["OSPREY-2", 2],
      ["HERON-3", 2],
      ["PETREL-4", 3],
    ]);
    expect(selectCandidates(incoming, traffic, graph, 2).map((c) => c.view.agent.callsign)).toEqual(["KESTREL-7", "OSPREY-2", "HERON-3"]);
  });

  it("skips itself, the same agent, sibling attempts of the same intent and attempts that left the traffic", () => {
    const incoming = darkModeVessel();
    const traffic = [
      incoming,
      searchVessel({ agent: agents.kestrel, attemptId: "att_same_agent" }),
      searchVessel({ intent: intents.darkMode, attemptId: "att_sibling" }),
      searchVessel({ attemptId: "att_abandoned", status: "abandoned" }),
      searchVessel({ attemptId: "att_alternate", status: "alternate" }),
      // Landed, but not passed in as landed-since-base traffic (state is not "landed"): skipped.
      searchVessel({ attemptId: "att_landed_status", status: "landed", state: "active" }),
      searchVessel({ attemptId: "att_ok" }),
    ];
    expect(selectCandidates(incoming, traffic, graph).map((c) => c.view.attempt.id)).toEqual(["att_ok"]);
  });

  it("keeps landed-since-base traffic that is passed in with state landed (even from the same agent)", () => {
    const incoming = darkModeVessel();
    const landed = searchVessel({ attemptId: "att_landed", status: "landed", state: "landed", agent: agents.kestrel });
    const got = selectCandidates(incoming, [landed], graph);
    expect(got).toHaveLength(1);
    expect(got[0].view.state).toBe("landed");
  });

  it("keeps a closing pair beyond the range limit when previous ranges are given", () => {
    const incoming = vessel({ attemptId: "att_readme", intent: makeIntent("int_readme", "Update the README", "Explain the API."), agent: makeAgent("agt_x", "TERN-1"), files: { "README.md": { hunks: [[1, 4]] } } });
    const far = vessel({ attemptId: "att_docs", intent: makeIntent("int_docs", "Docs site", "Docs."), agent: makeAgent("agt_y", "GULL-2"), files: { "docs/api.md": { hunks: [[1, 2]] } } });
    expect(selectCandidates(incoming, [far], graph)).toEqual([]);
    // previous range 5, now 5: not closing. A pair at 4 that was 5 is closing:
    const near = vessel({ attemptId: "att_styles", intent: makeIntent("int_s", "Styles", "CSS."), agent: makeAgent("agt_z", "LOON-8"), files: { "src/styles.js": { hunks: [[1, 2]] } } });
    const index = vessel({ attemptId: "att_index", intent: makeIntent("int_i", "Index", "Index."), agent: makeAgent("agt_w", "IBIS-6"), files: { "src/index.js": { hunks: [[1, 2]] } } });
    expect(selectCandidates(index, [near], graph)).toEqual([]); // range 4
    const closing = selectCandidates(index, [near], graph, 3, new Map([["att_styles", 5 as const]]));
    expect(closing.map((c) => [c.view.attempt.id, c.range])).toEqual([["att_styles", 4]]);
    expect(selectCandidates(index, [near], graph, 3, { att_styles: 4 })).toEqual([]);
  });

  it("caps the candidates at 20", () => {
    const incoming = darkModeVessel();
    const traffic = Array.from({ length: 30 }, (_, i) =>
      searchVessel({ attemptId: `att_${String(i).padStart(2, "0")}`, agent: makeAgent(`agt_${i}`, `WREN-${i}`), intent: makeIntent(`int_${i}`, `Search ${i}`, "Search."), updatedAt: T0 + i }),
    );
    const got = selectCandidates(incoming, traffic, graph);
    expect(got).toHaveLength(MAX_CANDIDATES);
    expect(got[0].view.attempt.id).toBe("att_29"); // most recent first within one range
  });
});

describe("measureTraffic (the radar)", () => {
  const index = () => vessel({ attemptId: "att_index", intent: makeIntent("int_i", "Index", "Index."), agent: makeAgent("agt_w", "IBIS-6"), files: { "src/index.js": { hunks: [[1, 2]] } } });
  const styles = () => vessel({ attemptId: "att_styles", intent: makeIntent("int_s", "Styles", "CSS."), agent: makeAgent("agt_z", "LOON-8"), files: { "src/styles.js": { hunks: [[1, 2]] } } });
  const readme = () => vessel({ attemptId: "att_readme", intent: makeIntent("int_r", "Readme", "Docs."), agent: makeAgent("agt_r", "TERN-1"), files: { "README.md": { hunks: [[1, 2]] } } });

  it("measures every traffic vessel, far ones included, so that the caller can store each range", () => {
    const got = measureTraffic(index(), [styles(), readme()], graph);
    expect(got.map((m) => [m.view.attempt.id, m.range, m.closing])).toEqual([
      ["att_styles", 4, false],
      ["att_readme", 5, false],
    ]);
    // Nothing is near: no candidate, but the radar knows both pairs.
    expect(pickCandidates(got)).toEqual([]);
  });

  it("makes a pair at range 4 a candidate when it came closer from 5", () => {
    const measured = measureTraffic(index(), [styles()], graph, new Map([["att_styles", 5 as const]]));
    expect(measured[0]).toMatchObject({ range: 4, closing: true });
    expect(pickCandidates(measured).map((c) => [c.view.attempt.id, c.range])).toEqual([["att_styles", 4]]);
  });

  it("counts a redo (rederiving) as traffic, and not the stale work copy that it redoes", () => {
    const incoming = darkModeVessel();
    const redo = searchVessel({ attemptId: "att_redo", status: "rederiving" });
    const stale = searchVessel({ attemptId: "att_stale", status: "stale", agent: makeAgent("agt_old", "SKUA-1") });
    expect(measureTraffic(incoming, [redo, stale], graph).map((m) => m.view.attempt.id)).toEqual(["att_redo"]);
    expect(selectCandidates(incoming, [redo, stale], graph).map((c) => [c.view.attempt.id, c.range])).toEqual([["att_redo", 0]]);
  });
});

describe("selectCandidates at scale", () => {
  it("prefilters 2,000 vessels quickly (memoized import distances)", () => {
    const incoming = darkModeVessel();
    const files = ["src/index.js", "src/render.js", "src/products.js", "src/styles.js", "README.md", "docs/a.md"];
    const traffic = Array.from({ length: 2000 }, (_, i) =>
      vessel({
        attemptId: `att_${i}`,
        intent: makeIntent(`int_${i}`, `Intent ${i}`, "Goal."),
        agent: makeAgent(`agt_${i}`, `SIM-${i}`),
        files: { [files[i % files.length]]: { hunks: [[(i % 50) + 1, (i % 50) + 3]] } },
        updatedAt: T0 + i,
      }),
    );
    const t0 = performance.now();
    const got = selectCandidates(incoming, traffic, graph);
    const ms = performance.now() - t0;
    expect(got).toHaveLength(20);
    expect(got.every((c) => c.range <= 3)).toBe(true);
    expect(ms).toBeLessThan(1500);
  });
});

describe("buildPairFacts", () => {
  it("(a) currency vs staff picks: range 1, an interface hit on formatPrice used in render.js", () => {
    const facts = buildPairFacts(staffPicksVessel(), currencyVessel(), graph);
    expect(facts).toMatchObject({
      otherAttemptId: "att_currency",
      otherAgentId: "agt_heron",
      otherIntentId: "int_currency",
      otherState: "active",
      sharedFiles: ["src/render.js"],
      sharedSymbols: [],
      hunkOverlaps: [],
      range: 1,
      closing: false,
    });
    expect(facts.interfaceHits).toEqual([{ changedBy: "other", symbol: "src/products.js#formatPrice", usedAt: ["src/render.js"] }]);
    expect(facts.previousRange).toBeUndefined();
    // From the producer's side, the hit is changed by the incoming vessel.
    const reverse = buildPairFacts(currencyVessel(), staffPicksVessel(), graph);
    expect(reverse.interfaceHits).toEqual([{ changedBy: "incoming", symbol: "src/products.js#formatPrice", usedAt: ["src/render.js"] }]);
  });

  it("(b) dark mode vs search: range 0, overlapping header hunks and a shared symbol", () => {
    const facts = buildPairFacts(searchVessel(), darkModeVessel(), graph);
    expect(facts.range).toBe(0);
    expect(facts.hunkOverlaps).toEqual([{ path: "src/render.js", incoming: [12, 18], other: [8, 20] }]);
    expect(facts.sharedSymbols).toEqual(["src/render.js#header"]);
    expect(facts.interfaceHits).toEqual([]);
  });

  it("(c) api item vs dark mode: range 3 through the import of render.js", () => {
    const facts = buildPairFacts(apiItemVessel(), darkModeVessel(), graph);
    expect(facts.range).toBe(3);
    expect(facts.sharedFiles).toEqual([]);
    expect(facts.intentSimilarity).toBe(0);
  });

  it("(d) closing: previous range 3, now 2", () => {
    const declared = vessel({
      attemptId: "att_banner",
      intent: makeIntent("int_banner", "Add a sale banner", "Show a sale banner above the list."),
      agent: makeAgent("agt_gull", "GULL-2"),
      course: { files: ["src/render.js"] },
    });
    const closing = buildPairFacts(declared, staffPicksVessel(), graph, 3);
    expect(closing.range).toBe(2);
    expect(closing.previousRange).toBe(3);
    expect(closing.closing).toBe(true);
    const steady = buildPairFacts(declared, staffPicksVessel(), graph, 2);
    expect(steady.closing).toBe(false);
    const opening = buildPairFacts(declared, staffPicksVessel(), graph, 1);
    expect(opening.closing).toBe(false);
  });

  it("names the usage files from the import graph, else from the consumer's other code files", () => {
    const consumer = { ...emptyShape(), files: ["src/index.js", "src/render.js", "tests/x.test.js"] };
    expect(usedAtFiles("src/products.js#formatPrice", consumer, graph)).toEqual(["src/index.js", "src/render.js"]);
    expect(usedAtFiles("src/styles.js#css", consumer, graph)).toEqual(["src/render.js"]);
    const local = { ...emptyShape(), files: ["src/products.js"] };
    expect(usedAtFiles("src/products.js#formatPrice", local, graph)).toEqual(["src/products.js"]);
  });

  it("prefers the files where the consumer really uses the symbol", () => {
    const consumer = {
      ...emptyShape(),
      files: ["src/products.js", "src/render.js"],
      referenced: ["src/render.js#renderItem"],
      referencedIn: { "src/render.js#renderItem": ["src/render.js"] },
    };
    expect(usedAtFiles("src/render.js#renderItem", consumer, graph)).toEqual(["src/render.js"]);
  });
});

describe("intentSimilarity", () => {
  it("(f) finds the duplicate: dark mode vs a dark theme toggle", () => {
    expect(intentSimilarity(intents.darkMode, intents.darkTheme)).toBeGreaterThanOrEqual(0.6);
  });

  it("keeps different goals apart", () => {
    expect(intentSimilarity(intents.darkMode, intents.search)).toBeLessThan(0.2);
    expect(intentSimilarity(intents.currency, intents.staffPicks)).toBeLessThan(0.2);
    expect(intentSimilarity(intents.darkMode, intents.darkMode)).toBe(1);
    expect(intentSimilarity(makeIntent("x", "", ""), makeIntent("y", "", ""))).toBe(0);
  });

  it("tokenizes with stop words, stems and synonyms", () => {
    expect(tokenize("Add a dark theme toggle")).toEqual(["dark", "mode", "switch"]);
    expect(tokenize("The user's toggles switches prices")).toEqual(["user", "switch", "switch", "price"]);
  });
});

describe("vessel views", () => {
  it("maps attempt status to a vessel state", () => {
    expect(stateOfAttempt("underway")).toBe("active");
    expect(stateOfAttempt("declared")).toBe("active");
    expect(stateOfAttempt("ready")).toBe("waiting");
    expect(stateOfAttempt("landing")).toBe("waiting");
    expect(stateOfAttempt("landed")).toBe("landed");
  });

  it("measures the footprint (lines + files; course files when nothing is written)", () => {
    const v = staffPicksVessel();
    expect(v.footprintSize).toBe(16 + 2 + 1);
    expect(footprintSize({ files: {}, symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] }, computedAt: T0 }, { files: ["a", "b"] })).toBe(2);
    expect(darkThemeVessel().footprintSize).toBe(2);
  });

  it("builds the shape from course ∪ footprint", () => {
    const v = buildVesselView({ attempt: currencyVessel().attempt, intent: intents.currency, agent: agents.heron });
    expect(v.shape.files).toEqual(["src/products.js", "src/render.js"]);
    expect(v.shape.signatureChanged).toEqual(["src/products.js#formatPrice"]);
    expect(v.state).toBe("active");
  });
});
