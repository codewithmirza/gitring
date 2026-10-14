/**
 * The REST routes for history questions: why a line is there, file history, search and compare.
 *
 * They are the twins of the MCP tools in mcp-history.ts. Viewers may ask: the answers show code that a viewer can already read.
 * Mounted by src/worker/routes/code-and-history.ts. Read next: src/harbor/derived.ts (where the answers come from).
 */
import type { Hono } from "hono";
import type { Role } from "../core/accounts";
import type { HarborMaster } from "../harbor/harbor";
import type { C, HonoEnv } from "./http";

/*
 * The routes:
 *
 *   GET /api/projects/:p/why?path=&line=&ref=        the change that last wrote a line (or the changes of a file)
 *   GET /api/projects/:p/history?path=&limit=         the changes of a file, a folder or main
 *   GET /api/projects/:p/search?q=&path=&limit=       a text in the files of main
 *   GET /api/projects/:p/compare?from=&to=&path=      the changes between two versions (all files, or under a path)
 */

/** What the routes need from the Worker: the role check with the project object, and the error answer. */
export interface HistoryRouteDeps {
  ready(c: C, project: string | undefined, need: Role): Promise<Pick<HarborMaster, "why" | "pathHistory" | "searchCode" | "compareRefs">>;
  err(c: C, e: unknown, status?: number): Response;
}

/** A whole number from a query value, or undefined. */
function int(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : NaN;
}

export function historyRoutes(app: Hono<HonoEnv>, deps: HistoryRouteDeps): void {
  app.get("/api/projects/:p/why", async (c) => {
    try {
      const h = await deps.ready(c, c.req.param("p"), "viewer");
      const line = int(c.req.query("line"));
      if (Number.isNaN(line)) return c.json({ error: "Give the line as a number." }, 400);
      return c.json(await h.why({ path: c.req.query("path") ?? "", line, ref: c.req.query("ref") || undefined }));
    } catch (e) {
      return deps.err(c, e);
    }
  });

  app.get("/api/projects/:p/history", async (c) => {
    try {
      const h = await deps.ready(c, c.req.param("p"), "viewer");
      const limit = int(c.req.query("limit"));
      return c.json(await h.pathHistory({ path: c.req.query("path") || undefined, limit: Number.isNaN(limit) ? undefined : limit }));
    } catch (e) {
      return deps.err(c, e);
    }
  });

  app.get("/api/projects/:p/search", async (c) => {
    try {
      const h = await deps.ready(c, c.req.param("p"), "viewer");
      const limit = int(c.req.query("limit"));
      return c.json(await h.searchCode({ query: c.req.query("q") ?? "", path: c.req.query("path") || undefined, limit: Number.isNaN(limit) ? undefined : limit }));
    } catch (e) {
      return deps.err(c, e);
    }
  });

  app.get("/api/projects/:p/compare", async (c) => {
    try {
      const h = await deps.ready(c, c.req.param("p"), "viewer");
      return c.json(await h.compareRefs(c.req.query("from") ?? "", c.req.query("to") ?? "", c.req.query("path") || undefined));
    } catch (e) {
      return deps.err(c, e);
    }
  });
}
