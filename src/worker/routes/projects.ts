/**
 * The routes of the project list and of one project: create, rename, archive, and its members.
 *
 * Mounted by app.ts. A change of a role or of the visibility also closes the live sockets that it affects.
 * Read next: src/worker/projects.ts (how a project is made) and src/worker/roles.ts (the role cache).
 */
import type { Hono } from "hono";
import type * as A from "../../core/accounts";
import { directory } from "../auth";
import { access, err, harbor, needUser, readyProjects, type HonoEnv } from "../http";
import { createProjectFor, ProjectError, type CreateProjectInput } from "../projects";
import { forgetRoles } from "../roles";

export function projectRoutes(app: Hono<HonoEnv>): void {
  projectCrudRoutes(app);
  memberRoutes(app);
}

/** The project list and one project: list, create, read, rename, archive. */
function projectCrudRoutes(app: Hono<HonoEnv>): void {
  // ───── projects ─────

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
}

/** The members of a project: list, add, remove. */
function memberRoutes(app: Hono<HonoEnv>): void {
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
}
