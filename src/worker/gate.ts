/**
 * The waitlist gate in the Worker: a person who is not allowed reaches the waitlist pages only.
 *
 * src/core/waitlist.ts says when the gate is on. Everything else answers 403 with the code "waitlist".
 * That covers the REST API, live sockets, previews, hooks and the MCP endpoints, also for tokens and sessions that exist.
 * The check reads the person, not the token. The operator key (GITRING_KEY) always passes.
 */
import type { Env } from "./env";
import type { Principal } from "./auth";
import { gateOn } from "../core/waitlist";

/** Paths that every caller may reach with the gate on: health, sign-in, the waitlist itself, plans and pages. */
export function gateExempt(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/api/me" ||
    path === "/api/plans" ||
    path === "/api/waitlist" ||
    path.startsWith("/auth/") ||
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/") ||
    path === "/device" ||
    path === "/setup" ||
    path.startsWith("/setup/") ||
    path === "/privacy" ||
    path === "/terms" ||
    // The owner pages and API check the owner themselves, and an owner always passes the gate.
    path.startsWith("/admin/") ||
    path.startsWith("/api/admin/")
  );
}

const WAITLIST_ANSWER = { error: "gitring is not open to you yet. You are on the waitlist. We will tell you when it opens.", code: "waitlist" } as const;
const SIGN_IN_ANSWER = { error: "Sign in first.", code: "sign_in" } as const;

function answer(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * The answer that stops a request, or null when it may go on. A signed-in person who is not allowed: 403.
 * A visitor: 401, except on hooks (a hook key belongs to a project of an allowed person).
 */
export function gateBlock(env: Env, p: Principal, path: string): Response | null {
  if (!gateOn(env) || p.via === "operator" || gateExempt(path)) return null;
  if (p.user) return p.user.allowed === false ? answer(WAITLIST_ANSWER, 403) : null;
  if (path.startsWith("/hooks/")) return null;
  return answer(SIGN_IN_ANSWER, 401);
}

/** The MCP endpoints: a person who is not allowed gets 403 (a visitor gets the usual sign-in challenge). */
export function gateBlockMcp(env: Env, p: Principal): Response | null {
  if (!gateOn(env) || p.via === "operator" || !p.user || p.user.allowed !== false) return null;
  return new Response(JSON.stringify({ error: "waitlist", error_description: WAITLIST_ANSWER.error, code: "waitlist" }), {
    status: 403,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "WWW-Authenticate, mcp-session-id", "cache-control": "no-store" },
  });
}
