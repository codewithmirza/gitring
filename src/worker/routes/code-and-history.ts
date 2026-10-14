/**
 * The read routes of a project: the timeline, a merge, the file tree, one file, history questions and the agent runner status.
 *
 * Mounted by app.ts. Viewers of a public project may read all of these. The agent runner status is for members.
 * Read next: src/worker/history-routes.ts (why, history, search, compare) and src/harbor/derived.ts.
 */
import type { Hono } from "hono";
import { isTimelineCursor, timelineLimit } from "../../core/timeline";
import { access, err, HTTPError, ready, type C, type HonoEnv } from "../http";
import { historyRoutes } from "../history-routes";

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

async function shortHash(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d.subarray(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function codeRoutes(app: Hono<HonoEnv>): void {
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

  /** Built-in agent status: phase, step, last error. Members only: it shows model replies. */
  app.get("/api/projects/:p/attempts/:id/vessel", async (c) => {
    const { id } = await access(c, c.req.param("p"), "member");
    const stub = c.env.VESSEL.get(c.env.VESSEL.idFromName(`${id}:${c.req.param("id")}`));
    return c.json((await stub.status()) ?? { phase: "none" });
  });
}
