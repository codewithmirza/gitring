/**
 * gitring Worker — routes:
 *   /mcp                       MCP server for external agents (OAuth or a personal API key)
 *   /mcp/github                the same, with GitHub-compatible tools (src/worker/mcp-github.ts)
 *   /mcp/readonly              the same, with the tools that only read
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
import { createMcp, toolSet } from "./mcp";
import { retryAfterReset } from "./mcp-kit";
import { servePreview } from "../platform/checks/preview";
import type * as T from "../core/types";
import type * as A from "../core/accounts";
import { atLeast, PROJECT_ID } from "../core/accounts";
import { isTimelineCursor, timelineLimit } from "../core/timeline";
import { actorOf, authRoutes, closeUserSockets, directory, forgetPrincipal, resolvePrincipal, type Principal } from "./auth";
import { mcpChallenge, mcpScopeChallenge, oauthRoutes } from "./oauth";
import { MCP_PATH, mcpSetOf, resourceOf, SCOPE, SCOPE_READ, type McpSet } from "../directory/oauth";
import { githubRoutes } from "./github";
import { hmacSha256Hex, sameString } from "../directory/crypto";
import { githubRepoName } from "../core/repo-rules";
import { isCrossSiteWrite } from "./csrf";
import { clientAddress, hasCredential, hookLimitKey, hookUrlKey, limitFor, overLimit, tooMany } from "./limits";
import { cloneHelp, createProjectFor, ProjectError, type CreateProjectInput } from "./projects";
import { forgetRoles, roleOf } from "./roles";
import type { SeedFile } from "../harbor/harbor";
import { historyRoutes } from "./history-routes";

export { HarborMaster } from "../harbor/harbor";
import { hookKey, viewerState } from "../harbor/harbor";
import { BUILD_ID } from "../harbor/harbor";
export { Vessel } from "../vessel/vessel";
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

/** The object of a project. A call that fails because the platform restarted the object is sent again (see retryAfterReset). */
function harbor(env: Env, project: string) {
  const id = env.HARBOR.idFromName(projectId(project));
  return retryAfterReset(() => env.HARBOR.get(id));
}

app.onError((e, c) => {
  if (e instanceof HTTPError) return c.json({ error: e.message }, e.status);
  console.error("unhandled", e);
  return c.json({ error: "gitring could not finish the request. Try again." }, 500);
});

/* ───────────── who is calling ───────────── */

app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const kind = limitFor(c.req.method, path);
  // Sign-in and OAuth endpoints, and live previews, are limited per address before any lookup.
  if ((kind === "auth" || kind === "token" || kind === "preview") && (await overLimit(c.env, kind, clientAddress(c.req.raw)))) return tooMany(60, kind === "token");
  // Credential lookups are limited per address before the lookup, on every route: keys and cookies that are
  // not valid are never cached, so a flood of them must stop here and not at the account store. The key in
  // a hook URL is a credential too (gitring compares it with the project's key).
  if ((hasCredential(c.req.raw) || (kind === "hook" && hookUrlKey(c.req.raw))) && (await overLimit(c.env, "cred", clientAddress(c.req.raw)))) return tooMany();
  const p = await resolvePrincipal(c.env, c.req.raw);
  if (p.badKey) return c.json({ error: "The API key is not valid. Create a new key in gitring (Account → API keys)." }, 401);
  c.set("principal", p);
  const who = p.user?.id ?? (p.via === "operator" ? "operator" : null);
  if (kind === "api" && (await overLimit(c.env, "api", who ?? clientAddress(c.req.raw)))) return tooMany();
  if (kind === "hook" && (await overLimit(c.env, "hook", await hookLimitKey(c.req.raw, who)))) return tooMany();
  // A browser session may only change state from gitring's own pages (no cross-site requests).
  if (p.via === "session" && isCrossSiteWrite(c.req.method, c.req.header("origin"), c.req.header("sec-fetch-site"), new URL(c.req.url).origin)) {
    return c.json({ error: "Cross-site requests are not allowed." }, 403);
  }
  await next();
  // Defaults for every Worker answer (pages set stricter ones themselves). Answers that came from
  // another object (WebSocket upgrades, previews) have fixed headers: leave them.
  if (c.res.status === 101) return;
  try {
    const h = c.res.headers;
    if (!h.has("x-content-type-options")) h.set("x-content-type-options", "nosniff");
    if (!h.has("referrer-policy")) h.set("referrer-policy", "strict-origin-when-cross-origin");
    if (path.startsWith("/api/") && !h.has("cache-control")) h.set("cache-control", "private, no-store");
  } catch {
    /* immutable headers */
  }
});

