/**
 * Test fixtures: the bookshop demo app and its traffic.
 *
 *   src/index.js     fetch handler: "/" HTML page, "/api/products" JSON  → imports render.js, products.js
 *   src/render.js    layout: header() lines 8–20, renderItem(p) 22–30 (calls formatPrice(p.cents)),
 *                    renderPage(items) 32–45                                → imports products.js, styles.js
 *   src/products.js  data + formatPrice(cents) lines 12–14
 *   src/styles.js    CSS string
 */
import type { AgentInfo, Attempt, AttemptStatus, Course, FileTouch, Intent, SymbolKey, SymbolTouches } from "../../src/core/types";
import type { ImportGraph } from "../../src/core/analysis/graph";
import type { SignatureInfo } from "../../src/core/analysis/range";
import { buildVesselView, type VesselView } from "../../src/core/coord/facts";

export const T0 = 1_760_000_000_000;

/** A fake import graph from an adjacency list ([importer, imported]). */
export function fakeGraph(edges: [string, string][]): ImportGraph {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const [a, b] of edges) {
    link(a, b);
    link(b, a);
  }
  return {
    edges,
    neighbors: (p: string) => [...(adj.get(p) ?? [])].sort(),
    distance(a: string, b: string, max = 4): number {
      if (a === b) return 0;
      let frontier = [a];
      const seen = new Set([a]);
      for (let d = 1; d <= max; d++) {
        const next: string[] = [];
        for (const n of frontier) {
          for (const m of adj.get(n) ?? []) {
            if (m === b) return d;
            if (!seen.has(m)) {
              seen.add(m);
              next.push(m);
            }
          }
        }
        frontier = next;
      }
      return Infinity;
    },
  };
}

export const BOOKSHOP_EDGES: [string, string][] = [
  ["src/index.js", "src/render.js"],
  ["src/index.js", "src/products.js"],
  ["src/render.js", "src/products.js"],
  ["src/render.js", "src/styles.js"],
];
export const graph = fakeGraph(BOOKSHOP_EDGES);

export function makeIntent(id: string, title: string, goal: string, extra: Partial<Intent> = {}): Intent {
  return {
    id,
    title,
    goal,
    constraints: [],
    checks: [{ id: `${id}-c1`, path: `tests/${id}.test.js`, content: "test()", description: `Checks for ${title}` }],
    priority: "normal",
    status: "underway",
    version: 1,
    amendments: [],
    createdBy: { kind: "human", id: "robin", name: "Robin" },
    createdAt: T0,
    updatedAt: T0,
    source: { kind: "seed" },
    ...extra,
  };
}

export function makeAgent(id: string, callsign: string, model = "@cf/zai-org/glm-5.3-flash"): AgentInfo {
  return { id, callsign, kind: "builtin", model, color: 0, status: "underway", lastSeen: T0 };
}

export interface VesselSpec {
  attemptId: string;
  intent: Intent;
  agent: AgentInfo;
  status?: AttemptStatus;
  state?: VesselView["state"];
  course?: Partial<Course>;
  files?: Record<string, Partial<FileTouch> & { hunks: [number, number][] }>;
  symbols?: Partial<SymbolTouches>;
  signatures?: Record<SymbolKey, SignatureInfo>;
  declaredAt?: number;
  updatedAt?: number;
  generation?: number;
}

export function makeAttempt(spec: VesselSpec): Attempt {
  const files: Record<string, FileTouch> = {};
  let additions = 0;
  let deletions = 0;
  for (const [path, t] of Object.entries(spec.files ?? {})) {
    const lines = t.hunks.reduce((s, h) => s + (h[1] - h[0] + 1), 0);
    files[path] = { status: t.status ?? "M", hunks: t.hunks, additions: t.additions ?? lines, deletions: t.deletions ?? lines };
    additions += files[path].additions;
    deletions += files[path].deletions;
  }
  const declaredAt = spec.declaredAt ?? T0;
  return {
    id: spec.attemptId,
    intentId: spec.intent.id,
    agentId: spec.agent.id,
    fork: { repo: `bookshop-${spec.attemptId}` },
    mode: "api",
    baseSha: "a".repeat(40),
    baseTree: "b".repeat(40),
    status: spec.status ?? "underway",
    course: {
      plan: ["Read the files", "Make the change", "Run the checks"],
      files: Object.keys(spec.files ?? {}),
      symbols: [],
      approach: "Small change.",
      declaredAt,
      ...spec.course,
    },
    footprint: {
      files,
      symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [], ...spec.symbols },
      computedAt: declaredAt + 1000,
    },
    corrections: [],
    lineage: { generation: spec.generation ?? 1 },
    stats: { filesChanged: Object.keys(files).length, additions, deletions, steps: 3 },
    createdAt: declaredAt,
    updatedAt: spec.updatedAt ?? declaredAt + 1000,
  };
}

export function vessel(spec: VesselSpec): VesselView {
  return buildVesselView({
    attempt: makeAttempt(spec),
    intent: spec.intent,
    agent: spec.agent,
    state: spec.state,
    signatures: spec.signatures,
  });
}

/* ───────────────────────────── the demo traffic ───────────────────────────── */

