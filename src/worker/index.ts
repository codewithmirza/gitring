/**
 * gitring Worker — routes:
 *   /mcp                       MCP server for external agents (personal API key)
 *   /api/*                     REST for the UI and other apps (session cookie or API key)
 *   /ws/:p                     WebSocket → HarborMaster live events
 *   /preview/:p/:ref/*         live preview of main or an attempt (Dynamic Worker)
 *   /hooks/*                   inbound webhooks (generic, GitHub App, GitHub, Slack, Claude Code)
 *   /auth/*, /setup            sign-in (GitHub, Google) and the owner's setup page
 *   everything else            the React UI (static assets, SPA)
 *
 * Access: every project has an owner and members (Directory). Public projects can be watched by anyone;
 * acting on a project needs the member role; settings and reset need the owner role.
 */
import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { createMcp } from "./mcp";
import { servePreview } from "../platform/checks/preview";
import type * as T from "../core/types";
import type * as A from "../core/accounts";
import { atLeast, PROJECT_ID } from "../core/accounts";
import { actorOf, authRoutes, directory, resolvePrincipal, type Principal } from "./auth";
import { hmacSha256Hex, sameString } from "../directory/crypto";
import { normalizeGitUrl } from "../core/repo-rules";
import type { SeedFile } from "../harbor/harbor";

export { HarborMaster } from "../harbor/harbor";
export { Vessel } from "../vessel/vessel";
export { Sector } from "../sim/sector";
export { Directory } from "../directory/directory";
export { Drydock, Seawall } from "../drydock/drydock";

type HonoEnv = { Bindings: Env; Variables: { principal: Principal } };
type C = Context<HonoEnv>;

const app = new Hono<HonoEnv>();

class HTTPError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Project ids: lowercase letters, digits and dashes (1–40). Other names (internal objects) are refused. */
export function projectId(raw: string | undefined): string {
  const id = (raw ?? "").trim();
  if (!PROJECT_ID.test(id)) throw new HTTPError(400, "Use a project id of lowercase letters, digits and dashes (at most 40).");
  return id;
}

function harbor(env: Env, project: string) {
  return env.HARBOR.get(env.HARBOR.idFromName(projectId(project)));
}

app.onError((e, c) => {
  if (e instanceof HTTPError) return c.json({ error: e.message }, e.status);
  console.error("unhandled", e);
  return c.json({ error: "gitring could not finish the request. Try again." }, 500);
});

/* ───────────── who is calling ───────────── */

app.use("*", async (c, next) => {
  const p = await resolvePrincipal(c.env, c.req.raw);
  if (p.badKey) return c.json({ error: "The API key is not valid. Create a new key in gitring (Connect → API keys)." }, 401);
  c.set("principal", p);
  // A browser session may only change state from gitring's own pages (no cross-site requests).
  const m = c.req.method;
  if (p.via === "session" && m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    const own = new URL(c.req.url).origin;
    if ((origin && origin !== own) || (!origin && site && site !== "same-origin")) return c.json({ error: "Cross-site requests are not allowed." }, 403);
  }
  await next();
});

/** The caller's role on a project; refuse when it is below `need`. */
async function access(c: C, raw: string | undefined, need: A.Role): Promise<{ id: string; role: A.Role }> {
  const id = projectId(raw);
  const p = c.get("principal");
  if (p.via === "operator") return { id, role: "owner" };
  const role = await directory(c.env).role(id, p.user?.id ?? null);
  if (!role) throw new HTTPError(p.user ? 404 : 401, p.user ? "This project does not exist, or you have no access to it." : "Sign in to open this project.");
  if (!atLeast(role, need)) {
    throw new HTTPError(p.user ? 403 : 401, p.user ? `You need the ${need} role on this project. Ask an owner.` : "Sign in to do this.");
  }
  return { id, role };
}

async function ready(c: C, raw: string | undefined, need: A.Role) {
  const { id, role } = await access(c, raw, need);
  const h = harbor(c.env, id);
  await h.ensure(id);
  return Object.assign(h, { role });
}

function err(c: C, e: unknown, status = 400) {
  if (e instanceof HTTPError) return c.json({ error: e.message }, e.status);
  const message = String((e as Error)?.message ?? e).replace(/^Error: /, "");
  return c.json({ error: message }, status as 400);
}

