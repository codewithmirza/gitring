/**
 * The entry point of the Worker: it sends each request to the MCP server, the app or the web app.
 *
 * Wrangler loads this file. It re-exports the Durable Object classes and has the fetch handler.
 * Keep the path list at the end of the file in step with run_worker_first in wrangler.jsonc (a test checks it).
 * Read next: src/worker/app.ts (the routes) and src/worker/README.md (the route map).
 */
import type { Env } from "./env";
import { app } from "./app";
import { handleMcp } from "./mcp-entry";

export { HarborMaster } from "../harbor/harbor";
export { Vessel } from "../vessel/vessel";
export { Directory } from "../directory/directory";
export { Drydock, Seawall } from "../drydock/drydock";
export { projectId } from "./http";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return handleMcp(request, env, ctx, url);
    const path = url.pathname;
    if (
      path.startsWith("/api/") ||
      path.startsWith("/ws/") ||
      path.startsWith("/preview/") ||
      path.startsWith("/hooks/") ||
      path.startsWith("/auth/") ||
      path.startsWith("/oauth/") ||
      path === "/device" ||
      path.startsWith("/.well-known/") ||
      path === "/setup" ||
      path.startsWith("/setup/") ||
      path.startsWith("/admin/") ||
      path === "/privacy" ||
      path === "/terms"
    ) {
      return app.fetch(request, env, ctx);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
