/**
 * The fixed numbers of the OAuth store (lifetimes, caps, scopes) and its SQL tables.
 *
 * Tokens last 1 hour (access) and 30 days (refresh, sliding). Codes last 10 minutes. Requests last 15 minutes.
 * Read next: src/directory/oauth-store/base.ts (runs the table list and adds old columns).
 */

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;
export const CODE_TTL_MS = 10 * 60_000;
export const REQUEST_TTL_MS = 15 * 60_000;
/** A refresh token presented again within this time (a client retry) gets a new pair instead of revoking the grant. */
export const REUSE_GRACE_MS = 30_000;
export const CIMD_TTL_MS = 24 * 3600_000;
export const CIMD_STALE_MS = 7 * 24 * 3600_000;
export const MAX_REDIRECTS = 10;
/** New clients (registrations and metadata documents) per hour: per address, and for the whole server. */
export const MAX_CLIENTS_PER_ADDRESS_HOUR = 30;
export const MAX_CLIENTS_PER_HOUR = 3000;
/** New device sign-ins per hour: per address, and for the whole server. */
export const MAX_DEVICES_PER_ADDRESS_HOUR = 30;
export const MAX_DEVICES_PER_HOUR = 3000;
/** The grant types of a registered client that names none. */
export const DEFAULT_GRANTS = ["authorization_code", "refresh_token"];
/** A client that nobody ever allowed is removed after a day; one whose grants are all revoked, after 30 days. */
export const NEVER_ALLOWED_CLIENT_MS = 24 * 3600_000;
export const UNUSED_CLIENT_MS = 30 * 24 * 3600_000;
/** The full scope: read and change. A token with no scope on record (made before mcp:read) has it. */
export const SCOPE = "mcp";
/** Read only: the tools that only read (their read-only hint says so). */
export const SCOPE_READ = "mcp:read";
/** The scopes that a request may name. Only mcp and mcp:read change the access (see accessScope). */
export const KNOWN_SCOPES = new Set([SCOPE, SCOPE_READ, "offline_access", "openid", "profile", "email"]);

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
