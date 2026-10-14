// Mock gitring Worker for browser checks of the code view, the history, the overview and the request
// layer (no Worker, no network).
//
//   npm run build && node test/web/code-mock.mjs [port]
//
// It serves dist/client with the single-page fallback, the API that these views use (tree and file with
// ETag and 304, work copy diffs, merge records), live events over /ws/:p, and test hooks:
//   GET  /__mock/log      every request: { method, path, status, ws? }
//   POST /__mock/reset    clear the log and the data (?data=keep keeps the data)
//   POST /__mock/emit     { events: [...] } → send to every socket
//   POST /__mock/drop     close every socket (the app must reconnect)
//   POST /__mock/bump     change the work copy at_s1 (a new version of its tree and files) and send the event
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createTwoFilesPatch } from "diff";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/client");
const port = Number(process.argv[2] ?? process.env.PORT ?? 8797);
const NOW = Date.now();
const min = 60_000;
const MAIN = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const OLD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const OLDER = "9999888877776666555544443333222211110000";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json" };

/* ───────────── files ───────────── */

const cart = Array.from({ length: 60 }, (_, i) => {
  if (i === 0) return "// The cart: items, totals and coupons.";
  if (i === 1) return 'import { price } from "./products.js";';
  if (i === 3) return "export function total(items) {";
  if (i === 4) return "  return items.reduce((sum, item) => sum + price(item) * item.count, 0);";
  if (i === 5) return "}";
  if (i === 9) return "/* Each line below is one rule of the cart.";
  if (i === 10) return "   Keep them in order. */";
  return `export const rule${i} = { id: ${i}, name: "rule ${i}", active: ${i % 2 === 0} }; // rule ${i}`;
}).join("\n") + "\n";

const main = new Map([
  ["README.md", "# Catalog\n\nA small app on Cloudflare Workers. Run `npm test`.\n\n```js\nimport { total } from './src/cart.js';\n```\n\n- Cart\n- **Coupons**\n"],
  ["package.json", '{\n  "name": "shop",\n  "version": "1.0.0",\n  "scripts": { "test": "node --test" },\n  "private": true\n}\n'],
  ["src/cart.js", cart],
  ["src/products.js", "export function price(item) {\n  return item.cents / 100;\n}\n"],
  ["src/index.js", 'import { render } from "./render/page.jsx";\n\nexport default {\n  async fetch(req) {\n    return new Response(render(), { headers: { "content-type": "text/html" } });\n  },\n};\n'],
  ["src/render/page.jsx", 'export function Page({ items }) {\n  return (\n    <main className="page">\n      <h1>Shop</h1>\n      {items.map((i) => <Item key={i.id} item={i} />)}\n    </main>\n  );\n}\n'],
  ["src/render/header.js", "export function header(title) {\n  const nav = ['home', 'cart'];\n  return `<header>${title}</header>`;\n}\n// one\n// two\n// three\n"],
  ["src/styles/theme.css", ":root {\n  --accent: #0a6;\n}\n.card:hover > a {\n  color: var(--accent);\n  margin: 0 4px;\n}\n/* end */\n"],
  ["src/server.ts", "interface Cart { items: Item[]; total: number }\ntype Item = { id: string; cents: number };\nexport const empty: Cart = { items: [], total: 0 };\n"],
  ["scripts/tool.py", '@cache\ndef total(items):\n    """Sum the prices."""\n    return sum(i.price for i in items)  # done\n'],
  ["cmd/main.go", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("shop")\n}\n'],
  ["public/index.html", '<!doctype html>\n<html>\n<head><style>body { margin: 0 }</style></head>\n<body class="x">Shop &amp; more<script>const a = 1;</script></body>\n</html>\n'],
  ["tests/cart.test.js", 'import { total } from "../src/cart.js";\nimport test from "node:test";\ntest("total", () => {});\n'],
  ["data/big.json", "[\n" + Array.from({ length: 20000 }, (_, i) => `  { "id": ${i}, "name": "item ${i}", "ok": ${i % 3 === 0} }${i < 19999 ? "," : ""}`).join("\n") + "\n]\n"],
  ["LICENSE", "MIT License\n"],
]);
for (let d = 0; d < 12; d++) for (let i = 0; i < 50; i++) main.set(`lib/group${d}/mod${i}.js`, `export const value${i} = ${i * d};\n`);
const binary = new Set(["public/logo.png"]);

const langOf = (p) => {
  const ext = p.split(".").pop().toLowerCase();
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "js";
  if (["ts", "tsx"].includes(ext)) return "ts";
  if (ext === "md") return "md";
  if (ext === "json") return "json";
  return ext || "text";
};
const nodes = (m, extra = []) => [...[...m.keys()], ...extra].sort().map((p) => ({ path: p, size: m.get(p)?.length ?? 0, lang: langOf(p) }));

