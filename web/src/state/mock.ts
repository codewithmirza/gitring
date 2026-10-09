/**
 * The mock harbor: an in-browser Bearing for demos and UI development.
 *
 * It emits the same BearingEvent stream as the Worker, so the store and every view
 * are shared. The code is real: the demo repo (Saltmarsh Books) and each attempt's
 * patch compose on main with real diffs, footprints and previews. Only the course
 * check answers (Clef probabilities) and check results are scripted.
 *
 * URL options: ?mock=1 · ?t=<seconds> start later in the scenario · ?freeze=1 stop the
 * clock · ?speed=2 · ?fleet=<n> add n synthetic vessels (performance test).
 */
import type {
  AgentInfo,
  AgentKind,
  Amendment,
  Attempt,
  BearingEvent,
  CheckRun,
  CheckSpec,
  Correction,
  CorrectionKind,
  CourseAssessment,
  CourseCheck,
  Decision,
  DecisionKind,
  FileNode,
  HarborStats,
  Intent,
  IntentStatus,
  Landing,
  LandingMethod,
  LineRange,
  LogEntry,
  LogKind,
  PairFacts,
  ProjectState,
  RadarPair,
  Range,
  RuleOfTheRoad,
  SimStats,
  Verdict,
} from "../../../src/core/types";
import { DEFAULT_SETTINGS } from "../../../src/core/types";
import type { AmendInput, ConnectInfo, DiffFile, DiffResult, HarborClient, LandingDetail, LandResult, NewIntentInput } from "./api";
import { defaultConnectInfo, ApiError } from "./api";
import { store } from "./store";
import { baseTree, patch, previewDocument, testNames } from "./mockRepo";
import {
  applyPatchFile,
  byteSize,
  computeFootprint,
  declRange,
  fakeSha,
  importsOf,
  langOf,
  lineStats,
  unifiedDiff,
  type PatchFile,
  type Tree,
} from "./patchkit";
import { slugify, modelShort } from "./format";

/** Real seconds per scenario second. */
const PACE = 1.5;
/** Real seconds before the demo loop restarts (unless a human took control). */
const LOOP_S = 100;

const MODELS = DEFAULT_SETTINGS.agentModels;
const GLM = MODELS[0];
const KIMI = MODELS[1];
const GPT = MODELS[2];

type IntentKey = "json" | "currency" | "dark" | "search" | "picks";

interface CastMember {
  key: string;
  attemptId: string;
  agentId: string;
  callsign: string;
  kind: AgentKind;
  model: string;
  client?: string;
  color: number;
  intent: string; // intent id
  patch: string | PatchFile[];
  plan: string[];
  files: string[];
  symbols: string[];
  approach: string;
  generation?: number;
  rederivedFrom?: string;
}

const HUMANS = {
  jon: { kind: "human" as const, id: "jon", name: "Jon Reyes" },
  mira: { kind: "human" as const, id: "mira", name: "Mira Okafor" },
  ana: { kind: "human" as const, id: "ana", name: "Ana Silva" },
  you: { kind: "human" as const, id: "you", name: "You" },
  bearing: { kind: "system" as const, id: "bearing", name: "Bearing" },
};

const INTENT_IDS: Record<IntentKey, string> = {
  json: "in-json",
  currency: "in-currency",
  dark: "in-dark",
  search: "in-search",
  picks: "in-picks",
};

const CAST: CastMember[] = [
  {
    key: "json-1",
    attemptId: "at-json-1",
    agentId: "ag-skua-1",
    callsign: "SKUA-1",
    kind: "mcp",
    model: "codex",
    client: "codex",
    color: 7,
    intent: INTENT_IDS.json,
    patch: "json-1",
    plan: ["Add findBook(id) to src/products.js.", "Add GET /api/books/:id to src/index.js.", "Return 404 with a JSON error for an unknown id."],
    files: ["src/products.js", "src/index.js"],
    symbols: ["src/products.js#findBook", "src/index.js#default"],
    approach: "Add one route and one lookup function. Reuse formatPrice for the formatted price.",
  },
  {
    key: "currency-1",
    attemptId: "at-currency-1",
    agentId: "ag-kestrel-7",
    callsign: "KESTREL-7",
    kind: "builtin",
    model: GLM,
    color: 0,
    intent: INTENT_IDS.currency,
    patch: "currency-1",
    plan: [
      "Add a fixed RATES table and a currency parameter to formatPrice.",
      "Pass the currency from renderPage to renderBookCard.",
      "Read ?currency= and Accept-Language in src/index.js.",
    ],
    files: ["src/products.js", "src/render.js", "src/index.js"],
    symbols: ["src/products.js#formatPrice", "src/products.js#RATES", "src/render.js#renderPage", "src/render.js#renderBookCard", "src/index.js#readerCurrency"],
    approach: "Change formatPrice(cents) to formatPrice(cents, currency) with a GBP default, so old calls keep working.",
  },
  {
    key: "dark-1",
    attemptId: "at-dark-1",
    agentId: "ag-heron-3",
    callsign: "HERON-3",
    kind: "builtin",
    model: KIMI,
    color: 5,
    intent: INTENT_IDS.dark,
    patch: "dark-1",
    plan: ["Move the colors in src/styles.js to variables.", "Add a dark scheme for the system setting and for data-theme.", "Add a toggle to the header. Store the choice."],
    files: ["src/styles.js", "src/render.js"],
    symbols: ["src/styles.js#css", "src/render.js#renderHeader", "src/render.js#renderPage"],
    approach: "CSS variables plus a header toggle that remembers the reader's choice.",
  },
  {
    key: "dark-2",
    attemptId: "at-dark-2",
    agentId: "ag-gannet-4",
    callsign: "GANNET-4",
    kind: "builtin",
    model: GLM,
    color: 4,
    intent: INTENT_IDS.dark,
    patch: "dark-2",
    plan: ["Add a prefers-color-scheme block with variables.", "Follow the system setting. Add no script."],
    files: ["src/styles.js"],
    symbols: ["src/styles.js#css"],
    approach: "Follow the system setting only. No toggle and no script.",
  },
  {
    key: "search-1",
    attemptId: "at-search-1",
    agentId: "ag-petrel-2",
    callsign: "PETREL-2",
    kind: "builtin",
    model: GPT,
    color: 2,
    intent: INTENT_IDS.search,
    patch: "search-1",
    plan: ["Add searchBooks(query) to src/products.js.", "Add a search form to the header in src/render.js.", "Route /?q= to the search in src/index.js."],
    files: ["src/products.js", "src/render.js", "src/index.js"],
    symbols: ["src/products.js#searchBooks", "src/render.js#renderHeader", "src/index.js#default"],
    approach: "A search form in the header. Results use the normal shelf.",
  },
  {
    key: "search-2",
    attemptId: "at-search-2",
    agentId: "ag-albatross-6",
    callsign: "ALBATROSS-6",
    kind: "builtin",
    model: KIMI,
    color: 1,
    intent: INTENT_IDS.search,
    patch: "search-2",
    plan: ["Add searchBooks(query) with word matching and accent folding.", "Add a /search page with a result list.", "Add a Search link to the navigation."],
    files: ["src/products.js", "src/render.js", "src/index.js"],
    symbols: ["src/products.js#searchBooks", "src/render.js#renderSearchPage", "src/index.js#default"],
    approach: "A separate /search page. The shelf stays as it is.",
  },
  {
    key: "picks-1",
    attemptId: "at-picks-1",
    agentId: "ag-tern-5",
    callsign: "TERN-5",
    kind: "mcp",
    model: "claude-code",
    client: "claude-code",
    color: 9,
    intent: INTENT_IDS.picks,
    patch: "picks-1",
    plan: ["Mark three books as staff picks in src/products.js.", "Show a badge and a staff note on the book card."],
    files: ["src/products.js", "src/render.js"],
    symbols: ["src/products.js#books", "src/render.js#renderBookCard"],
    approach: "A staffPick note on the book. The card shows a badge when the note exists.",
  },
  {
    key: "picks-2",
    attemptId: "at-picks-2",
    agentId: "ag-cormorant-8",
    callsign: "CORMORANT-8",
    kind: "builtin",
    model: GPT,
    color: 8,
    intent: INTENT_IDS.picks,
    patch: "picks-2",
    plan: [
      "Mark three books as staff picks on the new main.",
      "Show the badge and the note in renderBookCard(book, currency).",
      "Add .badge after .prose in src/styles.js.",
    ],
    files: ["src/products.js", "src/render.js", "src/styles.js"],
    symbols: ["src/products.js#books", "src/render.js#renderBookCard", "src/styles.js#css"],
    approach: "Re-derive from the intent on the new main. Keep the currency parameter of renderBookCard.",
    generation: 2,
    rederivedFrom: "at-picks-1",
  },
];

const CALLSIGN_POOL = [
  "FULMAR-9",
  "SHEARWATER-2",
  "PUFFIN-3",
  "GUILLEMOT-5",
  "OSPREY-4",
  "MERLIN-1",
  "CURLEW-8",
  "PLOVER-6",
  "EIDER-7",
  "GREBE-3",
  "SANDERLING-5",
  "AUK-2",
  "DUNLIN-4",
  "LAPWING-1",
  "WHIMBREL-6",
];

function checkFromPatch(key: string, description: string): CheckSpec {
  const created = patch(key).find((p) => p.create !== undefined && p.path.startsWith("tests/"));
  return { id: `chk-${key}`, path: created?.path ?? `tests/${key}.test.js`, content: created?.create ?? "", description };
}

type Step = [number, (h: MockHarbor) => void];

/* ───────────── the harbor ───────────── */

export class MockHarbor implements HarborClient {
  readonly mode = "mock" as const;
  readonly projectId: string;

  private world!: ProjectState;
  private main: Tree = new Map();
  private mainSha = "";
  private history = new Map<string, Tree>();
  private bases = new Map<string, { sha: string; tree: Tree }>();
  private heads = new Map<string, Tree>();
  private cast = new Map<string, CastMember>();
  private radar = new Map<string, RadarPair>();
  private seq = { log: 0, check: 0, corr: 0, land: 0, dec: 0 };
  private silent = false;
  private nowMs = Date.now();
  private t0 = Date.now();
  private cursor = 0;
  private speed = 1;
  private freeze = false;
  private manual = false;
  private queue: { at: number; run: () => void }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private simTimer: ReturnType<typeof setInterval> | null = null;
  private fleet = 0;
  private fleetTimer: ReturnType<typeof setInterval> | null = null;
  private steps: Step[] = SCENARIO;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  /* ───── lifecycle ───── */

