/**
 * The live routes: the WebSocket of a project, and the live preview of main or a work copy.
 *
 * Mounted by app.ts. Preview code runs in a sandbox with an opaque origin: it never sees gitring's cookies.
 * Read next: src/platform/checks/preview.ts (how a preview runs) and src/harbor/harbor.ts (live events).
 */
import type { Hono } from "hono";
import { servePreview } from "../../platform/checks/preview";
import { access, harbor, HTTPError, projectId, ready, type C, type HonoEnv } from "../http";

const previewCache = new Map<string, { key: string; files: Map<string, string> }>();

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function liveRoutes(app: Hono<HonoEnv>): void {
  // ───── live events ─────

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

  // ───── live previews (Dynamic Workers) ─────

  app.all("/preview/:p/:ref/*", async (c) => preview(c));
  app.all("/preview/:p/:ref", async (c) => preview(c));
}
