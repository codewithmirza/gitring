/**
 * Sample data for the style guide: a test run, a conflict check, change requests, agents, log lines and a diff.
 * It is static, so the guide works without a project coordinator.
 */
import type { AgentInfo, CheckRun, Correction, CourseCheck, LogEntry } from "../../../../src/core/types";

const T0 = Date.now() - 4 * 60_000;

export function run(names: string[], fail: string[] = [], scope: CheckRun["scope"] = "attempt"): CheckRun {
  const cases = names.map((name, i) => ({ file: "tests/search.test.js", name, ok: !fail.includes(name), error: fail.includes(name) ? "expected value to match /theme/" : undefined, ms: 3 + i }));
  const passed = cases.filter((c) => c.ok).length;
  return { id: "run", subject: "a1b2c3d", scope, ok: passed === cases.length, passed, failed: cases.length - passed, cases, ms: 212, at: T0 };
}
export const CASES = ["matches a title", "matches an author", "ignores case", "returns no books for a nonsense query", "shows a message when nothing matches", "renders a search field with a label", "keeps the shelf at /"];

export const CHECK: CourseCheck = {
  id: "ck-007",
  attemptId: "at-search-1",
  trigger: "declare",
  verdict: "correct",
  source: "clef-flash",
  confidence: 0.81,
  latencyMs: 44,
  at: T0,
  assessments: [{ otherAttemptId: "at-currency-1", collision: 0.58, interference: 3.1, duplicate: 0.03, giveWay: "incoming", giveWayConfidence: 0.88, rule: "R3-producer-stands-on" }],
  facts: [
    {
      otherAttemptId: "at-currency-1",
      otherAgentId: "ag-kestrel-7",
      otherIntentId: "in-currency",
      otherState: "active",
      sharedFiles: ["src/products.js", "src/render.js"],
      sharedSymbols: [],
      interfaceHits: [{ changedBy: "other", symbol: "src/products.js#formatPrice", usedAt: ["src/render.js#renderBookCard"] }],
      hunkOverlaps: [],
      range: 1,
      closing: false,
      intentSimilarity: 0.08,
    },
  ],
};

export function corr(status: Correction["status"], kind: Correction["kind"] = "interface"): Correction {
  return {
    id: kind === "interface" ? "cr-01" : "cr-02",
    attemptId: "at-search-1",
    standOnAttemptId: kind === "interface" ? "at-currency-1" : "at-dark-1",
    kind,
    rule: kind === "interface" ? "R3-producer-stands-on" : "R4-first-declared-stands-on",
    message:
      kind === "interface"
        ? "Agent KESTREL-7 changes `formatPrice(cents)` to `formatPrice(cents, currency)` in `src/products.js`. Pass the currency when you render prices. Continue your work."
        : "Agent HERON-3 changes the header in `src/render.js`, lines 27–37. Do not edit these lines. Put the search form below the header. Continue your work.",
    constraints:
      kind === "interface"
        ? { useSignatures: [{ symbol: "src/products.js#formatPrice", signature: 'formatPrice(cents, currency = "GBP")' }] }
        : { avoidRegions: [{ path: "src/render.js", lines: [27, 37] }] },
    checkId: "ck-007",
    status,
    createdAt: T0,
    ackNote: status === "acknowledged" ? "Use formatPrice(p.cents, currency)." : undefined,
  };
}

export const AGENT: AgentInfo = { id: "ag-kestrel-7", callsign: "KESTREL-7", kind: "builtin", model: "@cf/zai-org/glm-5.3-flash", color: 0, status: "underway", lastSeen: T0 };
export const AGENT2: AgentInfo = { id: "ag-petrel-2", callsign: "PETREL-2", kind: "builtin", model: "@cf/zai-org/glm-5.3", color: 2, status: "underway", lastSeen: T0 };
export const LOGS: [LogEntry, AgentInfo | undefined][] = [
  [{ id: "l1", at: T0, kind: "declare", message: "Declare course: A search form in the header. Results use the normal shelf." }, AGENT2],
  [{ id: "l2", at: T0 + 1000, kind: "check", message: "Course check: correction · clef-flash 44 ms" }, AGENT2],
  [{ id: "l3", at: T0 + 1200, kind: "correction", message: "Correction for PETREL-2 · interface · R3 · KESTREL-7 stands on" }, AGENT2],
  [{ id: "l4", at: T0 + 9000, kind: "write", message: "Pass the currency from renderPage to renderBookCard. Update 2 call sites." }, AGENT],
  [{ id: "l5", at: T0 + 20000, kind: "land", message: "Landed on main d20153b · 3-way merge · “Show prices in the reader's currency” · 17/17 checks" }, AGENT],
  [{ id: "l6", at: T0 + 21000, kind: "decision", message: "“Search books by title or author” has 2 ready attempts. A human pick is necessary." }, undefined],
];

export const DIFF = `diff --git a/src/products.js b/src/products.js
--- a/src/products.js
+++ b/src/products.js
@@ -38,6 +38,13 @@ export const books = [
   },
 ];

-export function formatPrice(cents) {
-  return "£" + (cents / 100).toFixed(2);
+// Fixed rates against GBP. Prices stay in integer pence in \`books\`.
+export const RATES = { GBP: 1, EUR: 1.17, USD: 1.27 };
+
+export function formatPrice(cents, currency = "GBP") {
+  const code = RATES[currency] ? currency : "GBP";
+  const amount = Math.round(cents * RATES[code]) / 100;
+  return new Intl.NumberFormat("en-GB", { style: "currency", currency: code }).format(amount);
 }
`;

export const names = (id: string) => ({ "at-currency-1": "KESTREL-7", "at-search-1": "PETREL-2", "at-dark-1": "HERON-3" })[id] ?? id;
