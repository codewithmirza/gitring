/**
 * Client authentication, and how an access token and a refresh token are made.
 *
 * A new pair ends the older refresh token of the same family: only the newest one works.
 * Never log a token.
 */
import { randomToken, sameString, sha256B64url } from "../crypto";
import { ACCESS_TTL_S, REFRESH_TTL_S, REUSE_GRACE_MS } from "./constants";
import { err, type JsonObject, type OAuthClient, type OAuthError } from "./types";
import { OAuthAuthorize } from "./authorize";

export abstract class OAuthIssue extends OAuthAuthorize {
  /**
   * Client authentication at the token and revocation endpoints: public clients send their id; clients
   * with a secret send it (client_secret_basic or client_secret_post).
   */
  protected async authenticateClient(
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

  protected grantActive(grantId: string): boolean {
    return Boolean(this.sql.exec("SELECT id FROM oauth_grants WHERE id = ? AND revoked = 0", grantId).toArray()[0]);
  }

  protected async issue(grantId: string, scope: string, resource: string | null, family: string): Promise<JsonObject> {
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
}