function needUser(c: C): A.UserInfo {
  const u = c.get("principal").user;
  if (!u) throw new HTTPError(401, "Sign in first.");
  return u;
}

/* ───────────── health, sign-in, setup ───────────── */

app.get("/api/health", async (c) =>
  c.json({
    ok: true,
    build: await harbor(c.env, "demo").version().catch(() => "unknown"),
    backend: "artifacts",
    ai: Boolean(c.env.AI),
    signIn: await directory(c.env)
      .providers()
      .then((p) => ({ github: Boolean(p.github), google: Boolean(p.google) }))
      .catch(() => ({ github: false, google: false })),
  }),
);

authRoutes(app);

/* ───────────── API keys ───────────── */

app.get("/api/keys", async (c) => c.json(await directory(c.env).listKeys(needUser(c).id)));

app.post("/api/keys", async (c) => {
  const user = needUser(c);
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  try {
    return c.json(await directory(c.env).createKey(user.id, body.name ?? "key"), 201);
  } catch (e) {
    return err(c, e);
  }
});

app.delete("/api/keys/:id", async (c) => {
  const ok = await directory(c.env).revokeKey(needUser(c).id, c.req.param("id"));
  return ok ? c.body(null, 204) : c.json({ error: "Unknown key." }, 404);
});

/* ───────────── projects ───────────── */

app.get("/api/projects", async (c) => c.json(await directory(c.env).listProjects(c.get("principal").user?.id ?? null)));

app.post("/api/projects", async (c) => {
  const principal = c.get("principal");
  // People own their projects. The operator key (scripts) makes projects that no person owns.
  const user = principal.via === "operator" ? null : needUser(c);
  const body = await c.req.json<{ name?: string; visibility?: A.Visibility; source?: T.ProjectSource; files?: SeedFile[] }>().catch(() => ({}) as Record<string, never>);
  let source: T.ProjectSource;
  try {
    source = parseSource(body.source, body.files);
  } catch (e) {
    return err(c, e);
  }
  const dir = directory(c.env);
  let info: A.ProjectInfo;
  try {
    info = await dir.createProject({ name: body.name ?? "", visibility: body.visibility, source, ownerId: user?.id ?? null });
  } catch (e) {
    return err(c, e);
  }
  try {
    const files = source.kind === "upload" && Array.isArray(body.files) ? body.files : undefined;
    const st = await harbor(c.env, info.id).init({ projectId: info.id, name: info.name, source, ownerId: user?.id, files });
    return c.json({ project: info, state: st }, 201);
  } catch (e) {
    await dir.dropProject(info.id).catch(() => undefined);
    return err(c, e);
  }
});

function parseSource(raw: unknown, files?: unknown): T.ProjectSource {
  const s = (raw ?? {}) as Record<string, unknown>;
  switch (s.kind) {
    case "sample":
      return { kind: "sample" };
    case "empty":
      return { kind: "empty" };
    case "push":
      return { kind: "push" };
    case "upload": {
      if (!Array.isArray(files) || !files.length) throw new HTTPError(400, "Send the files of the folder.");
      return { kind: "upload", files: files.length };
    }
    case "git": {
      const url = normalizeGitUrl(String(s.url ?? ""));
      const hostname = new URL(url).hostname;
      const host = /(^|\.)github\.com$/.test(hostname) ? "github" : /(^|\.)gitlab\.com$/.test(hostname) ? "gitlab" : /(^|\.)bitbucket\.org$/.test(hostname) ? "bitbucket" : "other";
      const branch = typeof s.branch === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(s.branch) ? s.branch : undefined;
      return { kind: "git", url, host, ...(branch ? { branch } : {}) };
    }
    default:
      throw new HTTPError(400, "Choose a source: sample, empty, git (an https URL), push or upload.");
  }
}

app.get("/api/projects/:p", async (c) => {
  const { id } = await access(c, c.req.param("p"), "viewer");
  return c.json(await directory(c.env).project(id, c.get("principal").user?.id ?? null));
});

