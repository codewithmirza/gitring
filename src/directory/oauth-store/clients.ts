/**
 * OAuth clients: dynamic registration (RFC 7591) and client ID metadata documents (an https URL as client id).
 *
 * A metadata document is fetched and cached for a day. When a refetch fails, the cached copy stays for up to a week.
 * New clients count against hourly caps for each address and for the whole server.
 */
import { randomToken, sha256B64url } from "../crypto";
import { CLI_CLIENT_ID, DEVICE_GRANT } from "../device";
import { CIMD_STALE_MS, CIMD_TTL_MS, DEFAULT_GRANTS, MAX_CLIENTS_PER_ADDRESS_HOUR, MAX_CLIENTS_PER_HOUR, MAX_REDIRECTS, SCOPE } from "./constants";
import { CLI_CLIENT, err, rand, type JsonObject, type OAuthClient } from "./types";
import { isCimdId, redirectOk } from "./rules";
import { OAuthBase } from "./base";

export abstract class OAuthClients extends OAuthBase {
  /** Too many new clients in the last hour, from this address or in all. */
  private clientCapReached(address: string | undefined): boolean {
    const hourAgo = this.now() - 3600_000;
    if (address) {
      const mine = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM oauth_clients WHERE address = ? AND created_at > ?", address, hourAgo).one().n;
      if (mine >= MAX_CLIENTS_PER_ADDRESS_HOUR) return true;
    }
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM oauth_clients WHERE created_at > ?", hourAgo).one().n >= MAX_CLIENTS_PER_HOUR;
  }

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
}
