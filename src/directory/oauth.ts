/**
 * OAuth 2.1 authorization server for MCP clients (Claude, Claude Code, Cursor, Codex, other agents).
 *
 *   clients     dynamic client registration (RFC 7591) and client ID metadata documents (an https URL
 *               as client_id, as the MCP authorization spec recommends)
 *   requests    a pending authorization (the person signs in and allows the client), 15 minutes
 *   codes       authorization codes: single use, 10 minutes, PKCE S256 only, bound to client,
 *               redirect URI, person and resource (RFC 8707)
 *   grants      one per person and client: the person sees and revokes them (Account → Connected apps)
 *   tokens      access tokens (1 hour) and refresh tokens (30 days, sliding). Refresh tokens rotate at
 *               each use. A refresh token used again after the grace time revokes the whole grant
 *               (reuse detection, OAuth 2.1 §4.3.1 and the OAuth security BCP).
 *   devices     the device authorization grant (RFC 8628, src/directory/device.ts): a program gets a token
 *               when a signed-in person types its user code on /device. 10 minutes, single use.
 *
 * Only SHA-256 hashes of codes and tokens are stored. Runs inside the Directory Durable Object
 * (SQLite); pure enough to test in Node.
 */
import { randomToken, sameString, sha256B64url } from "./crypto";
import { publicHostname } from "../core/repo-rules";
import {
  CLI_CLIENT_ID,
  CLI_CLIENT_NAME,
  DEVICE_GRANT,
  DEVICE_INTERVAL_S,
  DEVICE_MISSES_MAX,
  DEVICE_MISSES_WINDOW_MS,
  DEVICE_TTL_S,
  formatUserCode,
  newDeviceCode,
  newUserCode,
  normalizeUserCode,
} from "./device";

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 10 * 60_000;
const REQUEST_TTL_MS = 15 * 60_000;
/** A refresh token presented again within this time (a client retry) gets a new pair instead of revoking the grant. */
const REUSE_GRACE_MS = 30_000;
const CIMD_TTL_MS = 24 * 3600_000;
const CIMD_STALE_MS = 7 * 24 * 3600_000;
const MAX_REDIRECTS = 10;
/** New clients (registrations and metadata documents) per hour: per address, and for the whole server. */
const MAX_CLIENTS_PER_ADDRESS_HOUR = 30;
const MAX_CLIENTS_PER_HOUR = 3000;
/** New device sign-ins per hour: per address, and for the whole server. */
const MAX_DEVICES_PER_ADDRESS_HOUR = 30;
const MAX_DEVICES_PER_HOUR = 3000;
/** The grant types of a registered client that names none. */
const DEFAULT_GRANTS = ["authorization_code", "refresh_token"];
/** A client that nobody ever allowed is removed after a day; one whose grants are all revoked, after 30 days. */
const NEVER_ALLOWED_CLIENT_MS = 24 * 3600_000;
const UNUSED_CLIENT_MS = 30 * 24 * 3600_000;
/** The full scope: read and change. A token with no scope on record (made before mcp:read) has it. */
export const SCOPE = "mcp";
/** Read only: the tools that only read (their read-only hint says so). */
export const SCOPE_READ = "mcp:read";
/** The scopes that a request may name. Only mcp and mcp:read change the access (see accessScope). */
const KNOWN_SCOPES = new Set([SCOPE, SCOPE_READ, "offline_access", "openid", "profile", "email"]);

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

export const OAUTH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, secret_hash TEXT, name TEXT NOT NULL, uri TEXT, redirect_uris TEXT NOT NULL, auth_method TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, fetched_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS oauth_clients_created ON oauth_clients (created_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, grant_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS oauth_grants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS oauth_grants_user ON oauth_grants (user_id, client_id)`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL, resource TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens (grant_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_tokens_expiry ON oauth_tokens (expires_at)`,
  // Device sign-ins (RFC 8628). status: pending, allowed, denied or used. hash: of the device code; user_hash: of the user code.
  `CREATE TABLE IF NOT EXISTS oauth_devices (hash TEXT PRIMARY KEY, user_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT, status TEXT NOT NULL, user_id TEXT, grant_id TEXT, interval_s INTEGER NOT NULL, polled_at INTEGER, address TEXT, family TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS oauth_devices_created ON oauth_devices (created_at)`,
];

/* ───────────────────────── types ───────────────────────── */

interface Sql {
  exec<T = Record<string, unknown>>(q: string, ...b: unknown[]): { toArray(): T[]; one(): T } & Iterable<T>;
}

export interface OAuthClient {
  clientId: string;
  name: string;
  uri?: string;
  redirectUris: string[];
  /** "none" (public client with PKCE), "client_secret_post" or "client_secret_basic". */
  authMethod: "none" | "client_secret_post" | "client_secret_basic";
  /** builtin: gitring's own command line (no registration). */
  kind: "dcr" | "cimd" | "builtin";
  /** The grant types that the client may use. */
  grantTypes: string[];
}

/** gitring's own command line: every gitring knows it. It signs in with the device grant only. */
const CLI_CLIENT: OAuthClient = { clientId: CLI_CLIENT_ID, name: CLI_CLIENT_NAME, redirectUris: [], authMethod: "none", kind: "builtin", grantTypes: [DEVICE_GRANT, "refresh_token"] };

/** A device sign-in that waits for a person, as the /device page shows it. */
export interface PendingDevice {
  /** The user code, as people read it ("BCDF-GHJK"). */
  userCode: string;
  clientId: string;
  clientName: string;
  clientUri?: string;
  /** True for gitring's own command line. Other clients named themselves: gitring did not check the name. */
  builtin: boolean;
  scope: string;
  resource?: string;
  /** The address that started the sign-in. */
  address?: string;
  createdAt: number;
  expiresAt: number;
}

