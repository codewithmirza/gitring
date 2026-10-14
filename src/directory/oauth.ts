/**
 * OAuth 2.1 authorization server for MCP clients and the gitring command line. The front door of src/directory/oauth-store/.
 *
 * OAuthStore is a chain of layers (see src/directory/oauth-store/README.md). This file adds the token endpoint,
 * revocation and the grants of a person, and it re-exports every public name of the store.
 * Runs inside the Directory Durable Object (SQLite). Pure enough to test in Node.
 */
import { sameString, sha256B64url } from "./crypto";
import { CLI_CLIENT_ID, CLI_CLIENT_NAME, DEVICE_GRANT } from "./device";
import { REUSE_GRACE_MS, SCOPE } from "./oauth-store/constants";
import { err, rand, type OAuthClient, type OAuthError, type TokenAnswer } from "./oauth-store/types";
import { audienceOk, canonicalResource, resourceHint, resourceOf, resourceOk } from "./oauth-store/rules";
import { OAuthDevices } from "./oauth-store/devices";

export { ACCESS_TTL_S, OAUTH_SCHEMA, REFRESH_TTL_S, SCOPE, SCOPE_READ } from "./oauth-store/constants";
export type { JsonObject, OAuthClient, OAuthDeps, OAuthError, PendingDevice, PendingRequest, TokenAnswer } from "./oauth-store/types";
export { accessScope, audienceOk, basicAuth, canonicalResource, isCimdId, mcpSetOf, MCP_PATH, publicHostname, redirectMatches, redirectOk, resourceOf, s256, scopeCovers, withParams } from "./oauth-store/rules";
export type { McpSet } from "./oauth-store/rules";

type Fail = (status: number, e: OAuthError, extra?: Record<string, string>) => TokenAnswer;

export class OAuthStore extends OAuthDevices {
  // ───── The token endpoint ─────

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

    if (form.grant_type === "authorization_code") return this.codeToken(form, client, origin, fail, noStore);
    if (form.grant_type === "refresh_token") return this.refreshToken(form, client, fail, noStore);
    if (form.grant_type === DEVICE_GRANT) return this.deviceToken(form, client, origin, fail);
    return fail(400, err("unsupported_grant_type", `gitring supports authorization_code, refresh_token and ${DEVICE_GRANT}.`));
  }

  /** The code exchange of the token endpoint (grant_type authorization_code). */
  private async codeToken(form: Record<string, string | undefined>, client: OAuthClient, origin: string, fail: Fail, noStore: Record<string, string>): Promise<TokenAnswer> {
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

  /** The refresh of the token endpoint (grant_type refresh_token). A refresh token works once. */
  private async refreshToken(form: Record<string, string | undefined>, client: OAuthClient, fail: Fail, noStore: Record<string, string>): Promise<TokenAnswer> {
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

  // ───── Revocation and validation ─────

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

  // ───── Grants of a person ─────

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
}
