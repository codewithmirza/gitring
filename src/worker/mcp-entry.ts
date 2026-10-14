/**
 * Answers every request to /mcp: limits, the sign-in challenge, the read-only scope check, then the MCP server.
 *
 * Called by the fetch handler in index.ts. Three endpoints share this code: /mcp, /mcp/github and /mcp/readonly.
 * Never run a tool for a caller who has no person behind the credential.
 * Read next: src/worker/mcp.ts (the tools) and src/worker/oauth.ts (the challenge text).
 */
import type { Env } from "./env";
import { createMcp, toolSet } from "./mcp";
import { resolvePrincipal } from "./auth";
import { mcpChallenge, mcpScopeChallenge } from "./oauth";
import { MCP_PATH, mcpSetOf, resourceOf, SCOPE, SCOPE_READ, type McpSet } from "../directory/oauth";
import { gateBlockMcp } from "./gate";
import { clientAddress, hasCredential, overLimit, tooMany } from "./limits";

/**
 * Does this MCP request call a tool that changes data (a tool with no read-only hint)? The body can be one
 * JSON-RPC message or a batch. A body that is not JSON, or a tool that is not in the set, calls nothing: the
 * MCP handler answers it with an error.
 */
async function callsToolThatChanges(request: Request, set: McpSet): Promise<boolean> {
  if (request.method !== "POST") return false;
  const body: unknown = await request.clone().json().catch(() => null);
  const tools = toolSet(set).tools;
  return (Array.isArray(body) ? body : [body]).some((m) => {
    const msg = m as { method?: unknown; params?: { name?: unknown } } | null;
    if (msg?.method !== "tools/call") return false;
    const tool = tools.find((t) => t.name === msg.params?.name);
    return Boolean(tool && !tool.annotations.readOnlyHint);
  });
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  // Three endpoints, each with its own tools and its own OAuth resource: /mcp, /mcp/github, /mcp/readonly.
  // Any other path below /mcp keeps the rules of /mcp (the handler answers 404 after the sign-in check).
  const set = mcpSetOf(url.pathname) ?? "gitring";
  if (request.method === "OPTIONS") return createMcp(env, { user: null, via: null }, set, url.origin)(request, env, ctx);
  if (hasCredential(request) && (await overLimit(env, "cred", clientAddress(request)))) return tooMany(60, true);
  const p = await resolvePrincipal(env, request, { oauth: true, resource: resourceOf(url.origin, MCP_PATH[set]) });
  if (await overLimit(env, "mcp", p.user?.id ?? (p.via === "operator" ? "operator" : clientAddress(request)))) return tooMany(60, true);
  const waiting = gateBlockMcp(env, p);
  if (waiting) return waiting;
  if (!p.user && p.via !== "operator") {
    // MCP authorization: the challenge points the client to the protected resource metadata, and the
    // client signs the person in with OAuth. Scripts and hooks send a personal API key instead.
    return new Response(
      JSON.stringify({
        error: p.badKey ? "invalid_token" : "unauthorized",
        error_description: "Connect with OAuth (your MCP client does it when you add gitring), or send a personal API key: Authorization: Bearer gk_… (gitring → Connect).",
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": mcpChallenge(url.origin, Boolean(p.badKey), MCP_PATH[set]),
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "WWW-Authenticate, mcp-session-id",
          "cache-control": "no-store",
        },
      },
    );
  }
  // The scope mcp:read: the token may call only the tools that read (their read-only hint says so).
  // A call to another tool gets 403 with the scope that it needs (RFC 6750 §3.1, MCP scope challenge).
  if (p.via === "oauth" && p.scope === SCOPE_READ && (await callsToolThatChanges(request, set))) {
    return new Response(
      JSON.stringify({ error: "insufficient_scope", error_description: "This tool changes data. The access token has the scope mcp:read. It needs the scope mcp." }),
      {
        status: 403,
        headers: {
          "content-type": "application/json",
          "www-authenticate": mcpScopeChallenge(url.origin, MCP_PATH[set], SCOPE),
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "WWW-Authenticate, mcp-session-id",
          "cache-control": "no-store",
        },
      },
    );
  }
  return createMcp(env, p, set, url.origin)(request, env, ctx);
}
