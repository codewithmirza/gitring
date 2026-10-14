/**
 * The device authorization grant (RFC 8628): a program asks, a signed-in person types the user code on /device.
 *
 * Wrong user codes count for each person and address. After a few of them the page locks for a while.
 * Read next: src/directory/device.ts (the code alphabet and the limits).
 */
import { sha256B64url } from "../crypto";
import { CLI_CLIENT_ID, DEVICE_GRANT, DEVICE_INTERVAL_S, DEVICE_MISSES_MAX, DEVICE_MISSES_WINDOW_MS, DEVICE_TTL_S, formatUserCode, newDeviceCode, newUserCode, normalizeUserCode } from "../device";
import { KNOWN_SCOPES, MAX_DEVICES_PER_ADDRESS_HOUR, MAX_DEVICES_PER_HOUR, SCOPE, SCOPE_READ } from "./constants";
import { err, rand, type DeviceRow, type OAuthClient, type OAuthError, type PendingDevice, type TokenAnswer } from "./types";
import { accessScope, addressKey, canonicalResource, resourceHint, resourceOf, resourceOk } from "./rules";
import { OAuthIssue } from "./issue";

export abstract class OAuthDevices extends OAuthIssue {
  /** Wrong user codes on /device per person (see deviceLookup). The Directory is one object, so memory is enough. */
  private readonly deviceMisses = new Map<string, { n: number; since: number }>();

  // ───── Start and answer ─────

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
  async deviceLookup(raw: string, userId: string, address?: string): Promise<{ ok: true; device: PendingDevice } | { ok: false; reason: "unknown" | "locked" }> {
    if (this.deviceLocked(userId) || this.deviceLocked(addressKey(address))) return { ok: false, reason: "locked" };
    const code = normalizeUserCode(raw);
    const row = code ? this.pendingDevice(await sha256B64url(code)) : undefined;
    if (!code || !row) {
      this.deviceMiss(userId);
      this.deviceMiss(addressKey(address));
      return { ok: false, reason: this.deviceLocked(userId) || this.deviceLocked(addressKey(address)) ? "locked" : "unknown" };
    }
    return { ok: true, device: await this.deviceView(row, code) };
  }

  /**
   * The person allows the sign-in (a grant, as on the consent page) or not. Null when the code does not wait
   * any more. Wrong codes count here as on the lookup, so that the answer form cannot guess codes either.
   */
  async deviceDecide(raw: string, userId: string, allow: boolean, address?: string): Promise<PendingDevice | null | "locked"> {
    if (this.deviceLocked(userId) || this.deviceLocked(addressKey(address))) return "locked";
    const code = normalizeUserCode(raw);
    const userHash = code ? await sha256B64url(code) : "";
    // No await from the read to the write: only the first answer counts.
    const row = code ? this.pendingDevice(userHash) : undefined;
    if (!code || !row) {
      this.deviceMiss(userId);
      this.deviceMiss(addressKey(address));
      return null;
    }
    if (allow) {
      const grant = this.grantFor(userId, row.client_id, row.scope);
      this.sql.exec("UPDATE oauth_devices SET status = 'allowed', user_id = ?, grant_id = ? WHERE hash = ?", userId, grant, row.hash);
    } else {
      this.sql.exec("UPDATE oauth_devices SET status = 'denied', user_id = ? WHERE hash = ?", userId, row.hash);
    }
    return this.deviceView(row, code);
  }

  // ───── The token ─────

  /** POST /oauth/token with the device grant: the program asks again until the person answers (RFC 8628 §3.4, §3.5). */
  protected async deviceToken(form: Record<string, string | undefined>, client: OAuthClient, origin: string, fail: (status: number, e: OAuthError) => TokenAnswer): Promise<TokenAnswer> {
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

  // ───── Helpers ─────

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

  private deviceLocked(key: string | null): boolean {
    if (!key) return false;
    const m = this.deviceMisses.get(key);
    if (!m) return false;
    if (this.now() - m.since > DEVICE_MISSES_WINDOW_MS) {
      this.deviceMisses.delete(key);
      return false;
    }
    return m.n >= DEVICE_MISSES_MAX;
  }

  private deviceMiss(key: string | null): void {
    if (!key) return;
    const m = this.deviceMisses.get(key);
    if (m && this.now() - m.since <= DEVICE_MISSES_WINDOW_MS) m.n++;
    else this.deviceMisses.set(key, { n: 1, since: this.now() });
    if (this.deviceMisses.size > 10_000) this.deviceMisses.clear();
  }
}