/** The caller's role on a project; refuse when it is below `need`. */
async function access(c: C, raw: string | undefined, need: A.Role): Promise<{ id: string; role: A.Role }> {
  const id = projectId(raw);
  const p = c.get("principal");
  if (p.via === "operator") return { id, role: "owner" };
  const role = await roleOf(c.env, id, p.user?.id ?? null);
  if (!role) throw new HTTPError(p.user ? 404 : 401, p.user ? "This project does not exist, or you have no access to it." : "Sign in to open this project.");
  if (!atLeast(role, need)) {
    throw new HTTPError(p.user ? 403 : 401, p.user ? `You need the ${need} role on this project. Ask an owner.` : "Sign in to do this.");
  }
  return { id, role };
}

/** Projects that this isolate saw ready: later requests skip the check (one round trip less). */
const readyProjects = new Set<string>();

async function ready(c: C, raw: string | undefined, need: A.Role) {
  const { id, role } = await access(c, raw, need);
  const h = harbor(c.env, id);
  if (!readyProjects.has(id)) {
    await h.ensure(id);
    if (readyProjects.size > 5000) readyProjects.clear();
    readyProjects.add(id);
  }
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
    build: BUILD_ID,
    backend: "artifacts",
    ai: Boolean(c.env.AI),
    signIn: await directory(c.env)
      .providers()
      .then((p) => ({ github: Boolean(p.github), google: Boolean(p.google) }))
      .catch(() => ({ github: false, google: false })),
  }),
);

authRoutes(app);
oauthRoutes(app);
githubRoutes(app);

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
  const user = needUser(c);
  const ok = await directory(c.env).revokeKey(user.id, c.req.param("id"));
  if (ok) {
    forgetPrincipal({ userId: user.id });
    // A script that watched a project with this key connects again, and the key fails then.
    c.executionCtx.waitUntil(closeUserSockets(c.env, user.id, 4401));
  }
  return ok ? c.body(null, 204) : c.json({ error: "Unknown key." }, 404);
});

/* ───────────── the person: preferences, inbox, push ───────────── */

app.get("/api/me/prefs", async (c) => c.json(await directory(c.env).prefs(needUser(c).id)));

/**
 * Where the person answers merge questions (contract C3). A key can only make the rule strict ("app"). Only the
 * person in the gitring app (a browser session) can choose another place: an agent that holds the key must not
 * loosen the rule, or stop the push notifications of merge questions ("agent").
 */
app.put("/api/me/prefs", async (c) => {
  try {
    const user = needUser(c);
    const body = await c.req.json<Partial<A.PersonPrefs>>().catch(() => ({}) as Partial<A.PersonPrefs>);
    const dir = directory(c.env);
    if (body.approvalsIn !== undefined && body.approvalsIn !== "app" && c.get("principal").via !== "session" && (await dir.prefs(user.id)).approvalsIn !== body.approvalsIn) {
      throw new HTTPError(403, "Only you can change this, in the gitring app. A key can only choose \"In the gitring app\".");
    }
    return c.json(await dir.setPrefs(user.id, body.approvalsIn !== undefined ? { approvalsIn: body.approvalsIn } : {}));
  } catch (e) {
    return err(c, e);
  }
});

/**
 * The inbox of the person (contract C4): what waits for them in every project where they may act, oldest first.
 * A project that does not answer now (it imports, or it restarts) is left out of this answer.
 */
app.get("/api/me/inbox", async (c) => {
  const user = needUser(c);
  const projects = (await directory(c.env).listProjects(user.id)).filter((p) => atLeast(p.role, "member"));
  const lists = await Promise.all(
    projects.map(async (p) => {
      try {
        const items = await harbor(c.env, p.id).inbox({ id: user.id, role: p.role as A.Role });
        return items.map((x) => ({ ...x, projectName: p.name }));
      } catch {
        return [];
      }
    }),
  );
  return c.json({ items: lists.flat().sort((a, b) => a.at - b.at), at: Date.now() });
});

/** Push notifications for the inbox: available on this gitring, the public key for the browser, and the devices of the person. */
app.get("/api/me/push", async (c) => c.json(await directory(c.env).pushStatus(needUser(c).id)));

/** A device of the person gets push notifications. Only in the gitring app: the browser gives the push address. */
app.post("/api/me/push", async (c) => {
  try {
    const user = needUser(c);
    if (c.get("principal").via !== "session") throw new HTTPError(403, "Turn on push notifications in the gitring app.");
    const body = await c.req.json<{ endpoint?: unknown }>().catch(() => ({}) as { endpoint?: unknown });
    if (typeof body.endpoint !== "string") throw new HTTPError(400, "Give endpoint: the push address of the browser.");
    return c.json(await directory(c.env).pushSubscribe(user.id, body.endpoint), 201);
  } catch (e) {
    return err(c, e);
  }
});

/**
 * A device stops push notifications. Without an endpoint, every device of the person stops. Only in the gitring
 * app: an agent that holds the key must not stop the notifications of the person.
 */
