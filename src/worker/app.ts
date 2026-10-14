/**
 * Builds the Hono app of the REST API, the live sockets, the previews, the hooks and the sign-in pages.
 *
 * Imported by index.ts only. The ORDER of the lines below is the order of the routes: Hono tries them in order.
 * Never add a route here: add it to a file of src/worker/routes/ and mount that file.
 * Read next: src/worker/README.md (the route map).
 */
import { Hono } from "hono";
import { BUILD_ID } from "../harbor/harbor";
import { authRoutes, directory } from "./auth";
import { deviceRoutes } from "./device";
import { githubRoutes } from "./github";
import { HTTPError, type HonoEnv } from "./http";
import { oauthRoutes } from "./oauth";
import { useRequestGuard } from "./request-guard";
import { waitlistRoutes } from "./waitlist";
import { codeRoutes } from "./routes/code-and-history";
import { hookRoutes } from "./routes/hooks";
import { liveRoutes } from "./routes/live";
import { personRoutes } from "./routes/person";
import { projectRoutes } from "./routes/projects";
import { settingsRoutes } from "./routes/settings";
import { taskRoutes } from "./routes/tasks";

export const app = new Hono<HonoEnv>();

app.onError((e, c) => {
  if (e instanceof HTTPError) return c.json({ error: e.message }, e.status);
  console.error("unhandled", e);
  return c.json({ error: "gitring could not finish the request. Try again." }, 500);
});

// ───── who is calling ─────

useRequestGuard(app);

// ───── health, sign-in, setup ─────

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
waitlistRoutes(app);
oauthRoutes(app);
deviceRoutes(app);
githubRoutes(app);

personRoutes(app);
projectRoutes(app);
taskRoutes(app);
codeRoutes(app);
settingsRoutes(app);
liveRoutes(app);
hookRoutes(app);
