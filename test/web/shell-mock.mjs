// Mock gitring API for browser tests of the web app shell (no Worker, no network).
//   npm run build && node test/web/shell-mock.mjs [port]
// It serves dist/client (with the single-page fallback), the API contract the web app uses, live events
// over /ws/:p, and a request log at GET /__mock/log (POST /__mock/reset clears it and the data).
// Sign-in: /auth/:provider/start sets a session cookie and redirects back (no provider). ?fail=1 on a
// task title ("fail") makes the create request fail, to test error recovery.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/client");
const port = Number(process.argv[2] ?? process.env.PORT ?? 8799);
const NOW = Date.now();
const min = 60_000;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json" };

/* ───────────── data ───────────── */

let data;
let log = [];
function reset() {
  log = [];
  const files = [
    "README.md",
    "package.json",
    "src/index.js",
    "src/products.js",
    "src/cart.js",
    "src/search.js",
    "src/render/page.js",
    "src/render/header.js",
    "src/render/footer.js",
    "src/theme.css",
    "tests/products.test.js",
    "tests/cart.test.js",
    "harness/test.js",
  ].map((p) => ({ path: p, size: 400 + p.length * 37, lang: p.endsWith(".js") ? "javascript" : p.endsWith(".css") ? "css" : p.endsWith(".json") ? "json" : "markdown" }));
  const run = (passed, failed = 0, scope = "attempt") => ({
    id: `run-${passed}-${failed}-${scope}`,
    subject: "abc1234",
    scope,
    ok: failed === 0,
    passed,
    failed,
    cases: Array.from({ length: passed + failed }, (_, i) => ({ file: "tests/search.test.js", name: `case ${i + 1}`, ok: i < passed, ms: 3 })),
    ms: 210,
    at: NOW - 5 * min,
  });
  const fp = (files) => ({ files, symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] }, computedAt: NOW - 4 * min });
  const course = (plan, files) => ({ plan, files, symbols: [], approach: plan[0], declaredAt: NOW - 30 * min });
  const actor = { kind: "human", id: "u_1", name: "Mirza" };
  const intent = (id, title, status, extra = {}) => ({
    id,
    title,
    goal: `${title}. Show the result on the shop page.`,
    constraints: [],
    checks: [],
    priority: "normal",
    status,
    version: 1,
    amendments: [],
    createdBy: actor,
    createdAt: NOW - 90 * min,
    updatedAt: NOW - 10 * min,
    source: { kind: "ui" },
    ...extra,
  });
  const attempt = (id, intentId, agentId, status, extra = {}) => ({
    id,
    intentId,
    agentId,
    fork: { repo: `fork-${id}` },
    mode: "api",
    baseSha: "a1b2c3d4e5",
    baseTree: "t1",
    status,
    course: course(["Add a search field to the header", "Filter the items by title"], ["src/search.js", "src/render/header.js"]),
    footprint: fp({ "src/search.js": { status: "A", hunks: [], additions: 40, deletions: 0 }, "src/render/header.js": { status: "M", hunks: [[10, 18]], additions: 6, deletions: 2 } }),
    corrections: [],
    lineage: { generation: 1 },
    stats: { filesChanged: 2, additions: 46, deletions: 2, steps: 9 },
    createdAt: NOW - 40 * min,
    updatedAt: NOW - 3 * min,
    ...extra,
  });
  const agents = [
    { id: "g1", callsign: "PETREL-2", kind: "builtin", model: "@cf/moonshotai/kimi-k2.7-code", color: 0, status: "underway", lastSeen: NOW - 1 * min },
    { id: "g2", callsign: "KESTREL-7", kind: "builtin", model: "@cf/openai/gpt-oss-120b", color: 3, status: "underway", lastSeen: NOW - 2 * min },
    { id: "g3", callsign: "WREN-4", kind: "mcp", client: "claude-code", model: "claude-code", color: 6, status: "underway", lastSeen: NOW - 30_000 },
  ];
  const state = {
    project: {
      id: "shop",
      name: "Catalog",
      repo: { backend: "artifacts", namespace: "gitring", name: "shop", defaultBranch: "main" },
      mainSha: "a1b2c3d4e5f6",
      mainTree: "t1",
      createdAt: NOW - 3 * 24 * 60 * min,
      settings: {
        autoLand: true,
        fanout: 2,
        decisionModel: "clef-flash",
        agentModels: ["@cf/moonshotai/kimi-k2.7-code", "@cf/openai/gpt-oss-120b"],
        intentsInRepo: true,
        allowUntested: false,
        thresholds: { collision: 0.5, interference: 1.7, duplicate: 0.7, minConfidence: 0.55 },
        webhooks: [],
        github: { repo: "mirza/shop", mode: "pull-request", branch: "gitring" },
        redo: "agent-first",
        redoWaitMinutes: 15,
      },
      source: { kind: "github", repo: "mirza/shop", branch: "main" },
      github: { state: "ok", message: "GitHub has main.", repo: "mirza/shop", mode: "pull-request", branch: "gitring", prUrl: "https://github.com/mirza/shop/pull/7", prNumber: 7 },
    },
    intents: [
      intent("i_search", "Add a search to the shop", "judging"),
      intent("i_dark", "Add a dark mode", "underway"),
      intent("i_stock", "Show the stock count on each item", "open"),
      intent("i_footer", "Fix the footer links", "landed", { landedSha: "f00d1234" }),
    ],
    attempts: [
      attempt("at_s1", "i_search", "g1", "ready", { checks: run(8), composedChecks: run(8, 0, "composed") }),
      attempt("at_s2", "i_search", "g2", "ready", { checks: run(7, 1), stats: { filesChanged: 3, additions: 80, deletions: 12, steps: 11 } }),
      attempt("at_d1", "i_dark", "g3", "underway", {
        course: course(["Add a theme toggle", "Store the choice"], ["src/theme.css", "src/render/header.js"]),
        footprint: fp({ "src/theme.css": { status: "M", hunks: [[1, 9]], additions: 22, deletions: 3 } }),
        stats: { filesChanged: 1, additions: 22, deletions: 3, steps: 4 },
      }),
      attempt("at_f1", "i_footer", "g2", "landed", { landedAt: NOW - 60 * min }),
    ],
    agents,
    corrections: [
      {
        id: "c1",
        attemptId: "at_d1",
        standOnAttemptId: "at_s1",
        kind: "region",
        rule: "R4-first-declared-stands-on",
        message: "Keep out of src/render/header.js lines 10–18. PETREL-2 changes them.",
        constraints: { avoidRegions: [{ path: "src/render/header.js", lines: [10, 18] }] },
        checkId: "k1",
        status: "delivered",
        createdAt: NOW - 20 * min,
      },
    ],
    checks: [
      {
        id: "k1",
        attemptId: "at_d1",
        trigger: "declare",
        verdict: "correct",
        assessments: [{ otherAttemptId: "at_s1", collision: 0.7, interference: 2, duplicate: 0.05, giveWay: "incoming", giveWayConfidence: 0.8, rule: "R4-first-declared-stands-on" }],
        facts: [
          {
            otherAttemptId: "at_s1",
            otherAgentId: "g1",
            otherIntentId: "i_search",
            otherState: "active",
            sharedFiles: ["src/render/header.js"],
            sharedSymbols: [],
            interfaceHits: [],
            hunkOverlaps: [{ path: "src/render/header.js", incoming: [12, 16], other: [10, 18] }],
            range: 0,
            closing: true,
            intentSimilarity: 0.1,
          },
        ],
        source: "rules",
        confidence: 0.9,
        latencyMs: 41,
        at: NOW - 20 * min,
      },
    ],
    landings: [
      {
        id: "l1",
        attemptId: "at_f1",
        intentId: "i_footer",
        agentId: "g2",
        method: "fast-forward",
        mainBefore: "9999aaaa",
        mainAfter: "f00d1234",
        checks: run(5),
        correctionsApplied: 0,
        at: NOW - 60 * min,
        message: "Fix the footer links",
      },
    ],
    decisions: [],
    logs: [
      { id: "lg1", at: NOW - 30 * min, kind: "declare", attemptId: "at_s1", agentId: "g1", intentId: "i_search", message: "PETREL-2 sends its plan.", files: ["src/search.js"] },
      { id: "lg2", at: NOW - 20 * min, kind: "correction", attemptId: "at_d1", agentId: "g3", intentId: "i_dark", message: "WREN-4 gets a change request." },
      { id: "lg3", at: NOW - 5 * min, kind: "submit", attemptId: "at_s1", agentId: "g1", intentId: "i_search", message: "PETREL-2 submits its work." },
    ],
    radar: [{ a: "at_s1", b: "at_d1", range: 0, closing: true, verdict: "correct", updatedAt: NOW - 20 * min }],
    files,
    imports: [
      ["src/index.js", "src/render/page.js"],
      ["src/render/page.js", "src/render/header.js"],
      ["src/render/page.js", "src/render/footer.js"],
      ["src/index.js", "src/products.js"],
      ["src/search.js", "src/products.js"],
    ],
    stats: {
      courseChecks: 128,
      clear: 117,
      corrections: 9,
      correctionsAcknowledged: 8,
      escalations: 0,
      landings: 14,
      landedByMethod: { "fast-forward": 9, merge: 4, rederive: 1 },
      rederives: 1,
      replots: 3,
      medianCheckLatencyMs: 46,
    },
  };
  data = {
    signedIn: new Set(),
    github: { connected: true, login: "mirza" },
    keys: [
      { id: "k_1", name: "my laptop", prefix: "gk_ab12", createdAt: NOW - 9 * 24 * 60 * min, lastUsed: NOW - 2 * 60 * min },
      { id: "k_2", name: "CI", prefix: "gk_cd34", createdAt: NOW - 30 * 24 * 60 * min },
    ],
    grants: [
      { id: "gr_1", clientId: "claude", clientName: "Claude", clientUri: "https://claude.ai", scope: "projects", createdAt: NOW - 3 * 24 * 60 * min, lastUsedAt: NOW - 4 * min },
      { id: "gr_2", clientId: "cursor", clientName: "Cursor", clientUri: "https://cursor.com", scope: "projects", createdAt: NOW - 24 * 60 * min },
    ],
    projects: [
      { id: "shop", name: "Catalog", visibility: "private", source: { kind: "github", repo: "mirza/shop" }, createdAt: NOW - 3 * 24 * 60 * min, role: "owner" },
      { id: "docs", name: "Docs site", visibility: "public", source: { kind: "upload", files: 40 }, createdAt: NOW - 9 * 24 * 60 * min, role: "member" },
      { id: "infra", name: "Infra scripts", visibility: "private", source: { kind: "push" }, createdAt: NOW - 20 * 24 * 60 * min, role: "owner" },
    ],
    state,
    seq: 1,
  };
}
reset();

