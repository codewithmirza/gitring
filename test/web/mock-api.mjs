// A small mock of the gitring Worker API for browser tests of the web app (projects, onboarding, settings,
// connect). It serves a UI build and answers the API contract with in-memory data.
//
//   npx vite build --config vite.ui.config.ts          # builds tmp/ui-build
//   node test/web/mock-api.mjs [port] [build dir]      # default 5199, tmp/ui-build
//
// The cookie "mock" picks a scenario: github (default: signed in, GitHub connected), google (signed in,
// no GitHub connection), norepos (GitHub connected, no repositories), fresh (signed in, no projects),
// signedout, noprov (signed out, no sign-in providers).
// Test aids: GET /__mock/log (requests), POST /__mock/reset, POST /__mock/grant (an OAuth app signs in),
// POST /__mock/github-event (a live "github" event on the sockets), POST /__mock/settings ({ project,
// settings }: replace the settings of a project as they are, for example the settings of a server from
// before `landing` and `approver`).
//
// Settings behave like the Worker: `landing` ("automatic", "risky" or "ask") decides when a person says yes,
// `approver` ("sender" or "owner") decides who answers, and `autoLand` stays equal to `landing ===
// "automatic"`. A PUT merges a partial object, and only an owner may send it.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.argv[2] ?? 5199);
const ROOT = path.resolve(process.argv[3] ?? "tmp/ui-build");
const ORIGIN = `http://127.0.0.1:${PORT}`;
const INSTALL_URL = "https://github.com/apps/git-ring/installations/new";
const now = () => Date.now();
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;

const REPOS = [
  { fullName: "robin/gitring", private: true, defaultBranch: "main", description: "Many coding agents, one codebase.", language: "TypeScript", pushedAt: iso(2 * 3600_000), htmlUrl: "https://github.com/robin/gitring", canPush: true, sizeKb: 4200 },
  { fullName: "robin/gitring-web", private: false, defaultBranch: "main", description: "The web app of gitring.", language: "TypeScript", pushedAt: iso(DAY), htmlUrl: "https://github.com/robin/gitring-web", canPush: true, sizeKb: 900 },
  { fullName: "robin/greeter", private: false, defaultBranch: "main", description: "A small greeting app on Cloudflare Workers.", language: "JavaScript", pushedAt: iso(3 * DAY), htmlUrl: "https://github.com/robin/greeter", canPush: true, sizeKb: 120 },
  { fullName: "robin/ml-notes", private: true, defaultBranch: "trunk", description: "Python notebooks and tests.", language: "Python", pushedAt: iso(9 * DAY), htmlUrl: "https://github.com/robin/ml-notes", canPush: true, sizeKb: 3100 },
  { fullName: "robin/dotfiles", private: false, defaultBranch: "master", description: "Shell configuration.", language: "Shell", pushedAt: iso(40 * DAY), htmlUrl: "https://github.com/robin/dotfiles", canPush: true, sizeKb: 60 },
  { fullName: "acme/payments", private: true, defaultBranch: "main", description: "Payment service.", language: "Go", pushedAt: iso(5 * 3600_000), htmlUrl: "https://github.com/acme/payments", canPush: false, sizeKb: 8800 },
  { fullName: "acme/website", private: false, defaultBranch: "main", description: "Marketing site.", language: "TypeScript", pushedAt: iso(6 * DAY), htmlUrl: "https://github.com/acme/website", canPush: true, sizeKb: 2400 },
  { fullName: "acme/locked", private: true, defaultBranch: "main", description: "An owner must approve the app.", language: "Rust", pushedAt: iso(12 * DAY), htmlUrl: "https://github.com/acme/locked", canPush: true, sizeKb: 500 },
  { fullName: "robin/broken", private: false, defaultBranch: "main", description: "The guess fails for this one.", language: "JavaScript", pushedAt: iso(20 * DAY), htmlUrl: "https://github.com/robin/broken", canPush: true, sizeKb: 10 },
];
for (let i = 1; i <= 14; i++) {
  REPOS.push({ fullName: `robin/experiment-${String(i).padStart(2, "0")}`, private: i % 3 === 0, defaultBranch: "main", description: `Experiment number ${i}.`, language: i % 2 ? "TypeScript" : "Go", pushedAt: iso((30 + i) * DAY), htmlUrl: `https://github.com/robin/experiment-${i}`, canPush: true, sizeKb: 40 + i });
}
// Found only by a server search (the full list leaves it out).
const HIDDEN = { fullName: "acme/hidden-gem", private: false, defaultBranch: "main", description: "Only a search finds it.", language: "TypeScript", pushedAt: iso(80 * DAY), htmlUrl: "https://github.com/acme/hidden-gem", canPush: true, sizeKb: 70 };