  start(params: URLSearchParams, reason: "forced" | "fallback") {
    this.speed = Math.max(0.25, Math.min(8, Number(params.get("speed") ?? 1) || 1));
    this.freeze = params.get("freeze") === "1";
    this.fleet = Math.max(0, Math.min(400, Number(params.get("fleet") ?? 0) || 0));
    const startAt = Math.max(0, Number(params.get("t") ?? 0) || 0);
    this.reset(startAt);
    if (reason === "fallback") {
      this.log({ kind: "system", message: "No live harbor answered. The mock harbor runs the Saltmarsh Books demo in this browser." });
    }
    if (this.fleet) this.manual = true;
    this.timer = setInterval(() => this.tick(), 200);
  }

  private reset(startAtRealS: number) {
    this.silent = true;
    this.buildWorld();
    this.t0 = Date.now() - (startAtRealS * 1000) / this.speed;
    this.cursor = 0;
    this.runDue(startAtRealS);
    this.silent = false;
    this.nowMs = Date.now();
    this.recomputeStats(false);
    this.emit({ type: "snapshot", state: this.world });
    if (this.fleet) {
      this.stopFleet();
      this.startFleet(this.fleet);
    }
  }

  private elapsedRealS() {
    return ((Date.now() - this.t0) / 1000) * this.speed;
  }

  private tick() {
    const now = Date.now();
    if (!this.freeze) {
      const e = this.elapsedRealS();
      this.runDue(e);
      if (!this.manual && e > LOOP_S) {
        this.reset(0);
        this.log({ kind: "system", message: "The demo loop starts again. Take an action to stop the loop." });
        return;
      }
    }
    const due = this.queue.filter((q) => q.at <= now);
    if (due.length) {
      this.queue = this.queue.filter((q) => q.at > now);
      for (const q of due.sort((a, b) => a.at - b.at)) {
        this.nowMs = q.at;
        try {
          q.run();
        } catch (err) {
          console.warn("mock step failed", err);
        }
      }
    }
  }

  private runDue(elapsedRealS: number) {
    while (this.cursor < this.steps.length && this.steps[this.cursor][0] * PACE <= elapsedRealS) {
      const [at, run] = this.steps[this.cursor++];
      this.nowMs = this.t0 + (at * PACE * 1000) / this.speed;
      try {
        run(this);
      } catch (err) {
        console.warn("mock scenario step failed", at, err);
      }
    }
  }

  private later(seconds: number, run: () => void) {
    this.queue.push({ at: Date.now() + (seconds * 1000) / this.speed, run });
  }

  private takeControl() {
    if (this.manual) return;
    this.manual = true;
    this.log({ kind: "system", message: "The demo loop stops. You control this harbor now." });
  }

  /* ───── world ───── */

  private buildWorld() {
    this.radar.clear();
    this.bases.clear();
    this.heads.clear();
    this.cast.clear();
    this.history.clear();
    this.queue = [];
    this.seq = { log: 0, check: 0, corr: 0, land: 0, dec: 0 };
    for (const c of CAST) this.cast.set(c.key, c);
    this.main = baseTree();
    this.mainSha = fakeSha("saltmarsh-seed");
    this.history.set(this.mainSha, new Map(this.main));
    const now = Date.now();
    const min = 60_000;
    const project = {
      id: this.projectId,
      name: "Saltmarsh Books",
      repo: { backend: "emulator" as const, namespace: "bearing", name: "saltmarsh-books", defaultBranch: "main" },
      mainSha: this.mainSha,
      mainTree: fakeSha("tree-" + this.mainSha),
      createdAt: now - 3 * 60 * min,
      settings: { ...DEFAULT_SETTINGS, fanout: 2, autoLand: true },
    };
    const intent = (
      key: IntentKey,
      title: string,
      goal: string,
      createdBy: Intent["createdBy"],
      source: Intent["source"],
      ageMin: number,
      check: CheckSpec,
      priority: Intent["priority"] = "normal",
    ): Intent => ({
      id: INTENT_IDS[key],
      title,
      goal,
      constraints: [],
      checks: [check],
      priority,
      status: "open",
      version: 1,
      amendments: [],
      createdBy,
      createdAt: now - ageMin * min,
      updatedAt: now - ageMin * min,
      source,
    });
    const intents: Intent[] = [
      intent(
        "json",
        "Add a JSON endpoint for one book",
        "Add `GET /api/books/:id`. Return the book as JSON with the price in cents and a formatted price. Return 404 with a JSON error for an unknown id.",
        HUMANS.ana,
        { kind: "webhook", ref: "github#14" },
        41,
        checkFromPatch("json-1", "Return one book as JSON, or 404 with a JSON error."),
      ),
      intent(
        "currency",
        "Show prices in the reader's currency",
        "Show each price in the reader's currency. Read it from `?currency=` first, then from the `Accept-Language` header. Keep prices in integer cents in `src/products.js`.",
        HUMANS.jon,
        { kind: "ui" },
        38,
        checkFromPatch("currency-1", "Prices follow ?currency= and Accept-Language. Cents stay integers."),
        "high",
      ),
      intent(
        "dark",
        "Add a dark mode",
        "Add a dark color theme. Follow the reader's system setting. Let the reader change it in the header. Keep text contrast at 4.5:1 or more.",
        HUMANS.mira,
        { kind: "webhook", ref: "slack:/bearing" },
        24,
        checkFromPatch("dark-1", "A dark scheme, a theme control in the header, readable contrast."),
      ),
      intent(
        "search",
        "Search books by title or author",
        "Add a search field. Match the query against the title and the author. Ignore case. Show a clear message when nothing matches.",
        HUMANS.mira,
        { kind: "webhook", ref: "linear:SAL-31" },
        19,
        checkFromPatch("search-1", "Title and author match, case-insensitive, with a message for no match."),
      ),
      intent(
        "picks",
        "Mark staff picks",
        "Mark some books as staff picks. Show a small badge on the book card and a short staff note under the title.",
        HUMANS.ana,
        { kind: "ui" },
        12,
        checkFromPatch("picks-1", "Three staff picks with a badge and a note. Other cards stay plain."),
      ),
    ];
    // A human amendment from earlier (living spec, v2).
    const cur = intents[1];
    cur.version = 2;
    cur.constraints = ["Default to GBP when the currency is unknown."];
    cur.amendments = [
      {
        version: 2,
        at: now - 27 * min,
        by: HUMANS.jon,
        reason: "Readers from other regions saw no prices in the test shop.",
        text: "Default to GBP when the currency is unknown.",
      },
    ];
    cur.updatedAt = now - 27 * min;

    this.world = {
      project,
      intents,
      attempts: [],
      agents: [],
      corrections: [],
      checks: [],
      landings: [],
      decisions: [
        {
          id: "dc-00",
          kind: "amend",
          intentId: cur.id,
          attemptIds: [],
          by: HUMANS.jon,
          rationale: "Readers from other regions saw no prices in the test shop.",
          at: now - 27 * min,
        },
      ],
      logs: [],
      radar: [],
      files: [],
      imports: [],
      stats: emptyStats(),
    };
    this.refreshFiles(false);

    // Warm start: two vessels are already underway when the chart opens.
    this.nowMs = now - 70_000;
    this.declare("json-1");
    this.check("json-1", "declare", { verdict: "clear", pairs: [] });
    this.nowMs = now - 48_000;
    this.declare("currency-1");
    this.check("currency-1", "declare", {
      verdict: "clear",
      latency: 37,
      confidence: 0.91,
      pairs: [pair("json-1", 2, { collision: 0.07, interference: 0.6, giveWay: "incoming", gw: 0.71, rule: "R4-first-declared-stands-on", shared: ["src/products.js"] })],
    });
    this.range("currency-1", "json-1", 2, false, "clear");
    this.nowMs = now - 22_000;
    this.write("currency-1", "src/products.js", "Add a RATES table. formatPrice takes a currency with a GBP default.");
    this.check("currency-1", "write", { verdict: "clear", latency: 33, confidence: 0.93, pairs: [pair("json-1", 2, { collision: 0.05, interference: 0.5, giveWay: "incoming", gw: 0.7, rule: "R4-first-declared-stands-on", shared: ["src/products.js"] })] });
    this.nowMs = now - 9_000;
    this.logLine("json-1", "Read src/products.js and src/index.js. findBook goes after the books array.", ["src/products.js"], "log");
  }

  private emit(ev: BearingEvent) {
    if (this.silent) return;
    store.dispatch(structuredClone(ev));
  }

  private intent(id: string): Intent {
    const i = this.world.intents.find((x) => x.id === id);
    if (!i) throw new ApiError(404, "This intent is not in the harbor.");
    return i;
  }

  private attempt(id: string): Attempt {
    const a = this.world.attempts.find((x) => x.id === id);
    if (!a) throw new ApiError(404, "This attempt is not in the harbor.");
    return a;
  }

  private member(key: string): CastMember {
    const c = this.cast.get(key);
    if (!c) throw new Error(`unknown cast ${key}`);
    return c;
  }

  private agentOf(c: CastMember): AgentInfo | undefined {
    return this.world.agents.find((a) => a.id === c.agentId);
  }

  private touch<T extends { updatedAt?: number }>(o: T) {
    o.updatedAt = this.nowMs;
  }

  private putIntent(i: Intent) {
    i.updatedAt = this.nowMs;
    this.emit({ type: "intent", intent: i });
  }

  private putAttempt(a: Attempt) {
    this.touch(a);
    this.emit({ type: "attempt", attempt: a });
  }

  private putAgent(g: AgentInfo) {
    g.lastSeen = this.nowMs;
    this.emit({ type: "agent", agent: g });
  }

  private log(entry: Omit<LogEntry, "id" | "at">) {
    const l: LogEntry = { id: `lg-${String(++this.seq.log).padStart(4, "0")}`, at: this.nowMs, ...entry };
    this.world.logs.push(l);
    if (this.world.logs.length > 600) this.world.logs.splice(0, this.world.logs.length - 600);
    this.emit({ type: "log", log: l });
    return l;
  }

  logLine(key: string, message: string, files?: string[], kind: LogKind = "log", data?: Record<string, unknown>) {
    const c = this.member(key);
    this.log({ kind, attemptId: c.attemptId, agentId: c.agentId, intentId: c.intent, message, files, data });
  }

  private refreshFiles(emit = true) {
    const files: FileNode[] = [...this.main.entries()].map(([path, text]) => ({ path, size: byteSize(text), lang: langOf(path) }));
    files.sort((a, b) => a.path.localeCompare(b.path));
    this.world.files = files;
    this.world.imports = importsOf(this.main);
    this.world.project.mainSha = this.mainSha;
    this.world.project.mainTree = fakeSha("tree-" + this.mainSha);
    if (emit) this.emit({ type: "main", sha: this.mainSha, tree: this.world.project.mainTree, files, imports: this.world.imports });
  }

