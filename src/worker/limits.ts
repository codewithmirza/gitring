/**
 * Rate limits (Workers Rate Limiting bindings): counters per Cloudflare location, keyed by a person or an
 * address. Without a binding (local development, tests) nothing is limited.
 *
 *   RL_AUTH   sign-in starts and client registrations, per address      (20 per minute)
 *   RL_TOKEN  OAuth token and revocation calls, per address             (120 per minute)
 *   RL_MCP    MCP calls, per person (or address before sign-in)         (3000 per minute: 24 scripted agents of one person make about 1200 calls a minute)
 *   RL_API    other API calls, per person (or address)                  (1200 per minute)
 *   RL_CRED   credential lookups, per address, before gitring looks the credential up (6000 per minute):
 *             a flood of keys or cookies that are not valid stops at the edge, not at the account store
 */
import type { Env } from "./env";

export type LimitKind = "auth" | "token" | "mcp" | "api" | "cred";

const BINDING: Record<LimitKind, keyof Env> = { auth: "RL_AUTH", token: "RL_TOKEN", mcp: "RL_MCP", api: "RL_API", cred: "RL_CRED" };

/** True when the caller is over the limit. A failing limiter never blocks the request. */
export async function overLimit(env: Env, kind: LimitKind, key: string): Promise<boolean> {
  const rl = env[BINDING[kind]] as RateLimit | undefined;
  if (!rl) return false;
  try {
    const { success } = await rl.limit({ key: `${kind}:${key}` });
    return !success;
  } catch {
    return false;
  }
}

export function clientAddress(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

export function tooMany(retryAfterS = 60, cors = false): Response {
  return new Response(JSON.stringify({ error: "rate_limited", error_description: "Too many requests. Wait a minute, then try again." }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(retryAfterS), "cache-control": "no-store", ...(cors ? { "access-control-allow-origin": "*" } : {}) },
  });
}

/** True when the request carries a credential that needs a lookup (a Bearer token or a session cookie). */
export function hasCredential(req: Request): boolean {
  return /^Bearer\s+\S/i.test(req.headers.get("authorization") ?? "") || /(?:^|;\s*)__Host-gitring=/.test(req.headers.get("cookie") ?? "");
}

/** Which limit a path falls under (null: none). */
export function limitFor(_method: string, path: string): LimitKind | null {
  if (path === "/oauth/register" || path === "/oauth/authorize" || /^\/auth\/[^/]+\/start$/.test(path)) return "auth";
  if (path === "/oauth/token" || path === "/oauth/revoke") return "token";
  if ((path.startsWith("/api/") && path !== "/api/health") || path.startsWith("/ws/")) return "api";
  return null;
}
