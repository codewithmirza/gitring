/**
 * The base of the Directory: the SQL storage, the sealed config values and the one-time states.
 *
 * Every other layer builds on this class. See src/directory/layers/README.md for the order of the layers.
 * Never keep a secret here in clear text: sealed values use GITRING_SECRET (see crypto.ts).
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../worker/env";
import { randomToken, seal, unseal } from "../crypto";
import { OAuthStore } from "../oauth";
import { PASSKEY_SCHEMA } from "../passkeys";
import { STATE_MS } from "../constants";
import { SCHEMA } from "../schema";
import type { StateData } from "../types";

export abstract class DirectoryStore extends DurableObject<Env> {
  protected readonly sql: SqlStorage;

  /** OAuth 2.1 for MCP clients (src/directory/oauth.ts). */
  protected readonly oauth: OAuthStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const s of SCHEMA) this.sql.exec(s);
    for (const s of PASSKEY_SCHEMA) this.sql.exec(s);
    this.oauth = new OAuthStore({ sql: this.sql as never });
  }

  protected secret(): string {
    const s = this.env.GITRING_SECRET;
    if (!s) throw new Error("GITRING_SECRET is not set. Set it with: npx wrangler secret put GITRING_SECRET");
    return s;
  }

  protected async getSealed<T>(key: string): Promise<T | undefined> {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM config WHERE key = ?", key).toArray()[0];
    return row ? unseal<T>(this.secret(), row.value) : undefined;
  }

  protected async putSealed(key: string, value: unknown): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", key, await seal(this.secret(), value));
  }

  protected putState(data: StateData, ttl = STATE_MS): string {
    const state = randomToken(24);
    const now = Date.now();
    this.sql.exec("DELETE FROM states WHERE expires_at < ?", now);
    this.sql.exec("INSERT INTO states (state, data, expires_at) VALUES (?, ?, ?)", state, JSON.stringify(data), now + ttl);
    return state;
  }

  /** Read a one-time state without using it up. */
  protected peekState(state: string): StateData {
    const row = this.sql.exec<{ data: string; expires_at: number }>("SELECT data, expires_at FROM states WHERE state = ?", String(state ?? "")).toArray()[0];
    if (!row || row.expires_at < Date.now()) throw new Error("The setup link expired or was used already. Start again.");
    return JSON.parse(row.data) as StateData;
  }

  protected takeState(state: string): StateData {
    const row = this.sql.exec<{ data: string; expires_at: number }>("SELECT data, expires_at FROM states WHERE state = ?", String(state ?? "")).toArray()[0];
    this.sql.exec("DELETE FROM states WHERE state = ?", String(state ?? ""));
    if (!row || row.expires_at < Date.now()) throw new Error("The sign-in link expired or was used already. Start again.");
    return JSON.parse(row.data) as StateData;
  }
}
