/**
 * Pure rules of the OAuth store: scopes, redirect URIs, MCP resources and the audience of a token.
 *
 * No storage and no network here. Never relax a rule here without a test: each one protects a person.
 * Read next: src/directory/oauth-store/authorize.ts (where the rules are applied).
 */
import { publicHostname } from "../../core/repo-rules";
import { sha256B64url } from "../crypto";
import { SCOPE, SCOPE_READ } from "./constants";

// ───── Scopes ─────

/**
 * The access that a request asks for. mcp (or no gitring scope at all: older clients) is the full scope;
 * mcp:read alone is read only. The other scopes (offline_access, openid, ...) do not change the access.
 */
export function accessScope(scopes: string[]): string {
  return scopes.includes(SCOPE) || !scopes.includes(SCOPE_READ) ? SCOPE : SCOPE_READ;
}

/** Does a grant (or token) with scope `granted` cover a request for `asked`? The full scope covers read only. */
export function scopeCovers(granted: string | null | undefined, asked: string): boolean {
  const have = granted || SCOPE;
  return have === SCOPE || have === asked;
}

// ───── Redirect URIs ─────

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const BAD_SCHEMES = new Set(["javascript:", "data:", "file:", "blob:", "about:", "vbscript:", "filesystem:", "ws:", "wss:"]);

/**
 * Redirect URIs: https; http only on loopback (native and CLI clients, RFC 8252 §7.3); private-use
 * schemes of native apps (for example cursor:// or com.example.app:/). No fragments.
 */
export function redirectOk(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return Boolean(u.hostname);
  if (u.protocol === "http:") return LOOPBACK.test(u.hostname);
  if (BAD_SCHEMES.has(u.protocol)) return false;
  return /^[a-z][a-z0-9+.-]{1,60}:$/.test(u.protocol);
}

/**
 * Does a redirect URI of the request match a registered one? Exact match, except that a loopback
 * redirect may use any port (RFC 8252 §7.3: native apps pick a free port at run time).
 */
export function redirectMatches(registered: string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  let a: URL;
  try {
    a = new URL(asked);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" || !LOOPBACK.test(a.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === a.hostname && u.pathname === a.pathname && u.search === a.search;
    } catch {
      return false;
    }
  });
}

// ───── MCP resources and the audience of a token ─────

/**
 * The tool sets of this server. Each one has its own MCP endpoint, and each endpoint is its own OAuth
 * resource (RFC 8707): "gitring" is the full set, "github" has the names and arguments of the GitHub
 * MCP server, "readonly" has the gitring tools that only read.
 */
export type McpSet = "gitring" | "github" | "readonly";
export const MCP_PATH: Record<McpSet, string> = { gitring: "/mcp", github: "/mcp/github", readonly: "/mcp/readonly" };

/** The tool set that an endpoint path serves, or null. */
export function mcpSetOf(pathname: string): McpSet | null {
  const hit = (Object.entries(MCP_PATH) as [McpSet, string][]).find(([, p]) => p === pathname);
  return hit ? hit[0] : null;
}

/** The resource (RFC 8707) that tokens are for: an MCP endpoint of this server. The default is the full set. */
export function resourceOf(origin: string, path: string = MCP_PATH.gitring): string {
  return `${origin}${path}`;
}

/**
 * The resource that a request names, in one form: no trailing slash, and the bare origin means the
 * default endpoint. Null when the value is not a resource of this server.
 */
export function canonicalResource(asked: string, origin: string): string | null {
  const norm = asked.replace(/\/+$/, "");
  if (norm === origin) return resourceOf(origin);
  return Object.values(MCP_PATH).some((p) => norm === resourceOf(origin, p)) ? norm : null;
}

export function resourceOk(asked: string | undefined | null, origin: string): boolean {
  return !asked || canonicalResource(asked, origin) !== null;
}

/** The text of an invalid_target answer: the resources of this server. */
export function resourceHint(origin: string): string {
  return `This server serves these resources: ${Object.values(MCP_PATH).map((p) => resourceOf(origin, p)).join(", ")}.`;
}

/**
 * May a token be used at the endpoint `called`? `bound` is the resource that the token was issued for
 * (null: the app named none). A token works only at the exact resource it was issued for (RFC 8707):
 * a token for /mcp does not work at /mcp/github, and the other way round. A token with no resource
 * works only at the default endpoint, as before the other endpoints existed.
 */
export function audienceOk(bound: string | null | undefined, origin: string, called: string): boolean {
  const at = canonicalResource(called, origin);
  if (!at) return false;
  if (!bound) return at === resourceOf(origin);
  return canonicalResource(bound, origin) === at;
}

// ───── Client ID metadata documents ─────

/**
 * A client ID metadata document URL (draft-ietf-oauth-client-id-metadata-document §3): https, a path,
 * no fragment, no user or password, no dot segments.
 */
export function isCimdId(clientId: string): boolean {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || !u.hostname || u.pathname.length <= 1) return false;
  if (u.hash || u.username || u.password || clientId.includes("#")) return false;
  if (u.port && u.port !== "443") return false;
  if (!publicHostname(u.hostname)) return false;
  const raw = clientId.slice(clientId.indexOf(u.host) + u.host.length).split(/[?#]/)[0];
  return !raw.split("/").some((seg) => seg === "." || seg === "..");
}

export { publicHostname };

// ───── Small helpers ─────

/** The key of an address in the miss counter (an address cannot look like a user id). */
export function addressKey(address: string | undefined): string | null {
  return address && address !== "unknown" ? `addr:${address}` : null;
}

/** Add query parameters to a redirect URI (keeps its own query). Undefined values are left out. */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** S256 code challenge of a verifier (for clients and tests). */
export async function s256(verifier: string): Promise<string> {
  return sha256B64url(verifier);
}

/** Decode an HTTP Basic client authentication header (RFC 6749 §2.3.1: form-encoded id and secret). */
export function basicAuth(header: string | null | undefined): { id: string; secret: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? "");
  if (!m) return null;
  try {
    const raw = atob(m[1]);
    const i = raw.indexOf(":");
    if (i < 0) return null;
    return { id: decodeURIComponent(raw.slice(0, i).replace(/\+/g, " ")), secret: decodeURIComponent(raw.slice(i + 1).replace(/\+/g, " ")) };
  } catch {
    return null;
  }
}
