/**
 * The routes of the signed-in person: API keys, preferences, the inbox across projects and push notifications.
 *
 * Mounted by app.ts. A key may not loosen a rule that protects the person (see the note at each route).
 * Read next: src/worker/push.ts (Web Push) and src/directory/layers/ (where the person's data lives).
 */
import type { Hono } from "hono";
import type * as A from "../../core/accounts";
import { atLeast } from "../../core/accounts";
import { closeUserSockets, directory, forgetPrincipal } from "../auth";
import { err, harbor, HTTPError, needUser, type HonoEnv } from "../http";

export function personRoutes(app: Hono<HonoEnv>): void {
  keyRoutes(app);
  prefsAndInboxRoutes(app);
  pushRoutes(app);
}

/** The personal API keys of the person. */
function keyRoutes(app: Hono<HonoEnv>): void {
  // ───── API keys ─────

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
}

/** The preferences and the inbox of the person. */
function prefsAndInboxRoutes(app: Hono<HonoEnv>): void {
  // ───── the person: preferences, inbox, push ─────

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
}

/** Push notifications for the inbox. */
function pushRoutes(app: Hono<HonoEnv>): void {
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
}