app.delete("/api/me/push", async (c) => {
  try {
    const user = needUser(c);
    if (c.get("principal").via !== "session") throw new HTTPError(403, "Turn off push notifications in the gitring app.");
    const body = await c.req.json<{ endpoint?: unknown }>().catch(() => ({}) as { endpoint?: unknown });
    return c.json(await directory(c.env).pushUnsubscribe(user.id, typeof body.endpoint === "string" ? body.endpoint : undefined));
  } catch (e) {
    return err(c, e);
  }
});

/* ───────────── projects ───────────── */

app.get("/api/projects", async (c) => {
  const p = c.get("principal");
  return c.json(await directory(c.env).listProjects(p.user?.id ?? null, p.via === "operator"));
});

/**
 * A new project (contract C5: the same code as the MCP tool gitring_create_project). The source is a
 * template, empty, an upload, a push, any git URL, or a GitHub repository. Optional: the tests, the first
 * task, and built-in agents that start on it.
 */
app.post("/api/projects", async (c) => {
  const principal = c.get("principal");
  // People own their projects. The operator key (scripts) makes projects that no person owns.
  if (principal.via !== "operator") needUser(c);
  const body = await c.req.json<CreateProjectInput>().catch(() => ({}) as CreateProjectInput);
  try {
    const out = await createProjectFor(c.env, principal, body);
    forgetRoles(out.project.id);
    return c.json(out, 201);
  } catch (e) {
    if (e instanceof ProjectError) return c.json({ error: e.message, ...e.extra }, e.status);
    return err(c, e);
  }
});

app.get("/api/projects/:p", async (c) => {
  const { id } = await access(c, c.req.param("p"), "viewer");
  return c.json(await directory(c.env).project(id, c.get("principal").user?.id ?? null));
});

app.patch("/api/projects/:p", async (c) => {
  const { id } = await access(c, c.req.param("p"), "owner");
  const body = await c.req.json<{ name?: string; visibility?: A.Visibility }>().catch(() => ({}) as { name?: string; visibility?: A.Visibility });
  try {
    // Code of a private GitHub repository never goes into a public project: not while the repository is
    // linked, and not after an unlink or a relink (the code stays in main).
    if (body.visibility === "public") {
      const info = await directory(c.env).project(id, c.get("principal").user?.id ?? null);
      const facts = await harbor(c.env, id)
        .githubFacts()
        .catch(() => ({}) as { private?: boolean; privateCode?: boolean });
      if ((info?.source.kind === "github" && info.source.private) || facts.private || facts.privateCode) {
        return c.json({ error: "This project holds code of a private GitHub repository. It stays private." }, 400);
      }
    }
    const out = await directory(c.env).updateProject(id, body);
    forgetRoles(id);
    // A project that became private: people who only watched it connect again and get the answer "sign in" or "no access".
    if (body.visibility === "private") await harbor(c.env, id).closeSockets({ viewers: true }).catch(() => undefined);
    return c.json(out);
  } catch (e) {
    return err(c, e);
  }
});

app.delete("/api/projects/:p", async (c) => {
  const { id } = await access(c, c.req.param("p"), "owner");
  try {
    await directory(c.env).archiveProject(id);
    forgetRoles(id);
    readyProjects.delete(id);
    await harbor(c.env, id).closeSockets({ all: true }).catch(() => undefined);
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
    const out = await directory(c.env).addMember(id, body.who ?? "", body.role ?? "member");
    forgetRoles(id);
    const who = String(body.who ?? "").trim().replace(/^@/, "").toLowerCase();
    const changed = out.find((m) => m.userId && m.handle.toLowerCase() === who)?.userId;
    if (changed) {
      const h = harbor(c.env, id);
      // The person's live connections connect again with the new role.
      await h.closeSockets({ userId: changed }).catch(() => undefined);
      // A viewer does not act for the project: when gitring checked this person's GitHub rights for the
      // link, it stops doing so.
      if (body.role === "viewer") await h.githubActorLeft(changed).catch(() => undefined);
    }
    return c.json(out);
  } catch (e) {
    return err(c, e);
  }
});

app.delete("/api/projects/:p/members/:who", async (c) => {
  const { id } = await access(c, c.req.param("p"), "owner");
  try {
    const who = c.req.param("who");
    const leaving = (await directory(c.env).members(id)).find((m) => m.userId && (m.userId === who || m.handle.toLowerCase() === who.toLowerCase()))?.userId;
    const out = await directory(c.env).removeMember(id, who);
    forgetRoles(id);
    if (leaving) {
      const h = harbor(c.env, id);
      // Their live connections close now (a private project stops streaming to them at once); gitring
      // also stops checking their GitHub rights for the link.
      await h.closeSockets({ userId: leaving }).catch(() => undefined);
      await h.githubActorLeft(leaving).catch(() => undefined);
    }
    return c.json(out);
  } catch (e) {
    return err(c, e);
  }
});

