/**
 * The base of the OAuth store: the SQL handle, the clock, the table upgrades and the removal of old rows.
 *
 * Every other layer builds on this class. See src/directory/oauth-store/README.md for the order of the layers.
 * Only SHA-256 hashes of codes and tokens are stored.
 */
import { NEVER_ALLOWED_CLIENT_MS, OAUTH_SCHEMA, UNUSED_CLIENT_MS } from "./constants";
import type { OAuthDeps, Sql } from "./types";

export abstract class OAuthBase {
  protected readonly sql: Sql;

  protected readonly now: () => number;

  protected readonly fetcher: typeof fetch;

  protected cleanedAt = 0;

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

  protected revokeGrant(grantId: string): void {
    this.sql.exec("UPDATE oauth_grants SET revoked = 1 WHERE id = ?", grantId);
    this.revokeGrantTokens(grantId);
  }

  protected revokeGrantTokens(grantId: string): void {
    this.sql.exec("DELETE FROM oauth_tokens WHERE grant_id = ?", grantId);
  }

  protected revokeFamily(family: string): void {
    this.sql.exec("DELETE FROM oauth_tokens WHERE family = ?", family);
  }

  /** Drop expired requests, codes and tokens, and clients that nobody uses. At most every ten minutes. */
  protected cleanup(): void {
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
