import { describe, expect, it } from "vitest";
import {
  draftCorrection,
  draftDuplicateCorrection,
  draftIntentAmendedCorrection,
  draftReplotCorrection,
  draftUpstreamCorrection,
  formatLines,
  listFiles,
} from "../../src/core/coord/corrections";
import { buildPairFacts } from "../../src/core/coord/facts";
import { rulesOfTheRoad } from "../../src/core/coord/rules";
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
import { expectSTE, steViolations } from "./ste";

describe("STE helper", () => {
  it("catches long sentences and -ing forms, and allows identifiers and quoted titles", () => {
    expect(steViolations("Do nothing now. Continue your work.")).toHaveLength(1);
    expect(steViolations(`${"word ".repeat(21).trim()}. Continue your work.`)).toHaveLength(1);
    expect(steViolations('Call formatString(s) in src/string.js. Read "Add logging". Continue your work.')).toEqual([]);
  });
});

describe("draftCorrection", () => {
  it("(a) interface: the consumer (staff picks) gets the new signature — incoming gives way", () => {
    const sp = staffPicksVessel();
    const cur = currencyVessel();
    const facts = buildPairFacts(sp, cur, graph);
    const d = draftCorrection(sp, cur, facts, rulesOfTheRoad(sp, cur, facts).rule, "incoming");
    expect(d.kind).toBe("interface");
    expect(d.message).toBe(
      "HERON-3 changes formatPrice(cents) to formatPrice(cents, currency) in src/products.js. " +
        "Call formatPrice(cents, currency) in src/render.js. " +
        "Do not edit formatPrice in src/products.js. " +
        "HERON-3 edits lines 24–26 of src/render.js. Do not edit these lines. Continue your work.",
    );
    expect(d.constraints.useSignatures).toEqual([{ symbol: "src/products.js#formatPrice", signature: "formatPrice(cents, currency)" }]);
    expect(d.constraints.avoidRegions).toEqual([{ path: "src/render.js", lines: [24, 26] }]);
    expectSTE(d.message);
  });

  it("(a) the same correction when the incoming vessel stands on (perspective: other)", () => {
    const cur = currencyVessel();
    const sp = staffPicksVessel();
    const facts = buildPairFacts(cur, sp, graph); // from the producer's side
    const decision = rulesOfTheRoad(cur, sp, facts);
    expect(decision.giveWay).toBe("other");
    const d = draftCorrection(sp, cur, facts, decision.rule, "other");
    const fromConsumer = draftCorrection(sp, cur, buildPairFacts(sp, cur, graph), decision.rule, "incoming");
    expect(d).toEqual(fromConsumer);
  });

  it("(a) quotes the declared signature, and calls with the call form (no defaults)", () => {
    const sp = staffPicksVessel();
    const cur = currencyVessel({ signatures: { "src/products.js#formatPrice": { before: "formatPrice(cents)", after: 'formatPrice(cents, currency = "USD")' } } });
    const facts = buildPairFacts(sp, cur, graph);
    const d = draftCorrection(sp, cur, facts, "R3-producer-stands-on", "incoming");
    expect(d.message).toContain('HERON-3 changes formatPrice(cents) to formatPrice(cents, currency = "USD") in src/products.js.');
    expect(d.message).toContain("Call formatPrice(cents, currency) in src/render.js.");
    expect(d.constraints.useSignatures).toEqual([{ symbol: "src/products.js#formatPrice", signature: 'formatPrice(cents, currency = "USD")' }]);
    expectSTE(d.message);
  });

  it("uses 'this line' for a single line", () => {
    const se = searchVessel({ files: { "src/render.js": { hunks: [[12, 12]] } } });
    const dm = darkModeVessel({ files: { "src/render.js": { hunks: [[13, 13]] } } });
    const d = draftCorrection(se, dm, buildPairFacts(se, dm, graph), "R4-first-declared-stands-on", "incoming");
    expect(d.message).toContain("KESTREL-7 edits line 13 of src/render.js. Your edits overlap this line. Do not edit this line.");
    expectSTE(d.message);
  });

  it("(a) without signature info: names the file and 'the new signature'", () => {
    const sp = staffPicksVessel();
    const cur = currencyVessel({ signatures: undefined });
    const facts = buildPairFacts(sp, cur, graph);
    const d = draftCorrection(sp, cur, facts, "R3-producer-stands-on", "incoming");
    expect(d.message).toContain("HERON-3 changes the signature of formatPrice in src/products.js.");
    expect(d.message).toContain("Read the new signature of formatPrice in src/products.js. Use the new signature in src/render.js.");
    expect(d.constraints.useSignatures).toBeUndefined();
    expectSTE(d.message);
  });

  it("(b) region: search keeps out of the header lines of dark mode", () => {
    const se = searchVessel();
    const dm = darkModeVessel();
    const facts = buildPairFacts(se, dm, graph);
    const decision = rulesOfTheRoad(se, dm, facts);
    expect(decision).toMatchObject({ giveWay: "incoming", rule: "R4-first-declared-stands-on" });
    const d = draftCorrection(se, dm, facts, decision.rule, "incoming");
    expect(d.kind).toBe("region");
    expect(d.message).toBe(
      "KESTREL-7 edits lines 8–20 of src/render.js. Your edits overlap these lines. Do not edit these lines. " +
        "Put your change in a new block below line 20. Continue your work.",
    );
    expect(d.constraints).toEqual({
      avoidRegions: [{ path: "src/render.js", lines: [8, 20] }],
      notes: ["Do not edit lines 8–20 of src/render.js (KESTREL-7)."],
    });
    expectSTE(d.message);
  });

  it("producer side (R2): keep the old signature valid for a consumer that waits to land", () => {
    const cur = currencyVessel();
    const sp = staffPicksVessel({ status: "ready" }); // waits to land
    const facts = buildPairFacts(cur, sp, graph);
    const decision = rulesOfTheRoad(cur, sp, facts);
    expect(decision).toMatchObject({ giveWay: "incoming", rule: "R2-waiting-stands-on" });
    const d = draftCorrection(cur, sp, facts, decision.rule, "incoming");
    expect(d.kind).toBe("interface");
    expect(d.message).toBe(
      "OSPREY-2 calls formatPrice in src/render.js. Keep formatPrice(cents) valid for these calls. " +
        "Give each new parameter a default value. Do not edit the calls in src/render.js. " +
        "OSPREY-2 edits lines 40–41 and 45 of src/render.js. Do not edit these lines. Continue your work.",
    );
    expect(d.constraints.useSignatures).toEqual([{ symbol: "src/products.js#formatPrice", signature: "formatPrice(cents)" }]);
    expectSTE(d.message);
  });

  it("producer side, landed consumer (R1): update the calls, no contradictory region text", () => {
    const cur = currencyVessel();
    const landed = staffPicksVessel({ status: "landed", state: "landed" });
    const facts = buildPairFacts(cur, landed, graph);
    const decision = rulesOfTheRoad(cur, landed, facts);
    expect(decision.rule).toBe("R1-landed-has-way");
    const d = draftCorrection(cur, landed, facts, decision.rule, "incoming");
    expect(d.message).toBe(
      "OSPREY-2 added calls to formatPrice in src/render.js on main. " +
        "Update each call to formatPrice in src/render.js to formatPrice(cents, currency). Continue your work.",
    );
    expectSTE(d.message);
  });

  it("landed region: re-read the file", () => {
    const se = searchVessel();
    const landed = darkModeVessel({ status: "landed", state: "landed" });
    const facts = buildPairFacts(se, landed, graph);
    const d = draftCorrection(se, landed, facts, "R1-landed-has-way", "incoming");
    expect(d.message).toBe(
      "KESTREL-7 changed lines 8–20 of src/render.js on main. Your edits overlap these lines. " +
        "Read src/render.js again before your next edit. Continue your work.",
    );
    expectSTE(d.message);
  });

  it("course-only receiver: shows where to put the change", () => {
    const dt = darkThemeVessel();
    const dm = darkModeVessel();
    const d = draftCorrection(dt, dm, buildPairFacts(dt, dm, graph), "R4-first-declared-stands-on", "incoming");
    expect(d.kind).toBe("region");
    expect(d.message).toContain("KESTREL-7 edits lines 8–20 of src/render.js. Do not edit these lines. Put your change in a new block below line 20.");
    expect(d.message).toContain("KESTREL-7 edits lines 3–10 of src/styles.js.");
    expectSTE(d.message);
  });

  it("course-only stand-on vessel: names its symbols", () => {
    const se = searchVessel();
    const dt = darkThemeVessel();
    const facts = buildPairFacts(se, dt, graph);
    const d = draftCorrection(se, dt, facts, "R4-first-declared-stands-on", "incoming");
    expect(d.message).toContain(
      "SKUA-9 also changes header in src/render.js. Do not rewrite header. Keep your change to header small and in a separate block. Read gitring_traffic before you edit src/render.js.",
    );
    expectSTE(d.message);
  });

  it("near traffic (range 3): keep off the files of the stand-on vessel", () => {
    const api = apiItemVessel();
    const dm = darkModeVessel();
    const d = draftCorrection(api, dm, buildPairFacts(api, dm, graph), "R4-first-declared-stands-on", "incoming");
    expect(d.kind).toBe("region");
    expect(d.message).toBe(
      "KESTREL-7 edits src/render.js and src/styles.js. Do not edit these files. " +
        "Read src/render.js and src/styles.js again before you call their exports. Continue your work.",
    );
    expectSTE(d.message);
  });

  it("range 1 without a signature change: re-read the changed function", () => {
    const user = searchVessel({ symbols: { modified: ["src/render.js#searchBox"], referenced: ["src/render.js#renderItem"] }, files: { "src/index.js": { hunks: [[3, 4]] } } });
    const changer = currencyVessel({ symbols: { modified: ["src/render.js#renderItem"] } });
    const facts = buildPairFacts(user, changer, graph);
    expect(facts.range).toBe(1);
    expect(facts.interfaceHits).toEqual([]);
    const d = draftCorrection(user, changer, facts, "R4-first-declared-stands-on", "incoming");
    expect(d.kind).toBe("interface");
    expect(d.message).toContain("HERON-3 changes renderItem in src/render.js. Read src/render.js again before you call renderItem. Do not edit renderItem.");
    expectSTE(d.message);
  });
});