/* work copies */
let s1Version = 1;
function s1Files() {
  const m = new Map(main);
  const lines = cart.split("\n");
  lines.splice(10, 0, "export function subtotal(items) {", "  return total(items) * 0.9;", "}");
  lines[12 + 3] = `export const rule12 = { id: 12, name: "rule 12 (changed v${s1Version})", active: true };`;
  m.set("src/cart.js", lines.join("\n"));
  m.set("src/render/header.js", "export function header(title, user) {\n  const nav = ['home', 'cart', 'account'];\n  return `<header>${title} · ${user}</header>`;\n}\n// one\n// two\n// three\n");
  if (s1Version > 1) m.set("src/total.test.js", `// added in version ${s1Version}\n`);
  return m;
}
function s2Files() {
  // KESTREL-7 works on an older main.
  const m = oldFiles();
  const lines = cart.split("\n");
  lines[41] = "export const coupon = (code) => code === 'SALT' ? 0.8 : 1;";
  m.set("src/cart.js", lines.join("\n"));
  m.set("src/coupon.js", "export const CODES = ['SALT'];\n");
  m.delete("LICENSE");
  return m;
}
const oldFiles = () => {
  const m = new Map(main);
  m.set("src/cart.js", cart.replace("rule 20", "old rule 20"));
  m.delete("cmd/main.go");
  return m;
};

function diffOf(a, b) {
  const files = [];
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(p);
    const y = b.get(p);
    if (x === y) continue;
    const patch = createTwoFilesPatch(`a/${p}`, `b/${p}`, x ?? "", y ?? "", "", "", { context: 3 });
    const all = patch.split("\n");
    const lines = all.slice(Math.max(0, all.findIndex((l) => l.startsWith("@@"))));
    const additions = lines.filter((l) => l.startsWith("+")).length;
    const deletions = lines.filter((l) => l.startsWith("-")).length;
    files.push({ path: p, status: x === undefined ? "A" : y === undefined ? "D" : "M", additions, deletions, diff: `--- a/${p}\n+++ b/${p}\n${lines.join("\n")}` });
  }
  return { files: files.sort((m, n) => m.path.localeCompare(n.path)) };
}

/* ───────────── state ───────────── */

const run = (passed, failed = 0, scope = "attempt") => ({ id: `run-${passed}-${failed}-${scope}`, subject: "s", scope, ok: failed === 0, passed, failed, cases: [], ms: 210, at: NOW - 5 * min });
const fp = (files) => ({ files, symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] }, computedAt: NOW - 4 * min });
const course = (plan, files) => ({ plan, files, symbols: [], approach: plan[0], declaredAt: NOW - 30 * min });
const actor = { kind: "human", id: "u_1", name: "Robin" };
const intent = (id, title, status, extra = {}) => ({ id, title, goal: `${title}.`, constraints: [], checks: [], priority: "normal", status, version: 1, amendments: [], createdBy: actor, createdAt: NOW - 90 * min, updatedAt: NOW - 10 * min, source: { kind: "ui" }, ...extra });
const attempt = (id, intentId, agentId, status, extra = {}) => ({
  id,
  intentId,
  agentId,
  fork: { repo: `fork-${id}` },
  mode: "api",
  baseSha: MAIN,
  baseTree: "t1",
  status,
  course: course(["Add a total to the cart", "Show it in the header"], ["src/cart.js", "src/render/header.js", "src/products.js"]),
  footprint: fp({ "src/cart.js": { status: "M", hunks: [[10, 18]], additions: 4, deletions: 1 }, "src/render/header.js": { status: "M", hunks: [[1, 3]], additions: 3, deletions: 3 } }),
  corrections: [],
  lineage: { generation: 1 },
  stats: { filesChanged: 2, additions: 7, deletions: 4, steps: 9 },
  createdAt: NOW - 40 * min,
  updatedAt: NOW - 3 * min,
  ...extra,
});

