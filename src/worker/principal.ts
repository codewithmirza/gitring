/**
 * Who is calling: a browser session, a personal API key, an OAuth token or the operator key, found in a short cache.
 *
 * Called by the request guard (src/worker/request-guard.ts) and by the MCP entry. A removed key stops working within 30 seconds.
 * Never log a token. Read next: src/worker/auth-kit.ts (cookies) and src/directory/layers/credentials.ts.
 */
import type { Env } from "./env";
import type * as A from "../core/accounts";
import type * as T from "../core/types";
import { CLI_CLIENT_ID } from "../directory/device";
import { sameString } from "../directory/crypto";
import { cliMayCall } from "./cli";
import { SESSION_COOKIE, readCookie } from "./auth-kit";

export interface Principal {
  user: A.UserInfo | null;
  via: "session" | "key" | "operator" | "oauth" | null;
  /** OAuth only: the MCP client that acts for the person. */
  clientId?: string;
  /** OAuth only: what the token may do. "mcp:read": only the tools that read. Anything else: all tools. */
  scope?: string;
  /** The session token (cookie), for logout. */
  session?: string;
  /** A Bearer token was sent but it is not valid. */
  badKey?: boolean;
}

export function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
}

/**
 * Close the live connections of a person on every project of theirs (sign-out, a revoked key, a lost
 * role). Each connection comes back through the Worker, which checks the access again.
 */
export async function closeUserSockets(env: Env, userId: string, code: 4401 | 4403 = 4401): Promise<void> {
  const projects = await directory(env)
    .listProjects(userId)
    .catch(() => [] as A.ProjectInfo[]);
  await Promise.all(projects.map((p) => env.HARBOR.get(env.HARBOR.idFromName(p.id)).closeSockets({ userId }, code).catch(() => undefined)));
}

/*
 * A short cache of token lookups in this isolate. An agent sends many MCP calls with the same token and a
 * page sends many API calls with the same cookie; without the cache, each call is one more round trip to
 * the Directory. A removed key, session or app grant stops working everywhere within PRINCIPAL_TTL_MS
 * (at once in this isolate: see forgetPrincipal).
 */
const PRINCIPAL_TTL_MS = 30_000;
const PRINCIPAL_MAX = 5000;
const principals = new Map<string, { until: number; p: Principal }>();

function cached(key: string): Principal | null {
  const hit = principals.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.until) {
    principals.delete(key);
    return null;
  }
  return hit.p;
}

/** Cache a lookup for PRINCIPAL_TTL_MS, or until `expiresAt` (a token that expires sooner). */
function remember(key: string, p: Principal, expiresAt = Infinity): Principal {
  if (principals.size >= PRINCIPAL_MAX) {
    // Drop the oldest tenth (Map keeps insertion order).
    let n = Math.ceil(PRINCIPAL_MAX / 10);
    for (const k of principals.keys()) {
      principals.delete(k);
      if (--n <= 0) break;
    }
  }
  principals.set(key, { until: Math.min(Date.now() + PRINCIPAL_TTL_MS, expiresAt), p });
  return p;
}

/** Forget cached lookups: a session at sign-out, or everything of a person (keys, grants) after a change. */
export function forgetPrincipal(opts: { session?: string; userId?: string; all?: boolean }): void {
  if (opts.all) return principals.clear();
  if (opts.session) principals.delete(`s:${opts.session}`);
  if (opts.userId) for (const [k, v] of principals) if (v.p.user?.id === opts.userId) principals.delete(k);
}

/**
 * Who sends this request. `oauth: true` (the MCP endpoints only) also accepts OAuth access tokens: they
 * are for one MCP endpoint (RFC 8707), not for the rest of the API. `resource` is the endpoint that gets
 * this request (default <origin>/mcp): a token works only at the resource it was issued for. On a REST route
 * of a command of the gitring command line (src/worker/cli.ts), the token of that command line works too.
 * `cli` overrides that check of the route.
 */
export async function resolvePrincipal(env: Env, req: Request, opts: { oauth?: boolean; resource?: string; cli?: boolean } = {}): Promise<Principal> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (m) {
    const token = m[1].trim();
    if (env.GITRING_KEY && sameString(token, env.GITRING_KEY)) return { user: null, via: "operator" };
    if (token.startsWith("gk_")) {
      const hit = cached(`k:${token}`);
      if (hit) return hit;
      const user = await directory(env).keyUser(token);
      if (user) return remember(`k:${token}`, { user, via: "key" });
    }
    if (opts.oauth && token.startsWith("goa_")) {
      const origin = new URL(req.url).origin;
      // The lookup depends on the endpoint: the same token can be valid at one and not at another.
      const resource = opts.resource ?? `${origin}/mcp`;
      const hit = cached(`o:${resource}:${token}`);
      if (hit) return hit;
      const found = await directory(env).oauthUser(token, origin, resource);
      // OAuth tokens are cached for at most 15 seconds: a revoked token stops working soon everywhere.
      if (found) return remember(`o:${resource}:${token}`, { user: found.user, via: "oauth", clientId: found.clientId, scope: found.scope }, Math.min(found.expiresAt, Date.now() + 15_000));
    }
    if (!opts.oauth && token.startsWith("goa_") && (opts.cli ?? cliMayCall(req.method, new URL(req.url).pathname))) {
      // gitring's own command line: its token (for /mcp, with the full scope) also works for the REST
      // routes of its commands (src/worker/cli.ts). Tokens of other apps do not.
      const origin = new URL(req.url).origin;
      const hit = cached(`c:${origin}:${token}`);
      if (hit) return hit;
      const found = await directory(env).oauthUser(token, origin, `${origin}/mcp`);
      if (found && found.clientId === CLI_CLIENT_ID && found.scope === "mcp") {
        return remember(`c:${origin}:${token}`, { user: found.user, via: "oauth", clientId: found.clientId, scope: found.scope }, Math.min(found.expiresAt, Date.now() + 15_000));
      }
    }
    return { user: null, via: null, badKey: true };
  }
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) {
    const hit = cached(`s:${cookie}`);
    if (hit) return hit;
    const user = await directory(env).sessionUser(cookie);
    if (user) return remember(`s:${cookie}`, { user, via: "session", session: cookie });
  }
  return { user: null, via: null };
}

export function actorOf(p: Principal): T.Actor {
  if (p.user) return { kind: "human", id: p.user.id, name: p.user.name };
  if (p.via === "operator") return { kind: "system", id: "operator", name: "Operator" };
  return { kind: "human", id: "anonymous", name: "Anonymous" };
}
