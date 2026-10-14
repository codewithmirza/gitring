/**
 * The caller's role on a project, kept in this isolate for ROLE_TTL_MS.
 *
 * Roles change rarely and every project request needs one: without the cache, each REST request and each
 * MCP tool call makes one more round trip to the Directory. REST (index.ts) and MCP (mcp-kit.ts) share this
 * one cache, so a role change in this isolate (forgetRoles, called where REST changes a role) is seen by both
 * at once. Another isolate sees the change after at most ROLE_TTL_MS.
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
