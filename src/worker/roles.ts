/**
 * The caller's role on a project, kept in this isolate for a short time (ROLE_TTL_MS).
 *
 * Every project request needs a role. Without this cache, each REST request and each MCP tool call asks the registry.
 * REST (src/worker/http.ts) and MCP (mcp-kit.ts) share this cache, so forgetRoles reaches both at once.
 * Another isolate sees a role change after at most ROLE_TTL_MS. Never cache a role for an unknown project.
 */
import type { Env } from "./env";
import type * as A from "../core/accounts";
import { directory } from "./auth";

export const ROLE_TTL_MS = 15_000;
const roles = new Map<string, { until: number; role: A.Role | null }>();

/** Forget the cached roles of one project (or of all projects). */
export function forgetRoles(projectId?: string): void {
  if (!projectId) return roles.clear();
  for (const k of roles.keys()) if (k.startsWith(`${projectId}\u0000`)) roles.delete(k);
}

export async function roleOf(env: Env, id: string, userId: string | null): Promise<A.Role | null> {
  const key = `${id}\u0000${userId ?? ""}`;
  const hit = roles.get(key);
  if (hit && hit.until > Date.now()) return hit.role;
  const role = await directory(env).role(id, userId);
  if (roles.size > 5000) roles.clear();
  roles.set(key, { until: Date.now() + ROLE_TTL_MS, role });
  return role;
}
