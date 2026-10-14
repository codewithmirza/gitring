/**
 * Shared helpers of the route files: the error class, the project id check, the role check and the project object.
 *
 * Every file in src/worker/routes/ imports it, and so does history-routes.ts.
 * Never put a route here: a route belongs in a file of src/worker/routes/.
 */
import type { Context } from "hono";
import type { Env } from "./env";
import type * as A from "../core/accounts";
import { atLeast, PROJECT_ID } from "../core/accounts";
import type { Principal } from "./auth";
import { retryAfterReset } from "./mcp-kit";
import { roleOf } from "./roles";

export type HonoEnv = { Bindings: Env; Variables: { principal: Principal } };
export type C = Context<HonoEnv>;

// ───── Errors ─────

export class HTTPError extends Error {
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

// ───── The project object and the role check ─────

/** The object of a project. A call that fails because the platform restarted the object is sent again (see retryAfterReset). */
export function harbor(env: Env, project: string) {
  const id = env.HARBOR.idFromName(projectId(project));
  return retryAfterReset(() => env.HARBOR.get(id));
}

/** The caller's role on a project; refuse when it is below `need`. */
export async function access(c: C, raw: string | undefined, need: A.Role): Promise<{ id: string; role: A.Role }> {
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
export const readyProjects = new Set<string>();

export async function ready(c: C, raw: string | undefined, need: A.Role) {
  const { id, role } = await access(c, raw, need);
  const h = harbor(c.env, id);
  if (!readyProjects.has(id)) {
    await h.ensure(id);
    if (readyProjects.size > 5000) readyProjects.clear();
    readyProjects.add(id);
  }
  return Object.assign(h, { role });
}

// ───── Answers for a request that fails ─────

export function err(c: C, e: unknown, status = 400) {
  if (e instanceof HTTPError) return c.json({ error: e.message }, e.status);
  const message = String((e as Error)?.message ?? e).replace(/^Error: /, "");
  return c.json({ error: message }, status as 400);
}

export function needUser(c: C): A.UserInfo {
  const u = c.get("principal").user;
  if (!u) throw new HTTPError(401, "Sign in first.");
  return u;
}
