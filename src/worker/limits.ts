/**
 * Rate limits (Workers Rate Limiting bindings): counters per Cloudflare location, keyed by a person or an
 * address. Without a binding (local development, tests) nothing is limited.
 *
 *   RL_AUTH   sign-in starts, client registrations and device sign-ins, per address (20 per minute)
 *   RL_TOKEN  OAuth token and revocation calls, per address             (120 per minute)
 *   RL_MCP    MCP calls, per person (or address before sign-in)         (3000 per minute: 24 scripted agents of one person make about 1200 calls a minute)
 *   RL_API    other API calls, per person (or address)                  (1200 per minute)
 *   RL_CRED   credential lookups, per address, before gitring looks the credential up (6000 per minute):
 *             a flood of keys or cookies that are not valid stops at the edge, not at the account store.
 *             It runs on every route that reads a credential (a key, a session cookie, a hook URL key).
 *   RL_HOOK   inbound hooks (/hooks/*), per key: the person of an API key, the key in the hook URL, or
 *             the address when the request has no key (1200 per minute: Claude Code hooks of one person
 *             come for each tool call of each of its agents)
 *   RL_PREVIEW live previews (/preview/*), per address (600 per minute: a page loads many files)
 */
import type { Env } from "./env";
import { sha256Hex } from "../directory/crypto";

export type LimitKind = "auth" | "token" | "mcp" | "api" | "cred" | "hook" | "preview";

const BINDING: Record<LimitKind, keyof Env> = {
  auth: "RL_AUTH",
  token: "RL_TOKEN",
  mcp: "RL_MCP",
  api: "RL_API",
  cred: "RL_CRED",
  hook: "RL_HOOK",
  preview: "RL_PREVIEW",
};

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

/**
 * The key in the URL of a hook, or null. Only /hooks/slack and /hooks/github carry one (`?key=`, from the
 * Connect page): on other hooks a `?key=` is not a credential, and it does not get a counter of its own.
 */
export function hookUrlKey(req: Request): string | null {
  const url = new URL(req.url);
  if (url.pathname !== "/hooks/slack" && url.pathname !== "/hooks/github") return null;
  return url.searchParams.get("key") || null;
}

/**
 * The counter of a hook request: the person of the API key, the operator, the key in the URL (as a digest:
 * the key is a secret), or the address. A flood of wrong keys from one address stops at RL_CRED first.
 */
export async function hookLimitKey(req: Request, who: string | null): Promise<string> {
  if (who) return `who:${who}`;
  const key = hookUrlKey(req);
  if (key) return `key:${(await sha256Hex(key)).slice(0, 24)}`;
  return `ip:${clientAddress(req)}`;
}

/** Which limit a path falls under (null: none). */
export function limitFor(_method: string, path: string): LimitKind | null {
  if (path === "/oauth/register" || path === "/oauth/authorize" || path === "/oauth/device_authorization" || path === "/device" || /^\/auth\/[^/]+\/start$/.test(path)) return "auth";
  if (path === "/oauth/token" || path === "/oauth/revoke") return "token";
  if ((path.startsWith("/api/") && path !== "/api/health") || path.startsWith("/ws/")) return "api";
  if (path.startsWith("/hooks/")) return "hook";
  if (path.startsWith("/preview/")) return "preview";
  return null;
}
