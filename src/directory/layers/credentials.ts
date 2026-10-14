/**
 * The ways to prove who you are: browser sessions, personal API keys and the OAuth calls of MCP clients.
 *
 * Only a SHA-256 of a session cookie or of a key is stored. Never store or log the token itself.
 * Read next: src/directory/oauth.ts (the OAuth store that the oauth calls forward to).
 */
import type * as A from "../../core/accounts";
import { rand } from "../../harbor/ids";
import { randomToken, sha256B64url } from "../crypto";
import type { JsonObject, PendingDevice, PendingRequest, TokenAnswer } from "../oauth";
import { MAX_KEYS_PER_USER, SESSION_MS } from "../constants";
import { DirectoryPeople } from "./people";

export abstract class DirectoryCredentials extends DirectoryPeople {
  async oauthRegister(body: unknown, address?: string): Promise<{ status: number; body: JsonObject }> {
    return this.oauth.register(body, address);
  }

  async oauthStart(query: Record<string, string | undefined>, origin: string, address?: string) {
    return this.oauth.startRequest(query, origin, address);
  }

  async oauthRequest(id: string): Promise<PendingRequest | null> {
    return this.oauth.request(id);
  }

  /** The person allowed this app before, for this scope (mcp or mcp:read) or a wider one. */
  async oauthHasGrant(userId: string, clientId: string, scope?: string): Promise<boolean> {
    return this.oauth.hasGrant(userId, clientId, scope);
  }

  async oauthApprove(requestId: string, userId: string, origin: string): Promise<string | null> {
    if (!this.userInfo(userId)) return null;
    return this.oauth.approve(requestId, userId, origin);
  }

  async oauthDeny(requestId: string, origin: string): Promise<string | null> {
    return this.oauth.deny(requestId, origin);
  }

  async oauthToken(form: Record<string, string | undefined>, basic: { id: string; secret: string } | null, origin: string, address?: string): Promise<TokenAnswer> {
    return this.oauth.token(form, basic, origin, address);
  }

  async oauthRevoke(form: Record<string, string | undefined>, basic: { id: string; secret: string } | null): Promise<{ status: number; body?: Record<string, string>; userId?: string }> {
    return this.oauth.revoke(form, basic);
  }

  /** The person behind an OAuth access token (MCP) at this endpoint (`resource`; default /mcp), or null. */
  async oauthUser(token: string, origin: string, resource?: string): Promise<{ user: A.UserInfo; clientId: string; scope: string; expiresAt: number } | null> {
    const hit = await this.oauth.accessUser(token, origin, resource);
    if (!hit) return null;
    const user = this.userInfo(hit.userId);
    return user ? { user, clientId: hit.clientId, scope: hit.scope, expiresAt: hit.expiresAt } : null;
  }

  async oauthGrants(userId: string): Promise<A.OAuthGrantInfo[]> {
    return this.oauth.grants(userId);
  }

  async oauthRevokeGrant(userId: string, grantId: string): Promise<boolean> {
    return this.oauth.revokeUserGrant(userId, grantId);
  }

  /** The device grant (RFC 8628): a program asks for a sign-in (POST /oauth/device_authorization). */
  async oauthDeviceStart(form: Record<string, string | undefined>, basic: { id: string; secret: string } | null, origin: string, address?: string): Promise<TokenAnswer> {
    return this.oauth.deviceStart(form, basic, origin, address);
  }

  /** The device sign-in that waits for the user code that this person typed on /device. */
  async oauthDevice(userCode: string, userId: string, address?: string): Promise<{ ok: true; device: PendingDevice } | { ok: false; reason: "unknown" | "locked" }> {
    return this.oauth.deviceLookup(userCode, userId, address);
  }

  /** The person allows the device sign-in, or not. Null when the code does not wait any more. */
  async oauthDeviceDecide(userCode: string, userId: string, allow: boolean, address?: string): Promise<PendingDevice | null | "locked"> {
    if (!this.userInfo(userId)) return null;
    return this.oauth.deviceDecide(userCode, userId, allow, address);
  }

  /** Sign out everywhere: end every browser session of the person. API keys and connected apps stay. */
  async endAllSessions(userId: string): Promise<number> {
    const n = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE user_id = ?", userId).one().n;
    this.sql.exec("DELETE FROM sessions WHERE user_id = ?", userId);
    return n;
  }

  /** A new browser session for a person (only a SHA-256 of the token is stored). */
  protected async openSession(userId: string): Promise<string> {
    const token = randomToken(32);
    const hash = await sha256B64url(token);
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", now);
    this.sql.exec("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", hash, userId, now, now + SESSION_MS);
    return token;
  }

  async sessionUser(token: string): Promise<A.UserInfo | null> {
    if (!token) return null;
    const row = this.sql.exec<{ user_id: string; expires_at: number }>("SELECT user_id, expires_at FROM sessions WHERE hash = ?", await sha256B64url(token)).toArray()[0];
    if (!row || row.expires_at < Date.now()) return null;
    return this.userInfo(row.user_id);
  }

  async endSession(token: string): Promise<void> {
    if (token) this.sql.exec("DELETE FROM sessions WHERE hash = ?", await sha256B64url(token));
  }

  async createKey(userId: string, name: string): Promise<{ key: string; info: A.ApiKeyInfo }> {
    if (!this.userInfo(userId)) throw new Error("Unknown user.");
    const n = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM api_keys WHERE user_id = ?", userId).one().n;
    if (n >= MAX_KEYS_PER_USER) throw new Error(`You have ${MAX_KEYS_PER_USER} keys. Revoke one first.`);
    const key = `gk_${randomToken(30)}`;
    const info: A.ApiKeyInfo = { id: `key_${rand(8)}`, name: String(name || "key").slice(0, 60), prefix: key.slice(0, 10), createdAt: Date.now() };
    this.sql.exec("INSERT INTO api_keys (id, user_id, name, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)", info.id, userId, info.name, info.prefix, await sha256B64url(key), info.createdAt);
    return { key, info };
  }

  async listKeys(userId: string): Promise<A.ApiKeyInfo[]> {
    return this.sql
      .exec<{ id: string; name: string; prefix: string; created_at: number; last_used: number | null }>("SELECT id, name, prefix, created_at, last_used FROM api_keys WHERE user_id = ? ORDER BY created_at DESC", userId)
      .toArray()
      .map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.created_at, lastUsed: k.last_used ?? undefined }));
  }

  async revokeKey(userId: string, keyId: string): Promise<boolean> {
    const before = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM api_keys WHERE id = ? AND user_id = ?", keyId, userId).one().n;
    this.sql.exec("DELETE FROM api_keys WHERE id = ? AND user_id = ?", keyId, userId);
    return before > 0;
  }

  async keyUser(key: string): Promise<A.UserInfo | null> {
    if (!key?.startsWith("gk_")) return null;
    const hash = await sha256B64url(key);
    const row = this.sql.exec<{ id: string; user_id: string; last_used: number | null }>("SELECT id, user_id, last_used FROM api_keys WHERE hash = ?", hash).toArray()[0];
    if (!row) return null;
    const now = Date.now();
    if (!row.last_used || now - row.last_used > 60_000) this.sql.exec("UPDATE api_keys SET last_used = ? WHERE id = ?", now, row.id);
    return this.userInfo(row.user_id);
  }
}