/* ───────────── project state + intents ───────────── */

app.get("/api/projects/:p/state", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    const st = (await h.state()) as unknown as T.ProjectState;
    // Viewers of a public project do not get member-only settings (webhook addresses).
    return c.json({ ...(h.role === "viewer" ? viewerState(st) : st), access: h.role });
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
    // A person merges work. A key or an agent token cannot do it for a person: an agent could say yes to its own work.
    if (c.get("principal").via !== "session") throw new HTTPError(403, "A person must merge in the gitring app. A key or an agent token cannot do it for a person.");
    const body = await c.req.json<{ rationale?: string }>().catch(() => ({ rationale: "" }));
    // A work copy that waits for a yes is answered by that person (or an owner): the rules of the approval apply here too.
    const res = await h.land(c.req.param("id"), body.rationale ?? "", actorOf(c.get("principal")), h.role);
    return res.refused ? c.json({ error: res.message }, 403) : c.json(res);
  } catch (e) {
    return err(c, e);
  }
});

/**
 * A person answers the approval of a work copy: "approve" or "send-back" (with a note). Only a person in the
 * gitring app can answer: a browser session. A personal key or an OAuth token belongs to an agent, and an
 * agent cannot say yes for the person. `approvalId` is the question that the person saw.
 */
app.post("/api/projects/:p/attempts/:id/decide", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const principal = c.get("principal");
    if (principal.via !== "session" || !principal.user) {
      throw new HTTPError(403, "A person must answer in the gitring app. A key or an agent token cannot say yes for a person.");
    }
    const body = await c.req.json<{ approvalId?: string; answer?: string; note?: string }>().catch(() => ({}) as { approvalId?: string; answer?: string; note?: string });
    if (body.answer !== "approve" && body.answer !== "send-back") throw new HTTPError(400, 'Give answer: "approve" or "send-back".');
    if (!body.approvalId || typeof body.approvalId !== "string") throw new HTTPError(400, "Give approvalId: the id of the question that you saw.");
    const res = await h.decide(
      c.req.param("id"),
      { answer: body.answer, note: typeof body.note === "string" ? body.note : undefined },
      { id: principal.user.id, name: principal.user.name, role: h.role },
      "app",
      { approvalId: body.approvalId },
      new URL(c.req.url).origin,
    );
    return c.json(res, res.outcome === "refused" ? 403 : 200);
  } catch (e) {
    return err(c, e);
  }
});

/**
 * A person answers a question (an escalated conflict check, or work that did not merge). Only in the gitring
 * app, as for approvals: a key or an agent token cannot answer for the person.
 */
app.post("/api/projects/:p/questions/:id/answer", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const principal = c.get("principal");
    if (principal.via !== "session" || !principal.user) throw new HTTPError(403, "A person must answer in the gitring app. A key or an agent token cannot answer for a person.");
    const body = await c.req.json<{ option?: unknown; note?: unknown }>().catch(() => ({}) as { option?: unknown; note?: unknown });
    if (typeof body.option !== "string" || !body.option) throw new HTTPError(400, "Give option: the id of your answer.");
    const res = await h.answerQuestion(
      c.req.param("id"),
      { option: body.option, note: typeof body.note === "string" ? body.note : undefined },
      { id: principal.user.id, name: principal.user.name, role: h.role },
      new URL(c.req.url).origin,
    );
    return c.json(res, res.outcome === "refused" ? 403 : 200);
  } catch (e) {
    return err(c, e);
  }
});

/**
 * A person asks the agent to change some lines of its work (a line comment on the diff). The agent gets a
 * change request in the answer of its next call. Only a person in the gitring app can send it.
 */
app.post("/api/projects/:p/attempts/:id/requests", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const principal = c.get("principal");
    if (principal.via !== "session" || !principal.user) throw new HTTPError(403, "A person asks for a change in the gitring app. A key or an agent token cannot do it.");
    const body = await c.req.json<{ path?: unknown; from?: unknown; to?: unknown; text?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    const corr = await h.requestChange(
      c.req.param("id"),
      { path: String(body.path ?? ""), from: Number(body.from), to: Number(body.to ?? body.from), text: String(body.text ?? "") },
      { id: principal.user.id, name: principal.user.name },
    );
    return c.json(corr, 201);
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/attempts/:id/rederive", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: "" }));
    return c.json(await h.rederive(c.req.param("id"), body.reason || "A person asked for a redo on the new main.", actorOf(c.get("principal"))));
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

/**
 * The whole history of the project, oldest first, a page at a time (the Replay view reads it):
 * ?after=<the `next` cursor of the page before>&limit=<1–2000, default 500>. Viewers of a public project
 * may read it: it has what the live state shows them.
 */
app.get("/api/projects/:p/events", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    const after = c.req.query("after") || null;
    if (after !== null && !isTimelineCursor(after)) throw new HTTPError(400, "Give `after` as the `next` cursor of an earlier page.");
    return c.json(await h.events(after, timelineLimit(c.req.query("limit"))));
  } catch (e) {
    return err(c, e, 500);
  }
});