function makeState() {
  return {
    project: {
      id: "shop",
      name: "Catalog",
      repo: { backend: "artifacts", namespace: "gitring", name: "shop", defaultBranch: "main" },
      mainSha: MAIN,
      mainTree: "t1",
      createdAt: NOW - 3 * 24 * 60 * min,
      settings: {
        autoLand: true,
        fanout: 1,
        decisionModel: "clef-flash",
        agentModels: [],
        intentsInRepo: true,
        allowUntested: false,
        thresholds: { collision: 0.5, interference: 1.7, duplicate: 0.7, minConfidence: 0.55 },
        webhooks: [],
        github: { repo: "robin/shop", mode: "pull-request", branch: "gitring" },
        redo: "agent-first",
        redoWaitMinutes: 15,
      },
      source: { kind: "github", repo: "robin/shop", branch: "main" },
    },
    intents: [
      intent("i_total", "Add a cart total", "underway"),
      intent("i_coupon", "Add a coupon code", "judging"),
      intent("i_dark", "Add a dark mode", "underway"),
      intent("i_footer", "Fix the footer links", "landed"),
      intent("i_first", "Write the first page", "landed"),
    ],
    attempts: [
      attempt("at_s1", "i_total", "g1", "underway", { updatedAt: NOW - 3 * min + s1Version }),
      attempt("at_s2", "i_coupon", "g2", "ready", {
        baseSha: OLD,
        course: course(["Add a coupon field", "Apply the coupon"], ["src/cart.js", "src/coupon.js"]),
        footprint: fp({ "src/cart.js": { status: "M", hunks: [[40, 44]], additions: 1, deletions: 1 }, "src/coupon.js": { status: "A", hunks: [], additions: 1, deletions: 0 }, LICENSE: { status: "D", hunks: [[1, 1]], additions: 0, deletions: 1 } }),
        checks: run(8),
      }),
      attempt("at_d1", "i_dark", "g3", "underway", {
        course: course(["Add a theme toggle", "Store the choice"], ["src/styles/theme.css", "src/render/header.js"]),
        footprint: fp({ "src/styles/theme.css": { status: "M", hunks: [[1, 3]], additions: 2, deletions: 1 } }),
      }),
      attempt("at_f1", "i_footer", "g2", "landed", { landedAt: NOW - 60 * min, footprint: fp({ "src/render/page.jsx": { status: "M", hunks: [[3, 4]], additions: 1, deletions: 1 }, "README.md": { status: "M", hunks: [[1, 1]], additions: 1, deletions: 0 } }) }),
      attempt("at_f0", "i_first", "g1", "landed", { landedAt: NOW - 26 * 60 * min, footprint: fp({ "src/index.js": { status: "A", hunks: [], additions: 7, deletions: 0 } }) }),
    ],
    agents: [
      { id: "g1", callsign: "PETREL-2", kind: "builtin", model: "@cf/moonshotai/kimi-k2.7-code", color: 0, status: "underway", lastSeen: NOW - min },
      { id: "g2", callsign: "KESTREL-7", kind: "builtin", model: "@cf/openai/gpt-oss-120b", color: 3, status: "waiting", lastSeen: NOW - 2 * min },
      { id: "g3", callsign: "WREN-4", kind: "mcp", client: "claude-code", model: "claude-code", color: 6, status: "underway", lastSeen: NOW - 30_000 },
    ],
    corrections: [
      {
        id: "c1",
        attemptId: "at_s2",
        standOnAttemptId: "at_s1",
        kind: "region",
        rule: "R4-first-declared-stands-on",
        message: "Keep out of src/cart.js lines 10–18. PETREL-2 changes them.",
        constraints: { avoidRegions: [{ path: "src/cart.js", lines: [10, 18] }] },
        checkId: "k1",
        status: "delivered",
        createdAt: NOW - 20 * min,
      },
    ],
    checks: [
      {
        id: "k1",
        attemptId: "at_s2",
        trigger: "declare",
        verdict: "correct",
        assessments: [{ otherAttemptId: "at_s1", collision: 0.82, interference: 2.1, duplicate: 0.05, giveWay: "incoming", giveWayConfidence: 0.9, rule: "R4-first-declared-stands-on" }],
        facts: [{ otherAttemptId: "at_s1", otherAgentId: "g1", otherIntentId: "i_total", otherState: "active", sharedFiles: ["src/cart.js"], sharedSymbols: [], interfaceHits: [], hunkOverlaps: [{ path: "src/cart.js", incoming: [12, 14], other: [10, 18] }], range: 0, closing: true, intentSimilarity: 0.2 }],
        source: "rules",
        confidence: 0.9,
        latencyMs: 41,
        at: NOW - 20 * min,
      },
      {
        id: "k2",
        attemptId: "at_f1",
        trigger: "declare",
        verdict: "correct",
        assessments: [{ otherAttemptId: "at_s1", collision: 0.6, interference: 1.9, duplicate: 0.05, giveWay: "incoming", giveWayConfidence: 0.8, rule: "R6-smaller-gives-way" }],
        facts: [{ otherAttemptId: "at_s1", otherAgentId: "g1", otherIntentId: "i_total", otherState: "active", sharedFiles: ["src/render/page.jsx"], sharedSymbols: ["src/render/page.jsx#Page"], interfaceHits: [], hunkOverlaps: [{ path: "src/render/page.jsx", incoming: [3, 4], other: [2, 5] }], range: 0, closing: false, intentSimilarity: 0.1 }],
        source: "clef-flash",
        confidence: 0.8,
        latencyMs: 230,
        at: NOW - 70 * min,
      },
    ],
    landings: [
      { id: "l1", attemptId: "at_f1", intentId: "i_footer", agentId: "g2", method: "merge", mainBefore: OLD, mainAfter: MAIN, checks: run(12, 0, "composed"), correctionsApplied: 1, at: NOW - 60 * min, message: "Fix the footer links\n\nGitring-Intent: i_footer" },
      { id: "l0", attemptId: "at_f0", intentId: "i_first", agentId: "g1", method: "fast-forward", mainBefore: OLDER, mainAfter: OLD, checks: run(5, 0, "composed"), correctionsApplied: 0, at: NOW - 26 * 60 * min, message: "Write the first page" },
    ],
    decisions: [],
    logs: [{ id: "log1", at: NOW - 2 * min, kind: "write", attemptId: "at_s1", agentId: "g1", message: "PETREL-2 wrote src/cart.js", files: ["src/cart.js"] }],
    radar: [{ a: "at_s1", b: "at_s2", range: 0, closing: true, verdict: "correct", updatedAt: NOW - 20 * min }],
    files: nodes(main, [...binary]),
    imports: [],
    stats: { courseChecks: 14, clear: 11, corrections: 3, correctionsAcknowledged: 2, escalations: 0, landings: 2, landedByMethod: { "fast-forward": 1, merge: 1, rederive: 0 }, rederives: 0, replots: 0, medianCheckLatencyMs: 44 },
  };
}