  private recomputeStats(emit = true) {
    const w = this.world;
    const lat = w.checks.map((c) => c.latencyMs).sort((a, b) => a - b);
    const byMethod: Record<LandingMethod, number> = { "fast-forward": 0, merge: 0, rederive: 0 };
    for (const l of w.landings) byMethod[l.method]++;
    w.stats = {
      courseChecks: w.checks.length,
      clear: w.checks.filter((c) => c.verdict === "clear").length,
      corrections: w.corrections.length,
      correctionsAcknowledged: w.corrections.filter((c) => c.status === "acknowledged").length,
      escalations: w.checks.filter((c) => c.verdict === "escalate").length,
      landings: w.landings.length,
      landedByMethod: byMethod,
      rederives: w.attempts.filter((a) => (a.lineage?.generation ?? 1) > 1).length,
      humanMergeFixes: 0,
      medianCheckLatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
    };
    if (emit) this.emit({ type: "stats", stats: w.stats });
  }

  /* ───── vessel actions (shared by the scenario and by user actions) ───── */

  declare(key: string) {
    const c = this.member(key);
    let agent = this.agentOf(c);
    if (!agent) {
      agent = {
        id: c.agentId,
        callsign: c.callsign,
        kind: c.kind,
        model: c.model,
        client: c.client,
        color: c.color,
        status: "underway",
        attemptId: c.attemptId,
        lastSeen: this.nowMs,
      };
      this.world.agents.push(agent);
    }
    agent.status = "underway";
    agent.attemptId = c.attemptId;
    this.putAgent(agent);
    const base = { sha: this.mainSha, tree: new Map(this.main) };
    this.bases.set(c.attemptId, base);
    this.heads.set(c.attemptId, new Map(this.main));
    const attempt: Attempt = {
      id: c.attemptId,
      intentId: c.intent,
      agentId: c.agentId,
      fork: {
        repo: `saltmarsh-books--${c.callsign.toLowerCase()}`,
        remote: c.client === "codex" ? `https://<account-id>.artifacts.cloudflare.net/git/bearing/saltmarsh-books--${c.callsign.toLowerCase()}.git` : undefined,
      },
      mode: c.kind === "mcp" && c.client === "codex" ? "git" : "api",
      baseSha: base.sha,
      baseTree: fakeSha("tree-" + base.sha),
      status: "declared",
      course: { plan: c.plan, files: c.files, symbols: c.symbols, approach: c.approach, declaredAt: this.nowMs },
      footprint: { files: {}, symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] }, computedAt: this.nowMs },
      corrections: [],
      lineage: { generation: c.generation ?? 1, rederivedFrom: c.rederivedFrom },
      stats: { filesChanged: 0, additions: 0, deletions: 0, steps: 0 },
      createdAt: this.nowMs,
      updatedAt: this.nowMs,
    };
    const existing = this.world.attempts.findIndex((a) => a.id === attempt.id);
    if (existing >= 0) this.world.attempts[existing] = attempt;
    else this.world.attempts.push(attempt);
    this.putAttempt(attempt);
    const intent = this.intent(c.intent);
    if (intent.status === "open" || intent.status === "draft") {
      intent.status = "underway";
      this.putIntent(intent);
    }
    this.logLine(key, `Declare course: ${c.approach}`, undefined, "declare", { files: c.files, symbols: c.symbols });
  }

  write(key: string, path: string, message: string) {
    const c = this.member(key);
    const a = this.attempt(c.attemptId);
    const head = this.heads.get(a.id)!;
    for (const pf of this.patchFiles(c).filter((p) => p.path === path && p.create === undefined)) applyPatchFile(head, pf);
    this.refreshFootprint(a);
    a.status = "underway";
    a.stats.steps++;
    this.putAttempt(a);
    this.logLine(key, message, [path], "write");
  }

  private patchFiles(c: CastMember): PatchFile[] {
    return typeof c.patch === "string" ? patch(c.patch) : c.patch;
  }

  private refreshFootprint(a: Attempt) {
    const base = this.bases.get(a.id)!.tree;
    const head = this.heads.get(a.id)!;
    const paths = [...new Set([...base.keys(), ...head.keys()])].filter((p) => base.get(p) !== head.get(p));
    a.footprint = computeFootprint(base, head, paths, this.nowMs);
    const files = Object.values(a.footprint.files);
    a.stats.filesChanged = files.length;
    a.stats.additions = files.reduce((s, f) => s + f.additions, 0);
    a.stats.deletions = files.reduce((s, f) => s + f.deletions, 0);
  }

  check(key: string, trigger: CourseCheck["trigger"], spec: CheckDsl): CourseCheck {
    const c = this.member(key);
    const facts: PairFacts[] = [];
    const assessments: CourseAssessment[] = [];
    for (const p of spec.pairs) {
      const o = this.member(p.other);
      facts.push({
        otherAttemptId: o.attemptId,
        otherAgentId: o.agentId,
        otherIntentId: o.intent,
        otherState: p.otherState ?? "active",
        sharedFiles: p.shared ?? [],
        sharedSymbols: p.sharedSymbols ?? [],
        interfaceHits: p.hits ?? [],
        hunkOverlaps: p.overlaps ?? [],
        range: p.range,
        previousRange: p.previous,
        closing: p.closing ?? false,
        intentSimilarity: p.similarity ?? 0.08,
      });
      assessments.push({
        otherAttemptId: o.attemptId,
        collision: p.collision,
        interference: p.interference,
        duplicate: p.duplicate ?? 0.03,
        giveWay: p.giveWay,
        giveWayConfidence: p.gw,
        rule: p.rule,
      });
    }
    const noModel = spec.pairs.length === 0;
    const check: CourseCheck = {
      id: `ck-${String(++this.seq.check).padStart(3, "0")}`,
      attemptId: c.attemptId,
      trigger,
      verdict: spec.verdict,
      assessments,
      facts,
      source: noModel ? "rules" : spec.source ?? "clef-flash",
      confidence: spec.confidence ?? (noModel ? 1 : 0.88),
      latencyMs: spec.latency ?? (noModel ? 1 : 30 + Math.round(Math.random() * 28)),
      at: this.nowMs,
      raw: spec.escalatedFrom ? { escalatedFrom: spec.escalatedFrom } : undefined,
    };
    this.world.checks.push(check);
    this.emit({ type: "check", check });
    const n = spec.pairs.length;
    const src = check.source === "rules" ? "no model call" : `${check.source} ${check.latencyMs} ms`;
    const text =
      check.verdict === "clear"
        ? n === 0
          ? "Course check: clear. No vessels in range."
          : `Course check: clear. ${n} ${n === 1 ? "vessel" : "vessels"} in range · ${src}`
        : check.verdict === "correct"
          ? `Course check: correction · ${src}`
          : `Course check: ${check.verdict} · ${src}`;
    this.log({ kind: "check", attemptId: c.attemptId, agentId: c.agentId, intentId: c.intent, message: text, data: { checkId: check.id } });
    this.recomputeStats();
    return check;
  }

  correct(key: string, from: string | null, spec: { kind: CorrectionKind; rule: RuleOfTheRoad | "human"; message: string; constraints: Correction["constraints"] }) {
    const c = this.member(key);
    const a = this.attempt(c.attemptId);
    const fromM = from ? this.cast.get(from) : undefined;
    const lastCheck = [...this.world.checks].reverse().find((k) => k.attemptId === a.id);
    const corr: Correction = {
      id: `cr-${String(++this.seq.corr).padStart(2, "0")}`,
      attemptId: a.id,
      standOnAttemptId: fromM?.attemptId,
      kind: spec.kind,
      rule: spec.rule,
      message: spec.message,
      constraints: spec.constraints,
      checkId: lastCheck?.id ?? "",
      status: "pending",
      createdAt: this.nowMs,
    };
    this.world.corrections.push(corr);
    a.corrections.push(corr.id);
    this.emit({ type: "correction", correction: corr });
    this.putAttempt(a);
    const ruleCode = spec.rule === "human" ? "human" : spec.rule.slice(0, 2);
    this.log({
      kind: "correction",
      attemptId: a.id,
      agentId: c.agentId,
      intentId: c.intent,
      message: `Correction for ${c.callsign} · ${spec.kind} · ${ruleCode}${fromM ? ` · ${fromM.callsign} stands on` : ""}`,
      data: { correctionId: corr.id },
    });
    // Corrections that change scope amend the intent constraints (living spec).
    const notes = [
      ...(spec.constraints.useSignatures ?? []).map((s) => `Use \`${s.signature}\` (${s.symbol.split("#")[0]}).`),
      ...(spec.constraints.avoidRegions ?? []).map((r) => `Do not edit ${r.path}, lines ${r.lines[0]}–${r.lines[1]}, while ${fromM?.callsign ?? "the other vessel"} works there.`),
    ];
    if (notes.length && spec.kind !== "upstream") {
      const intent = this.intent(c.intent);
      const fresh = notes.filter((n) => !intent.constraints.includes(n));
      if (fresh.length) {
        intent.version++;
        intent.constraints.push(...fresh);
        const am: Amendment = {
          version: intent.version,
          at: this.nowMs,
          by: HUMANS.bearing,
          reason: `Correction ${corr.id} (${spec.kind}, ${ruleCode}) for ${c.callsign}.`,
          text: fresh.join(" "),
        };
        intent.amendments.push(am);
        this.putIntent(intent);
      }
    }
    this.recomputeStats();
    return corr;
  }

  private correctionFor(key: string, nth = -1): Correction | undefined {
    const c = this.member(key);
    const list = this.world.corrections.filter((x) => x.attemptId === c.attemptId);
    return nth < 0 ? list[list.length + nth] : list[nth];
  }

  deliver(key: string, which: "all" | number = "all") {
    const c = this.member(key);
    for (const corr of this.world.corrections.filter((x) => x.attemptId === c.attemptId && x.status === "pending")) {
      if (which !== "all" && corr.id !== this.correctionFor(key, which)?.id) continue;
      corr.status = "delivered";
      corr.deliveredAt = this.nowMs;
      this.emit({ type: "correction", correction: corr });
    }
  }

  ack(key: string, note: string, which: "all" | number = "all") {
    const c = this.member(key);
    for (const corr of this.world.corrections.filter((x) => x.attemptId === c.attemptId && (x.status === "delivered" || x.status === "pending"))) {
      if (which !== "all" && corr.id !== this.correctionFor(key, which)?.id) continue;
      corr.status = "acknowledged";
      corr.deliveredAt ??= this.nowMs;
      corr.acknowledgedAt = this.nowMs;
      corr.ackNote = note;
      this.emit({ type: "correction", correction: corr });
      this.log({ kind: "ack", attemptId: c.attemptId, agentId: c.agentId, intentId: c.intent, message: `${c.callsign} acknowledges ${corr.id}: ${note}`, data: { correctionId: corr.id } });
    }
    this.recomputeStats();
  }

  range(aKey: string, bKey: string, range: Range, closing = false, verdict?: Verdict) {
    const a = this.member(aKey).attemptId;
    const b = this.member(bKey).attemptId;
    const pair: RadarPair = { a, b, range, closing, verdict, updatedAt: this.nowMs };
    this.radar.set(a < b ? `${a}|${b}` : `${b}|${a}`, pair);
    this.world.radar = [...this.radar.values()];
    this.emit({ type: "radar", pairs: [pair] });
  }

  submit(key: string, summary: string) {
    const c = this.member(key);
    const a = this.attempt(c.attemptId);
    // Bearing writes the intent checks into the working tree before it runs them.
    const head = this.heads.get(a.id)!;
    const intent = this.intent(c.intent);
    for (const chk of intent.checks) head.set(chk.path, chk.content);
    this.refreshFootprint(a);
    a.status = "checking";
    a.summary = summary;
    this.putAttempt(a);
    const agent = this.agentOf(c);
    if (agent) {
      agent.status = "waiting";
      this.putAgent(agent);
    }
    this.logLine(key, `Submit: ${summary}`, undefined, "submit");
  }

  private caseList(intentId: string, failing: string[] = [], errors: Record<string, string> = {}): CheckRun["cases"] {
    const intent = this.intent(intentId);
    return intent.checks.flatMap((chk) => {
      const names = testNames(chk.content);
      return (names.length ? names : ["keeps the shop running"]).map((name, i) => ({
        file: chk.path,
        name,
        ok: !failing.includes(name),
        error: failing.includes(name) ? errors[name] ?? "expected value to match" : undefined,
        ms: 2 + ((name.length * 7 + i * 13) % 17),
      }));
    });
  }

  runChecks(key: string, failing: string[] = [], errors: Record<string, string> = {}) {
    const c = this.member(key);
    const a = this.attempt(c.attemptId);
    const cases = this.caseList(c.intent, failing, errors);
    const passed = cases.filter((x) => x.ok).length;
    const run: CheckRun = {
      id: `cr-run-${a.id}-${a.stats.steps}`,
      subject: fakeSha("overlay-" + a.id + a.stats.steps),
      scope: "attempt",
      ok: passed === cases.length,
      passed,
      failed: cases.length - passed,
      cases,
      ms: cases.reduce((s, x) => s + x.ms, 0) + 140,
      at: this.nowMs,
    };
    a.checks = run;
    a.status = run.ok ? "ready" : "underway";
    this.putAttempt(a);
    const agent = this.agentOf(c);
    if (agent) {
      agent.status = run.ok ? "waiting" : "underway";
      this.putAgent(agent);
    }
    this.logLine(
      key,
      run.ok
        ? `Checks pass: ${passed} of ${cases.length} · ${run.ms} ms`
        : `Checks fail: ${run.failed} of ${cases.length}. ${cases.filter((x) => !x.ok).map((x) => x.name).join("; ")}.`,
      undefined,
      "check",
    );
    return run;
  }

  /** After a check run: the intent waits for a human pick when several attempts are ready. */
  settleIntent(intentId: string) {
    const intent = this.intent(intentId);
    if (intent.status === "landed" || intent.status === "parked") return;
    const live = this.world.attempts.filter(
      (a) => a.intentId === intentId && !["alternate", "abandoned", "failed", "landed"].includes(a.status) && !(a.status === "stale" && this.world.attempts.some((b) => b.lineage.rederivedFrom === a.id)),
    );
    const ready = live.filter((a) => a.status === "ready");
    if (live.length > 1 && ready.length === live.length && intent.status !== "judging") {
      intent.status = "judging";
      this.putIntent(intent);
      this.log({ kind: "decision", intentId, message: `“${intent.title}” has ${ready.length} ready attempts. A human pick is necessary.` });
    }
  }

  private composedRun(tree: Tree, subject: string): CheckRun {
    const cases = [...tree.entries()]
      .filter(([p]) => p.startsWith("tests/") && p.endsWith(".test.js"))
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([file, text]) => testNames(text).map((name, i) => ({ file, name, ok: true, ms: 2 + ((name.length * 5 + i * 11) % 15) })));
    return {
      id: `run-composed-${subject.slice(0, 8)}`,
      subject,
      scope: "composed",
      ok: true,
      passed: cases.length,
      failed: 0,
      cases,
      ms: cases.reduce((s, x) => s + x.ms, 0) + 210,
      at: this.nowMs,
    };
  }

  /** Try to compose an attempt on main. Returns the new tree or the conflicting paths. */
  private compose(a: Attempt): { tree: Tree; conflicts: { path: string; lines: LineRange | null }[]; method: "fast-forward" | "merge" } {
    const base = this.bases.get(a.id)!;
    const head = this.heads.get(a.id)!;
    if (base.sha === this.mainSha) return { tree: new Map(head), conflicts: [], method: "fast-forward" };
    const c = [...this.cast.values()].find((m) => m.attemptId === a.id);
    const tree = new Map(this.main);
    const conflicts: { path: string; lines: LineRange | null }[] = [];
    const written = new Set(Object.keys(a.footprint.files));
    for (const pf of c ? this.patchFiles(c) : []) {
      if (!written.has(pf.path)) continue;
      const r = applyPatchFile(tree, pf);
      if (!r.ok) {
        const fp = a.footprint.files[pf.path];
        conflicts.push({ path: pf.path, lines: fp?.hunks.length ? [fp.hunks[0][0], fp.hunks[fp.hunks.length - 1][1]] : null });
      }
    }
    return { tree, conflicts, method: "merge" };
  }

  landKey(key: string, opts: { method?: LandingMethod; decision?: Decision } = {}): Landing | null {
    const c = this.member(key);
    const a = this.attempt(c.attemptId);
    const intent = this.intent(c.intent);
    const agent = this.agentOf(c);
    const composed = this.compose(a);
    if (composed.conflicts.length) {
      this.stale(key, composed.conflicts);
      return null;
    }
    a.status = "landing";
    this.putAttempt(a);
    const method: LandingMethod = opts.method ?? composed.method;
    const before = this.mainSha;
    const tree = composed.tree;
    const intentPath = `.bearing/intents/${slugify(intent.title)}.md`;
    const corrections = this.world.corrections.filter((x) => x.attemptId === a.id && x.status !== "superseded");
    tree.set(intentPath, intentFile(intent, a, c, method, corrections.length));
    const after = fakeSha(`main-${before}-${a.id}`);
    const composedRun = this.composedRun(tree, fakeSha("tree-" + after));
    a.composedChecks = composedRun;
    this.main = tree;
    this.mainSha = after;
    this.history.set(after, new Map(tree));
    const landing: Landing = {
      id: `ld-${String(++this.seq.land).padStart(2, "0")}`,
      attemptId: a.id,
      intentId: intent.id,
      agentId: c.agentId,
      method,
      mainBefore: before,
      mainAfter: after,
      checks: composedRun,
      correctionsApplied: corrections.length,
      at: this.nowMs,
      message: commitMessage(intent, a, c, method, corrections.length, composedRun),
    };
    this.world.landings.push(landing);
    a.status = "landed";
    a.landedAt = this.nowMs;
    a.headSha = after;
    this.putAttempt(a);
    for (const sib of this.world.attempts.filter((x) => x.intentId === intent.id && x.id !== a.id && !["landed", "abandoned"].includes(x.status))) {
      sib.status = "alternate";
      this.putAttempt(sib);
      const sa = this.world.agents.find((g) => g.id === sib.agentId);
      if (sa) {
        sa.status = "idle";
        sa.attemptId = undefined;
        this.putAgent(sa);
      }
    }
    intent.status = "landed";
    intent.landedSha = after;
    intent.chosenAttemptId = a.id;
    this.putIntent(intent);
    if (agent) {
      agent.status = "idle";
      agent.attemptId = undefined;
      this.putAgent(agent);
    }
    this.emit({ type: "landing", landing });
    this.refreshFiles(true);
    const how = method === "fast-forward" ? "fast-forward" : method === "merge" ? "3-way merge" : "re-derive";
    this.log({
      kind: "land",
      attemptId: a.id,
      agentId: c.agentId,
      intentId: intent.id,
      message: `Landed on main ${after.slice(0, 7)} · ${how} · “${intent.title}” · ${composedRun.passed}/${composedRun.passed + composedRun.failed} checks`,
      files: Object.keys(a.footprint.files),
      data: { landingId: landing.id },
    });
    this.recomputeStats();
    return landing;
  }

  stale(key: string, conflicts: { path: string; lines: LineRange | null }[]) {
    const c = this.member(key);
    const a = this.attempt(c.attemptId);
    a.status = "stale";
    this.putAttempt(a);
    const where = conflicts.map((x) => (x.lines ? `${x.path} lines ${x.lines[0]}–${x.lines[1]}` : x.path)).join(", ");
    this.logLine(key, `Stale at landing: ${where} changed on main ${this.mainSha.slice(0, 7)}. Re-derive from the intent.`, conflicts.map((x) => x.path), "stale");
  }

  rederiveTo(fromKey: string, toKey: string, reason: string) {
    const from = this.member(fromKey);
    const old = this.attempt(from.attemptId);
    const to = this.member(toKey);
    const fromAgent = this.agentOf(from);
    if (fromAgent) {
      fromAgent.status = "idle";
      fromAgent.attemptId = undefined;
      this.putAgent(fromAgent);
    }
    for (const corr of this.world.corrections.filter((x) => x.attemptId === old.id && x.status !== "acknowledged")) {
      corr.status = "superseded";
      this.emit({ type: "correction", correction: corr });
    }
    this.log({
      kind: "rederive",
      attemptId: to.attemptId,
      agentId: to.agentId,
      intentId: to.intent,
      message: `${to.callsign} re-derives “${this.intent(to.intent).title}” on main ${this.mainSha.slice(0, 7)} (generation ${to.generation ?? 2}). ${reason}`,
    });
    this.declare(toKey);
  }

  /* ───── HarborClient: user actions ───── */

  async createIntent(input: NewIntentInput): Promise<Intent> {
    this.takeControl();
    this.nowMs = Date.now();
    const title = input.title.trim();
    if (!title) throw new ApiError(400, "The intent needs a title. Write a title and try again.");
    const slug = slugify(title) || "intent";
    const checks: CheckSpec[] = (input.checks ?? [])
      .filter((c) => c.content.trim())
      .map((c, i) => ({ id: `chk-${slug}-${i}`, path: c.path || `tests/${slug}.test.js`, content: c.content, description: c.description || `Checks for “${title}”.` }));
    if (!checks.length) checks.push({ id: `chk-${slug}`, path: `tests/${slug}.test.js`, content: defaultTest(title), description: "Repo checks only. The shop and the JSON list still work." });
    let id = `in-${slug}`.slice(0, 40);
    while (this.world.intents.some((i) => i.id === id)) id += "-2";
    const intent: Intent = {
      id,
      title,
      goal: input.goal.trim() || title,
      constraints: [],
      checks,
      priority: input.priority ?? "normal",
      status: "open",
      version: 1,
      amendments: [],
      createdBy: HUMANS.you,
      createdAt: this.nowMs,
      updatedAt: this.nowMs,
      source: { kind: "ui" },
    };
    this.world.intents.push(intent);
    this.emit({ type: "intent", intent });
    this.log({ kind: "intent", intentId: id, message: `You open intent “${title}”.` });
    return structuredClone(intent);
  }

  async amendIntent(id: string, input: AmendInput): Promise<Intent> {
    this.takeControl();
    this.nowMs = Date.now();
    const intent = this.intent(id);
    if (!input.reason?.trim()) throw new ApiError(400, "An amendment needs a reason. Write the reason and try again.");
    const added: string[] = [];
    if (input.goal && input.goal.trim() !== intent.goal) {
      intent.goal = input.goal.trim();
      added.push("Goal changed.");
    }
    for (const c of input.constraints ?? []) {
      if (c.trim() && !intent.constraints.includes(c.trim())) {
        intent.constraints.push(c.trim());
        added.push(c.trim());
      }
    }
    intent.version++;
    intent.amendments.push({ version: intent.version, at: this.nowMs, by: HUMANS.you, reason: input.reason.trim(), text: added.join(" ") || "No text change." });
    this.putIntent(intent);
    this.world.decisions.push(this.decision("amend", id, [], input.reason.trim()));
    this.emit({ type: "decision", decision: this.world.decisions[this.world.decisions.length - 1] });
    this.log({ kind: "intent", intentId: id, message: `You amend “${intent.title}” to v${intent.version}: ${input.reason.trim()}` });
    // Active attempts get an intent-amended correction.
    for (const a of this.world.attempts.filter((x) => x.intentId === id && ["declared", "underway", "checking", "ready"].includes(x.status))) {
      const m = [...this.cast.values()].find((c) => c.attemptId === a.id);
      if (!m) continue;
      this.correct(m.key, null, {
        kind: "intent-amended",
        rule: "human",
        message: `A human changed the intent to v${intent.version}. ${added.length ? `New text: ${added.join(" ")} ` : ""}Read the intent again. Continue your work.`,
        constraints: { notes: added },
      });
      const key = m.key;
      this.later(1.5, () => this.deliver(key));
      this.later(3, () => this.ack(key, `Follow intent v${intent.version}.`));
    }
    return structuredClone(intent);
  }

  private decision(kind: DecisionKind, intentId: string, attemptIds: string[], rationale: string, by = HUMANS.you): Decision {
    return { id: `dc-${String(++this.seq.dec).padStart(2, "0")}`, kind, intentId, attemptIds, by, rationale, at: this.nowMs };
  }

  async launch(id: string, fanout: number, models?: string[]): Promise<{ attempts: Attempt[] }> {
    this.takeControl();
    this.nowMs = Date.now();
    const intent = this.intent(id);
    if (["landed", "parked"].includes(intent.status)) throw new ApiError(409, "This intent is closed. Open a new intent for new work.");
    const n = Math.max(1, Math.min(4, Math.round(fanout)));
    const pool = models?.length ? models : MODELS;
    const created: Attempt[] = [];
    for (let i = 0; i < n; i++) {
      const m = this.newMember(intent, pool[i % pool.length]);
      this.declare(m.key);
      created.push(structuredClone(this.attempt(m.attemptId)));
      this.scriptDynamic(m, i * 0.8, n);
    }
    this.log({ kind: "intent", intentId: id, message: `You launch ${n} ${n === 1 ? "attempt" : "attempts"} for “${intent.title}”.` });
    return { attempts: created };
  }

  private newMember(intent: Intent, model: string, opts: { generation?: number; rederivedFrom?: string } = {}): CastMember {
    const used = new Set(this.world.agents.map((a) => a.callsign));
    const callsign = CALLSIGN_POOL.find((c) => !used.has(c)) ?? `VESSEL-${this.world.agents.length + 1}`;
    const usedColors = new Set(this.world.agents.filter((a) => a.status !== "idle" && a.status !== "offline").map((a) => a.color));
    const color = [3, 6, 10, 11, 0, 1, 2, 4, 5, 7, 8, 9].find((c) => !usedColors.has(c)) ?? this.world.agents.length % 12;
    const files = targetFiles(intent.title + " " + intent.goal);
    const slug = slugify(intent.title);
    const fn = camel(slug) || "feature";
    const patchFiles: PatchFile[] = files.map((path) => ({
      path,
      edits: [
        {
          find: "",
          replace: path.endsWith(".md")
            ? `\n## ${intent.title}\n\n${firstSentence(intent.goal)}`
            : `\n// ${intent.title} (${callsign})\nexport function ${fn}${path.includes("render") ? "Section" : path.includes("index") ? "Route" : path.includes("styles") ? "Styles" : ""}() {\n  return ${JSON.stringify(firstSentence(intent.goal))};\n}`,
        },
      ],
    }));
    const key = `dyn-${slug}-${callsign.toLowerCase()}`;
    const m: CastMember = {
      key,
      attemptId: `at-${slug}-${callsign.toLowerCase()}`.slice(0, 48),
      agentId: `ag-${callsign.toLowerCase()}`,
      callsign,
      kind: "builtin",
      model,
      color,
      intent: intent.id,
      patch: patchFiles,
      plan: [...files.map((f) => `Change ${f} for “${intent.title}”.`), "Run the checks. Submit."],
      files,
      symbols: files.filter((f) => f.endsWith(".js")).map((f) => `${f}#${fn}`),
      approach: firstSentence(intent.goal),
      generation: opts.generation,
      rederivedFrom: opts.rederivedFrom,
    };
    this.cast.set(key, m);
    return m;
  }

  private scriptDynamic(m: CastMember, offset: number, fanout: number) {
    const key = m.key;
    const others = () =>
      this.world.attempts.filter(
        (a) => a.id !== m.attemptId && a.intentId !== m.intent && ["declared", "underway", "checking", "ready"].includes(a.status),
      );
    this.later(offset + 0.6, () => {
      const near = others()
        .map((a) => {
          const shared = a.course.files.filter((f) => m.files.includes(f));
          return { a, shared };
        })
        .filter((x) => x.shared.length)
        .slice(0, 3);
      const pairs: PairDsl[] = [];
      for (const n of near) {
        const om = [...this.cast.values()].find((c) => c.attemptId === n.a.id);
        if (!om) continue;
        pairs.push(pair(om.key, 2, { collision: 0.18, interference: 1.1, giveWay: "incoming", gw: 0.77, rule: "R4-first-declared-stands-on", shared: n.shared }));
        this.range(key, om.key, 2, false, "clear");
      }
      this.check(key, "declare", { verdict: "clear", pairs });
    });
    m.files.forEach((f, i) => {
      this.later(offset + 2.5 + i * 2.6, () => this.write(key, f, `Change ${f}: add ${f.endsWith(".md") ? "a section" : "a function"} for this intent.`));
      this.later(offset + 3.1 + i * 2.6, () => this.check(key, "write", { verdict: "clear", pairs: [] }));
    });
    const done = offset + 3.5 + m.files.length * 2.6;
    this.later(done, () => this.submit(key, `${m.callsign} completes “${this.intent(m.intent).title}”.`));
    this.later(done + 1.2, () => {
      this.runChecks(key);
      if (fanout === 1 && this.world.project.settings.autoLand) {
        this.later(1, () => {
          this.landKey(key);
        });
      } else {
        this.settleIntent(m.intent);
      }
    });
  }

  async park(id: string, reason: string): Promise<void> {
    this.takeControl();
    this.nowMs = Date.now();
    const intent = this.intent(id);
    intent.status = "parked";
    this.putIntent(intent);
    const ids: string[] = [];
    for (const a of this.world.attempts.filter((x) => x.intentId === id && !["landed", "alternate", "abandoned"].includes(x.status))) {
      a.status = "abandoned";
      ids.push(a.id);
      this.putAttempt(a);
      const g = this.world.agents.find((x) => x.id === a.agentId);
      if (g) {
        g.status = "idle";
        g.attemptId = undefined;
        this.putAgent(g);
      }
    }
    const d = this.decision("park", id, ids, reason || "Parked by a human.");
    this.world.decisions.push(d);
    this.emit({ type: "decision", decision: d });
    this.log({ kind: "decision", intentId: id, message: `You park “${intent.title}”: ${reason || "no reason given"}` });
  }

  async land(attemptId: string, rationale: string): Promise<LandResult> {
    this.takeControl();
    this.nowMs = Date.now();
    const a = this.attempt(attemptId);
    if (a.status !== "ready") throw new ApiError(409, "Only a ready attempt can land. Wait for the checks to pass.");
    if (!rationale.trim()) throw new ApiError(400, "A landing pick needs a reason. Write the reason and try again.");
    const m = [...this.cast.values()].find((c) => c.attemptId === a.id);
    if (!m) throw new ApiError(404, "This attempt has no vessel in the mock harbor.");
    const siblings = this.world.attempts.filter((x) => x.intentId === a.intentId && x.id !== a.id).map((x) => x.id);
    const d = this.decision("pick", a.intentId, [a.id, ...siblings], rationale.trim());
    this.world.decisions.push(d);
    this.emit({ type: "decision", decision: d });
    this.log({ kind: "decision", attemptId: a.id, intentId: a.intentId, message: `You pick ${m.callsign}: ${rationale.trim()}` });
    const intent = this.intent(a.intentId);
    intent.status = "landing";
    this.putIntent(intent);
    const landing = this.landKey(m.key, { decision: d });
    if (!landing) {
      // Stale: re-derive from the intent on the new main.
      const next = this.newMember(intent, m.model, { generation: (a.lineage.generation ?? 1) + 1, rederivedFrom: a.id });
      this.rederiveTo(m.key, next.key, "The attempt does not compose with main.");
      this.scriptDynamic(next, 0, 1);
      return { status: "rederiving", message: "The attempt does not compose with main. Bearing re-derives it from the intent." };
    }
    return { status: "landed", landing: structuredClone(landing) };
  }

  async rederive(attemptId: string, reason: string): Promise<{ attempt: Attempt }> {
    this.takeControl();
    this.nowMs = Date.now();
    if (!reason.trim()) throw new ApiError(400, "A re-derive needs a reason. Write what is wrong and try again.");
    const a = this.attempt(attemptId);
    const m = [...this.cast.values()].find((c) => c.attemptId === a.id);
    if (!m) throw new ApiError(404, "This attempt has no vessel in the mock harbor.");
    const intent = this.intent(a.intentId);
    if (intent.status === "landed" || intent.status === "parked") throw new ApiError(409, "This intent is closed. Open a new intent for new work.");
    const d = this.decision("rederive", a.intentId, [a.id], reason.trim());
    this.world.decisions.push(d);
    this.emit({ type: "decision", decision: d });
    if (!["landed", "alternate"].includes(a.status)) {
      a.status = "alternate";
      this.putAttempt(a);
    }
    const next = this.newMember(intent, m.model, { generation: (a.lineage.generation ?? 1) + 1, rederivedFrom: a.id });
    this.rederiveTo(m.key, next.key, reason.trim());
    if (intent.status === "judging") {
      intent.status = "underway";
      this.putIntent(intent);
    }
    this.scriptDynamic(next, 0, 2);
    return { attempt: structuredClone(this.attempt(next.attemptId)) };
  }

  async attemptDiff(attemptId: string): Promise<DiffResult> {
    const base = this.bases.get(attemptId)?.tree;
    const head = this.heads.get(attemptId);
    if (!base || !head) throw new ApiError(404, "This attempt has no diff yet.");
    const paths = [...new Set([...base.keys(), ...head.keys()])].filter((p) => base.get(p) !== head.get(p)).sort();
    return { files: paths.map((p) => fileDiff(p, base.get(p) ?? null, head.get(p) ?? null)) };
  }

  async landing(id: string): Promise<LandingDetail> {
    const l = this.world.landings.find((x) => x.id === id);
    if (!l) throw new ApiError(404, "This landing is not in the logbook.");
    const before = this.history.get(l.mainBefore) ?? new Map();
    const after = this.history.get(l.mainAfter) ?? new Map();
    const paths = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
    const a = this.world.attempts.find((x) => x.id === l.attemptId);
    const intent = this.world.intents.find((x) => x.id === l.intentId);
    const agent = this.world.agents.find((x) => x.id === l.agentId);
    const corrections = this.world.corrections.filter((c) => c.attemptId === l.attemptId);
    const checks = this.world.checks.filter((c) => c.attemptId === l.attemptId);
    const decision = this.world.decisions.find((d) => d.kind === "pick" && d.attemptIds[0] === l.attemptId);
    const note = {
      schema: "bearing.logbook/v1",
      landing: { id: l.id, method: l.method, mainBefore: l.mainBefore, mainAfter: l.mainAfter, at: new Date(l.at).toISOString() },
      intent: intent && { id: intent.id, title: intent.title, version: intent.version, goal: intent.goal, constraints: intent.constraints },
      attempt: a && { id: a.id, generation: a.lineage.generation, rederivedFrom: a.lineage.rederivedFrom ?? null, baseSha: a.baseSha, course: a.course },
      agent: agent && { id: agent.id, callsign: agent.callsign, model: agent.model, client: agent.client ?? null },
      corrections: corrections.map((c) => ({ id: c.id, kind: c.kind, rule: c.rule, status: c.status, message: c.message })),
      courseChecks: checks.map((c) => ({
        id: c.id,
        trigger: c.trigger,
        verdict: c.verdict,
        source: c.source,
        latencyMs: c.latencyMs,
        confidence: c.confidence,
        assessments: c.assessments,
      })),
      checks: { scope: l.checks.scope, passed: l.checks.passed, failed: l.checks.failed, ms: l.checks.ms },
      decision: decision ? { kind: decision.kind, by: decision.by.name, rationale: decision.rationale } : null,
    };
    return { landing: structuredClone(l), note, diff: { files: paths.map((p) => fileDiff(p, before.get(p) ?? null, after.get(p) ?? null)) } };
  }

  async file(ref: string, path: string): Promise<string> {
    const tree = ref === "main" || !ref ? this.main : this.history.get(ref) ?? this.heads.get(ref);
    const text = tree?.get(path);
    if (text === undefined) throw new ApiError(404, `${path} is not in ${ref === "main" ? "main" : ref.slice(0, 7)}.`);
    return text;
  }

  async demoReset(): Promise<void> {
    this.manual = false;
    this.stopFleet();
    this.reset(0);
    this.log({ kind: "system", message: "Demo reset. The harbor starts again from the seed." });
  }

  async demoRun(_mode?: "llm" | "scripted"): Promise<void> {
    await this.demoReset();
  }

  async simStart(agents: number, sectors: number): Promise<void> {
    this.simStop();
    const A = Math.max(1, Math.round(agents));
    const S = Math.max(1, Math.round(sectors));
    const started = Date.now();
    let avoided = 0;
    let conflicts = 0;
    const step = () => {
      const offered = A * 0.5;
      const capacity = S * 2400;
      const rho = offered / capacity;
      const served = Math.min(offered, capacity) * (0.97 + Math.random() * 0.06);
      const corrections = served * 0.055 * (0.9 + Math.random() * 0.2);
      avoided += corrections * 0.5 * 0.6;
      if (rho > 1) conflicts += (offered - capacity) * 0.0004 * 0.5;
      const sim: SimStats = {
        running: true,
        agents: A,
        sectors: S,
        courseChecksPerSec: served,
        correctionsPerSec: corrections,
        landingsPerSec: A * 0.004 * (0.9 + Math.random() * 0.2),
        conflictsAtLanding: Math.round(conflicts),
        collisionsAvoided: Math.round(avoided),
        p50CheckMs: 36 + 7 * Math.min(rho, 1.4) ** 2 + Math.random() * 2,
        p99CheckMs: rho < 0.75 ? 88 + 30 * rho + Math.random() * 6 : 110 + 2600 * (rho - 0.7) ** 2 + Math.random() * 20,
        startedAt: started,
        elapsedMs: Date.now() - started,
      };
      this.world.sim = sim;
      this.emit({ type: "sim", sim });
    };
    step();
    this.simTimer = setInterval(step, 500);
  }

  async simStop(): Promise<void> {
    if (this.simTimer) clearInterval(this.simTimer);
    this.simTimer = null;
    if (this.world?.sim) {
      this.world.sim = { ...this.world.sim, running: false };
      this.emit({ type: "sim", sim: this.world.sim });
    }
  }

  async connect(): Promise<ConnectInfo> {
    return defaultConnectInfo(this.projectId);
  }

  previewUrl(): string | null {
    return null;
  }

  previewDoc(attemptId: string, path = "/"): string | null {
    const head = this.heads.get(attemptId);
    if (!head) return null;
    const m = [...this.cast.values()].find((c) => c.attemptId === attemptId);
    return previewDocument(head, path, m?.callsign ?? attemptId);
  }

  /** Preview of main (used when no attempt is selected). */
  mainPreviewDoc(path = "/"): string {
    return previewDocument(this.main, path, "main");
  }

  /* ───── fleet (performance test) ───── */

  private startFleet(n: number) {
    const files = this.world.files.map((f) => f.path).filter((p) => !p.startsWith(".bearing"));
    const ids: string[] = [];
    this.nowMs = Date.now();
    for (let i = 0; i < n; i++) {
      const callsign = `FLEET-${String(i + 1).padStart(3, "0")}`;
      const course = [files[(i * 7) % files.length], files[(i * 11 + 3) % files.length]];
      const m: CastMember = {
        key: `fleet-${i}`,
        attemptId: `at-fleet-${i}`,
        agentId: `ag-fleet-${i}`,
        callsign,
        kind: "sim",
        model: MODELS[i % 3],
        color: i % 12,
        intent: this.world.intents[i % this.world.intents.length].id,
        patch: [],
        plan: ["Synthetic course for the performance test."],
        files: course,
        symbols: [],
        approach: "Synthetic vessel.",
      };
      this.cast.set(m.key, m);
      this.declare(m.key);
      ids.push(m.key);
    }
    this.fleetTimer = setInterval(() => {
      this.nowMs = Date.now();
      for (let k = 0; k < Math.max(1, Math.round(n / 8)); k++) {
        const key = ids[Math.floor(Math.random() * ids.length)];
        const f = files[Math.floor(Math.random() * files.length)];
        const c = this.member(key);
        const a = this.world.attempts.find((x) => x.id === c.attemptId);
        if (!a) continue;
        a.status = "underway";
        this.putAttempt(a);
        this.log({ kind: "write", attemptId: a.id, agentId: c.agentId, intentId: c.intent, message: `Write ${f}.`, files: [f] });
      }
    }, 1000);
  }

  private stopFleet() {
    if (this.fleetTimer) clearInterval(this.fleetTimer);
    this.fleetTimer = null;
  }

  /* used by the scenario */
  regionOf(key: string, path: string): LineRange {
    const a = this.attempt(this.member(key).attemptId);
    const fp = a.footprint.files[path];
    if (fp?.hunks.length) return [Math.max(1, fp.hunks[0][0]), fp.hunks[fp.hunks.length - 1][1]];
    return declRange(this.main.get(path) ?? "", "renderHeader") ?? [1, 10];
  }

  mainLine(path: string, name: string): LineRange {
    return declRange(this.main.get(path) ?? "", name) ?? [1, 10];
  }

  sha() {
    return this.mainSha.slice(0, 7);
  }
}