app.get("/api/projects/:p/landings/:id", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    const d = await h.landingDetail(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "Unknown merge." }, 404);
  } catch (e) {
    return err(c, e, 500);
  }
});

/*
 * Files of a ref, for the code view. A commit id never changes: the browser keeps the answer for a year.
 * main and work copies change: the browser asks again with If-None-Match and gets 304 when nothing moved.
 */
function cacheHeaders(ref: string, etag: string): Record<string, string> {
  const immutable = /^[0-9a-f]{40}$/.test(ref);
  return { etag, "cache-control": immutable ? "private, max-age=31536000, immutable" : "private, no-cache", vary: "Cookie, Authorization" };
}

function notModified(c: C, etag: string): boolean {
  const inm = c.req.header("if-none-match") ?? "";
  return inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

app.get("/api/projects/:p/tree", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    const ref = c.req.query("ref") ?? "main";
    const version = await h.refVersion(ref);
    if (!version) return c.json({ error: `Unknown ref ${ref}.` }, 404);
    const etag = `"t-${version}"`;
    if (notModified(c, etag)) return c.body(null, 304, cacheHeaders(ref, etag));
    return c.json(await h.tree(ref), 200, cacheHeaders(ref, etag));
  } catch (e) {
    return err(c, e);
  }
});

app.get("/api/projects/:p/file", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    const ref = c.req.query("ref") ?? "main";
    const path = c.req.query("path") ?? "";
    const version = await h.refVersion(ref);
    const etag = version ? `"f-${version}-${await shortHash(path)}"` : "";
    if (etag && notModified(c, etag)) return c.body(null, 304, cacheHeaders(ref, etag));
    const text = await h.file(ref, path);
    if (text === null) return c.text("Not found", 404);
    return c.text(text, 200, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...(etag ? cacheHeaders(ref, etag) : { "cache-control": "private, no-cache" }) });
  } catch (e) {
    return err(c, e, 500);
  }
});

/* History questions: why a line is there, the changes of a file, a search of main, a compare of two versions. */
historyRoutes(app, { ready, err });

async function shortHash(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d.subarray(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Built-in agent status: phase, step, last error. Members only: it shows model replies. */
app.get("/api/projects/:p/attempts/:id/vessel", async (c) => {
  const { id } = await access(c, c.req.param("p"), "member");
  const stub = c.env.VESSEL.get(c.env.VESSEL.idFromName(`${id}:${c.req.param("id")}`));
  return c.json((await stub.status()) ?? { phase: "none" });
});

/* ───────────── push token, imports, launch all, settings ───────────── */

/** A push project: a 24-hour write token for the owner's first `git push`. */
app.post("/api/projects/:p/push-token", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "owner");
    return c.json(await h.pushAccess());
  } catch (e) {
    return err(c, e);
  }
});

/** A member clones the project with plain git: a 6-hour read token, sent in a header (never in the URL). */
app.post("/api/projects/:p/clone-token", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    const project = projectId(c.req.param("p"));
    return c.json(cloneHelp(await h.cloneAccess(), project));
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

/** GitHub sync status (members) and Sync now (owners). */
app.get("/api/projects/:p/github", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    return c.json(await h.githubStatus());
  } catch (e) {
    return err(c, e);
  }
});

app.post("/api/projects/:p/github/sync", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "owner");
    return c.json(await h.githubSync());
  } catch (e) {
    return err(c, e);
  }
});

/** Bring GitHub changes into main now (members). */
app.post("/api/projects/:p/github/pull", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "member");
    return c.json(await h.githubPull({ reason: "manual" }));
  } catch (e) {
    return err(c, e);
  }
});

app.get("/api/projects/:p/connect", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "viewer");
    const info = await h.connectInfo(new URL(c.req.url).origin);
    if (atLeast(h.role, "member")) return c.json(info);
    // Viewers get the public addresses only: no repository names, and no hook URLs with keys.
    const { artifacts: _artifacts, slackUrl: _slack, githubHookUrl: _github, ...pub } = info;
    return c.json({ ...pub, artifacts: { namespace: "", repo: "", backend: info.artifacts.backend } });
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

/** The settings that decide when a person must say yes before a merge. */
const APPROVAL_SETTINGS = ["landing", "approver", "autoLand", "allowUntested"] as const;