/* ───────────── server ───────────── */

let log = [];
const sockets = new Set();

function send(res, status, body, headers = {}) {
  const isText = typeof body === "string";
  res.writeHead(status, { "content-type": isText ? "text/plain; charset=utf-8" : "application/json", ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

function refFiles(ref) {
  if (ref === "main" || ref === MAIN) return { files: main, version: MAIN, extra: [...binary] };
  if (ref === OLD) return { files: oldFiles(), version: OLD, extra: [...binary] };
  if (ref === "at_s1") return { files: s1Files(), version: `at_s1@${s1Version}`, extra: [...binary] };
  if (ref === "at_s2") return { files: s2Files(), version: "at_s2@1", extra: [...binary] };
  if (ref === "at_d1") return { files: main, version: "at_d1@1", extra: [...binary] };
  return null;
}

function cacheHeaders(ref, etag) {
  return { etag, "cache-control": /^[0-9a-f]{40}$/.test(ref) ? "private, max-age=31536000, immutable" : "private, no-cache" };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function broadcast(events) {
  const msg = JSON.stringify(events.length === 1 ? events[0] : events);
  for (const ws of sockets) ws.send(msg);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const entry = { method: req.method, path: p + url.search, at: Date.now() };
  const done = (status) => {
    entry.status = status;
    if (!p.startsWith("/__mock")) log.push(entry);
  };

  if (p === "/__mock/log") return send(res, 200, log);
  if (p === "/__mock/reset") {
    log = [];
    if (url.searchParams.get("data") !== "keep") s1Version = 1;
    return send(res, 200, { ok: true });
  }
  if (p === "/__mock/emit") {
    const body = await readBody(req);
    broadcast(body.events ?? []);
    return send(res, 200, { sent: sockets.size });
  }
  if (p === "/__mock/drop") {
    for (const ws of sockets) ws.terminate();
    return send(res, 200, { dropped: true });
  }
  if (p === "/__mock/bump") {
    s1Version++;
    const st = makeState();
    broadcast([{ type: "attempt", attempt: st.attempts.find((a) => a.id === "at_s1") }]);
    return send(res, 200, { version: s1Version });
  }

  if (p === "/api/me") {
    done(200);
    return send(res, 200, { user: { id: "u_1", name: "Robin", identities: [{ provider: "github", login: "robin" }], admin: false }, providers: { github: true, google: true }, setupNeeded: false, github: { connected: true, login: "robin" } });
  }
  if (p === "/api/projects" && req.method === "GET") {
    done(200);
    return send(res, 200, [{ id: "shop", name: "Catalog", visibility: "private", source: { kind: "github", repo: "robin/shop" }, createdAt: NOW - 3 * 86400000, role: "owner" }]);
  }
  const m = /^\/api\/projects\/shop(\/.*)?$/.exec(p);
  if (m) {
    const sub = m[1] ?? "";
    if (sub === "/state") {
      done(200);
      return send(res, 200, { ...makeState(), access: "owner" });
    }
    if (sub === "/clone-token" && req.method === "POST") {
      // Like the Worker: a 6-hour read token in a header, never in the URL.
      done(200);
      const remote = "https://artifacts.example/shop.git";
      const header = `Authorization: Basic ${Buffer.from("x:tok_read").toString("base64")}`;
      return send(res, 200, { remote, branch: "main", token: "tok_read?expires=1", expiresAt: new Date(NOW + 6 * 3600_000).toISOString(), header, clone: `git -c http.extraHeader="${header}" clone --branch main ${remote} shop`, pull: `git -c http.extraHeader="${header}" pull` });
    }
    if (sub === "/connect") {
      done(200);
      return send(res, 200, { projectId: "shop", mcpUrl: `http://${req.headers.host}/mcp`, hookUrl: "", intentsUrl: "", artifacts: { namespace: "", repo: "", backend: "artifacts" }, inputs: { slack: false, githubIssues: true }, githubApp: null });
    }
    if (sub === "/tree") {
      const ref = url.searchParams.get("ref") ?? "main";
      const r = refFiles(ref);
      if (!r) {
        done(404);
        return send(res, 404, { error: `Unknown ref ${ref}.` });
      }
      const etag = `"t-${r.version}"`;
      if ((req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim() === etag)) {
        done(304);
        res.writeHead(304, cacheHeaders(ref, etag));
        return res.end();
      }
      done(200);
      return send(res, 200, { ref, sha: r.version, files: nodes(r.files, r.extra) }, cacheHeaders(ref, etag));
    }
    if (sub === "/file") {
      const ref = url.searchParams.get("ref") ?? "main";
      const fpth = url.searchParams.get("path") ?? "";
      const r = refFiles(ref);
      const etag = r ? `"f-${r.version}-${hash(fpth)}"` : "";
      if (etag && (req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim() === etag)) {
        done(304);
        res.writeHead(304, cacheHeaders(ref, etag));
        return res.end();
      }
      const text = r?.files.get(fpth);
      if (text === undefined) {
        done(404);
        return send(res, 404, "Not found");
      }
      done(200);
      return send(res, 200, text, { ...cacheHeaders(ref, etag), "x-content-type-options": "nosniff" });
    }
    const dm = /^\/attempts\/([^/]+)\/diff$/.exec(sub);
    if (dm) {
      const id = dm[1];
      const files = id === "at_s1" ? s1Files() : id === "at_s2" ? s2Files() : id === "at_d1" ? main : null;
      if (!files) {
        done(404);
        return send(res, 404, { error: "Unknown work copy." });
      }
      done(200);
      return send(res, 200, diffOf(id === "at_s2" ? oldFiles() : main, files));
    }
    const lm = /^\/landings\/([^/]+)$/.exec(sub);
    if (lm) {
      const st = makeState();
      const l = st.landings.find((x) => x.id === lm[1]);
      if (!l) {
        done(404);
        return send(res, 404, { error: "Unknown merge." });
      }
      done(200);
      // A slow answer, so loading states are visible in checks.
      await new Promise((r) => setTimeout(r, 250));
      return send(res, 200, { landing: l, note: { intent: l.intentId }, diff: diffOf(oldFiles(), main) });
    }
    done(404);
    return send(res, 404, { error: "Not in the mock." });
  }
  if (p.startsWith("/api/")) {
    done(404);
    return send(res, 404, { error: "Not in the mock." });
  }
  if (p.startsWith("/auth/")) {
    done(200);
    res.writeHead(302, { location: url.searchParams.get("return") || "/" });
    return res.end();
  }

  // Static files, with the single-page fallback.
  let file = path.join(root, decodeURIComponent(p));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
  fs.createReadStream(file).pipe(res);
  if (p.startsWith("/assets/")) log.push({ method: "GET", path: p, status: 200, at: Date.now(), asset: true });
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws/shop") {
    socket.destroy();
    return;
  }
  log.push({ method: "WS", path: url.pathname, status: 101, at: Date.now(), ws: true });
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (data) => {
      if (String(data) === "ping") {
        log.push({ method: "WS", path: "ping", status: 0, at: Date.now(), ws: true });
        ws.send("pong");
      }
    });
    ws.send(JSON.stringify({ type: "snapshot", state: makeState() }));
  });
});

server.listen(port, "127.0.0.1", () => console.log(`code mock on http://127.0.0.1:${port}`));
