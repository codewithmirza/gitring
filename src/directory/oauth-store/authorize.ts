/**
 * The authorization request: check it, keep it while the person decides, then make a grant and a single-use code.
 *
 * A code works once, for 10 minutes, with PKCE S256 only. A grant is one per person and client.
 */
import { randomToken, sha256B64url } from "../crypto";
import { CODE_TTL_MS, KNOWN_SCOPES, REQUEST_TTL_MS, SCOPE, SCOPE_READ } from "./constants";
import { err, rand, type OAuthError, type PendingRequest } from "./types";
import { accessScope, canonicalResource, redirectMatches, resourceHint, resourceOk, scopeCovers, withParams } from "./rules";
import { OAuthClients } from "./clients";

export abstract class OAuthAuthorize extends OAuthClients {
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
    // An app that registered only the device grant never gets a code.
    if (!client.grantTypes.includes("authorization_code")) return back(err("unauthorized_client", "This app did not register the grant type authorization_code."));
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
  protected grantFor(userId: string, clientId: string, scope: string): string {
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
}
