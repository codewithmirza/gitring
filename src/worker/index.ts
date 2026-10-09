/**
 * Bearing Worker — routes:
 *   /mcp                       MCP server for external agents (Claude Code, Codex, Cursor, …)
 *   /api/projects/:p/*         REST for the UI and other apps
 *   /ws/:p                     WebSocket → HarborMaster live events
 *   /preview/:p/:ref/*         live preview of main or an attempt (Dynamic Worker)
 *   /hooks/*                   inbound webhooks (generic, GitHub, Slack) + Claude Code PostToolUse hook
 *   everything else            the React UI (static assets, SPA)
 */
import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { mcpHandler } from "./mcp";
import { servePreview } from "../platform/checks/preview";
import type * as T from "../core/types";

export { HarborMaster } from "../harbor/harbor";
export { Vessel } from "../vessel/vessel";
export { Sector } from "../sim/sector";

type C = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

/** Project ids: lowercase letters, digits and dashes (1–40). Other names (internal objects) are refused. */
export function projectId(raw: string | undefined): string {
  const id = (raw ?? "demo").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new HTTPError(400, "Use a project id of lowercase letters, digits and dashes (at most 40).");
  return id;
}

class HTTPError extends Error {
  constructor(
    readonly status: 400 | 401 | 404,
    message: string,
  ) {
    super(message);
  }
}

function harbor(env: Env, project: string) {
  return env.HARBOR.get(env.HARBOR.idFromName(projectId(project)));
}

app.onError((e, c) => {
  if (e instanceof HTTPError) return c.json({ error: e.message }, e.status);
  console.error("unhandled", e);
  return c.json({ error: "Bearing could not finish the request. Try again." }, 500);
});

async function ready(env: Env, project: string) {
  const h = harbor(env, project);
  await h.ensure(project);
  return h;
}

/** Write access: open when BEARING_KEY is unset (demo); otherwise a bearer key. */
function authorized(c: C): boolean {
  const key = c.env.BEARING_KEY;
  if (!key) return true;
  const header = c.req.header("authorization") ?? "";
  return header === `Bearer ${key}`;
}

function deny(c: C) {
  return c.json({ error: "Missing or wrong key. Send Authorization: Bearer <BEARING_KEY>." }, 401);
}

function actor(c: C): T.Actor {
  const name = c.req.header("x-bearing-user") || "Human";
  return { kind: "human", id: name.toLowerCase().replace(/\s+/g, "-"), name };
}

function err(c: C, e: unknown, status = 400) {
  const message = String((e as Error)?.message ?? e).replace(/^Error: /, "");
  return c.json({ error: message }, status as 400);
}

/* ───────────── health ───────────── */

app.get("/api/health", async (c) =>
  c.json({
    ok: true,
    build: await harbor(c.env, c.req.query("project") ?? "demo").version().catch(() => "unknown"),
    backend: "artifacts",
    ai: Boolean(c.env.AI),
  }),
);

/* ───────────── project state + intents ───────────── */

app.get("/api/projects/:p/state", async (c) => {
  try {
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.state());
  } catch (e) {
    return err(c, e, 500);
  }
});

app.post("/api/projects/:p/intents", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const body = await c.req.json<{ title: string; goal: string; checks?: { path: string; content: string; description?: string }[]; priority?: "normal" | "high" }>();
    if (!body?.title) return c.json({ error: "Give a title." }, 400);
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.createIntent({ ...body, source: { kind: "ui" } }, actor(c)));
  } catch (e) {
    return err(c, e);
  }
});

app.patch("/api/projects/:p/intents/:id", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const body = await c.req.json<{ goal?: string; constraints?: string[]; reason: string }>();
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.amendIntent(c.req.param("id"), body, actor(c)));
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/intents/:id/launch", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const body = await c.req.json<{ fanout?: number; models?: string[] }>().catch(() => ({}) as Record<string, never>);
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.launch(c.req.param("id"), { fanout: body.fanout, models: body.models }, actor(c)));
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/intents/:id/park", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: "" }));
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.park(c.req.param("id"), body.reason ?? "", actor(c)));
  } catch (e) {
    return err(c, e);
  }
});

/* ───────────── attempts ───────────── */

app.post("/api/projects/:p/attempts/:id/land", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const body = await c.req.json<{ rationale?: string }>().catch(() => ({ rationale: "" }));
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.land(c.req.param("id"), body.rationale ?? "", actor(c)));
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/attempts/:id/rederive", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: "" }));
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.rederive(c.req.param("id"), body.reason || "A human asked for a re-derive.", actor(c)));
  } catch (e) {
    return err(c, e);
  }
});

app.get("/api/projects/:p/attempts/:id/diff", async (c) => {
  try {
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.attemptDiff(c.req.param("id")));
  } catch (e) {
    return err(c, e, 404);
  }
});

