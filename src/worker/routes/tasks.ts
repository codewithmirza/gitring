/**
 * The routes that act on tasks and work copies: state, create, change, launch, park, merge, answer, redo and diff.
 *
 * Mounted by app.ts. A person merges and answers questions. A key or an agent token never does: the routes check the way in.
 * Read next: src/worker/cli.ts (answers outside the app) and src/harbor/harbor.ts (what each call does).
 */
import type { Hono } from "hono";
import type * as T from "../../core/types";
import { viewerState } from "../../harbor/harbor";
import { actorOf, directory } from "../auth";
import { answerWay } from "../cli";
import { err, HTTPError, ready, type HonoEnv } from "../http";

export function taskRoutes(app: Hono<HonoEnv>): void {
  intentRoutes(app);
  decisionRoutes(app);
  workCopyRoutes(app);
}

/** The state of a project, and the tasks: create, change, launch, park. */
function intentRoutes(app: Hono<HonoEnv>): void {
  // ───── project state + intents ─────

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
}

/** Where a person decides: merge a work copy, answer an approval, answer a question. */
function decisionRoutes(app: Hono<HonoEnv>): void {
  // ───── attempts ─────

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
   * A person answers the approval of a work copy: "approve" or "send-back" (with a note). A person answers in the
   * gitring app (a browser session), or with gitring's own command line when the person allows answers outside
   * the app (contract C3, src/worker/cli.ts). A personal key or the OAuth token of another app belongs to an
   * agent, and an agent cannot say yes for the person. `approvalId` is the question that the person saw.
   */
  app.post("/api/projects/:p/attempts/:id/decide", async (c) => {
    try {
      const h = await ready(c, c.req.param("p"), "member");
      const principal = c.get("principal");
      const way = await answerWay(directory(c.env), principal);
      if ("refused" in way || !principal.user) throw new HTTPError(403, "refused" in way ? way.refused : "Sign in first.");
      const body = await c.req.json<{ approvalId?: string; answer?: string; note?: string }>().catch(() => ({}) as { approvalId?: string; answer?: string; note?: string });
      if (body.answer !== "approve" && body.answer !== "send-back") throw new HTTPError(400, 'Give answer: "approve" or "send-back".');
      if (!body.approvalId || typeof body.approvalId !== "string") throw new HTTPError(400, "Give approvalId: the id of the question that you saw.");
      const res = await h.decide(
        c.req.param("id"),
        { answer: body.answer, note: typeof body.note === "string" ? body.note : undefined },
        { id: principal.user.id, name: principal.user.name, role: h.role },
        way.how,
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
}

/** Actions on one work copy: ask for a change, redo, read the diff. */
function workCopyRoutes(app: Hono<HonoEnv>): void {
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
        { id: principal.user.id, name: principal.user.name, role: h.role },
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
}