/* ───────────── DSL helpers ───────────── */

interface PairDsl {
  other: string;
  range: Range;
  previous?: Range;
  closing?: boolean;
  collision: number;
  interference: number;
  duplicate?: number;
  giveWay: "incoming" | "other";
  gw: number;
  rule: RuleOfTheRoad;
  shared?: string[];
  sharedSymbols?: string[];
  hits?: PairFacts["interfaceHits"];
  overlaps?: PairFacts["hunkOverlaps"];
  similarity?: number;
  otherState?: PairFacts["otherState"];
}

interface CheckDsl {
  verdict: Verdict;
  pairs: PairDsl[];
  source?: CourseCheck["source"];
  latency?: number;
  confidence?: number;
  escalatedFrom?: { source: "clef-flash"; confidence: number; latencyMs: number };
}

function pair(other: string, range: Range, rest: Omit<PairDsl, "other" | "range">): PairDsl {
  return { other, range, ...rest };
}

function emptyStats(): HarborStats {
  return {
    courseChecks: 0,
    clear: 0,
    corrections: 0,
    correctionsAcknowledged: 0,
    escalations: 0,
    landings: 0,
    landedByMethod: { "fast-forward": 0, merge: 0, rederive: 0 },
    rederives: 0,
    humanMergeFixes: 0,
    medianCheckLatencyMs: 0,
  };
}