app.patch("/api/projects/:p", async (c) => {
  const { id } = await access(c, c.req.param("p"), "owner");
  const body = await c.req.json<{ name?: string; visibility?: A.Visibility }>().catch(() => ({}));
  try {
    return c.json(await directory(c.env).updateProject(id, body));
  } catch (e) {
    return err(c, e);
  }
});

app.delete("/api/projects/:p", async (c) => {
  const { id } = await access(c, c.req.param("p"), "owner");
  try {
    await directory(c.env).archiveProject(id);
    return c.body(null, 204);
  } catch (e) {
    return err(c, e);
  }
});

app.get("/api/projects/:p/members", async (c) => {
  const { id } = await access(c, c.req.param("p"), "member");
  return c.json(await directory(c.env).members(id));
});

app.post("/api/projects/:p/members", async (c) => {
  const { id } = await access(c, c.req.param("p"), "owner");
  const body = await c.req.json<{ who?: string; role?: A.Role }>().catch(() => ({}) as { who?: string; role?: A.Role });
  try {
    return c.json(await directory(c.env).addMember(id, body.who ?? "", body.role ?? "member"));
  } catch (e) {
    return err(c, e);
  }
});

app.delete("/api/projects/:p/members/:who", async (c) => {
  const { id } = await access(c, c.req.param("p"), "owner");
  try {
    return c.json(await directory(c.env).removeMember(id, c.req.param("who")));
  } catch (e) {
    return err(c, e);
  }
});

/* ───────────── project state + intents ───────────── */

app.get("/api/projects/:p/state", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    const st = (await h.state()) as unknown as T.ProjectState;
    return c.json({ ...st, access: h.role });
  } catch (e) {
    return err(c, e, 500);
  }
});

app.post("/api/projects/:p/intents", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const body = await c.req.json<{ title: string; goal: string; checks?: { path: string; content: string; description?: string }[]; priority?: "normal" | "high" }>();
    if (!body?.title) return c.json({ error: "Give a title." }, 400);
    return c.json(await h.createIntent({ ...body, source: { kind: "ui" } }, actorOf(c.get("principal"))));
  } catch (e) {
    return err(c, e);
  }
});

app.patch("/api/projects/:p/intents/:id", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const body = await c.req.json<{ goal?: string; constraints?: string[]; reason: string }>();
    return c.json(await h.amendIntent(c.req.param("id"), body, actorOf(c.get("principal"))));
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/intents/:id/launch", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const body = await c.req.json<{ fanout?: number; models?: string[] }>().catch(() => ({}) as Record<string, never>);
    return c.json(await h.launch(c.req.param("id"), { fanout: body.fanout, models: body.models }, actorOf(c.get("principal"))));
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/intents/:id/park", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: "" }));
    return c.json(await h.park(c.req.param("id"), body.reason ?? "", actorOf(c.get("principal"))));
  } catch (e) {
    return err(c, e);
  }
});

/* ───────────── attempts ───────────── */

app.post("/api/projects/:p/attempts/:id/land", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const body = await c.req.json<{ rationale?: string }>().catch(() => ({ rationale: "" }));
    return c.json(await h.land(c.req.param("id"), body.rationale ?? "", actorOf(c.get("principal"))));
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/attempts/:id/rederive", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: "" }));
    return c.json(await h.rederive(c.req.param("id"), body.reason || "A human asked for a re-derive.", actorOf(c.get("principal"))));
  } catch (e) {
    return err(c, e);
  }
});

app.get("/api/projects/:p/attempts/:id/diff", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    return c.json(await h.attemptDiff(c.req.param("id")));
  } catch (e) {
    return err(c, e, 404);
  }
});

app.get("/api/projects/:p/landings/:id", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    const d = await h.landingDetail(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "Unknown landing." }, 404);
  } catch (e) {
    return err(c, e, 500);
  }
});

app.get("/api/projects/:p/file", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    const text = await h.file(c.req.query("ref") ?? "main", c.req.query("path") ?? "");
    if (text === null) return c.text("Not found", 404);
    return c.text(text, 200, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  } catch (e) {
    return err(c, e, 500);
  }
});