export const intents = {
  currency: makeIntent(
    "int_currency",
    "Add currency support",
    "Show prices in the currency of the visitor. formatPrice takes a currency code. Default to USD.",
  ),
  staffPicks: makeIntent(
    "int_staffpicks",
    "Add staff picks",
    "Show a staff picks section under the product list with three books and their prices.",
  ),
  darkMode: makeIntent(
    "int_darkmode",
    "Add dark mode",
    "Add a dark mode to the bookshop page. The page follows the color scheme of the user, and a toggle in the header switches between light and dark.",
  ),
  darkTheme: makeIntent(
    "int_darktheme",
    "Add a dark theme toggle",
    "Let users switch the bookshop page to a dark theme with a toggle in the header. Remember the choice of the user.",
  ),
  search: makeIntent("int_search", "Add search", "Add a search box to the header that filters the product list by title."),
  apiItem: makeIntent("int_apiitem", "Add a JSON endpoint for one product", "Serve /api/products/:id as JSON from the fetch handler."),
};

export const agents = {
  heron: makeAgent("agt_heron", "HERON-3"),
  osprey: makeAgent("agt_osprey", "OSPREY-2", "@cf/moonshotai/kimi-k2.7-code"),
  kestrel: makeAgent("agt_kestrel", "KESTREL-7"),
  wren: makeAgent("agt_wren", "WREN-5", "claude-code"),
  petrel: makeAgent("agt_petrel", "PETREL-4", "@cf/openai/gpt-oss-120b"),
  skua: makeAgent("agt_skua", "SKUA-9"),
};

/** HERON-3: formatPrice(cents) → formatPrice(cents, currency); updates the call in renderItem. */
export function currencyVessel(over: Partial<VesselSpec> = {}): VesselView {
  return vessel({
    attemptId: "att_currency",
    intent: intents.currency,
    agent: agents.heron,
    declaredAt: T0,
    files: { "src/products.js": { hunks: [[12, 14]] }, "src/render.js": { hunks: [[24, 26]] } },
    symbols: {
      modified: ["src/products.js#formatPrice", "src/render.js#renderItem"],
      signatureChanged: ["src/products.js#formatPrice"],
      referenced: ["src/products.js#formatPrice"],
    },
    signatures: { "src/products.js#formatPrice": { before: "formatPrice(cents)", after: "formatPrice(cents, currency)" } },
    ...over,
  });
}

/** OSPREY-2: a new staff picks block in render.js that calls formatPrice(p.cents). */
export function staffPicksVessel(over: Partial<VesselSpec> = {}): VesselView {
  return vessel({
    attemptId: "att_staffpicks",
    intent: intents.staffPicks,
    agent: agents.osprey,
    declaredAt: T0 + 60_000,
    files: { "src/render.js": { hunks: [[40, 41], [45, 45]], additions: 16, deletions: 2 } },
    symbols: {
      defined: ["src/render.js#renderStaffPicks"],
      modified: ["src/render.js#renderPage"],
      referenced: ["src/products.js#formatPrice", "src/products.js#products"],
    },
    ...over,
  });
}

/** KESTREL-7: dark mode edits the header (lines 8–20) and the CSS. */
export function darkModeVessel(over: Partial<VesselSpec> = {}): VesselView {
  return vessel({
    attemptId: "att_darkmode",
    intent: intents.darkMode,
    agent: agents.kestrel,
    declaredAt: T0 + 10_000,
    files: { "src/render.js": { hunks: [[8, 20]] }, "src/styles.js": { hunks: [[3, 10]] } },
    symbols: { modified: ["src/render.js#header", "src/styles.js#css"], referenced: ["src/styles.js#css"] },
    ...over,
  });
}

/** WREN-5: search adds a box to the header (lines 12–18). */
export function searchVessel(over: Partial<VesselSpec> = {}): VesselView {
  return vessel({
    attemptId: "att_search",
    intent: intents.search,
    agent: agents.wren,
    declaredAt: T0 + 20_000,
    files: { "src/render.js": { hunks: [[12, 18]], additions: 9, deletions: 3 } },
    symbols: { modified: ["src/render.js#header"], referenced: ["src/products.js#products"] },
    ...over,
  });
}

/** PETREL-4: a JSON endpoint in index.js only. */
export function apiItemVessel(over: Partial<VesselSpec> = {}): VesselView {
  return vessel({
    attemptId: "att_apiitem",
    intent: intents.apiItem,
    agent: agents.petrel,
    declaredAt: T0 + 30_000,
    files: { "src/index.js": { hunks: [[20, 28]] } },
    symbols: { defined: ["src/index.js#productJson"], referenced: ["src/products.js#products"] },
    ...over,
  });
}

/** SKUA-9: "Add a dark theme toggle" — the same goal as KESTREL-7, declared later (course only). */
export function darkThemeVessel(over: Partial<VesselSpec> = {}): VesselView {
  return vessel({
    attemptId: "att_darktheme",
    intent: intents.darkTheme,
    agent: agents.skua,
    declaredAt: T0 + 90_000,
    course: { files: ["src/render.js", "src/styles.js"], symbols: ["src/render.js#header"], approach: "Add a theme toggle to the header." },
    ...over,
  });
}