/** A validated authorization request, kept while the person signs in and decides. */
export interface PendingRequest {
  id: string;
  clientId: string;
  clientName: string;
  clientUri?: string;
  redirectUri: string;
  state?: string;
  challenge: string;
  scope: string;
  resource?: string;
  /** prompt=consent: always ask, also with an existing grant. */
  forceConsent: boolean;
}

export type OAuthError = { error: string; error_description: string };

/** A row of oauth_devices. */
interface DeviceRow {
  hash: string;
  user_hash: string;
  client_id: string;
  scope: string;
  resource: string | null;
  status: "pending" | "allowed" | "denied" | "used";
  user_id: string | null;
  grant_id: string | null;
  interval_s: number;
  polled_at: number | null;
  address: string | null;
  family: string | null;
  created_at: number;
  expires_at: number;
}

/** JSON bodies of the endpoints: flat plain data, so that they cross the Durable Object RPC boundary. */
export type JsonObject = Record<string, string | number | boolean | null | string[]>;

export type TokenAnswer = { status: number; body: JsonObject; headers?: Record<string, string> };

export interface OAuthDeps {
  sql: Sql;
  now?: () => number;
  /** fetch for client ID metadata documents (tests stub it). */
  fetch?: typeof fetch;
}

const err = (error: string, error_description: string): OAuthError => ({ error, error_description });

function rand(n: number): string {
  return randomToken(n).replace(/[-_]/g, "x").slice(0, Math.ceil((n * 4) / 3));
}

/* ───────────────────────── URL rules ───────────────────────── */

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

function resourceOk(asked: string | undefined | null, origin: string): boolean {
  return !asked || canonicalResource(asked, origin) !== null;
}

