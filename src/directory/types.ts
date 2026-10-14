/**
 * The types of the Directory: the answers that other files import, the database rows and the one-time states.
 *
 * Read next: src/directory/directory.ts (the front door that re-exports the public ones).
 */
import type * as A from "../core/accounts";

// ───── GitHub App and sign-in providers ─────

export interface GithubAppConfig {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  /** Empty for an app without a webhook. */
  webhookSecret: string;
  pem: string;
  htmlUrl: string;
  owner?: string;
}

/** GitHub's answer to POST /app-manifests/{code}/conversions. */
export interface ManifestConversion {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  /** null when the app has no webhook (an app made for localhost). */
  webhook_secret: string | null;
  pem: string;
  html_url: string;
  owner?: { login?: string };
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export interface ProvidersInfo {
  github: { slug: string; appId: number; htmlUrl: string; installUrl: string; webhook: boolean } | null;
  google: { clientId: string } | null;
}

// ───── Database rows and one-time states ─────

export type UserRow = {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  created_at: number;
  last_seen: number;
};

export type WaitlistRow = { id: string; user_id: string; email: string | null; name: string; provider: string; pack: string; note: string; created_at: number; updated_at: number };

export type ProjectRow = {
  id: string;
  name: string;
  owner_id: string | null;
  visibility: A.Visibility;
  source: string;
  created_at: number;
  archived: number;
};

export type StateData =
  | { kind: "manifest"; origin: string }
  | { kind: "signin"; provider: A.Provider; origin: string; returnTo: string; verifier?: string; nonce?: string; linkUserId?: string }
  /** create: a new account named `name`; add: the signed-in person `userId` adds a passkey; login: sign in. */
  | { kind: "passkey"; mode: "create" | "add" | "login"; challenge: string; origin: string; rpId: string; userId?: string; name?: string };

/** A profile from a provider, after the code exchange. */
export interface Profile {
  provider: A.Provider;
  subject: string;
  name: string;
  login?: string;
  email?: string;
  emailVerified?: boolean;
  avatar?: string;
  /** GitHub only: the user token of the GitHub App (sealed before it is stored). */
  github?: GithubUserToken;
}

// ───── GitHub user tokens ─────

/**
 * A GitHub App user token. GitHub gives an access token for 8 hours and a single-use refresh token for
 * 6 months (or one access token without expiry, when the app turned expiry off).
 */
export interface GithubUserToken {
  access: string;
  refresh?: string;
  /** ms since epoch; absent: no expiry. */
  expiresAt?: number;
  refreshExpiresAt?: number;
}

export type GithubUserTokenResult =
  | { ok: true; token: string; login: string; expiresAt: number | null }
  | { ok: false; state: "not-connected" | "expired" | "no-app" | "error"; reason: string };

export type GithubRepoAccess =
  | { ok: true; token: string; expiresAt: number; permissions: Record<string, string> }
  | { ok: false; state: "no-app" | "not-installed" | "error"; message: string; installUrl?: string };

/** GitHub's answer at https://github.com/login/oauth/access_token (code exchange and refresh). */
export interface GithubTokenAnswer {
  access_token?: string;
  refresh_token?: string;
  /** Seconds. */
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}
