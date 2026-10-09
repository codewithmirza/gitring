import { describe, expect, it } from "vitest";
import { intentFile, landingMessage, landingNote, LOGBOOK_SCHEMA, parseTrailers, slugify } from "../../src/core/logbook";
import type { CheckRun, Correction, CourseCheck, Decision } from "../../src/core/types";
import { agents, currencyVessel, intents, makeIntent, T0 } from "../coord/fixtures";

const checks: CheckRun = {
  id: "chk_1",
  subject: "c".repeat(40),
  scope: "composed",
  ok: true,
  passed: 7,
  failed: 0,
  cases: [
    { file: "tests/currency.test.js", name: "formats EUR", ok: true, ms: 1 },
    { file: "tests/render.test.js", name: "renders the list", ok: true, ms: 2 },
  ],
  ms: 41,
  at: T0,
};

const correction: Correction = {
  id: "cor_1",
  attemptId: "att_staffpicks",
  standOnAttemptId: "att_currency",
  kind: "interface",
  rule: "R3-producer-stands-on",
  message: "HERON-3 changes formatPrice(cents) to formatPrice(cents, currency) in src/products.js. Call formatPrice(cents, currency) in src/render.js. Continue your work.",
  constraints: { useSignatures: [{ symbol: "src/products.js#formatPrice", signature: "formatPrice(cents, currency)" }] },
  checkId: "cc_1",
  status: "acknowledged",
  createdAt: T0,
  ackNote: "Done.",
};

const courseCheck: CourseCheck = {
  id: "cc_1",
  attemptId: "att_currency",
  trigger: "write",
  verdict: "correct",
  assessments: [
    { otherAttemptId: "att_staffpicks", collision: 0.83, interference: 2.82, duplicate: 0.02, giveWay: "other", giveWayConfidence: 0.82, rule: "R3-producer-stands-on" },
  ],
  facts: [],
  source: "clef-flash",
  confidence: 0.77,
  latencyMs: 41,
  at: T0,
};

const decision: Decision = {
  id: "dec_1",
  kind: "pick",
  intentId: "int_currency",
  attemptIds: ["att_currency"],
  by: { kind: "human", id: "robin", name: "Robin" },
  rationale: "Smallest diff; all checks pass.",
  at: T0,
};

describe("landingMessage", () => {
  it("(k) has a subject, a short body and trailers that parse back", () => {
    const attempt = { ...currencyVessel().attempt, summary: "formatPrice takes a currency code. The list shows prices in USD by default." };
    const msg = landingMessage({ intent: intents.currency, attempt, agent: agents.heron, method: "merge", corrections: [correction], checks });
    const [subject, blank] = msg.split("\n");
    expect(subject).toBe("Add currency support");
    expect(blank).toBe("");
    expect(msg).toContain("formatPrice takes a currency code. The list shows prices in USD by\ndefault.");
    expect(msg).toContain("\n\nLanded by HERON-3 with merge. Generation 1.\nCorrections: 1. Checks: 7/7 pass.\n\nGitring-Intent:");
    expect(parseTrailers(msg)).toEqual({
      "Gitring-Intent": "int_currency",
      "Gitring-Attempt": "att_currency",
      "Gitring-Agent": "HERON-3 (agt_heron)",
      "Gitring-Model": "@cf/zai-org/glm-5.3-flash",
      "Gitring-Method": "merge",
      "Gitring-Corrections": "1",
      "Gitring-Checks": "7/7 pass",
      "Gitring-Generation": "1",
    });
    for (const line of msg.split("\n")) expect(line.length).toBeLessThanOrEqual(72);
  });

  it("truncates long subjects to 72 characters and records a re-derived generation", () => {
    const long = makeIntent("int_long", `Add ${"a very long title ".repeat(8)}`, "Goal.\n\nSecond paragraph.");
    const attempt = { ...currencyVessel().attempt, lineage: { generation: 2, rederivedFrom: "att_old" } };
    const failing = { ...checks, ok: false, passed: 5, failed: 2 };
    const msg = landingMessage({ intent: long, attempt, agent: { ...agents.wren, model: undefined, client: "claude-code" }, method: "rederive", corrections: [], checks: failing });
    const subject = msg.split("\n")[0];
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("…")).toBe(true);
    expect(msg).toContain("Generation 2 (re-derived from att_old).");
    expect(msg).not.toContain("Second paragraph");
    const t = parseTrailers(msg);
    expect(t["Gitring-Generation"]).toBe("2");
    expect(t["Gitring-Method"]).toBe("rederive");
    expect(t["Gitring-Model"]).toBe("claude-code");
    expect(t["Gitring-Checks"]).toBe("5/7 pass");
    expect(t["Gitring-Corrections"]).toBe("0");
  });
});

describe("parseTrailers", () => {
  it("reads only the last paragraph, with continuation lines", () => {
    expect(parseTrailers("Fix: a subject line only")).toEqual({});
    expect(parseTrailers("Subject\n\nBody text.\nNot: a trailer block\nbecause this line is prose")).toEqual({});
    expect(parseTrailers("Subject\n\nBody.\n\nKey: one\n  two\nOther-Key: x\r\n")).toEqual({ Key: "one two", "Other-Key": "x" });
  });
});