app.get("/api/projects/:p/landings/:id", async (c) => {
  try {
    const h = await ready(c.env, c.req.param("p"));
    const d = await h.landingDetail(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "Unknown landing." }, 404);
  } catch (e) {
    return err(c, e, 500);
  }
});

app.get("/api/projects/:p/file", async (c) => {
  try {
    const h = await ready(c.env, c.req.param("p"));
    const text = await h.file(c.req.query("ref") ?? "main", c.req.query("path") ?? "");
    if (text === null) return c.text("Not found", 404);
    return c.text(text, 200, { "content-type": "text/plain; charset=utf-8" });
  } catch (e) {
    return err(c, e, 500);
  }
});

app.get("/api/projects/:p/attempts/:id/vessel", async (c) => {
  const stub = c.env.VESSEL.get(c.env.VESSEL.idFromName(`${c.req.param("p")}:${c.req.param("id")}`));
  return c.json((await stub.status()) ?? { phase: "none" });
});

/* ───────────── sample reset, launch all, simulation, settings ───────────── */

app.post("/api/projects/:p/reset", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const h = harbor(c.env, c.req.param("p"));
    await h.ensure(c.req.param("p"));
    const st = (await h.reset()) as unknown as T.ProjectState;
    return c.json({ ok: true, main: st.project.mainSha });
  } catch (e) {
    return err(c, e, 500);
  }
});

app.post("/api/projects/:p/launch-all", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.launchAll(actor(c)));
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/sim/start", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const body = await c.req.json<{ agents?: number; sectors?: number; coordinate?: boolean; seconds?: number }>().catch(() => ({}));
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.simStart(body));
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/sim/stop", async (c) => {
  if (!authorized(c)) return deny(c);
  const h = await ready(c.env, c.req.param("p"));
  return c.json((await h.simStop()) ?? { running: false });
});

app.get("/api/projects/:p/connect", async (c) => {
  const h = await ready(c.env, c.req.param("p"));
  return c.json(await h.connectInfo(new URL(c.req.url).origin));
});

app.get("/api/projects/:p/settings", async (c) => {
  const h = await ready(c.env, c.req.param("p"));
  return c.json(await h.settings());
});

app.put("/api/projects/:p/settings", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const h = await ready(c.env, c.req.param("p"));
    return c.json(await h.updateSettings(await c.req.json()));
  } catch (e) {
    return err(c, e);
  }
});

/* ───────────── live events ───────────── */

app.get("/ws/:p", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("Expected a WebSocket upgrade.", 426);
  const p = c.req.param("p");
  const url = new URL(c.req.url);
  url.searchParams.set("project", p);
  return harbor(c.env, p).fetch(new Request(url.toString(), c.req.raw));
});

/* ───────────── live previews (Dynamic Workers) ───────────── */

const previewCache = new Map<string, { key: string; files: Map<string, string> }>();

app.all("/preview/:p/:ref/*", async (c) => preview(c));
app.all("/preview/:p/:ref", async (c) => preview(c));

async function preview(c: C): Promise<Response> {
  const p = c.req.param("p") ?? "demo";
  const ref = c.req.param("ref") ?? "main";
  const base = `/preview/${encodeURIComponent(p)}/${encodeURIComponent(ref)}`;
  try {
    const h = await ready(c.env, p);
    const pf = await h.previewFiles(ref);
    if (!pf) return c.html(`<p style="font-family:system-ui;padding:2rem">No preview for ${escapeHtml(ref)}.</p>`, 404);
    let entry = previewCache.get(pf.key);
    if (!entry) {
      entry = { key: pf.key, files: new Map(Object.entries(pf.files)) };
      previewCache.set(pf.key, entry);
      if (previewCache.size > 64) previewCache.delete(previewCache.keys().next().value!);
    }
    return servePreview(c.env.LOADER, entry.key, entry.files, c.req.raw, base);
  } catch (e) {
    return c.html(`<p style="font-family:system-ui;padding:2rem">Preview error: ${escapeHtml(String(e))}</p>`, 500);
  }
}

/* ───────────── inbound hooks (other apps send input) ───────────── */

app.post("/hooks/intents", async (c) => {
  if (!authorized(c)) return deny(c);
  try {
    const body = await c.req.json<{ project?: string; title: string; goal?: string; checks?: { path: string; content: string; description?: string }[]; source?: string; launch?: number }>();
    if (!body?.title) return c.json({ error: "Give a title." }, 400);
    const p = body.project ?? "demo";
    const h = await ready(c.env, p);
    const intent = await h.createIntent(
      { title: body.title, goal: body.goal ?? body.title, checks: body.checks, source: { kind: "webhook", ref: body.source ?? "webhook" } },
      { kind: "system", id: body.source ?? "webhook", name: body.source ?? "Webhook" },
    );
    const launched = body.launch ? await h.launch(intent.id, { fanout: body.launch }, { kind: "system", id: body.source ?? "webhook", name: body.source ?? "Webhook" }) : undefined;
    return c.json({ intent, launched: launched?.attempts.map((a) => a.id) ?? [] }, 201);
  } catch (e) {
    return err(c, e);
  }
});

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hooks that cannot send a header (GitHub, Slack) may carry the key as ?key= when no signing secret is set. */
function hookKeyOk(c: C): boolean {
  const key = c.env.BEARING_KEY;
  if (!key) return true;
  return authorized(c) || c.req.query("key") === key;
}