/** The text of an invalid_target answer: the resources of this server. */
function resourceHint(origin: string): string {
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

/* ───────────────────────── the store ───────────────────────── */

export class OAuthStore {
  private readonly sql: Sql;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private cleanedAt = 0;
  /** Wrong user codes on /device per person (see deviceLookup). The Directory is one object, so memory is enough. */
  private readonly deviceMisses = new Map<string, { n: number; since: number }>();

  constructor(deps: OAuthDeps) {
    this.sql = deps.sql;
    this.now = deps.now ?? (() => Date.now());
    this.fetcher = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    for (const s of OAUTH_SCHEMA) this.sql.exec(s);
    // Token families (one per code exchange) came after the first tables: add the column once.
    const cols = this.sql.exec<{ name: string }>("PRAGMA table_info(oauth_tokens)").toArray().map((c) => c.name);
    if (!cols.includes("family")) this.sql.exec("ALTER TABLE oauth_tokens ADD COLUMN family TEXT");
    // The scope of each token (mcp or mcp:read). A token with none is an older one: it has the full scope.
    if (!cols.includes("scope")) this.sql.exec("ALTER TABLE oauth_tokens ADD COLUMN scope TEXT");
    this.sql.exec("CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens (family)");
    const codeCols = this.sql.exec<{ name: string }>("PRAGMA table_info(oauth_codes)").toArray().map((c) => c.name);
    if (!codeCols.includes("family")) this.sql.exec("ALTER TABLE oauth_codes ADD COLUMN family TEXT");
    // The address that made a client known (registration, or the first metadata document fetch): the caps per address.
    const clientCols = this.sql.exec<{ name: string }>("PRAGMA table_info(oauth_clients)").toArray().map((c) => c.name);
    if (!clientCols.includes("address")) this.sql.exec("ALTER TABLE oauth_clients ADD COLUMN address TEXT");
    // The grant types of a registered client (JSON). None on record: authorization_code and refresh_token.
    if (!clientCols.includes("grant_types")) this.sql.exec("ALTER TABLE oauth_clients ADD COLUMN grant_types TEXT");
  }

  /** Too many new clients in the last hour, from this address or in all. */
  private clientCapReached(address: string | undefined): boolean {
    const hourAgo = this.now() - 3600_000;
    if (address) {
      const mine = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM oauth_clients WHERE address = ? AND created_at > ?", address, hourAgo).one().n;
      if (mine >= MAX_CLIENTS_PER_ADDRESS_HOUR) return true;
    }
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM oauth_clients WHERE created_at > ?", hourAgo).one().n >= MAX_CLIENTS_PER_HOUR;
  }

  /* ───────────── clients ───────────── */

  /** RFC 7591 dynamic client registration. Answers the registration response or an error. `address`: the caller, for the caps. */
  async register(raw: unknown, address?: string): Promise<{ status: number; body: JsonObject }> {
    const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const uris = Array.isArray(m.redirect_uris) ? m.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    const grants = Array.isArray(m.grant_types) ? m.grant_types : DEFAULT_GRANTS;
    if (!grants.length || grants.some((g) => g !== "authorization_code" && g !== "refresh_token" && g !== DEVICE_GRANT)) {
      return { status: 400, body: err("invalid_client_metadata", `gitring supports the grant types authorization_code, refresh_token and ${DEVICE_GRANT}.`) };
    }
    // A client that only uses the device grant never gets a redirect: it needs no redirect URI.
    const codeFlow = grants.includes("authorization_code");
    if (!uris.length && codeFlow) return { status: 400, body: err("invalid_redirect_uri", "Give at least one redirect URI.") };
    if (uris.length > MAX_REDIRECTS) return { status: 400, body: err("invalid_redirect_uri", `Give at most ${MAX_REDIRECTS} redirect URIs.`) };
    const bad = uris.find((u) => !redirectOk(u) || u.length > 500);
    if (bad) return { status: 400, body: err("invalid_redirect_uri", `This redirect URI is not allowed: ${bad.slice(0, 120)}. Use https, a loopback http address, or an app scheme.`) };
    const method = m.token_endpoint_auth_method === undefined ? "none" : m.token_endpoint_auth_method;
    if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
      return { status: 400, body: err("invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.") };
    }
    const responses = Array.isArray(m.response_types) ? m.response_types : ["code"];
    if (responses.some((r) => r !== "code")) return { status: 400, body: err("invalid_client_metadata", "gitring supports the response type code.") };
    if (this.clientCapReached(address)) return { status: 429, body: err("temporarily_unavailable", "Too many registrations in the last hour. Try again later.") };
    const name = typeof m.client_name === "string" && m.client_name.trim() ? m.client_name.trim().slice(0, 100) : "MCP client";
    const uri = typeof m.client_uri === "string" && /^https:\/\//.test(m.client_uri) ? m.client_uri.slice(0, 300) : undefined;
    const clientId = `gitring-${rand(18)}`;
    const secret = method === "none" ? undefined : `gcs_${randomToken(32)}`;
    const now = this.now();
    const grantTypes = [...new Set(grants as string[])];
    this.sql.exec(
      "INSERT INTO oauth_clients (client_id, secret_hash, name, uri, redirect_uris, auth_method, kind, created_at, address, grant_types) VALUES (?, ?, ?, ?, ?, ?, 'dcr', ?, ?, ?)",
      clientId,
      secret ? await sha256B64url(secret) : null,
      name,
      uri ?? null,
      JSON.stringify(uris),
      method,
      now,
      address ?? null,
      JSON.stringify(grantTypes),
    );
    return {
      status: 201,
      body: {
        client_id: clientId,
        client_id_issued_at: Math.floor(now / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: name,
        ...(uri ? { client_uri: uri } : {}),
        redirect_uris: uris,
        grant_types: grantTypes,
        response_types: codeFlow ? ["code"] : [],
        token_endpoint_auth_method: method,
        scope: SCOPE,
      },
    };
  }

  /**
   * A client by id: a registered one, or a client ID metadata document (https URL), fetched and cached
   * for a day. When a refetch fails, the cached document stays in use for up to a week (stale-if-error),
   * so that a short outage of the client's site does not sign people out.
   */
  async client(clientId: string, address?: string): Promise<OAuthClient | null> {
    if (!clientId || clientId.length > 500) return null;
    if (clientId === CLI_CLIENT_ID) return CLI_CLIENT;
    const row = this.sql
      .exec<{ client_id: string; name: string; uri: string | null; redirect_uris: string; auth_method: string; kind: string; fetched_at: number | null; grant_types: string | null }>(
        "SELECT client_id, name, uri, redirect_uris, auth_method, kind, fetched_at, grant_types FROM oauth_clients WHERE client_id = ?",
        clientId,
      )
      .toArray()[0];
    const cached: OAuthClient | null = row
      ? {
          clientId: row.client_id,
          name: row.name,
          uri: row.uri ?? undefined,
          redirectUris: JSON.parse(row.redirect_uris) as string[],
          authMethod: row.auth_method as OAuthClient["authMethod"],
          kind: row.kind as OAuthClient["kind"],
          grantTypes: row.grant_types ? (JSON.parse(row.grant_types) as string[]) : DEFAULT_GRANTS,
        }
      : null;
    const age = this.now() - (row?.fetched_at ?? 0);
    if (cached && (cached.kind !== "cimd" || age < CIMD_TTL_MS)) return cached;
    if (!isCimdId(clientId)) return null;
    const fetched = await this.fetchMetadataDocument(clientId, address);
    if (fetched === "invalid") return null;
    if (fetched) return fetched;
    return cached && age < CIMD_STALE_MS ? cached : null;
  }

  /** Fetch and store a metadata document. Answers null when the fetch failed, "invalid" for a bad document. */
  private async fetchMetadataDocument(clientId: string, address?: string): Promise<OAuthClient | null | "invalid"> {
    let doc: Record<string, unknown>;
    try {
      const res = await this.fetcher(clientId, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (res.status >= 400 && res.status < 500) return "invalid";
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > 20_000) return "invalid";
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!doc || typeof doc !== "object" || doc.client_id !== clientId) return "invalid";
    // A metadata document must not carry a shared secret (§4.1).
    if ("client_secret" in doc || "client_secret_expires_at" in doc) return "invalid";
    const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === "string" && redirectOk(u)).slice(0, MAX_REDIRECTS) : [];
    if (!uris.length) return "invalid";
    const name = typeof doc.client_name === "string" && doc.client_name.trim() ? doc.client_name.trim().slice(0, 100) : new URL(clientId).hostname;
    const uri = typeof doc.client_uri === "string" && /^https:\/\//.test(doc.client_uri) ? doc.client_uri.slice(0, 300) : undefined;
    // New metadata documents count against the same hourly caps as registrations (storage growth). A
    // document fetched again keeps its first-seen time.
    const known = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM oauth_clients WHERE client_id = ?", clientId).one().n > 0;
    if (!known && this.clientCapReached(address)) return null;
    // A metadata document client authenticates with PKCE only (private_key_jwt is not supported here).
    this.sql.exec(
      `INSERT INTO oauth_clients (client_id, secret_hash, name, uri, redirect_uris, auth_method, kind, created_at, fetched_at, address) VALUES (?, NULL, ?, ?, ?, 'none', 'cimd', ?, ?, ?)
       ON CONFLICT (client_id) DO UPDATE SET name = excluded.name, uri = excluded.uri, redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at`,
      clientId,
      name,
      uri ?? null,
      JSON.stringify(uris),
      this.now(),
      this.now(),
      address ?? null,
    );
    return { clientId, name, uri, redirectUris: uris, authMethod: "none", kind: "cimd", grantTypes: DEFAULT_GRANTS };
  }

  /* ───────────── authorization ───────────── */

  /**
   * Check an authorization request. Errors before the redirect URI is known go to the person ("page");
   * later errors go back to the client ("redirect"). On success, the request waits as a pending request.
   */
  async startRequest(
    q: Record<string, string | undefined>,
    origin: string,
    address?: string,
  ): Promise<{ ok: true; request: PendingRequest } | { ok: false; page: string } | { ok: false; redirect: string; clientId: string; clientName: string; reason: string }> {
    const clientId = q.client_id ?? "";
    const client = await this.client(clientId, address);
    if (!client) return { ok: false, page: "This app is not registered with gitring. Add gitring to the app again." };
    let redirectUri = q.redirect_uri;
    if (!redirectUri) {
      if (client.redirectUris.length !== 1) return { ok: false, page: "The app did not say where to go back to (redirect_uri)." };
      redirectUri = client.redirectUris[0];
    }
    if (!redirectMatches(client.redirectUris, redirectUri)) return { ok: false, page: "The app asked to go back to an address that it did not register." };
    const back = (e: OAuthError) => ({
      ok: false as const,
      redirect: withParams(redirectUri!, { error: e.error, error_description: e.error_description, state: q.state, iss: origin }),
      clientId: client.clientId,
      clientName: client.name,
      reason: e.error_description,
    });
    if (q.response_type !== "code") return back(err("unsupported_response_type", "gitring supports response_type=code."));
    if (!q.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return back(err("invalid_request", "Send a PKCE code_challenge (S256)."));
    if ((q.code_challenge_method ?? "") !== "S256") return back(err("invalid_request", "code_challenge_method must be S256."));
    if (!resourceOk(q.resource, origin)) return back(err("invalid_target", resourceHint(origin)));
    const scopes = (q.scope ?? SCOPE).split(/\s+/).filter(Boolean);
    if (scopes.some((s) => !KNOWN_SCOPES.has(s))) return back(err("invalid_scope", `gitring knows the scopes "${SCOPE}" (read and change) and "${SCOPE_READ}" (read only).`));
    const request: PendingRequest = {
      id: `req_${rand(24)}`,
      clientId: client.clientId,
      clientName: client.name,
      clientUri: client.uri,
      redirectUri,
      state: q.state ? q.state.slice(0, 1000) : undefined,
      challenge: q.code_challenge,
      scope: accessScope(scopes),
      // The token is bound to this endpoint (the bare origin means the default endpoint).
      resource: q.resource ? (canonicalResource(q.resource, origin) ?? undefined) : undefined,
      forceConsent: (q.prompt ?? "").split(/\s+/).includes("consent"),
    };
    this.cleanup();
    this.sql.exec("INSERT INTO oauth_requests (id, data, expires_at) VALUES (?, ?, ?)", request.id, JSON.stringify(request), this.now() + REQUEST_TTL_MS);
    return { ok: true, request };
  }

  request(id: string): PendingRequest | null {
    const row = this.sql.exec<{ data: string; expires_at: number }>("SELECT data, expires_at FROM oauth_requests WHERE id = ?", String(id ?? "")).toArray()[0];
    if (!row || row.expires_at < this.now()) return null;
    return JSON.parse(row.data) as PendingRequest;
  }

  /**
   * The person has an active grant for this client that covers `scope` (consent can be skipped). A grant
   * for read only does not cover a request to read and change: the person must say yes to that.
   */
  hasGrant(userId: string, clientId: string, scope: string = SCOPE): boolean {
    const row = this.sql.exec<{ scope: string }>("SELECT scope FROM oauth_grants WHERE user_id = ? AND client_id = ? AND revoked = 0", userId, clientId).toArray()[0];
    return Boolean(row) && scopeCovers(row.scope, scope);
  }

  /** The person allows the request: a grant (new or the existing one) and a single-use code. Answers the redirect URL. */
  async approve(requestId: string, userId: string, origin: string): Promise<string | null> {
    const r = this.request(requestId);
    if (!r) return null;
    this.sql.exec("DELETE FROM oauth_requests WHERE id = ?", r.id);
    const now = this.now();
    const grant = this.grantFor(userId, r.clientId, r.scope);
    const code = `goc_${randomToken(32)}`;
    this.sql.exec(
      "INSERT INTO oauth_codes (hash, client_id, user_id, grant_id, redirect_uri, challenge, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      await sha256B64url(code),
      r.clientId,
      userId,
      grant,
      r.redirectUri,
      r.challenge,
      r.scope,
      r.resource ?? null,
      now + CODE_TTL_MS,
    );
    return withParams(r.redirectUri, { code, state: r.state, iss: origin });
  }

  /** The grant of a person for a client that the person just allowed: the existing one (made wide enough for `scope`), or a new one. */
  private grantFor(userId: string, clientId: string, scope: string): string {
    const had = this.sql.exec<{ id: string; scope: string }>("SELECT id, scope FROM oauth_grants WHERE user_id = ? AND client_id = ? AND revoked = 0", userId, clientId).toArray()[0];
    if (!had) {
      const grant = `grant_${rand(18)}`;
      this.sql.exec("INSERT INTO oauth_grants (id, user_id, client_id, scope, created_at) VALUES (?, ?, ?, ?, ?)", grant, userId, clientId, scope, this.now());
      return grant;
    }
    // The person allowed read only before, and allows read and change now.
    if (!scopeCovers(had.scope, scope)) this.sql.exec("UPDATE oauth_grants SET scope = ? WHERE id = ?", scope, had.id);
    return had.id;
  }

  /** The person says no. Answers the redirect URL with access_denied. */
  deny(requestId: string, origin: string): string | null {
    const r = this.request(requestId);
    if (!r) return null;
    this.sql.exec("DELETE FROM oauth_requests WHERE id = ?", r.id);
    return withParams(r.redirectUri, { error: "access_denied", error_description: "The person did not allow the app.", state: r.state, iss: origin });
  }

  /* ───────────── token endpoint ───────────── */

  /**
   * POST /oauth/token. `form` holds the request parameters; `basic` is the decoded HTTP Basic
   * client authentication, if any.
   */
  async token(form: Record<string, string | undefined>, basic: { id: string; secret: string } | null, origin: string, address?: string): Promise<TokenAnswer> {
    const noStore = { "cache-control": "no-store", pragma: "no-cache" };
    const fail = (status: number, e: OAuthError, extra: Record<string, string> = {}): TokenAnswer => ({ status, body: e, headers: { ...noStore, ...extra } });
    const auth = await this.authenticateClient(form, basic, address);
    if (!auth.ok) return fail(401, auth.error, basic ? { "www-authenticate": 'Basic realm="gitring"' } : {});
    const client = auth.client;
    if (!resourceOk(form.resource, origin)) return fail(400, err("invalid_target", resourceHint(origin)));

    if (form.grant_type === "authorization_code") {
      // Hash first: the checks and the "used" mark below run with no await between them, so two
      // requests with the same code cannot both pass (the Durable Object may interleave at an await).
      const codeHash = await sha256B64url(form.code ?? "");
      const verifier = form.code_verifier ?? "";
      const verifierHash = await sha256B64url(verifier);
      const row = this.sql
        .exec<{ hash: string; client_id: string; user_id: string; grant_id: string; redirect_uri: string; challenge: string; scope: string; resource: string | null; expires_at: number; used: number; family: string | null }>(
          "SELECT * FROM oauth_codes WHERE hash = ?",
          codeHash,
        )
        .toArray()[0];
      if (!row) return fail(400, err("invalid_grant", "The code is not valid."));
      if (row.used) {
        // A code used twice: someone may have stolen it. Revoke what the first use gave out.
        if (row.family) this.revokeFamily(row.family);
        else this.revokeGrantTokens(row.grant_id);
        return fail(400, err("invalid_grant", "The code was already used."));
      }
      if (row.expires_at < this.now()) return fail(400, err("invalid_grant", "The code expired. Sign in again."));
      if (row.client_id !== client.clientId) return fail(400, err("invalid_grant", "The code belongs to another client."));
      if (form.redirect_uri !== undefined && form.redirect_uri !== row.redirect_uri) return fail(400, err("invalid_grant", "The redirect URI does not match the authorization request."));
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !sameString(verifierHash, row.challenge)) {
        return fail(400, err("invalid_grant", "The PKCE code_verifier does not match."));
      }
      if (form.resource && row.resource && canonicalResource(form.resource, origin) !== canonicalResource(row.resource, origin)) {
        return fail(400, err("invalid_target", "The resource does not match the authorization request."));
      }
      // Each code exchange starts a token family (one sign-in of one app on one device).
      const family = `fam_${rand(18)}`;
      this.sql.exec("UPDATE oauth_codes SET used = 1, family = ? WHERE hash = ?", family, row.hash);
      if (!this.grantActive(row.grant_id)) return fail(400, err("invalid_grant", "The person removed this app."));
      const resource = row.resource ? canonicalResource(row.resource, origin) : form.resource ? canonicalResource(form.resource, origin) : null;
      return { status: 200, body: await this.issue(row.grant_id, row.scope, resource, family), headers: noStore };
    }

    if (form.grant_type === "refresh_token") {
      const hash = await sha256B64url(form.refresh_token ?? "");
      // No await from here to the "used" mark (see above).
      const row = this.sql
        .exec<{ hash: string; grant_id: string; kind: string; resource: string | null; scope: string | null; expires_at: number; used_at: number | null; family: string | null }>("SELECT * FROM oauth_tokens WHERE hash = ?", hash)
        .toArray()[0];
      if (!row || row.kind !== "refresh") return fail(400, err("invalid_grant", "The refresh token is not valid."));
      const grant = this.sql.exec<{ client_id: string; scope: string; revoked: number }>("SELECT client_id, scope, revoked FROM oauth_grants WHERE id = ?", row.grant_id).toArray()[0];
      if (!grant || grant.revoked) return fail(400, err("invalid_grant", "The person removed this app."));
      if (grant.client_id !== client.clientId) return fail(400, err("invalid_grant", "The refresh token belongs to another client."));
      if (row.expires_at < this.now()) return fail(400, err("invalid_grant", "The refresh token expired. Sign in again."));
      const family = row.family ?? `fam_${rand(18)}`;
      if (row.used_at !== null) {
        if (this.now() - row.used_at > REUSE_GRACE_MS) {
          // Reuse of a rotated refresh token: the token may be stolen. End this sign-in (the family).
          if (row.family) this.revokeFamily(row.family);
          else this.revokeGrantTokens(row.grant_id);
          return fail(400, err("invalid_grant", "The refresh token was already used. For safety, gitring ended this sign-in of the app. Connect it again."));
        }
      } else {
        this.sql.exec("UPDATE oauth_tokens SET used_at = ? WHERE hash = ?", this.now(), row.hash);
      }
      // The new tokens have the scope of the refresh token, never more: the grant can be wider (the
      // person allowed the app to read and change in another sign-in), but this sign-in is not.
      return { status: 200, body: await this.issue(row.grant_id, row.scope || SCOPE, row.resource, family), headers: noStore };
    }

    if (form.grant_type === DEVICE_GRANT) return this.deviceToken(form, client, origin, fail);

    return fail(400, err("unsupported_grant_type", `gitring supports authorization_code, refresh_token and ${DEVICE_GRANT}.`));
  }

  /**
   * Client authentication at the token and revocation endpoints: public clients send their id; clients
   * with a secret send it (client_secret_basic or client_secret_post).
   */
  private async authenticateClient(
    form: Record<string, string | undefined>,
    basic: { id: string; secret: string } | null,
    address?: string,
  ): Promise<{ ok: true; client: OAuthClient } | { ok: false; error: OAuthError }> {
    const clientId = basic?.id ?? form.client_id ?? "";
    const client = await this.client(clientId, address);
    if (!client) return { ok: false, error: err("invalid_client", "Unknown client.") };
    if (client.authMethod === "none") return { ok: true, client };
    const secret = basic?.secret ?? form.client_secret ?? "";
    const hash = await sha256B64url(secret);
    const row = this.sql.exec<{ secret_hash: string | null }>("SELECT secret_hash FROM oauth_clients WHERE client_id = ?", client.clientId).toArray()[0];
    if (!secret || !row?.secret_hash || !sameString(hash, row.secret_hash)) return { ok: false, error: err("invalid_client", "The client secret is not valid.") };
    return { ok: true, client };
  }

  private grantActive(grantId: string): boolean {
    return Boolean(this.sql.exec("SELECT id FROM oauth_grants WHERE id = ? AND revoked = 0", grantId).toArray()[0]);
  }

  private async issue(grantId: string, scope: string, resource: string | null, family: string): Promise<JsonObject> {
    const access = `goa_${randomToken(32)}`;
    const refresh = `gor_${randomToken(32)}`;
    const [accessHash, refreshHash] = await Promise.all([sha256B64url(access), sha256B64url(refresh)]);
    const now = this.now();
    // Only the newest refresh token of a family works. An older one that nobody used (a lost answer,
    // or a second use within the grace time) now counts as used long ago: if it comes back, gitring
    // ends the family, so two chains of one family cannot live side by side.
    this.sql.exec("UPDATE oauth_tokens SET used_at = ? WHERE family = ? AND kind = 'refresh' AND used_at IS NULL", now - REUSE_GRACE_MS - 1, family);
    this.sql.exec("INSERT INTO oauth_tokens (hash, grant_id, kind, resource, scope, created_at, expires_at, family) VALUES (?, ?, 'access', ?, ?, ?, ?, ?)", accessHash, grantId, resource, scope, now, now + ACCESS_TTL_S * 1000, family);
    this.sql.exec("INSERT INTO oauth_tokens (hash, grant_id, kind, resource, scope, created_at, expires_at, family) VALUES (?, ?, 'refresh', ?, ?, ?, ?, ?)", refreshHash, grantId, resource, scope, now, now + REFRESH_TTL_S * 1000, family);
    this.sql.exec("UPDATE oauth_grants SET last_used = ? WHERE id = ?", now, grantId);
    this.cleanup();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
  }

  /* ───────────── device authorization grant (RFC 8628) ───────────── */

  /**
   * POST /oauth/device_authorization: a program asks for a sign-in. Answers the device code (for the
   * program), the user code (for the person) and the page where the person types it.
   */
  async deviceStart(form: Record<string, string | undefined>, basic: { id: string; secret: string } | null, origin: string, address?: string): Promise<TokenAnswer> {
    const noStore = { "cache-control": "no-store", pragma: "no-cache" };
    const fail = (status: number, e: OAuthError): TokenAnswer => ({ status, body: e, headers: noStore });
    const auth = await this.authenticateClient(form, basic, address);
    if (!auth.ok) return fail(401, auth.error);
    const client = auth.client;
    if (!client.grantTypes.includes(DEVICE_GRANT)) return fail(400, err("unauthorized_client", `This app may not use the device grant. Register it with the grant type ${DEVICE_GRANT}.`));
    if (!resourceOk(form.resource, origin)) return fail(400, err("invalid_target", resourceHint(origin)));
    const scopes = (form.scope ?? SCOPE).split(/\s+/).filter(Boolean);
    if (scopes.some((s) => !KNOWN_SCOPES.has(s))) return fail(400, err("invalid_scope", `gitring knows the scopes "${SCOPE}" (read and change) and "${SCOPE_READ}" (read only).`));
    if (this.deviceCapReached(address)) return fail(429, err("temporarily_unavailable", "Too many sign-ins in the last hour. Try again later."));
    const deviceCode = newDeviceCode();
    const hash = await sha256B64url(deviceCode);
    // The token works at one MCP endpoint (RFC 8707): the one that the program names, else /mcp.
    const resource = (form.resource ? canonicalResource(form.resource, origin) : null) ?? resourceOf(origin);
    let userCode = "";
    for (let i = 0; i < 5 && !userCode; i++) {
      const candidate = newUserCode();
      const userHash = await sha256B64url(candidate);
      // No await from the check to the insert: two sign-ins cannot get the same code.
      if (this.sql.exec("SELECT 1 FROM oauth_devices WHERE user_hash = ?", userHash).toArray().length) continue;
      const now = this.now();
      this.sql.exec(
        "INSERT INTO oauth_devices (hash, user_hash, client_id, scope, resource, status, interval_s, address, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
        hash,
        userHash,
        client.clientId,
        accessScope(scopes),
        resource,
        DEVICE_INTERVAL_S,
        address ?? null,
        now,
        now + DEVICE_TTL_S * 1000,
      );
      userCode = candidate;
    }
    if (!userCode) return fail(503, err("temporarily_unavailable", "gitring could not make a code. Try again."));
    this.cleanup();
    const shown = formatUserCode(userCode);
    return {
      status: 200,
      headers: noStore,
      body: {
        device_code: deviceCode,
        user_code: shown,
        verification_uri: `${origin}/device`,
        verification_uri_complete: `${origin}/device?code=${shown}`,
        expires_in: DEVICE_TTL_S,
        interval: DEVICE_INTERVAL_S,
      },
    };
  }

  /**
   * The sign-in that waits for the user code that a person typed on /device. Wrong codes count per
   * person: after DEVICE_MISSES_MAX of them, the page stops for a while ("locked"), so that nobody can
   * guess the codes of other people.
   */
  async deviceLookup(raw: string, userId: string): Promise<{ ok: true; device: PendingDevice } | { ok: false; reason: "unknown" | "locked" }> {
    if (this.deviceLocked(userId)) return { ok: false, reason: "locked" };
    const code = normalizeUserCode(raw);
    const row = code ? this.pendingDevice(await sha256B64url(code)) : undefined;
    if (!code || !row) {
      this.deviceMiss(userId);
      return { ok: false, reason: this.deviceLocked(userId) ? "locked" : "unknown" };
    }
    return { ok: true, device: await this.deviceView(row, code) };
  }

  /** The person allows the sign-in (a grant, as on the consent page) or not. Null when the code does not wait any more. */
  async deviceDecide(raw: string, userId: string, allow: boolean): Promise<PendingDevice | null> {
    const code = normalizeUserCode(raw);
    if (!code) return null;
    const userHash = await sha256B64url(code);
    // No await from the read to the write: only the first answer counts.
    const row = this.pendingDevice(userHash);
    if (!row) return null;
    if (allow) {
      const grant = this.grantFor(userId, row.client_id, row.scope);
      this.sql.exec("UPDATE oauth_devices SET status = 'allowed', user_id = ?, grant_id = ? WHERE hash = ?", userId, grant, row.hash);
    } else {
      this.sql.exec("UPDATE oauth_devices SET status = 'denied', user_id = ? WHERE hash = ?", userId, row.hash);
    }
    return this.deviceView(row, code);
  }

  /** POST /oauth/token with the device grant: the program asks again until the person answers (RFC 8628 §3.4, §3.5). */
  private async deviceToken(form: Record<string, string | undefined>, client: OAuthClient, origin: string, fail: (status: number, e: OAuthError) => TokenAnswer): Promise<TokenAnswer> {
    if (!client.grantTypes.includes(DEVICE_GRANT)) return fail(400, err("unauthorized_client", `This app may not use the device grant. Register it with the grant type ${DEVICE_GRANT}.`));
    const hash = await sha256B64url(form.device_code ?? "");
    // No await from here to the "used" mark (see the code exchange).
    const row = this.sql.exec<DeviceRow>("SELECT * FROM oauth_devices WHERE hash = ?", hash).toArray()[0];
    if (!row) return fail(400, err("invalid_grant", "The device code is not valid."));
    if (row.client_id !== client.clientId) return fail(400, err("invalid_grant", "The device code belongs to another client."));
    if (row.status === "used") {
      // A device code used twice: someone may have copied it. End the sign-in that the first use started.
      if (row.family) this.revokeFamily(row.family);
      return fail(400, err("invalid_grant", "The device code was already used."));
    }
    const now = this.now();
    if (row.expires_at < now) return fail(400, err("expired_token", "The code expired. Start the sign-in again."));
    if (row.status === "denied") return fail(400, err("access_denied", "The person did not allow the sign-in."));
    if (row.status === "pending") {
      if (row.polled_at !== null && now - row.polled_at < row.interval_s * 1000) {
        // The program asks too often: it waits 5 seconds more from now on (RFC 8628 §3.5).
        this.sql.exec("UPDATE oauth_devices SET interval_s = ?, polled_at = ? WHERE hash = ?", row.interval_s + 5, now, hash);
        return fail(400, err("slow_down", `Ask less often. Wait ${row.interval_s + 5} seconds between two requests.`));
      }
      this.sql.exec("UPDATE oauth_devices SET polled_at = ? WHERE hash = ?", now, hash);
      return fail(400, err("authorization_pending", "The person did not answer yet."));
    }
    const family = `fam_${rand(18)}`;
    this.sql.exec("UPDATE oauth_devices SET status = 'used', family = ? WHERE hash = ?", family, hash);
    if (!row.grant_id || !this.grantActive(row.grant_id)) return fail(400, err("invalid_grant", "The person removed this app."));
    const resource = row.resource ? canonicalResource(row.resource, origin) : resourceOf(origin);
    return { status: 200, body: await this.issue(row.grant_id, row.scope, resource, family), headers: { "cache-control": "no-store", pragma: "no-cache" } };
  }

  private pendingDevice(userHash: string): DeviceRow | undefined {
    return this.sql.exec<DeviceRow>("SELECT * FROM oauth_devices WHERE user_hash = ? AND status = 'pending' AND expires_at >= ?", userHash, this.now()).toArray()[0];
  }

  private async deviceView(row: DeviceRow, code: string): Promise<PendingDevice> {
    const client = await this.client(row.client_id);
    return {
      userCode: formatUserCode(code),
      clientId: row.client_id,
      clientName: client?.name ?? row.client_id,
      ...(client?.uri ? { clientUri: client.uri } : {}),
      builtin: row.client_id === CLI_CLIENT_ID,
      scope: row.scope,
      ...(row.resource ? { resource: row.resource } : {}),
      ...(row.address ? { address: row.address } : {}),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /** Too many device sign-ins in the last hour, from this address or in all. */
  private deviceCapReached(address: string | undefined): boolean {
    const hourAgo = this.now() - 3600_000;
    if (address && this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM oauth_devices WHERE address = ? AND created_at > ?", address, hourAgo).one().n >= MAX_DEVICES_PER_ADDRESS_HOUR) return true;
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM oauth_devices WHERE created_at > ?", hourAgo).one().n >= MAX_DEVICES_PER_HOUR;
  }

  private deviceLocked(userId: string): boolean {
    const m = this.deviceMisses.get(userId);
    if (!m) return false;
    if (this.now() - m.since > DEVICE_MISSES_WINDOW_MS) {
      this.deviceMisses.delete(userId);
      return false;
    }
    return m.n >= DEVICE_MISSES_MAX;
  }

  private deviceMiss(userId: string): void {
    const m = this.deviceMisses.get(userId);
    if (m && this.now() - m.since <= DEVICE_MISSES_WINDOW_MS) m.n++;
    else this.deviceMisses.set(userId, { n: 1, since: this.now() });
    if (this.deviceMisses.size > 10_000) this.deviceMisses.clear();
  }

  /* ───────────── revocation and validation ───────────── */

  /**
   * RFC 7009. A refresh token ends its family (that sign-in of the app: every token of it); an access
   * token only itself. The person's consent (the grant) stays. Unknown tokens are fine (200). A token of
   * another client is refused. Answers the person, so that the caller can forget cached lookups.
   */
  async revoke(form: Record<string, string | undefined>, basic: { id: string; secret: string } | null): Promise<{ status: number; body?: OAuthError; userId?: string }> {
    const token = form.token ?? "";
    const hash = await sha256B64url(token);
    // Public clients may leave out client_id at revocation; a client that sends one must be itself.
    if (basic || form.client_id) {
      const auth = await this.authenticateClient(form, basic);
      if (!auth.ok) return { status: 401, body: auth.error };
      const row = this.sql.exec<{ client_id: string }>("SELECT g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ?", hash).toArray()[0];
      if (row && row.client_id !== auth.client.clientId) return { status: 400, body: err("unauthorized_client", "This token belongs to another client.") };
    }
    if (!token) return { status: 200 };
    const row = this.sql
      .exec<{ grant_id: string; kind: string; family: string | null; user_id: string }>("SELECT t.grant_id, t.kind, t.family, g.user_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ?", hash)
      .toArray()[0];
    if (!row) return { status: 200 };
    if (row.kind === "refresh") {
      if (row.family) this.revokeFamily(row.family);
      else this.revokeGrantTokens(row.grant_id);
    } else this.sql.exec("DELETE FROM oauth_tokens WHERE hash = ?", hash);
    return { status: 200, userId: row.user_id };
  }

  /**
   * The person behind an access token, when it is valid at this endpoint (`resource`: the MCP endpoint
   * that gets the call; the default is /mcp). Answers the user id, client id and grant id, or null.
   */
  async accessUser(token: string, origin: string, resource: string = resourceOf(origin)): Promise<{ userId: string; clientId: string; grantId: string; scope: string; expiresAt: number } | null> {
    if (!token.startsWith("goa_")) return null;
    const row = this.sql
      .exec<{ grant_id: string; resource: string | null; scope: string | null; expires_at: number }>("SELECT grant_id, resource, scope, expires_at FROM oauth_tokens WHERE hash = ? AND kind = 'access'", await sha256B64url(token))
      .toArray()[0];
    if (!row || row.expires_at < this.now()) return null;
    if (!audienceOk(row.resource, origin, resource)) return null;
    const grant = this.sql.exec<{ user_id: string; client_id: string; revoked: number; last_used: number | null }>("SELECT user_id, client_id, revoked, last_used FROM oauth_grants WHERE id = ?", row.grant_id).toArray()[0];
    if (!grant || grant.revoked) return null;
    if (!grant.last_used || this.now() - grant.last_used > 60_000) this.sql.exec("UPDATE oauth_grants SET last_used = ? WHERE id = ?", this.now(), row.grant_id);
    return { userId: grant.user_id, clientId: grant.client_id, grantId: row.grant_id, scope: row.scope || SCOPE, expiresAt: row.expires_at };
  }

  /* ───────────── grants of a person ───────────── */

  grants(userId: string): { id: string; clientId: string; clientName: string; clientUri?: string; scope: string; createdAt: number; lastUsedAt?: number }[] {
    return this.sql
      .exec<{ id: string; client_id: string; scope: string; created_at: number; last_used: number | null; name: string | null; uri: string | null }>(
        "SELECT g.id, g.client_id, g.scope, g.created_at, g.last_used, c.name, c.uri FROM oauth_grants g LEFT JOIN oauth_clients c ON c.client_id = g.client_id WHERE g.user_id = ? AND g.revoked = 0 ORDER BY COALESCE(g.last_used, g.created_at) DESC",
        userId,
      )
      .toArray()
      .map((g) => ({ id: g.id, clientId: g.client_id, clientName: g.name ?? (g.client_id === CLI_CLIENT_ID ? CLI_CLIENT_NAME : g.client_id), ...(g.uri ? { clientUri: g.uri } : {}), scope: g.scope, createdAt: g.created_at, ...(g.last_used ? { lastUsedAt: g.last_used } : {}) }));
  }

  /** Revoke a grant of this person. Answers false when the grant is not theirs. */
  revokeUserGrant(userId: string, grantId: string): boolean {
    const row = this.sql.exec<{ id: string }>("SELECT id FROM oauth_grants WHERE id = ? AND user_id = ? AND revoked = 0", grantId, userId).toArray()[0];
    if (!row) return false;
    this.revokeGrant(grantId);
    return true;
  }

  /** Revoke every grant of a person (account deletion, sign-out everywhere). */
  revokeAllOf(userId: string): void {
    for (const g of this.sql.exec<{ id: string }>("SELECT id FROM oauth_grants WHERE user_id = ? AND revoked = 0", userId).toArray()) this.revokeGrant(g.id);
  }

  private revokeGrant(grantId: string): void {
    this.sql.exec("UPDATE oauth_grants SET revoked = 1 WHERE id = ?", grantId);
    this.revokeGrantTokens(grantId);
  }

  private revokeGrantTokens(grantId: string): void {
    this.sql.exec("DELETE FROM oauth_tokens WHERE grant_id = ?", grantId);
  }

  private revokeFamily(family: string): void {
    this.sql.exec("DELETE FROM oauth_tokens WHERE family = ?", family);
  }

  /** Drop expired requests, codes and tokens, and clients that nobody uses. At most every ten minutes. */
  private cleanup(): void {
    const now = this.now();
    if (now - this.cleanedAt < 10 * 60_000) return;
    this.cleanedAt = now;
    this.sql.exec("DELETE FROM oauth_requests WHERE expires_at < ?", now);
    this.sql.exec("DELETE FROM oauth_devices WHERE expires_at < ?", now - 3600_000);
    this.sql.exec("DELETE FROM oauth_codes WHERE expires_at < ?", now - 3600_000);
    this.sql.exec("DELETE FROM oauth_tokens WHERE expires_at < ?", now - 24 * 3600_000);
    this.sql.exec(
      "DELETE FROM oauth_clients WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)",
      now - NEVER_ALLOWED_CLIENT_MS,
    );
    this.sql.exec(
      "DELETE FROM oauth_clients WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id AND g.revoked = 0)",
      now - UNUSED_CLIENT_MS,
    );
  }
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