function fileDiff(path: string, before: string | null, after: string | null): DiffFile {
  const st = lineStats(before ?? "", after ?? "");
  return {
    path,
    status: before === null ? "A" : after === null ? "D" : "M",
    additions: st.additions,
    deletions: st.deletions,
    diff: unifiedDiff(path, before, after),
  };
}

function intentFile(intent: Intent, a: Attempt, c: CastMember, method: LandingMethod, corrections: number): string {
  return `---
intent: ${intent.id}
title: ${JSON.stringify(intent.title)}
version: ${intent.version}
attempt: ${a.id}
agent: ${c.callsign}
model: ${c.model}
method: ${method}
corrections: ${corrections}
---

# ${intent.title}

${intent.goal}
${intent.constraints.length ? `\n## Constraints\n\n${intent.constraints.map((x) => `- ${x}`).join("\n")}\n` : ""}
## Checks

${intent.checks.map((k) => `- \`${k.path}\`: ${k.description}`).join("\n")}
`;
}

function commitMessage(intent: Intent, a: Attempt, c: CastMember, method: LandingMethod, corrections: number, composed: CheckRun): string {
  const how = method === "fast-forward" ? "a fast-forward" : method === "merge" ? "a 3-way merge" : "a re-derive from the intent";
  return `${intent.title}

Land attempt ${a.id} by ${c.callsign} (${modelShort(c.model)}) with ${how}.
Checks: ${a.checks ? `${a.checks.passed}/${a.checks.passed + a.checks.failed} pass alone, ` : ""}${composed.passed}/${composed.passed + composed.failed} pass composed with main.

Bearing-Intent: ${intent.id} v${intent.version}
Bearing-Attempt: ${a.id}
Bearing-Agent: ${c.callsign}
Bearing-Model: ${c.model}
Bearing-Method: ${method}
Bearing-Corrections: ${corrections}
Bearing-Checks: ${composed.passed}/${composed.passed + composed.failed}
Bearing-Generation: ${a.lineage.generation}`;
}

function defaultTest(title: string): string {
  return `import { test, expect } from "../harness/test.js";
import worker from "../src/index.js";

// ${title}: no acceptance checks were written. These repo checks keep the shop running.
test("keeps the shelf at /", async () => {
  const res = await worker.fetch(new Request("https://shop.test/"));
  expect(res.status).toBe(200);
});

test("keeps every book in the JSON list", async () => {
  const res = await worker.fetch(new Request("https://shop.test/api/products"));
  expect((await res.json()).length).toBe(6);
});
`;
}

function targetFiles(text: string): string[] {
  const t = text.toLowerCase();
  if (/(dark|theme|colou?r|style|font|css|contrast|layout)/.test(t)) return ["src/styles.js", "src/render.js"];
  if (/(search|filter|sort|find)/.test(t)) return ["src/products.js", "src/render.js", "src/index.js"];
  if (/(api|json|endpoint|route|http|header)/.test(t)) return ["src/index.js", "src/products.js"];
  if (/(price|currency|cart|stock|discount|sale)/.test(t)) return ["src/products.js", "src/render.js"];
  if (/(readme|docs?|agents|guide)/.test(t)) return ["README.md"];
  return ["src/render.js", "src/products.js"];
}

function camel(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("")
    .replace(/^[0-9]+/, "");
}

function firstSentence(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  return (m ? m[1] : s.trim()).replace(/`/g, "");
}