describe("other corrections", () => {
  it("(f) duplicate", () => {
    const d = draftDuplicateCorrection(darkThemeVessel(), darkModeVessel());
    expect(d.kind).toBe("duplicate");
    expect(d.message).toBe(
      'KESTREL-7 does the same work in the intent "Add dark mode". Do not do this work twice. ' +
        "Change your course to the parts that are different. The two intents go to a human for a merge decision. Continue your work.",
    );
    expectSTE(d.message);
  });

  it("upstream: main moved, with a signature change", () => {
    const d = draftUpstreamCorrection(staffPicksVessel(), {
      intentTitle: "Add currency support",
      files: ["src/products.js", "src/render.js"],
      signatureChanges: [{ symbol: "src/products.js#formatPrice", signature: "formatPrice(cents, currency)" }],
    });
    expect(d.kind).toBe("upstream");
    expect(d.message).toBe(
      'The intent "Add currency support" landed on main. It changed src/products.js and src/render.js. ' +
        "formatPrice in src/products.js is now formatPrice(cents, currency). Call formatPrice(cents, currency) in src/render.js. " +
        "Read src/render.js again before your next edit. Continue your work.",
    );
    expect(d.constraints.useSignatures).toEqual([{ symbol: "src/products.js#formatPrice", signature: "formatPrice(cents, currency)" }]);
    expectSTE(d.message);
  });

  it("re-plot: Gitring moved the work onto the new main and merged the landed change", () => {
    const d = draftReplotCorrection(
      staffPicksVessel(),
      {
        intentTitle: "Add currency support",
        files: ["src/products.js", "src/render.js"],
        signatureChanges: [{ symbol: "src/products.js#formatPrice", signature: "formatPrice(cents, currency)" }],
      },
      { mainSha: "8df749b0c0ffee", merged: ["src/products.js"], reapply: [] },
    );
    expect(d.kind).toBe("upstream");
    expect(d.message).toBe(
      'The intent "Add currency support" landed on main. Gitring moved your work onto the new main (8df749b). ' +
        "Your copies of src/products.js now include the landed change. " +
        "formatPrice in src/products.js is now formatPrice(cents, currency). Call formatPrice(cents, currency) in src/render.js. " +
        "Read src/products.js again before your next edit. Continue your work.",
    );
    expect(d.constraints.replot).toEqual({ mainSha: "8df749b0c0ffee" });
    expect(d.constraints.reapply).toBeUndefined();
    expectSTE(d.message);
  });

  it("re-plot: an overlapping file goes back to main and the agent makes its change again", () => {
    const diff = "--- a/src/render.js\n+++ b/src/render.js\n@@ -9,1 +9,1 @@\n-old\n+new\n";
    const d = draftReplotCorrection(
      searchVessel(),
      { intentTitle: "Mark staff picks", files: ["src/render.js"], signatureChanges: [] },
      { mainSha: "c57540a", merged: [], reapply: [{ path: "src/render.js", diff }] },
    );
    const [sentences, rest] = d.message.split("\n\n");
    expect(sentences).toBe(
      'The intent "Mark staff picks" landed on main. Gitring moved your work onto the new main (c57540a). ' +
        "Your change to src/render.js overlaps the landed change. Gitring kept the main version of src/render.js. " +
        "Make your change again on the new text. Read src/render.js again before your next edit. Continue your work.",
    );
    expectSTE(sentences);
    expect(rest).toContain("Your earlier change to src/render.js:");
    expect(d.message).toContain("```diff\n--- a/src/render.js");
    expect(d.constraints.reapply).toEqual([{ path: "src/render.js", diff }]);
  });

  it("upstream: a vessel that changes the function body keeps the new parameter list", () => {
    const d = draftUpstreamCorrection(darkModeVessel(), {
      intentTitle: "Search books by title or author",
      files: ["src/render.js"],
      signatureChanges: [{ symbol: "src/render.js#header", signature: "header(query)" }],
    });
    expect(d.message).toContain("header in src/render.js is now header(query).");
    expect(d.message).toContain("Keep the parameter list header(query) when you change header.");
    expect(d.message).not.toContain("Call header");
    expectSTE(d.message);
  });

  it("re-plot: a caller is told to call the new form where it really calls it", () => {
    const v = searchVessel({ symbols: { modified: ["src/render.js#page"], referenced: ["src/render.js#header"] } });
    v.shape.referencedIn = { "src/render.js#header": ["src/render.js"] };
    const d = draftReplotCorrection(
      v,
      { intentTitle: "Add a dark mode", files: ["src/render.js"], signatureChanges: [{ symbol: "src/render.js#header", signature: "header(theme)" }] },
      { mainSha: "abc1234", merged: ["src/render.js"], reapply: [] },
    );
    expect(d.message).toContain("Call header(theme) in src/render.js.");
    expectSTE(d.message);
  });

  it("upstream: a signature change that the vessel does not use is information only", () => {
    const d = draftUpstreamCorrection(darkModeVessel(), {
      intentTitle: "Add currency support",
      files: ["src/products.js", "src/render.js"],
      signatureChanges: [{ symbol: "src/products.js#formatPrice", signature: "formatPrice(cents, currency)" }],
    });
    expect(d.message).toContain("formatPrice in src/products.js is now formatPrice(cents, currency).");
    expect(d.message).not.toContain("Call formatPrice");
    expect(d.message).toContain("Read src/render.js again before your next edit.");
    expectSTE(d.message);
  });

  it("upstream: many files, a long title, no signature change", () => {
    const d = draftUpstreamCorrection(apiItemVessel(), {
      intentTitle: "Refactor the whole rendering pipeline into components with a streaming writer and a cache",
      files: ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js"],
      signatureChanges: [],
    });
    expect(d.message).toContain("It changed src/a.js, src/b.js and 3 other files.");
    expectSTE(d.message);
  });

  it("intent amended", () => {
    const d = draftIntentAmendedCorrection(staffPicksVessel(), {
      version: 2,
      at: T0,
      by: { kind: "human", id: "robin", name: "Robin" },
      reason: "Scope",
      text: "Show at most three staff picks. Hide the section when the list is empty, also on small screens.",
    });
    expect(d.kind).toBe("intent-amended");
    expect(d.message.startsWith('A human changed the intent "Add staff picks" to version 2.')).toBe(true);
    expect(d.constraints.notes).toEqual(["Show at most three staff picks. Hide the section when the list is empty, also on small screens."]);
    expectSTE(d.message);
  });

  it("formats line ranges and file lists", () => {
    expect(formatLines([[12, 12]])).toBe("line 12");
    expect(formatLines([[41, 44], [8, 20]])).toBe("lines 8–20 and 41–44");
    expect(formatLines([[0, 0]])).toBe("line 1");
    expect(listFiles(["a", "b", "c"])).toBe("a, b and c");
    expect(listFiles(["a", "b", "c", "d"])).toBe("a, b and 2 other files");
  });
});