const USERS = {
  github: { id: "u_robin", name: "Robin Example", email: "robin@example.com", avatar: "", identities: [{ provider: "github", login: "robin" }], admin: false },
  google: { id: "u_ada", name: "Ada Example", email: "ada@example.com", avatar: "", identities: [{ provider: "google", email: "ada@example.com" }], admin: false },
};

const LANDINGS = ["automatic", "risky", "ask"];

/**
 * The approval fields as the Worker keeps them (withDefaults in src/core/types.ts): `landing` decides; a
 * settings object with only the old `autoLand` gets "automatic" (true) or "ask" (false); with neither, a
 * new project's default ("risky"). `autoLand` always follows `landing`.
 */
function withApproval(s) {
  const landing = LANDINGS.includes(s.landing) ? s.landing : typeof s.autoLand === "boolean" ? (s.autoLand ? "automatic" : "ask") : "risky";
  return { ...s, landing, approver: s.approver === "owner" ? "owner" : "sender", autoLand: landing === "automatic" };
}

function settingsDefaults(extra = {}) {
  const s = {
    landing: "risky",
    approver: "sender",
    autoLand: false,
    fanout: 1,
    decisionModel: "clef-flash",
    agentModels: ["@cf/zai-org/glm-5.3-flash", "@cf/zai-org/glm-5.3"],
    intentsInRepo: true,
    allowUntested: false,
    thresholds: { collision: 0.5, interference: 1.7, duplicate: 0.7, minConfidence: 0.55 },
    webhooks: [],
    github: { mode: "off", branch: "gitring" },
    redo: "agent-first",
    redoWaitMinutes: 15,
    checks: { runner: "container", install: "npm ci", test: "npm test" },
    ...extra,
  };
  // Only the old `autoLand` in `extra`: it decides, as in the Worker.
  if (extra.landing === undefined && typeof extra.autoLand === "boolean") delete s.landing;
  return withApproval(s);
}

/** A settings PUT: merge a partial object into the settings, like the Worker. */
function patchSettings(cur, b) {
  const { landing, autoLand, approver, ...rest } = b;
  const next = {
    ...cur,
    ...rest,
    github: { ...cur.github, ...(b.github ?? {}) },
    checks: b.checks ? { ...b.checks } : cur.checks,
    thresholds: { ...cur.thresholds, ...(b.thresholds ?? {}) },
  };
  // `landing` decides. An old client sends `autoLand` only: true means "automatic", false means "ask".
  next.landing = LANDINGS.includes(landing) ? landing : typeof autoLand === "boolean" ? (autoLand ? "automatic" : "ask") : cur.landing;
  if (approver === "sender" || approver === "owner") next.approver = approver;
  return withApproval(next);
}

let db;
function reset() {
  db = {
    log: [],
    grants: [],
    keys: [],
    projects: new Map(),
    sockets: new Set(),
  };
  addProject({ id: "gitring-web-ab12", name: "gitring web", visibility: "private", source: { kind: "github", repo: "robin/gitring-web", branch: "main" }, ownerName: "Robin Example", owner: "u_robin", files: 3, settings: settingsDefaults({ github: { repo: "robin/gitring-web", mode: "pull-request", branch: "gitring" } }), github: { state: "ok", message: "GitHub has main. The pull request is open.", repo: "robin/gitring-web", mode: "pull-request", branch: "gitring", syncedSha: "9f2c1e0a7b", prUrl: "https://github.com/robin/gitring-web/pull/7", prNumber: 7, at: now() - 120_000 } });
  addProject({ id: "notes-cd34", name: "Notes", visibility: "private", source: { kind: "upload", files: 12 }, ownerName: "Robin Example", owner: "u_robin", files: 2, role: "member" });
  addProject({ id: "react-ef56", name: "react", visibility: "public", source: { kind: "git", url: "https://github.com/facebook/react" }, ownerName: "Grace Example", owner: "u_grace", files: 4, role: null });
}