/* ───────────── the scenario (scenario seconds; real time = × PACE) ───────────── */

const SCENARIO: Step[] = [
  [1.0, (h) => h.logLine("currency-1", "Keep cents as integers. Convert only for display.", ["src/products.js"], "log")],
  [1.6, (h) => h.write("json-1", "src/products.js", "Add findBook(id) after the books array.")],
  [
    2.1,
    (h) => {
      h.check("json-1", "write", {
        verdict: "clear",
        latency: 31,
        confidence: 0.92,
        pairs: [pair("currency-1", 2, { collision: 0.06, interference: 0.6, giveWay: "other", gw: 0.68, rule: "R4-first-declared-stands-on", shared: ["src/products.js"] })],
      });
      h.range("json-1", "currency-1", 2, false, "clear");
    },
  ],
  [
    3.0,
    (h) => {
      h.declare("dark-1");
    },
  ],
  [
    3.1,
    (h) => {
      h.check("dark-1", "declare", {
        verdict: "clear",
        latency: 42,
        confidence: 0.9,
        pairs: [pair("currency-1", 2, { collision: 0.09, interference: 0.8, giveWay: "incoming", gw: 0.74, rule: "R4-first-declared-stands-on", shared: ["src/render.js"] })],
      });
      h.range("dark-1", "currency-1", 2, false, "clear");
    },
  ],
  [4.2, (h) => h.declare("dark-2")],
  [
    4.3,
    (h) => {
      h.check("dark-2", "declare", {
        verdict: "clear",
        latency: 36,
        confidence: 0.94,
        pairs: [pair("currency-1", 3, { collision: 0.03, interference: 0.3, giveWay: "incoming", gw: 0.7, rule: "R4-first-declared-stands-on" })],
      });
      h.range("dark-2", "currency-1", 3, false, "clear");
    },
  ],
  [5.2, (h) => h.write("currency-1", "src/render.js", "Pass the currency from renderPage to renderBookCard. Update 2 call sites.")],
  [
    5.8,
    (h) => {
      h.check("currency-1", "write", {
        verdict: "clear",
        latency: 39,
        confidence: 0.86,
        pairs: [
          pair("dark-1", 2, { collision: 0.12, interference: 1.0, giveWay: "other", gw: 0.66, rule: "R4-first-declared-stands-on", shared: ["src/render.js"], sharedSymbols: [] }),
          pair("json-1", 2, { collision: 0.05, interference: 0.5, giveWay: "incoming", gw: 0.7, rule: "R4-first-declared-stands-on", shared: ["src/products.js"] }),
        ],
      });
    },
  ],
  [6.5, (h) => h.declare("search-1")],
  [
    6.55,
    (h) => {
      h.range("search-1", "dark-1", 0, false);
      h.range("search-1", "currency-1", 1, false);
      h.range("search-1", "json-1", 2, false);
    },
  ],
  [
    6.65,
    (h) => {
      const header = h.mainLine("src/render.js", "renderHeader");
      h.check("search-1", "declare", {
        verdict: "correct",
        latency: 44,
        confidence: 0.81,
        pairs: [
          pair("currency-1", 1, {
            collision: 0.58,
            interference: 3.1,
            giveWay: "incoming",
            gw: 0.88,
            rule: "R3-producer-stands-on",
            shared: ["src/products.js", "src/render.js"],
            hits: [{ changedBy: "other", symbol: "src/products.js#formatPrice", usedAt: ["src/render.js#renderBookCard"] }],
          }),
          pair("dark-1", 0, {
            collision: 0.74,
            interference: 2.3,
            giveWay: "incoming",
            gw: 0.79,
            rule: "R4-first-declared-stands-on",
            shared: ["src/render.js"],
            sharedSymbols: ["src/render.js#renderHeader"],
          }),
          pair("json-1", 2, { collision: 0.07, interference: 0.6, giveWay: "incoming", gw: 0.64, rule: "R2-waiting-stands-on", shared: ["src/index.js", "src/products.js"] }),
        ],
      });
      h.correct("search-1", "currency-1", {
        kind: "interface",
        rule: "R3-producer-stands-on",
        message:
          "Agent KESTREL-7 changes `formatPrice(cents)` to `formatPrice(cents, currency)` in `src/products.js`. Pass the currency when you render prices. Do not copy the old signature. Continue your work.",
        constraints: { useSignatures: [{ symbol: "src/products.js#formatPrice", signature: 'formatPrice(cents, currency = "GBP")' }] },
      });
      h.correct("search-1", "dark-1", {
        kind: "region",
        rule: "R4-first-declared-stands-on",
        message: `Agent HERON-3 changes the header in \`src/render.js\`, lines ${header[0]}–${header[1]}. Do not edit these lines. Put the search form below the header, in a new function. Continue your work.`,
        constraints: { avoidRegions: [{ path: "src/render.js", lines: header }] },
      });
      h.range("search-1", "dark-1", 0, false, "correct");
      h.range("search-1", "currency-1", 1, false, "correct");
    },
  ],
  [7.8, (h) => h.write("json-1", "src/index.js", "Add GET /api/books/:id. Return 404 JSON for an unknown id.")],
  [8.2, (h) => h.check("json-1", "write", { verdict: "clear", latency: 29, confidence: 0.95, pairs: [pair("search-1", 2, { collision: 0.08, interference: 0.7, giveWay: "other", gw: 0.81, rule: "R2-waiting-stands-on", shared: ["src/index.js"] })] })],
  [
    8.6,
    (h) => {
      h.deliver("search-1");
      h.logLine("search-1", "Read 2 corrections. Move the search form below the header. Pass the currency to prices.", ["src/render.js"], "log");
    },
  ],
  [
    9.3,
    (h) => {
      h.ack("search-1", "Use formatPrice(p.cents, currency).", 0);
      h.ack("search-1", "Put the form in renderSearch(), below the header.", 1);
      h.range("search-1", "dark-1", 2, false, "correct");
    },
  ],
  [9.9, (h) => h.declare("picks-1")],
  [
    10.0,
    (h) => {
      h.check("picks-1", "declare", {
        verdict: "correct",
        latency: 47,
        confidence: 0.84,
        pairs: [
          pair("currency-1", 1, {
            collision: 0.63,
            interference: 3.0,
            giveWay: "incoming",
            gw: 0.9,
            rule: "R3-producer-stands-on",
            shared: ["src/render.js", "src/products.js"],
            sharedSymbols: ["src/render.js#renderBookCard"],
            hits: [{ changedBy: "other", symbol: "src/render.js#renderBookCard", usedAt: ["src/render.js#renderPage"] }],
          }),
          pair("dark-1", 3, { collision: 0.04, interference: 0.4, giveWay: "incoming", gw: 0.6, rule: "R4-first-declared-stands-on" }),
        ],
      });
      h.correct("picks-1", "currency-1", {
        kind: "interface",
        rule: "R3-producer-stands-on",
        message:
          "Agent KESTREL-7 changes `renderBookCard(book)` to `renderBookCard(book, currency)` in `src/render.js`. Keep the currency parameter when you add the badge. Continue your work.",
        constraints: { useSignatures: [{ symbol: "src/render.js#renderBookCard", signature: 'renderBookCard(book, currency = "GBP")' }] },
      });
      h.range("picks-1", "currency-1", 1, true, "correct");
      h.range("picks-1", "dark-1", 3, false, "clear");
    },
  ],
  [11.0, (h) => h.declare("search-2")],
  [
    11.1,
    (h) => {
      h.check("search-2", "declare", {
        verdict: "correct",
        latency: 41,
        confidence: 0.87,
        pairs: [
          pair("currency-1", 1, {
            collision: 0.52,
            interference: 2.9,
            giveWay: "incoming",
            gw: 0.86,
            rule: "R3-producer-stands-on",
            shared: ["src/products.js", "src/render.js"],
            hits: [{ changedBy: "other", symbol: "src/products.js#formatPrice", usedAt: ["src/render.js#renderSearchPage"] }],
          }),
          pair("dark-1", 2, { collision: 0.1, interference: 0.9, giveWay: "incoming", gw: 0.71, rule: "R4-first-declared-stands-on", shared: ["src/render.js"] }),
          pair("json-1", 2, { collision: 0.06, interference: 0.6, giveWay: "incoming", gw: 0.62, rule: "R2-waiting-stands-on", shared: ["src/index.js"] }),
        ],
      });
      h.correct("search-2", "currency-1", {
        kind: "interface",
        rule: "R3-producer-stands-on",
        message:
          "Agent KESTREL-7 changes `formatPrice(cents)` to `formatPrice(cents, currency)` in `src/products.js`. Call `formatPrice(b.cents, currency)` in your result list. Continue your work.",
        constraints: { useSignatures: [{ symbol: "src/products.js#formatPrice", signature: 'formatPrice(cents, currency = "GBP")' }] },
      });
      h.range("search-2", "currency-1", 1, false, "correct");
      h.range("search-2", "dark-1", 2, false, "clear");
    },
  ],
  [12.0, (h) => h.submit("json-1", "Add GET /api/books/:id with a 404 JSON error.")],
  [12.8, (h) => h.runChecks("json-1")],
  [
    13.7,
    (h) => {
      h.landKey("json-1");
      h.correct("currency-1", "json-1", {
        kind: "upstream",
        rule: "R1-landed-has-way",
        message: `Main moved to ${h.sha()}. SKUA-1 landed \`findBook(id)\` in \`src/products.js\` and a route in \`src/index.js\`. Keep both. Continue your work.`,
        constraints: { notes: ["Keep findBook(id) and the /api/books/:id route."] },
      });
    },
  ],
  [14.3, (h) => h.deliver("picks-1")],
  [14.9, (h) => h.ack("picks-1", "Keep renderBookCard(book, currency).")],
  [15.2, (h) => h.write("dark-1", "src/styles.js", "Move the colors to variables. Add a dark scheme.")],
  [15.7, (h) => h.check("dark-1", "write", { verdict: "clear", latency: 35, confidence: 0.9, pairs: [pair("picks-1", 3, { collision: 0.05, interference: 0.5, giveWay: "other", gw: 0.62, rule: "R4-first-declared-stands-on" })] })],
  [16.0, (h) => h.ack("currency-1", "Keep findBook. Merge onto main.")],
  [16.6, (h) => h.write("search-1", "src/products.js", "Add searchBooks(query): title or author, ignore case.")],
  [17.0, (h) => h.check("search-1", "write", { verdict: "clear", latency: 32, confidence: 0.93, pairs: [] })],
  [17.4, (h) => h.write("dark-2", "src/styles.js", "Add a prefers-color-scheme block. No toggle.")],
  [17.8, (h) => h.check("dark-2", "write", { verdict: "clear", latency: 38, confidence: 0.91, pairs: [] })],
  [18.2, (h) => h.deliver("search-2")],
  [18.8, (h) => h.ack("search-2", "Call formatPrice(b.cents, currency) in the result list.")],
  [19.1, (h) => h.write("picks-1", "src/products.js", "Mark three books as staff picks.")],
  [
    19.8,
    (h) => {
      h.logLine("picks-1", "Add a .badge style to src/styles.js.", ["src/styles.js"], "log");
      h.range("picks-1", "dark-1", 2, true);
    },
  ],
  [
    20.6,
    (h) => {
      const vars = h.regionOf("dark-1", "src/styles.js");
      h.check("picks-1", "log", {
        verdict: "correct",
        source: "clef",
        latency: 412,
        confidence: 0.83,
        escalatedFrom: { source: "clef-flash", confidence: 0.49, latencyMs: 38 },
        pairs: [
          pair("dark-1", 2, {
            previous: 3,
            closing: true,
            collision: 0.41,
            interference: 2.1,
            giveWay: "incoming",
            gw: 0.72,
            rule: "R6-smaller-gives-way",
            shared: ["src/styles.js"],
            sharedSymbols: ["src/styles.js#css"],
          }),
        ],
      });
      h.correct("picks-1", "dark-1", {
        kind: "region",
        rule: "R6-smaller-gives-way",
        message: `Agent HERON-3 changes the colors in \`src/styles.js\` to variables, lines ${vars[0]}–${vars[1]}. Do not edit these lines. Add \`.badge\` after \`.prose\` and use \`var(--link, #24577a)\`. Continue your work.`,
        constraints: { avoidRegions: [{ path: "src/styles.js", lines: vars }], notes: ["Use var(--link, #24577a) for the badge."] },
      });
      h.range("picks-1", "dark-1", 2, true, "correct");
    },
  ],
  [21.2, (h) => h.write("dark-1", "src/render.js", "Add the theme toggle to the header. Remember the choice.")],
  [21.7, (h) => h.check("dark-1", "write", { verdict: "clear", latency: 40, confidence: 0.88, pairs: [pair("search-1", 2, { collision: 0.11, interference: 0.9, giveWay: "other", gw: 0.8, rule: "R4-first-declared-stands-on", shared: ["src/render.js"] })] })],
  [22.1, (h) => h.deliver("picks-1")],
  [22.7, (h) => h.ack("picks-1", "Put .badge after .prose with var(--link, #24577a).")],
  [23.0, (h) => h.write("search-1", "src/render.js", "Add renderSearch() below the header. Show a message when nothing matches.")],
  [23.4, (h) => h.check("search-1", "write", { verdict: "clear", latency: 37, confidence: 0.9, pairs: [pair("dark-1", 2, { collision: 0.1, interference: 0.8, giveWay: "incoming", gw: 0.8, rule: "R4-first-declared-stands-on", shared: ["src/render.js"] })] })],
  [24.0, (h) => h.write("search-2", "src/products.js", "Add searchBooks(query): every word, accents folded.")],
  [24.6, (h) => h.write("currency-1", "src/index.js", "Read ?currency= and Accept-Language. Default to GBP.")],
  [25.0, (h) => h.check("currency-1", "write", { verdict: "clear", latency: 34, confidence: 0.92, pairs: [] })],
  [25.6, (h) => h.write("picks-1", "src/render.js", "Show the badge and the staff note on the card.")],
  [26.6, (h) => h.write("search-1", "src/index.js", "Route /?q= to searchBooks.")],
  [27.2, (h) => h.submit("currency-1", "Prices follow ?currency= and Accept-Language. Cents stay integers.")],
  [28.0, (h) => h.runChecks("currency-1")],
  [
    28.9,
    (h) => {
      h.landKey("currency-1");
      h.correct("picks-1", "currency-1", {
        kind: "upstream",
        rule: "R1-landed-has-way",
        message: `Main moved to ${h.sha()}. KESTREL-7 landed \`renderBookCard(book, currency)\` in \`src/render.js\`. Your fork has the old signature. Rebase your card change on main. Continue your work.`,
        constraints: { useSignatures: [{ symbol: "src/render.js#renderBookCard", signature: 'renderBookCard(book, currency = "GBP")' }] },
      });
      h.range("picks-1", "dark-1", 2, false, "correct");
    },
  ],
  [29.4, (h) => h.write("picks-1", "src/styles.js", "Add .badge after .prose.")],
  [30.0, (h) => h.write("search-2", "src/render.js", "Add a /search page with a result list.")],
  [30.5, (h) => h.check("search-2", "write", { verdict: "clear", latency: 42, confidence: 0.89, pairs: [pair("dark-1", 2, { collision: 0.09, interference: 0.8, giveWay: "incoming", gw: 0.76, rule: "R4-first-declared-stands-on", shared: ["src/render.js"] })] })],
  [31.0, (h) => h.deliver("picks-1")],
  [31.6, (h) => h.submit("picks-1", "Three staff picks with a badge and a note.")],
  [32.4, (h) => h.runChecks("picks-1")],
  [33.2, (h) => h.landKey("picks-1")],
  [34.0, (h) => h.rederiveTo("picks-1", "picks-2", "TERN-5's fork has the old renderBookCard signature.")],
  [
    34.5,
    (h) => {
      h.check("picks-2", "declare", {
        verdict: "clear",
        latency: 39,
        confidence: 0.9,
        pairs: [pair("dark-1", 2, { collision: 0.12, interference: 1.0, giveWay: "incoming", gw: 0.75, rule: "R6-smaller-gives-way", shared: ["src/styles.js"] })],
      });
      h.range("picks-2", "dark-1", 2, false, "clear");
    },
  ],
  [35.0, (h) => h.write("search-2", "src/index.js", "Route /search to renderSearchPage.")],
  [35.6, (h) => h.submit("dark-2", "Follow the system color scheme.")],
  [
    36.4,
    (h) => {
      h.runChecks("dark-2", ["renders a theme control in the header", "gives the theme control an accessible name"], {
        "renders a theme control in the header": "expected value to match /theme/",
        "gives the theme control an accessible name": "expected value to match /(aria-pressed|<label[^>]*>[^<]*Theme)/",
      });
    },
  ],
  [36.9, (h) => h.submit("search-1", "Search form below the header; results on the shelf.")],
  [37.7, (h) => h.runChecks("search-1")],
  [38.0, (h) => h.write("picks-2", "src/products.js", "Mark three books as staff picks.")],
  [38.6, (h) => h.submit("dark-1", "Dark scheme with a header toggle that remembers the choice.")],
  [39.4, (h) => h.runChecks("dark-1")],
  [39.9, (h) => h.write("picks-2", "src/render.js", "Show the badge and the note. Keep renderBookCard(book, currency).")],
  [40.6, (h) => h.write("dark-2", "src/render.js", "Add a theme select to the header: system, light, dark.")],
  [41.0, (h) => h.check("dark-2", "write", { verdict: "clear", latency: 36, confidence: 0.9, pairs: [] })],
  [41.6, (h) => h.submit("search-2", "A /search page with word matching.")],
  [
    42.4,
    (h) => {
      h.runChecks("search-2");
      h.settleIntent("in-search");
    },
  ],
  [43.0, (h) => h.write("picks-2", "src/styles.js", "Add .badge with var(--link, #24577a).")],
  [44.0, (h) => h.submit("picks-2", "Three staff picks on the new main.")],
  [44.8, (h) => h.runChecks("picks-2")],
  [
    45.7,
    (h) => {
      h.landKey("picks-2", { method: "rederive" });
      const msg = (sha: string) =>
        `Main moved to ${sha}. CORMORANT-8 landed \`.badge\` and \`.staff-note\` in \`src/styles.js\` after \`.prose\`. Keep these rules when you change the colors. Continue your work.`;
      h.correct("dark-1", "picks-2", { kind: "upstream", rule: "R1-landed-has-way", message: msg(h.sha()), constraints: { notes: ["Keep .badge and .staff-note in src/styles.js."] } });
      h.correct("dark-2", "picks-2", { kind: "upstream", rule: "R1-landed-has-way", message: msg(h.sha()), constraints: { notes: ["Keep .badge and .staff-note in src/styles.js."] } });
    },
  ],
  [46.4, (h) => h.submit("dark-2", "Theme select in the header. Follows the system by default.")],
  [
    47.2,
    (h) => {
      h.runChecks("dark-2");
      h.settleIntent("in-dark");
    },
  ],
  [47.8, (h) => h.ack("dark-1", "Keep .badge and .staff-note.")],
  [48.4, (h) => h.ack("dark-2", "Keep .badge and .staff-note.")],
  [54.0, (h) => h.logLine("dark-1", "Ready. Wait for a pick.", undefined, "log")],
  [58.0, (h) => h.logLine("search-1", "Ready. Wait for a pick.", undefined, "log")],
];