app.get("/api/projects/:p/attempts/:id/vessel", async (c) => {
  const { id } = await access(c, c.req.param("p"), "viewer");
  const stub = c.env.VESSEL.get(c.env.VESSEL.idFromName(`${id}:${c.req.param("id")}`));
  return c.json((await stub.status()) ?? { phase: "none" });
});

/* ───────────── sample reset, launch all, simulation, settings ───────────── */

app.post("/api/projects/:p/reset", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "owner");
    const st = (await h.reset()) as unknown as T.ProjectState;
    return c.json({ ok: true, main: st.project.mainSha });
  } catch (e) {
    return err(c, e);
  }
});

/** A push project: a 24-hour write token for the owner's first `git push`. */
app.post("/api/projects/:p/push-token", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "owner");
    return c.json(await h.pushAccess());
  } catch (e) {
    return err(c, e);
  }
});

/** Look for the push (or the end of an import) now. */
app.post("/api/projects/:p/import/check", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const st = (await h.checkImport()) as unknown as T.ProjectState;
    return c.json({ importing: st.project.importing ?? null, mainSha: st.project.mainSha });
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/launch-all", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    return c.json(await h.launchAll(actorOf(c.get("principal"))));
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/sim/start", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "owner");
    const body = await c.req.json<{ agents?: number; sectors?: number; coordinate?: boolean; seconds?: number }>().catch(() => ({}));
    return c.json(await h.simStart(body));
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/sim/stop", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "owner");
    return c.json((await h.simStop()) ?? { running: false });
  } catch (e) {
    return err(c, e);
  }
});

app.get("/api/projects/:p/connect", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    return c.json(await h.connectInfo(new URL(c.req.url).origin));
  } catch (e) {
    return err(c, e);
  }
});

app.get("/api/projects/:p/settings", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    return c.json(await h.settings());
  } catch (e) {
    return err(c, e);
  }
});

app.put("/api/projects/:p/settings", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "owner");
    return c.json(await h.updateSettings(await c.req.json()));
  } catch (e) {
    return err(c, e);
  }
});

/** Operator only: diagnostics of a check container (name = "<project>:<attempt>"). */
app.get("/api/ops/drydock", async (c) => {
  if (c.get("principal").via !== "operator") return c.json({ error: "Operator key only." }, 403);
  const name = c.req.query("name") ?? "diag";
  return c.json(await c.env.DRYDOCK.get(c.env.DRYDOCK.idFromName(name)).diag({ instance: c.req.query("instance"), internet: c.req.query("internet") === "1" }));
});

/* ───────────── live events ───────────── */

app.get("/ws/:p", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("Expected a WebSocket upgrade.", 426);
  const { id } = await access(c, c.req.param("p"), "viewer");
  const url = new URL(c.req.url);
  url.searchParams.set("project", id);
  return harbor(c.env, id).fetch(new Request(url.toString(), c.req.raw));
});

/* ───────────── live previews (Dynamic Workers) ───────────── */

const previewCache = new Map<string, { key: string; files: Map<string, string> }>();

app.all("/preview/:p/:ref/*", async (c) => preview(c));
app.all("/preview/:p/:ref", async (c) => preview(c));

async function preview(c: C): Promise<Response> {
  const ref = c.req.param("ref") ?? "main";
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    const p = projectId(c.req.param("p"));
    const base = `/preview/${encodeURIComponent(p)}/${encodeURIComponent(ref)}`;
    const pf = await h.previewFiles(ref);
    if (!pf) return c.html(`<p style="font-family:system-ui;padding:2rem">No preview for ${escapeHtml(ref)}.</p>`, 404);
    let entry = previewCache.get(pf.key);
    if (!entry) {
      entry = { key: pf.key, files: new Map(Object.entries(pf.files)) };
      previewCache.set(pf.key, entry);
      if (previewCache.size > 64) previewCache.delete(previewCache.keys().next().value!);
    }
    // Agent code runs in an opaque origin: it never sees gitring's cookies or storage.
    return servePreview(c.env.LOADER, entry.key, entry.files, c.req.raw, base, { sandbox: true });
  } catch (e) {
    const status = e instanceof HTTPError ? e.status : 500;
    return c.html(`<p style="font-family:system-ui;padding:2rem">Preview error: ${escapeHtml(String((e as Error).message ?? e))}</p>`, status);
  }
}