function addProject(p) {
  db.projects.set(p.id, {
    createdAt: now() - 4 * DAY,
    role: "owner",
    settings: settingsDefaults(),
    members: [
      { userId: "u_robin", name: "Robin Example", handle: "robin", role: "owner", pending: false },
      { userId: "u_lin", name: "Lin Example", handle: "lin@example.com", role: "member", pending: false },
      { name: "octocat", handle: "octocat", role: "viewer", pending: true },
    ],
    ...p,
  });
}

/** The caller's role: signed-out people and the "fresh" person see public projects only (and their new ones). */
function roleFor(p, scenario) {
  const signedIn = scenario !== "signedout" && scenario !== "noprov";
  if (signedIn && p.created) return "owner";
  if (signedIn && scenario !== "fresh" && p.role) return p.role;
  return p.visibility === "public" ? "viewer" : null;
}

function info(p, scenario) {
  return { id: p.id, name: p.name, visibility: p.visibility, source: p.source, createdAt: p.createdAt, ownerName: p.ownerName, role: roleFor(p, scenario) };
}

function stateOf(p, scenario) {
  const files = Array.from({ length: p.files ?? 0 }, (_, i) => ({ path: i === 0 ? "README.md" : `src/file-${i}.ts`, size: 400 + i * 40, lang: i === 0 ? "markdown" : "typescript" }));
  const project = {
    id: p.id,
    name: p.name,
    repo: { backend: "artifacts", namespace: "gitring", name: p.id, remote: `https://artifacts.example/${p.id}.git`, defaultBranch: "main" },
    mainSha: files.length ? "3c4d5e6f7a8b9c0d" : "",
    mainTree: files.length ? "tree1" : "",
    createdAt: p.createdAt,
    settings: p.settings,
    source: p.source,
    ...(p.importing ? { importing: p.importing } : {}),
    ...(p.github ? { github: p.github } : {}),
  };
  const agents = p.id === "gitring-web-ab12" ? [{ id: "ag_1", callsign: "KESTREL-7", kind: "mcp", client: "claude-code", model: "claude-code", color: 2, status: "idle", lastSeen: now() - 5 * 60_000 }] : [];
  const role = roleFor(p, scenario);
  return {
    project,
    intents: [],
    attempts: [],
    agents,
    corrections: [],
    checks: [],
    landings: [],
    decisions: [],
    logs: [],
    radar: [],
    files,
    imports: [],
    stats: { courseChecks: 0, clear: 0, corrections: 0, correctionsAcknowledged: 0, escalations: 0, landings: 0, landedByMethod: { "fast-forward": 0, merge: 0, rederive: 0 }, rederives: 0, replots: 0, medianCheckLatencyMs: 0 },
    access: role,
  };
}

function guessFor(repo) {
  const r = REPOS.find((x) => x.fullName.toLowerCase() === repo.toLowerCase()) ?? (repo === HIDDEN.fullName ? HIDDEN : null);
  const name = repo.split("/")[1];
  if (repo === "vercel/next.js") {
    return { status: 200, body: { repo, name: "next.js", id: "next-js-q1w2", branch: "canary", private: false, language: "JavaScript", checks: { runner: "container", install: "pnpm install --frozen-lockfile", test: "pnpm test" }, reasons: ["The default branch is canary.", "pnpm-lock.yaml is in the repository, so the install command is pnpm install --frozen-lockfile.", "package.json has a test script: pnpm test.", "You cannot push to this repository, so merged code stays in gitring."], sync: "off" } };
  }
  if (!r) return { status: 404, body: { error: "gitring cannot see this repository." } };
  if (r.fullName === "acme/locked") return { status: 403, body: { error: "An owner of acme must approve the GitHub app.", installUrl: INSTALL_URL } };
  if (r.fullName === "robin/broken") return { status: 502, body: { error: "GitHub did not answer. Try again." } };
  const python = r.language === "Python";
  const worker = r.fullName === "robin/greeter";
  return {
    status: 200,
    body: {
      repo: r.fullName,
      name,
      id: `${name}-z9y8`,
      branch: r.defaultBranch,
      private: r.private,
      language: r.language,
      checks: worker ? { runner: "worker" } : python ? { runner: "container", install: "pip install -r requirements.txt", test: "pytest" } : { runner: "container", install: "npm ci", test: "npm test" },
      reasons: [
        `The default branch is ${r.defaultBranch}.`,
        ...(worker ? ["tests/*.test.js files use the gitring test runner."] : python ? ["requirements.txt is in the repository, so the install command is pip install -r requirements.txt.", "pytest.ini is in the repository: the tests run with pytest."] : ["package-lock.json is in the repository, so the install command is npm ci.", "package.json has a test script: npm test."]),
        r.canPush ? "GitHub sync is off: merged code stays in gitring. You can turn it on now, or later in Settings → GitHub." : "You cannot push to this repository, so merged code stays in gitring.",
      ],
      // Like the Worker: GitHub sync starts off; canSync says that the person may turn it on.
      sync: "off",
      ...(r.canPush ? { canSync: true } : {}),
    },
  };
}

