/**
 * The types of the OAuth store: clients, pending requests, pending device sign-ins, rows and answers.
 *
 * The answers are flat plain data, so that they can cross the Durable Object RPC boundary.
 * Read next: src/directory/oauth.ts (the front door that re-exports the public ones).
 */
import { randomToken } from "../crypto";
import { CLI_CLIENT_ID, CLI_CLIENT_NAME, DEVICE_GRANT } from "../device";

// ───── Clients ─────

export interface Sql {
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
export const CLI_CLIENT: OAuthClient = { clientId: CLI_CLIENT_ID, name: CLI_CLIENT_NAME, redirectUris: [], authMethod: "none", kind: "builtin", grantTypes: [DEVICE_GRANT, "refresh_token"] };

// ───── Pending requests and device sign-ins ─────

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

/** A row of oauth_devices. */
export interface DeviceRow {
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

// ───── Answers and small helpers ─────

export type OAuthError = { error: string; error_description: string };

/** JSON bodies of the endpoints: flat plain data, so that they cross the Durable Object RPC boundary. */
export type JsonObject = Record<string, string | number | boolean | null | string[]>;

export type TokenAnswer = { status: number; body: JsonObject; headers?: Record<string, string> };

export interface OAuthDeps {
  sql: Sql;
  now?: () => number;
  /** fetch for client ID metadata documents (tests stub it). */
  fetch?: typeof fetch;
}

export const err = (error: string, error_description: string): OAuthError => ({ error, error_description });

export function rand(n: number): string {
  return randomToken(n).replace(/[-_]/g, "x").slice(0, Math.ceil((n * 4) / 3));
}