/* ───────────── inbound hooks (other apps send input) ───────────── */

/** Any app: a member's API key (Authorization: Bearer gk_…) opens an intent, and can launch agents. */
app.post("/hooks/intents", async (c) => {
  try {
    const body = await c.req.json<{ project?: string; title: string; goal?: string; checks?: { path: string; content: string; description?: string }[]; source?: string; launch?: number }>();
    if (!body?.title) return c.json({ error: "Give a title." }, 400);
    const h = await ready(c, body.project, "member");
    const principal = c.get("principal");
    const by: T.Actor = principal.user ? actorOf(principal) : { kind: "system", id: body.source ?? "webhook", name: body.source ?? "Webhook" };
    const intent = await h.createIntent({ title: body.title, goal: body.goal ?? body.title, checks: body.checks, source: { kind: "webhook", ref: body.source ?? "webhook" } }, by);
    const launched = body.launch ? await h.launch(intent.id, { fanout: body.launch }, by) : undefined;
    return c.json({ intent, launched: launched?.attempts.map((a) => a.id) ?? [] }, 201);
  } catch (e) {
    return err(c, e);
  }
});

interface GithubIssueEvent {
  action?: string;
  issue?: { title: string; body?: string; html_url?: string; number?: number; labels?: { name: string }[] };
  repository?: { full_name?: string };
  sender?: { login?: string };
}

function gitringIssue(event: string | undefined, body: GithubIssueEvent | null): string | null {
  if (event !== "issues" || !body?.issue) return null;
  const labeled = body.issue.labels?.some((l) => l.name.toLowerCase() === "gitring");
  if (!labeled || !["opened", "labeled", "reopened"].includes(body.action ?? "")) return 'Add the label "gitring" to the issue.';
  return "";
}

/**
 * GitHub App webhook: an issue labeled "gitring" becomes an intent in each project imported from that
 * repository, when the person who labeled it is a member of the project.
 */
