/**
 * The routes of inbound hooks: a key, GitHub, Slack and Claude Code send input and gitring opens tasks from it.
 *
 * Mounted by app.ts. A hook is checked by a signature or by a key in its URL. Never open a task without one of them.
 * Read next: src/worker/limits.ts (hook limits) and src/harbor/harbor.ts (hookKey, githubIssueIntent).
 */
import type { Hono } from "hono";
import type * as T from "../../core/types";
import { hmacSha256Hex, sameString } from "../../directory/crypto";
import { hookKey } from "../../harbor/harbor";
import { actorOf, directory } from "../auth";
import { err, harbor, projectId, ready, type C, type HonoEnv } from "../http";

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

/** A push to a branch: projects that link the repository bring the changes into main. */
async function githubPush(c: C, raw: string): Promise<Response> {
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

/** An issue event: an issue labeled "gitring" becomes a task in each project that the sender may use. */
async function githubIssueLabeled(c: C, raw: string, event: string | undefined): Promise<Response> {
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
}
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

export function hookRoutes(app: Hono<HonoEnv>): void {
  keyAndGithubHookRoutes(app);
  slackAndClaudeHookRoutes(app);
}

/** Hooks from a key and from GitHub: open a task from outside. */
function keyAndGithubHookRoutes(app: Hono<HonoEnv>): void {
  keyHookRoutes(app);
  githubHookRoutes(app);
}

/** The hook for any app that holds a member key. */
function keyHookRoutes(app: Hono<HonoEnv>): void {
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
}

/** The hooks of GitHub: the GitHub App and a plain repository webhook. */
function githubHookRoutes(app: Hono<HonoEnv>): void {
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
    if (event === "push") return githubPush(c, raw);
    return githubIssueLabeled(c, raw, event);
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
}

/** Hooks from Slack and from Claude Code. */
function slackAndClaudeHookRoutes(app: Hono<HonoEnv>): void {
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

  app.post("/hooks/claude-code", (c) => claudeHook(c, c.req.query("project")));
  app.post("/hooks/claude/:p", (c) => claudeHook(c, c.req.param("p")));
}