/** Constant-time compare of two hex strings. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** GitHub: issues opened or labeled with "bearing" become intents. */
app.post("/hooks/github", async (c) => {
  const event = c.req.header("x-github-event");
  const raw = await c.req.text();
  if (c.env.GITHUB_WEBHOOK_SECRET) {
    const sig = (c.req.header("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
    if (!sameHex(sig, await hmacHex(c.env.GITHUB_WEBHOOK_SECRET, raw))) return c.json({ error: "Bad signature." }, 401);
  } else if (!hookKeyOk(c)) return deny(c);
  let body: { action?: string; issue?: { title: string; body?: string; html_url?: string; number?: number; labels?: { name: string }[] }; repository?: { full_name?: string } } | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (event === "ping") return c.json({ ok: true });
  if (event !== "issues" || !body?.issue) return c.json({ ignored: true });
  const labeled = body.issue.labels?.some((l) => l.name.toLowerCase() === "bearing");
  if (!labeled || !["opened", "labeled", "reopened"].includes(body.action ?? "")) return c.json({ ignored: true, reason: 'Add the label "bearing" to the issue.' });
  const project = c.req.query("project") ?? "demo";
  const h = await ready(c.env, project);
  const intent = await h.createIntent(
    { title: body.issue.title, goal: body.issue.body || body.issue.title, source: { kind: "webhook", ref: `GitHub ${body.repository?.full_name ?? ""}#${body.issue.number ?? ""}` } },
    { kind: "system", id: "github", name: "GitHub" },
  );
  return c.json({ intent: intent.id }, 201);
});

/** Slack slash command: /bearing <intent title> — <goal> */
app.post("/hooks/slack", async (c) => {
  const raw = await c.req.text();
  if (!c.env.SLACK_SIGNING_SECRET && !hookKeyOk(c)) return deny(c);
  if (c.env.SLACK_SIGNING_SECRET) {
    const ts = c.req.header("x-slack-request-timestamp") ?? "0";
    const sig = (c.req.header("x-slack-signature") ?? "").replace(/^v0=/, "");
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
    if (!fresh || !sameHex(sig, await hmacHex(c.env.SLACK_SIGNING_SECRET, `v0:${ts}:${raw}`))) return c.json({ error: "Bad signature." }, 401);
  }
  const form = Object.fromEntries(new URLSearchParams(raw)) as Record<string, unknown>;
  const text = String(form.text ?? "").trim();
  const user = String(form.user_name ?? "slack");
  if (!text) return c.json({ response_type: "ephemeral", text: "Write the intent after the command: /bearing Add a dark mode — Readers can switch to a dark theme." });
  const [titleRaw, ...rest] = text.split(/\s+[—-]{1,2}\s+/);
  const title = titleRaw ?? text;
  const project = c.req.query("project") ?? "demo";
  const h = await ready(c.env, project);
  const intent = await h.createIntent({ title, goal: rest.join(" — ") || title, source: { kind: "webhook", ref: `Slack @${user}` } }, { kind: "human", id: user, name: user });
  return c.json({ response_type: "in_channel", text: `:compass: Intent opened: *${intent.title}* (${intent.id}). Agents can take it now.` });
});

/** Claude Code PostToolUse hook: corrections arrive mid-task as additional context. */
async function claudeHook(c: C, project: string) {
  if (!authorized(c)) return c.json({});
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  try {
    const h = await ready(c.env, project);
    return c.json(await h.claudeHook(body as never));
  } catch {
    return c.json({});
  }
}
app.post("/hooks/claude-code", (c) => claudeHook(c, c.req.query("project") ?? "demo"));
app.post("/hooks/claude/:p", (c) => claudeHook(c, c.req.param("p")));

/* ───────────── MCP + static assets ───────────── */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (env.BEARING_KEY && request.method !== "OPTIONS" && request.headers.get("authorization") !== `Bearer ${env.BEARING_KEY}`) {
        return new Response(JSON.stringify({ error: "Missing or wrong key." }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return mcpHandler(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/") || url.pathname.startsWith("/preview/") || url.pathname.startsWith("/hooks/")) {
      return app.fetch(request, env, ctx);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