app.post("/hooks/github-app", async (c) => {
  const raw = await c.req.text();
  const gh = await directory(c.env).githubApp();
  if (!gh) return c.json({ error: "The GitHub App is not set up." }, 404);
  const sig = (c.req.header("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
  if (!sameString(sig, await hmacSha256Hex(gh.webhookSecret, raw))) return c.json({ error: "Bad signature." }, 401);
  const event = c.req.header("x-github-event");
  if (event === "ping") return c.json({ ok: true });
  let body: GithubIssueEvent | null = null;
  try {
    body = JSON.parse(raw) as GithubIssueEvent;
  } catch {
    return c.json({ error: "Bad JSON." }, 400);
  }
  const why = gitringIssue(event, body);
  if (why === null) return c.json({ ignored: true });
  if (why) return c.json({ ignored: true, reason: why });
  const repo = body!.repository?.full_name ?? "";
  const ids = await directory(c.env).projectsForGithubLogin(`https://github.com/${repo}`, body!.sender?.login ?? "");
  const opened: string[] = [];
  for (const id of ids) {
    const h = harbor(c.env, id);
    const intent = await h.createIntent(
      { title: body!.issue!.title, goal: body!.issue!.body || body!.issue!.title, source: { kind: "webhook", ref: `github:${repo}#${body!.issue!.number ?? ""}` } },
      { kind: "system", id: "github", name: "GitHub" },
    );
    opened.push(`${id}/${intent.id}`);
  }
  return c.json({ intents: opened }, opened.length ? 201 : 200);
});

/** A plain GitHub repository webhook (no app): needs GITHUB_WEBHOOK_SECRET and ?project=. */
app.post("/hooks/github", async (c) => {
  const event = c.req.header("x-github-event");
  const raw = await c.req.text();
  if (!c.env.GITHUB_WEBHOOK_SECRET) return c.json({ error: "Set GITHUB_WEBHOOK_SECRET, or use the gitring GitHub App." }, 404);
  const sig = (c.req.header("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
  if (!sameString(sig, await hmacSha256Hex(c.env.GITHUB_WEBHOOK_SECRET, raw))) return c.json({ error: "Bad signature." }, 401);
  if (event === "ping") return c.json({ ok: true });
  let body: GithubIssueEvent | null = null;
  try {
    body = JSON.parse(raw) as GithubIssueEvent;
  } catch {
    body = null;
  }
  const why = gitringIssue(event, body);
  if (why === null) return c.json({ ignored: true });
  if (why) return c.json({ ignored: true, reason: why });
  const id = projectId(c.req.query("project"));
  if (!(await directory(c.env).exists(id))) return c.json({ error: "Unknown project." }, 404);
  const h = harbor(c.env, id);
  await h.ensure(id);
  const intent = await h.createIntent(
    { title: body!.issue!.title, goal: body!.issue!.body || body!.issue!.title, source: { kind: "webhook", ref: `github:${body!.repository?.full_name ?? ""}#${body!.issue!.number ?? ""}` } },
    { kind: "system", id: "github", name: "GitHub" },
  );
  return c.json({ intent: intent.id }, 201);
});

/** Slack slash command: /gitring <intent title> — <goal>. Needs SLACK_SIGNING_SECRET and ?project=. */
app.post("/hooks/slack", async (c) => {
  const raw = await c.req.text();
  if (!c.env.SLACK_SIGNING_SECRET) return c.json({ error: "Set SLACK_SIGNING_SECRET to use the Slack command." }, 404);
  const ts = c.req.header("x-slack-request-timestamp") ?? "0";
  const sig = (c.req.header("x-slack-signature") ?? "").replace(/^v0=/, "");
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  if (!fresh || !sameString(sig, await hmacSha256Hex(c.env.SLACK_SIGNING_SECRET, `v0:${ts}:${raw}`))) return c.json({ error: "Bad signature." }, 401);
  const form = Object.fromEntries(new URLSearchParams(raw)) as Record<string, unknown>;
  const text = String(form.text ?? "").trim();
  const user = String(form.user_name ?? "slack");
  if (!text) return c.json({ response_type: "ephemeral", text: "Write the intent after the command: /gitring Add a dark mode — Readers can switch to a dark theme." });
  const [titleRaw, ...rest] = text.split(/\s+[—-]{1,2}\s+/);
  const title = titleRaw ?? text;
  const id = projectId(c.req.query("project"));
  if (!(await directory(c.env).exists(id))) return c.json({ response_type: "ephemeral", text: "This Slack command points to a project that does not exist. Fix ?project= in the command URL." });
  const h = harbor(c.env, id);
  await h.ensure(id);
  const intent = await h.createIntent({ title, goal: rest.join(" — ") || title, source: { kind: "webhook", ref: `slack:@${user}` } }, { kind: "system", id: "slack", name: `Slack @${user}` });
  return c.json({ response_type: "in_channel", text: `:compass: Intent opened: *${intent.title}* (${intent.id}). Agents can take it now.` });
});

/** Claude Code PostToolUse hook: corrections arrive mid-task as additional context (member API key). */
async function claudeHook(c: C, project: string | undefined) {
  try {
    const h = await ready(c, project, "member");
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    return c.json(await h.claudeHook(body as never));
  } catch {
    return c.json({});
  }
}
app.post("/hooks/claude-code", (c) => claudeHook(c, c.req.query("project")));
app.post("/hooks/claude/:p", (c) => claudeHook(c, c.req.param("p")));

/* ───────────── MCP + static assets ───────────── */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (request.method === "OPTIONS") return createMcp(env, { user: null, via: null })(request, env, ctx);
      const p = await resolvePrincipal(env, request);
      if (!p.user && p.via !== "operator") {
        return new Response(JSON.stringify({ error: "Send a personal API key: Authorization: Bearer gk_… (create one in gitring → Connect)." }), {
          status: 401,
          headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="gitring"' },
        });
      }
      return createMcp(env, p)(request, env, ctx);
    }
    const path = url.pathname;
    if (
      path.startsWith("/api/") ||
      path.startsWith("/ws/") ||
      path.startsWith("/preview/") ||
      path.startsWith("/hooks/") ||
      path.startsWith("/auth/") ||
      path === "/setup" ||
      path.startsWith("/setup/")
    ) {
      return app.fetch(request, env, ctx);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