const user = { id: "u_1", name: "Mirza Example", email: "mirza@example.com", identities: [{ provider: "github", login: "mirza" }], admin: true };

/* ───────────── server ───────────── */

const sockets = new Set();
function broadcast(ev) {
  const msg = JSON.stringify(ev);
  for (const ws of sockets) if (ws.readyState === 1) ws.send(msg);
}

/** Files of main for the code route. */
const SHOP_FILES = new Map([
  ["README.md", "# Catalog\n\nA small app that lists products.\n"],
  ["src/index.js", "export const items = [];\n"],
  ["src/render/header.js", "export function header() {\n  return \"<h1>Catalog</h1>\";\n}\n"],
  ["src/theme.css", ":root { --ink: #111; }\n"],
]);

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function session(req) {
  const m = /(?:^|;\s*)mock_session=([^;]+)/.exec(req.headers.cookie ?? "");
  return m && data.signedIn.has(m[1]) ? m[1] : null;
}

function serveStatic(req, res, pathname) {
  let file = path.join(root, decodeURIComponent(pathname));
  if (!file.startsWith(root)) file = path.join(root, "index.html");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
  const ext = path.extname(file);
  res.writeHead(200, {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const method = req.method ?? "GET";
  if (p.startsWith("/api/") || p.startsWith("/auth/")) log.push({ method, path: p + url.search, at: Date.now() });
  const sid = session(req);
  const st = data.state;

  // test controls
  if (p === "/__mock/log") return json(res, 200, log);
  if (p === "/__mock/reset" && method === "POST") {
    reset();
    return json(res, 200, { ok: true });
  }

  // sign-in (no provider: the cookie is set at once)
  const auth = /^\/auth\/(github|google)\/start$/.exec(p);
  if (auth) {
    const id = `s${data.seq++}`;
    data.signedIn.add(id);
    res.writeHead(302, { location: url.searchParams.get("return") || "/", "set-cookie": `mock_session=${id}; Path=/; HttpOnly; SameSite=Lax` });
    return res.end();
  }
  if (p === "/auth/logout" && method === "POST") {
    if (sid) data.signedIn.delete(sid);
    res.writeHead(204, { "set-cookie": "mock_session=; Path=/; Max-Age=0" });
    return res.end();
  }

  if (p === "/api/me") {
    return json(res, 200, {
      user: sid ? user : null,
      providers: { github: true, google: true },
      setupNeeded: false,
      github: sid ? data.github : undefined,
      githubInstallUrl: "https://github.com/apps/git-ring/installations/new",
    });
  }
  if (p === "/api/me/github" && method === "DELETE") {
    if (!sid) return json(res, 401, { error: "Sign in first." });
    data.github = { connected: false, reason: "You disconnected GitHub. Connect it again to import repositories." };
    return json(res, 204);
  }
  if (p === "/api/projects" && method === "GET") return json(res, 200, sid ? data.projects : data.projects.filter((x) => x.visibility === "public").map((x) => ({ ...x, role: "viewer" })));

  // keys and grants (signed in only)
  if (p.startsWith("/api/keys") || p.startsWith("/api/oauth/grants")) {
    if (!sid) return json(res, 401, { error: "Sign in first." });
    if (p === "/api/keys" && method === "GET") return json(res, 200, data.keys);
    if (p === "/api/keys" && method === "POST") {
      const body = await readBody(req);
      const info = { id: `k_${data.seq++}`, name: String(body.name || "key"), prefix: `gk_${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() };
      data.keys.push(info);
      return json(res, 200, { key: `${info.prefix}${"x".repeat(28)}`, info });
    }
    const k = /^\/api\/keys\/([^/]+)$/.exec(p);
    if (k && method === "DELETE") {
      data.keys = data.keys.filter((x) => x.id !== k[1]);
      return json(res, 204);
    }
    if (p === "/api/oauth/grants" && method === "GET") return json(res, 200, data.grants);
    const g = /^\/api\/oauth\/grants\/([^/]+)$/.exec(p);
    if (g && method === "DELETE") {
      if (g[1] === "gr_fail") return json(res, 500, { error: "The grant store did not answer." });
      data.grants = data.grants.filter((x) => x.id !== g[1]);
      return json(res, 204);
    }
  }

  const proj = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(p);
  if (proj) {
    const rest = proj[2] ?? "";
    if (proj[1] !== "shop") return json(res, 404, { error: "This project does not exist, or you cannot see it." });
    const access = sid ? "owner" : "viewer";
    if (rest === "/state") return json(res, 200, { ...st, access });
    if (method !== "GET" && !sid) return json(res, 401, { error: "Sign in first." });
    if (rest === "/connect") {
      const origin = `http://${req.headers.host}`;
      return json(res, 200, { projectId: "shop", mcpUrl: `${origin}/mcp`, hookUrl: `${origin}/hooks/claude/shop`, intentsUrl: `${origin}/hooks/intents`, artifacts: { namespace: "gitring", repo: "shop", backend: "artifacts" }, inputs: { slack: false, githubIssues: true }, githubApp: { slug: "git-ring", installUrl: "https://github.com/apps/git-ring/installations/new" } });
    }
    if (rest === "/intents" && method === "POST") {
      const body = await readBody(req);
      await new Promise((r) => setTimeout(r, 250));
      if (/fail/i.test(body.title ?? "")) return json(res, 503, { error: "The project is busy. Try again in a minute." });
      const it = { ...st.intents[2], id: `i_${data.seq++}`, title: body.title, goal: body.goal ?? "", priority: body.priority ?? "normal", status: "open", createdAt: Date.now(), updatedAt: Date.now(), checks: (body.checks ?? []).map((c, i) => ({ id: `chk_${i}`, ...c })) };
      st.intents = [...st.intents, it];
      setTimeout(() => broadcast({ type: "intent", intent: it }), 150);
      return json(res, 200, it);
    }
    const launch = /^\/intents\/([^/]+)\/launch$/.exec(rest);
    if (launch && method === "POST") {
      const body = await readBody(req);
      const n = Math.max(1, Math.min(4, Number(body.fanout) || 1));
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = { ...st.attempts[2], id: `at_${data.seq++}`, intentId: launch[1], agentId: i % 2 ? "g2" : "g1", status: "declared", waitsForBudget: n > 2 ? Date.now() + 20 * min : undefined, createdAt: Date.now() };
        out.push(a);
      }
      st.attempts = [...st.attempts, ...out];
      for (const a of out) setTimeout(() => broadcast({ type: "attempt", attempt: a }), 100);
      return json(res, 200, { attempts: out });
    }
    if (rest === "/launch-all" && method === "POST") return json(res, 200, { launched: 1, queued: 0 });
    const amend = /^\/intents\/([^/]+)$/.exec(rest);
    if (amend && method === "PATCH") {
      const body = await readBody(req);
      const it = st.intents.find((x) => x.id === amend[1]);
      const next = { ...it, goal: body.goal ?? it.goal, constraints: [...it.constraints, ...(body.constraints ?? [])], version: it.version + 1, amendments: [...it.amendments, { version: it.version + 1, at: Date.now(), by: { kind: "human", id: "u_1", name: "Mirza" }, reason: body.reason, text: body.goal ?? "" }] };
      st.intents = st.intents.map((x) => (x.id === next.id ? next : x));
      broadcast({ type: "intent", intent: next });
      return json(res, 200, next);
    }
    const park = /^\/intents\/([^/]+)\/park$/.exec(rest);
    if (park && method === "POST") {
      const it = st.intents.find((x) => x.id === park[1]);
      const next = { ...it, status: "parked" };
      st.intents = st.intents.map((x) => (x.id === next.id ? next : x));
      broadcast({ type: "intent", intent: next });
      return json(res, 200, {});
    }
    const land = /^\/attempts\/([^/]+)\/land$/.exec(rest);
    if (land && method === "POST") {
      const body = await readBody(req);
      const a = st.attempts.find((x) => x.id === land[1]);
      const landing = { id: `l${data.seq++}`, attemptId: a.id, intentId: a.intentId, agentId: a.agentId, method: "merge", mainBefore: st.project.mainSha, mainAfter: "beef5678cafe", checks: a.checks, correctionsApplied: 0, at: Date.now(), message: body.rationale };
      st.landings = [...st.landings, landing];
      st.attempts = st.attempts.map((x) => (x.id === a.id ? { ...x, status: "landed" } : x.intentId === a.intentId && x.status === "ready" ? { ...x, status: "alternate" } : x));
      st.intents = st.intents.map((x) => (x.id === a.intentId ? { ...x, status: "landed", landedSha: "beef5678" } : x));
      broadcast({ type: "landing", landing });
      for (const x of st.attempts.filter((x) => x.intentId === a.intentId)) broadcast({ type: "attempt", attempt: x });
      broadcast({ type: "intent", intent: st.intents.find((x) => x.id === a.intentId) });
      return json(res, 200, { status: "landed", landing });
    }
    const redo = /^\/attempts\/([^/]+)\/rederive$/.exec(rest);
    if (redo && method === "POST") {
      const a = st.attempts.find((x) => x.id === redo[1]);
      const n = { ...a, id: `at_${data.seq++}`, status: "rederiving", lineage: { generation: 2, rederivedFrom: a.id }, createdAt: Date.now() };
      st.attempts = [...st.attempts, n];
      broadcast({ type: "attempt", attempt: n });
      return json(res, 200, { attempt: n });
    }
    const diff = /^\/attempts\/([^/]+)\/diff$/.exec(rest);
    if (diff) {
      return json(res, 200, {
        files: [
          { path: "src/search.js", status: "A", additions: 3, deletions: 0, diff: "@@ -0,0 +1,3 @@\n+export function search(q) {\n+  return items.filter((i) => i.title.includes(q));\n+}\n" },
          { path: "src/render/header.js", status: "M", additions: 1, deletions: 1, diff: "@@ -10,3 +10,3 @@\n const a = 1;\n-const b = 2;\n+const b = search(q);\n const c = 3;\n" },
        ],
      });
    }
    if (rest === "/settings") return json(res, 200, st.project.settings);
    if (rest === "/github") return json(res, 200, st.project.github);
    // The code view (its own checks live in code-e2e.mjs): a small tree of main, so the route renders.
    if (rest === "/tree") {
      return json(res, 200, {
        ref: url.searchParams.get("ref") ?? "main",
        sha: st.project.mainSha,
        files: [...SHOP_FILES.keys()].map((path) => ({ path, size: SHOP_FILES.get(path).length })),
      });
    }
    if (rest === "/file") {
      const text = SHOP_FILES.get(url.searchParams.get("path") ?? "");
      if (text === undefined) return json(res, 404, { error: "No such file." });
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return res.end(text);
    }
    console.log("mock 404", method, p + url.search);
    return json(res, 404, { error: "Not in the mock." });
  }
  if (p.startsWith("/api/")) {
    console.log("mock 404", method, p + url.search);
    return json(res, 404, { error: "Not in the mock." });
  }
  if (p.startsWith("/preview/")) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><title>Preview</title><body style="font:14px system-ui;padding:16px">Preview of ${p.split("/")[3] ?? "work copy"}</body>`);
  }
  if (p === "/privacy" || p === "/terms") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<h1>${p.slice(1)}</h1>`);
  }
  serveStatic(req, res, p === "/" ? "/index.html" : p);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/ws/")) return socket.destroy();
  log.push({ method: "WS", path: req.url, at: Date.now() });
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });
});

server.listen(port, "127.0.0.1", () => console.log(`mock gitring on http://127.0.0.1:${port}`));