/* ───────────── HTTP ───────────── */

function scenarioOf(req) {
  const m = /(?:^|;\s*)mock=([a-z]+)/.exec(req.headers.cookie ?? "");
  return m ? m[1] : "github";
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString("utf8");
  try {
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json" };

async function serveStatic(res, pathname) {
  let file = path.join(ROOT, decodeURIComponent(pathname));
  if (!file.startsWith(ROOT)) file = path.join(ROOT, "index.html");
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = path.join(ROOT, "index.html");
  } catch {
    file = path.join(ROOT, "index.html");
  }
  const data = await readFile(file);
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable" });
  res.end(data);
}

async function api(req, res, url) {
  const s = scenarioOf(req);
  const signedIn = s !== "signedout" && s !== "noprov";
  const user = s === "google" ? USERS.google : USERS.github;
  const p = url.pathname;
  const m = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(p);

  if (p === "/api/me" && req.method === "GET") {
    const providers = s === "noprov" ? { github: false, google: false } : { github: true, google: true };
    const github = !signedIn ? undefined : s === "google" ? { connected: false, reason: "Connect GitHub to see your repositories." } : { connected: true, login: "robin" };
    return json(res, 200, { user: signedIn ? user : null, providers, setupNeeded: s === "noprov", ...(github ? { github } : {}), githubInstallUrl: INSTALL_URL });
  }
  if (p === "/auth/logout") return json(res, 204);
  if (p === "/api/projects" && req.method === "GET") {
    return json(res, 200, [...db.projects.values()].map((x) => info(x, s)).filter((x) => x.role !== null));
  }
  if (p === "/api/projects" && req.method === "POST") {
    if (!signedIn) return json(res, 401, { error: "Sign in first." });
    const b = await body(req);
    await sleep(300);
    if (!String(b.name ?? "").trim()) return json(res, 400, { error: "Give the project a name." });
    const src = b.source ?? {};
    if (src.kind === "github" && src.repo === "acme/payments") return json(res, 403, { error: "An owner of acme must approve the GitHub app.", installUrl: INSTALL_URL });
    if (!["template", "github", "git", "upload", "push", "empty"].includes(src.kind)) return json(res, 400, { error: "Choose a source: template, empty, upload, push, git (an https URL) or github." });
    // Like the Worker: the starter templates of src/core/templates.ts, with their file counts.
    const TEMPLATE_FILES = { empty: 3, "js-library": 6, "worker-api": 7, "static-site": 7 };
    if (src.kind === "template" && !(src.template in TEMPLATE_FILES)) return json(res, 400, { error: "Choose a template: empty, js-library, worker-api, static-site." });
    const id = `${String(b.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "project"}-${Math.random().toString(36).slice(2, 6)}`;
    const importing = src.kind === "github" ? { url: `https://github.com/${src.repo}`, startedAt: now() } : src.kind === "git" ? { url: src.url, startedAt: now() } : src.kind === "push" ? { url: "", startedAt: now(), push: true } : undefined;
    addProject({ id, name: b.name, visibility: b.visibility ?? "private", source: src, ownerName: user.name, owner: user.id, files: src.kind === "upload" ? (b.files?.length ?? 0) : src.kind === "template" ? TEMPLATE_FILES[src.template] : 0, importing, settings: settingsDefaults(b.settings ?? {}), createdAt: now(), created: true, body: b });
    const created = db.projects.get(id);
    return json(res, 201, { project: info(created, s), state: stateOf(created, s) });
  }
  if (p === "/api/github/repos" && req.method === "GET") {
    // Like the Worker: ?q= filters the same list; "partial" stands for a list that GitHub cut short.
    if (!signedIn) return json(res, 401, { error: "Sign in first." });
    await sleep(350);
    if (s === "google") return json(res, 200, { connected: false, repos: [], installUrl: INSTALL_URL, reason: "Connect GitHub to see your repositories." });
    if (s === "norepos") return json(res, 200, { connected: true, repos: [], installUrl: INSTALL_URL, installations: [], complete: true, reason: "Install the gitring GitHub app on your repositories to see them here." });
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const pool = s === "partial" && q ? [...REPOS, HIDDEN] : REPOS;
    const all = q ? pool.filter((r) => r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)) : REPOS;
    const installations = [
      { id: 1, account: "robin", type: "User", selection: "all", repos: REPOS.filter((r) => r.fullName.startsWith("robin/")).length },
      { id: 2, account: "acme", type: "Organization", selection: "selected", repos: REPOS.filter((r) => r.fullName.startsWith("acme/")).length },
    ];
    return json(res, 200, { connected: true, repos: all, installUrl: INSTALL_URL, installations, complete: s !== "partial" }, { "cache-control": "private, max-age=30" });
  }
  if (p === "/api/github/guess" && req.method === "GET") {
    if (!signedIn) return json(res, 401, { error: "Sign in first." });
    await sleep(450);
    const g = guessFor(url.searchParams.get("repo") ?? "");
    return json(res, g.status, g.body);
  }
  if (p === "/api/oauth/grants" && req.method === "GET") {
    if (!signedIn) return json(res, 401, { error: "Sign in first." });
    return json(res, 200, db.grants);
  }
  if (p === "/api/keys" && req.method === "GET") return json(res, 200, db.keys);
  if (p === "/api/keys" && req.method === "POST") {
    const b = await body(req);
    const k = { id: `k_${db.keys.length + 1}`, name: b.name ?? "key", prefix: "gk_live_ab12", createdAt: now() };
    db.keys.push(k);
    return json(res, 201, { key: "gk_live_ab12cd34ef56gh78", info: k });
  }

  if (m) {
    const id = decodeURIComponent(m[1]);
    const rest = m[2] ?? "";
    const proj = db.projects.get(id);
    if (!proj) return json(res, 404, { error: "Unknown project." });
    const role = roleFor(proj, s);
    if (!role) return json(res, 404, { error: "Unknown project." });
    if (rest === "/__body") return json(res, 200, proj.body ?? null);
    if (rest === "/state") return json(res, 200, stateOf(proj, s));
    if (rest === "" && req.method === "PATCH") {
      Object.assign(proj, await body(req));
      return json(res, 200, info(proj, s));
    }
    if (rest === "" && req.method === "DELETE") {
      db.projects.delete(id);
      return json(res, 204);
    }
    if (rest === "/members" && req.method === "GET") return json(res, 200, proj.members);
    if (rest === "/members" && req.method === "POST") {
      const b = await body(req);
      proj.members.push({ name: b.who, handle: b.who, role: b.role ?? "member", pending: true });
      return json(res, 200, proj.members);
    }
    const mm = /^\/members\/(.+)$/.exec(rest);
    if (mm && req.method === "DELETE") {
      const who = decodeURIComponent(mm[1]);
      proj.members = proj.members.filter((x) => (x.userId ?? x.handle) !== who);
      return json(res, 200, proj.members);
    }
    if (rest === "/settings" && req.method === "GET") {
      await sleep(250);
      return json(res, 200, proj.settings);
    }
    if (rest === "/settings" && req.method === "PUT") {
      if (role !== "owner") return json(res, 403, { error: "Only an owner can change the settings." });
      const b = await body(req);
      if (b.github?.repo === "acme/payments") return json(res, 403, { error: "You cannot push to acme/payments. A person who can push must link it.", installUrl: INSTALL_URL });
      proj.settings = patchSettings(proj.settings, b);
      return json(res, 200, proj.settings);
    }
    if (rest === "/github" && req.method === "GET") {
      const g = proj.settings.github;
      return json(res, 200, proj.github ?? (g.repo ? { state: g.mode === "off" ? "off" : "pending", message: g.mode === "off" ? "The sync is off." : "gitring sends main to GitHub soon.", repo: g.repo, mode: g.mode } : { state: "not-linked", message: "No GitHub repository is linked." }));
    }
    if (rest === "/github/sync" && req.method === "POST") {
      await sleep(400);
      proj.github = { state: "ok", message: "GitHub has main now. The pull request is up to date.", repo: proj.settings.github.repo, mode: proj.settings.github.mode, branch: "gitring", syncedSha: "aa11bb22cc", prUrl: `https://github.com/${proj.settings.github.repo}/pull/8`, prNumber: 8, at: now() };
      return json(res, 200, proj.github);
    }
    if (rest === "/github/pull" && req.method === "POST") {
      await sleep(400);
      proj.github = { ...(proj.github ?? {}), state: "ok", message: "GitHub had 2 new commits. gitring merged them into main.", repo: proj.settings.github.repo, at: now() };
      return json(res, 200, proj.github);
    }
    if (rest === "/connect") {
      return json(res, 200, { projectId: id, mcpUrl: `${ORIGIN}/mcp`, hookUrl: `${ORIGIN}/hooks/claude/${id}`, intentsUrl: `${ORIGIN}/hooks/intents`, artifacts: { namespace: "gitring", repo: id, backend: "artifacts" }, inputs: { slack: false, githubIssues: true }, githubApp: { slug: "git-ring", installUrl: INSTALL_URL } });
    }
    if (rest === "/import/check" && req.method === "POST") return json(res, 200, { importing: proj.importing ?? null, mainSha: "" });
    if (rest === "/push-token" && req.method === "POST") return json(res, 200, { remote: `https://artifacts.example/${id}.git`, token: "tok_123", expiresAt: new Date(now() + DAY).toISOString() });
    if (rest === "/clone-token" && req.method === "POST") {
      const remote = `https://artifacts.example/${id}.git`;
      const header = `Authorization: Basic ${Buffer.from("x:tok_read").toString("base64")}`;
      return json(res, 200, { remote, branch: "main", token: "tok_read?expires=1", expiresAt: new Date(now() + 6 * 3600_000).toISOString(), header, clone: `git -c http.extraHeader="${header}" clone --branch main ${remote} ${id}`, pull: `git -c http.extraHeader="${header}" pull` });
    }
  }
  return json(res, 404, { error: `No mock for ${req.method} ${p}.` });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) db.log.push({ method: req.method, path: url.pathname + url.search, at: now() });
  try {
    if (url.pathname === "/__mock/log") return json(res, 200, db.log);
    if (url.pathname === "/__mock/reset") {
      reset();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/__mock/grant") {
      db.grants.push({ id: `g_${db.grants.length + 1}`, clientId: "c_claude_code", clientName: "Claude Code", clientUri: "https://claude.ai", scope: "gitring", createdAt: now(), lastUsedAt: now() });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/__mock/settings" && req.method === "POST") {
      const b = await body(req);
      const proj = db.projects.get(b.project);
      if (!proj) return json(res, 404, { error: "Unknown project." });
      proj.settings = b.settings;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/__mock/github-event") {
      const ev = { type: "github", github: { state: "ok", message: "Live: GitHub has main now.", repo: "robin/gitring-web", mode: "pull-request", at: now() } };
      for (const s of db.sockets) frame(s, JSON.stringify(ev));
      return json(res, 200, { sent: db.sockets.size });
    }
    const auth = /^\/auth\/(github|google)\/start$/.exec(url.pathname);
    if (auth) {
      const back = url.searchParams.get("return") ?? "/";
      res.writeHead(302, { location: back.startsWith("/") ? back : "/", "set-cookie": `mock=${auth[1] === "github" ? "github" : "google"}; Path=/` });
      return res.end();
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/auth/logout") return await api(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

/* ───────────── WebSocket (a snapshot, then events from /__mock/github-event) ───────────── */

function frame(socket, text) {
  const payload = Buffer.from(text);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([head, payload]));
}

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, ORIGIN);
  const m = /^\/ws\/([^/]+)$/.exec(url.pathname);
  const proj = m ? db.projects.get(decodeURIComponent(m[1])) : null;
  if (!proj) return socket.destroy();
  db.log.push({ method: "WS", path: url.pathname, at: now() });
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  frame(socket, JSON.stringify({ type: "snapshot", state: stateOf(proj, scenarioOf(req)) }));
  db.sockets.add(socket);
  socket.on("data", () => undefined);
  socket.on("error", () => undefined);
  socket.on("close", () => db.sockets.delete(socket));
});

reset();
server.listen(PORT, "127.0.0.1", () => console.log(`mock gitring on ${ORIGIN} (UI from ${ROOT})`));