describe("landingNote", () => {
  it("is pretty JSON with schema gitring.logbook/v1 and the full why-record", () => {
    const attempt = currencyVessel().attempt;
    const text = landingNote({ intent: intents.currency, attempt, agent: agents.heron, method: "merge", corrections: [correction], courseChecks: [courseCheck], checks, decision });
    expect(text).toContain('\n  "schema": "gitring.logbook/v1"');
    const note = JSON.parse(text);
    expect(note.schema).toBe(LOGBOOK_SCHEMA);
    expect(note.intent).toEqual({ id: "int_currency", title: "Add currency support", goal: intents.currency.goal, constraints: [], version: 1, amendments: [] });
    expect(note.attempt).toMatchObject({ id: "att_currency", generation: 1, rederivedFrom: null, base: { sha: "a".repeat(40), tree: "b".repeat(40) } });
    expect(note.attempt.course.declaredAt).toBe(T0);
    expect(note.attempt.footprint.files).toEqual([
      { path: "src/products.js", status: "M", additions: 3, deletions: 3 },
      { path: "src/render.js", status: "M", additions: 3, deletions: 3 },
    ]);
    expect(note.attempt.footprint.symbols.signatureChanged).toEqual(["src/products.js#formatPrice"]);
    expect(note.agent).toEqual({ id: "agt_heron", callsign: "HERON-3", kind: "builtin", model: "@cf/zai-org/glm-5.3-flash", client: null });
    expect(note.method).toBe("merge");
    expect(note.corrections).toEqual([
      { id: "cor_1", kind: "interface", rule: "R3-producer-stands-on", message: correction.message, standOn: "att_currency", status: "acknowledged", ackNote: "Done." },
    ]);
    expect(note.courseChecks[0]).toMatchObject({ verdict: "correct", source: "clef-flash", confidence: 0.77, latencyMs: 41, trigger: "write" });
    expect(note.courseChecks[0].assessments[0].rule).toBe("R3-producer-stands-on");
    expect(note.checks).toEqual({
      passed: 7,
      failed: 0,
      cases: [
        { file: "tests/currency.test.js", name: "formats EUR", ok: true },
        { file: "tests/render.test.js", name: "renders the list", ok: true },
      ],
    });
    expect(note.decision).toEqual(decision);
  });

  it("writes decision: null when there was no human decision", () => {
    const note = JSON.parse(landingNote({ intent: intents.currency, attempt: currencyVessel().attempt, agent: agents.heron, method: "fast-forward", corrections: [], courseChecks: [], checks }));
    expect(note.decision).toBeNull();
    expect(note.corrections).toEqual([]);
  });
});

describe("intentFile", () => {
  it("writes .gitring/intents/<slug>.md with YAML front matter", () => {
    const intent = {
      ...intents.currency,
      version: 2,
      constraints: ["Call formatPrice(cents, currency) in src/render.js."],
      amendments: [{ version: 2, at: T0, by: { kind: "human" as const, id: "robin", name: "Robin" }, reason: "Correction from HERON-3", text: "Default to USD." }],
    };
    const file = intentFile(intent, { sha: "d".repeat(40), attemptId: "att_currency", agent: agents.heron, method: "merge" });
    expect(file.path).toBe(".gitring/intents/add-currency-support.md");
    const [, front, body] = file.content.split(/^---$/m);
    expect(front.trim().split("\n")).toEqual([
      'id: "int_currency"',
      'title: "Add currency support"',
      "status: landed",
      "version: 2",
      'landed_by: "HERON-3 (agt_heron)"',
      "method: merge",
      'attempt: "att_currency"',
      `sha: "${"d".repeat(40)}"`,
      "priority: normal",
    ]);
    expect(body).toContain("# Add currency support");
    expect(body).toContain("## Goal\n\nShow prices in the currency of the visitor.");
    expect(body).toContain("- Call formatPrice(cents, currency) in src/render.js.");
    expect(body).toContain("- `tests/int_currency.test.js` — Checks for Add currency support");
    expect(body).toContain("- v2 · Robin (human) · 2025-10-09T08:53:20.000Z: Correction from HERON-3 — Default to USD.");
  });

  it("quotes titles safely in YAML", () => {
    const file = intentFile(makeIntent("int_q", 'Fix "quotes": and #hashes', "Goal."), { attemptId: "a", agent: agents.kestrel, method: "fast-forward" });
    expect(file.path).toBe(".gitring/intents/fix-quotes-and-hashes.md");
    expect(file.content).toContain('title: "Fix \\"quotes\\": and #hashes"');
    expect(file.content).not.toContain("sha:");
  });
});

describe("slugify", () => {
  it("makes file-safe slugs", () => {
    expect(slugify("Add dark mode")).toBe("add-dark-mode");
    expect(slugify("  Crème brûlée & Café!  ")).toBe("creme-brulee-and-cafe");
    expect(slugify("???")).toBe("intent");
    const long = slugify("Refactor the rendering pipeline into small components with streaming output and caching");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("-")).toBe(false);
  });
});