app.put("/api/projects/:p/settings", async (c) => {
  try {
    const h = await ready(c, c.req.param("p"), "owner");
    const body = await c.req.json<Partial<T.ProjectSettings>>().catch(() => ({}) as Partial<T.ProjectSettings>);
    // These settings decide when a person must say yes before a merge. A person changes them in the gitring app:
    // an agent with a key must not switch the question off.
    const caller = c.get("principal");
    if (caller.via !== "session" && caller.via !== "operator" && APPROVAL_SETTINGS.some((k) => body && typeof body === "object" && k in body)) {
      throw new HTTPError(403, "A person must change this setting in the gitring app. A key or an agent token cannot change when a person says yes to a merge.");
    }
    const raw = body?.github && typeof body.github === "object" ? (body.github as unknown as Record<string, unknown>) : undefined;
    if (raw) {
      // The GitHub settings after this change (a field that the patch leaves out keeps its value).
      const current = (await h.settings()).github;
      let repo = current.repo;
      if ("repo" in raw) {
        const text = typeof raw.repo === "string" ? raw.repo.trim() : "";
        repo = text ? (githubRepoName(text) ?? undefined) : undefined;
        if (text && !repo) return c.json({ error: "Give the GitHub repository as owner/name, or as its https://github.com URL." }, 400);
        body.github = { ...(body.github as T.GithubSettings), repo: repo ?? "" };
      }
      const mode = typeof raw.mode === "string" ? raw.mode : current.mode;
      const branch = typeof raw.branch === "string" ? raw.branch.trim() : current.branch;
      const base = "base" in raw ? (typeof raw.base === "string" ? raw.base.trim() : "") : (current.base ?? "");
      const relinked = Boolean(repo) && repo!.toLowerCase() !== current.repo?.toLowerCase();
      // Pushing needs a person who can push on GitHub now: turning sync on, or changing where or how it
      // goes (the mode, the pull request branch, the base branch).
      const pushes = Boolean(repo) && mode !== "off" && (relinked || current.mode === "off" || mode !== current.mode || branch !== current.branch || base !== (current.base ?? ""));
      const principal = c.get("principal");
      if (repo && principal.via !== "operator") {
        // The person behind the link left the project: the owner who saves the settings takes their place.
        const facts = await h.githubFacts().catch(() => ({}) as Awaited<ReturnType<typeof h.githubFacts>>);
        const actorGone = Boolean(facts.actor?.gone) && facts.repo?.toLowerCase() === repo.toLowerCase();
        if (relinked || pushes || actorGone) {
          const user = needUser(c);
          const perm = await directory(c.env).githubPermission(user.id, repo);
          const needPush = pushes || (actorGone && mode !== "off");
          if (needPush && !perm.installed) return c.json({ error: `Install the gitring GitHub App on ${repo} first.`, ...(perm.installUrl ? { installUrl: perm.installUrl } : {}) }, 403);
          if (needPush && !perm.push) return c.json({ error: perm.message }, 403);
          if (!perm.read) return c.json({ error: perm.message, ...(perm.installUrl ? { installUrl: perm.installUrl } : {}) }, 403);
          // A public project links a repository only when GitHub says that it is public.
          if (perm.private !== false && (await directory(c.env).visibilityOf(projectId(c.req.param("p")))) === "public") {
            const why = perm.private ? `${repo} is private on GitHub, and this project is public.` : `gitring could not find out whether ${repo} is private on GitHub.`;
            return c.json({ error: `${why} Make the project private first.` }, 400);
          }
          const out = await h.updateSettings(body);
          await h.setGithubActor(user.id, { read: perm.read, push: perm.push, ...(perm.private !== undefined ? { private: perm.private } : {}) });
          return c.json(out);
        }
      }
    }
    return c.json(await h.updateSettings(body));
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
  const { id, role } = await access(c, c.req.param("p"), "viewer");
  const url = new URL(c.req.url);
  url.searchParams.set("project", id);
  url.searchParams.set("role", role);
  // The person behind the socket: a change of their access closes it (see closeSockets).
  url.searchParams.set("user", c.get("principal").user?.id ?? "");
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
  repository?: { full_name?: string; private?: boolean };
  sender?: { login?: string; id?: number };
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
  // An app made for localhost has no webhook and no webhook secret: refuse every delivery.
  if (!gh.webhookSecret) return c.json({ error: "The GitHub App has no webhook." }, 404);
  const sig = (c.req.header("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
  if (!sameString(sig, await hmacSha256Hex(gh.webhookSecret, raw))) return c.json({ error: "Bad signature." }, 401);
  const event = c.req.header("x-github-event");
  if (event === "ping") return c.json({ ok: true });
  // GitHub may deliver one event twice (retries, manual redelivery): handle each delivery once.
  if (!(await directory(c.env).firstDelivery(c.req.header("x-github-delivery") ?? ""))) return c.json({ ignored: true, reason: "Delivery handled already." });
  if (event === "push") {
    // A push to the default branch: projects that link the repository bring the changes into main.
    let push: { ref?: string; repository?: { full_name?: string; default_branch?: string } } = {};
    try {
      push = JSON.parse(raw);
    } catch {
      return c.json({ error: "Bad JSON." }, 400);
    }
    const repo = push.repository?.full_name ?? "";
    if (!repo || !push.ref?.startsWith("refs/heads/")) return c.json({ ignored: true, reason: "Not a branch." });
    const ids = await directory(c.env).githubLinkedProjects(repo);
    // Each project follows one branch (default: the repository's default branch); it ignores the others.
    for (const id of ids) {
      c.executionCtx.waitUntil(
        harbor(c.env, id)
          .githubPull({ reason: "webhook", ref: push.ref, defaultBranch: push.repository?.default_branch })
          .catch((e) => console.warn("github pull failed", id, String(e))),
      );
    }
    return c.json({ projects: ids.length }, ids.length ? 202 : 200);
  }
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
  const ids = await directory(c.env).projectsForGithubLogin(`https://github.com/${repo}`, body!.sender?.login ?? "", body!.sender?.id);
  const opened: string[] = [];
  const refused: string[] = [];
  // An issue of a private repository is private too: it goes only into a private project whose link
  // holder can read the repository now (the project decides).
  for (const id of ids) {
    const issue = { repo, private: body!.repository?.private, title: body!.issue!.title, goal: body!.issue!.body || body!.issue!.title, number: body!.issue!.number };
    const res = await harbor(c.env, id)
      .githubIssueIntent(issue)
      .catch((e) => ({ refused: String((e as Error)?.message ?? e).slice(0, 200) }));
    if ("intent" in res) opened.push(`${id}/${res.intent.id}`);
    else refused.push(`${id}: ${res.refused}`);
  }
  return c.json({ intents: opened, ...(refused.length ? { refused } : {}) }, opened.length ? 201 : 200);
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
  // The URL carries the project and its key (Connect page): the shared secret alone aims at no project.
  const id = projectId(c.req.query("project"));
  const key = c.req.query("key") ?? "";
  if (!key || !sameString(key, await hookKey(c.env.GITHUB_WEBHOOK_SECRET, "github", id))) return c.json({ error: "The key in the webhook URL is not valid. Copy the URL from the project's Connect page." }, 401);
  const why = gitringIssue(event, body);
  if (why === null) return c.json({ ignored: true });
  if (why) return c.json({ ignored: true, reason: why });
  // GitHub sends a delivery again when the first answer was slow: each one opens one task.
  const delivery = c.req.header("x-github-delivery") ?? "";
  if (delivery && !(await directory(c.env).firstDelivery(`hook:${delivery}`))) return c.json({ ignored: true, reason: "This delivery was handled before." });
  if (!(await directory(c.env).exists(id))) return c.json({ error: "Unknown project." }, 404);
  const h = harbor(c.env, id);
  await h.ensure(id);
  // Only the project's own repository opens tasks here.
  const repo = body!.repository?.full_name ?? "";
  const own = await h.githubRepoOf();
  if (!own || own.toLowerCase() !== repo.toLowerCase()) return c.json({ error: `This project is not linked to ${repo || "that repository"}.` }, 403);
  const res = await h.githubIssueIntent({ repo, private: body!.repository?.private, title: body!.issue!.title, goal: body!.issue!.body || body!.issue!.title, number: body!.issue!.number });
  if ("refused" in res) return c.json({ ignored: true, reason: res.refused });
  return c.json({ intent: res.intent.id }, 201);
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
  if (!text) return c.json({ response_type: "ephemeral", text: "Write the task after the command: /gitring Add a dark mode — Readers can switch to a dark theme." });
  const [titleRaw, ...rest] = text.split(/\s+[—-]{1,2}\s+/);
  const title = titleRaw ?? text;
  const id = projectId(c.req.query("project"));
  // The command URL carries the project and its key (Connect page).
  const key = c.req.query("key") ?? "";
  if (!key || !sameString(key, await hookKey(c.env.SLACK_SIGNING_SECRET, "slack", id))) {
    return c.json({ response_type: "ephemeral", text: "The key in the command URL is not valid. Copy the URL from the project's Connect page in gitring." });
  }
  // Slack sends a command again when the first answer was slow: the same signed request opens one task.
  if (!(await directory(c.env).firstDelivery(`slack:${sig}`))) return c.json({ response_type: "ephemeral", text: "gitring already opened this task." });
  if (!(await directory(c.env).exists(id))) return c.json({ response_type: "ephemeral", text: "This Slack command points to a project that does not exist. Fix ?project= in the command URL." });
  const h = harbor(c.env, id);
  await h.ensure(id);
  const intent = await h.createIntent({ title, goal: rest.join(" — ") || title, source: { kind: "webhook", ref: `slack:@${user}` } }, { kind: "system", id: "slack", name: `Slack @${user}` });
  return c.json({ response_type: "in_channel", text: `:memo: Task opened: *${intent.title}* (${intent.id}). Agents can take it now.` });
});

/** Claude Code PostToolUse hook: corrections arrive mid-task as additional context (member API key). */
async function claudeHook(c: C, project: string | undefined) {
  try {
    const h = await ready(c, project, "member");
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    // The person of the key: the hook of another person changes no work copy of this person.
    const user = c.get("principal").user;
    return c.json(await h.claudeHook(body as never, user ? { viewer: { id: user.id, role: h.role } } : {}));
  } catch {
    return c.json({});
  }
}
app.post("/hooks/claude-code", (c) => claudeHook(c, c.req.query("project")));
app.post("/hooks/claude/:p", (c) => claudeHook(c, c.req.param("p")));

/* ───────────── MCP + static assets ───────────── */

/**
 * Does this MCP request call a tool that changes data (a tool with no read-only hint)? The body can be one
 * JSON-RPC message or a batch. A body that is not JSON, or a tool that is not in the set, calls nothing: the
 * MCP handler answers it with an error.
 */
async function callsToolThatChanges(request: Request, set: McpSet): Promise<boolean> {
  if (request.method !== "POST") return false;
  const body: unknown = await request.clone().json().catch(() => null);
  const tools = toolSet(set).tools;
  return (Array.isArray(body) ? body : [body]).some((m) => {
    const msg = m as { method?: unknown; params?: { name?: unknown } } | null;
    if (msg?.method !== "tools/call") return false;
    const tool = tools.find((t) => t.name === msg.params?.name);
    return Boolean(tool && !tool.annotations.readOnlyHint);
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // Three endpoints, each with its own tools and its own OAuth resource: /mcp, /mcp/github, /mcp/readonly.
      // Any other path below /mcp keeps the rules of /mcp (the handler answers 404 after the sign-in check).
      const set = mcpSetOf(url.pathname) ?? "gitring";
      if (request.method === "OPTIONS") return createMcp(env, { user: null, via: null }, set, url.origin)(request, env, ctx);
      if (hasCredential(request) && (await overLimit(env, "cred", clientAddress(request)))) return tooMany(60, true);
      const p = await resolvePrincipal(env, request, { oauth: true, resource: resourceOf(url.origin, MCP_PATH[set]) });
      if (await overLimit(env, "mcp", p.user?.id ?? (p.via === "operator" ? "operator" : clientAddress(request)))) return tooMany(60, true);
      if (!p.user && p.via !== "operator") {
        // MCP authorization: the challenge points the client to the protected resource metadata, and the
        // client signs the person in with OAuth. Scripts and hooks send a personal API key instead.
        return new Response(
          JSON.stringify({
            error: p.badKey ? "invalid_token" : "unauthorized",
            error_description: "Connect with OAuth (your MCP client does it when you add gitring), or send a personal API key: Authorization: Bearer gk_… (gitring → Connect).",
          }),
          {
            status: 401,
            headers: {
              "content-type": "application/json",
              "www-authenticate": mcpChallenge(url.origin, Boolean(p.badKey), MCP_PATH[set]),
              "access-control-allow-origin": "*",
              "access-control-expose-headers": "WWW-Authenticate, mcp-session-id",
              "cache-control": "no-store",
            },
          },
        );
      }
      // The scope mcp:read: the token may call only the tools that read (their read-only hint says so).
      // A call to another tool gets 403 with the scope that it needs (RFC 6750 §3.1, MCP scope challenge).
      if (p.via === "oauth" && p.scope === SCOPE_READ && (await callsToolThatChanges(request, set))) {
        return new Response(
          JSON.stringify({ error: "insufficient_scope", error_description: "This tool changes data. The access token has the scope mcp:read. It needs the scope mcp." }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "www-authenticate": mcpScopeChallenge(url.origin, MCP_PATH[set], SCOPE),
              "access-control-allow-origin": "*",
              "access-control-expose-headers": "WWW-Authenticate, mcp-session-id",
              "cache-control": "no-store",
            },
          },
        );
      }
      return createMcp(env, p, set, url.origin)(request, env, ctx);
    }
    const path = url.pathname;
    if (
      path.startsWith("/api/") ||
      path.startsWith("/ws/") ||
      path.startsWith("/preview/") ||
      path.startsWith("/hooks/") ||
      path.startsWith("/auth/") ||
      path.startsWith("/oauth/") ||
      path.startsWith("/.well-known/") ||
      path === "/setup" ||
      path.startsWith("/setup/") ||
      path === "/privacy" ||
      path === "/terms"
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
