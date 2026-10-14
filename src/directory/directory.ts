/**
 * Directory — one Durable Object for the whole deployment: who people are, which projects exist,
 * who may do what, and the sealed credentials of the sign-in providers.
 *
 *   users + identities   one person, one or more sign-ins (GitHub, Google)
 *   passkeys             WebAuthn credentials (src/directory/passkeys.ts): a person may have passkeys only
 *   sessions             browser sessions (only a SHA-256 of the cookie token is stored)
 *   api_keys             personal keys for MCP clients, hooks and scripts (only a hash is stored)
 *   projects + members   project registry and roles (owner, member, viewer); invites by login or email
 *   config               sealed (AES-GCM) provider credentials: the GitHub App and the Google client
 *   budgets              rolling one-hour windows of built-in AI agent starts (per user and global)
 *   prefs + push_subs    the preferences of a person, and the devices that get push notifications
 *
 * The HarborMaster of each project holds the project's state; the Directory only knows that it exists.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../worker/env";
import type * as A from "../core/accounts";
import { APPROVALS_IN, atLeast, cleanPrefs, PROJECT_ID } from "../core/accounts";
import type { ProjectSource } from "../core/types";
import { rand } from "../harbor/ids";
import { githubAppJwt, randomToken, sameString, seal, sha256B64url, unseal } from "./crypto";
import { OAuthStore, type JsonObject, type PendingDevice, type PendingRequest, type TokenAnswer } from "./oauth";
import { pushEndpointOk, pushKeys, sendPush } from "../worker/push";
import { credentialIdOf, PASSKEY_ALGS, PASSKEY_SCHEMA, PasskeyError, signCountOk, userHandleOf, verifyAssertion, verifyRegistration, type NewPasskey, type PasskeyAlg } from "./passkeys";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, avatar TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, login TEXT, email TEXT, token TEXT, PRIMARY KEY (provider, subject))`,
  `CREATE INDEX IF NOT EXISTS identities_user ON identities (user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used INTEGER)`,
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT, visibility TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS members (project_id TEXT NOT NULL, handle TEXT NOT NULL, user_id TEXT, role TEXT NOT NULL, PRIMARY KEY (project_id, handle))`,
  `CREATE INDEX IF NOT EXISTS members_user ON members (user_id)`,
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS states (state TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS budgets (owner TEXT PRIMARY KEY, starts TEXT NOT NULL)`,
  // Projects linked to a GitHub repository (lowercase "owner/name"): a push webhook reaches them.
  `CREATE TABLE IF NOT EXISTS github_links (repo TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY (repo, project_id))`,
  `CREATE INDEX IF NOT EXISTS github_links_project ON github_links (project_id)`,
  // Webhook deliveries already handled (GitHub can send one twice; a replay must not open a task twice).
  `CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  // The preferences of a person (JSON): where they answer merge questions (contract C3).
  `CREATE TABLE IF NOT EXISTS prefs (user_id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
  // Devices of a person that get push notifications for the inbox: the push address that the browser gave.
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (user_id)`,
  // A login in GITRING_OWNERS stays with the account that used it first (logins can change hands).
  `CREATE TABLE IF NOT EXISTS owner_pins (handle TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL, pinned_at INTEGER NOT NULL)`,
  // The public sample left the product (2026-10-10): archive its project.
  `UPDATE projects SET archived = 1 WHERE id = 'demo' AND source LIKE '%"sample"%'`,
];

const SESSION_MS = 30 * 24 * 3600_000;
const STATE_MS = 15 * 60_000;
/** A passkey challenge works once, for 5 minutes. */
const PASSKEY_STATE_MS = 5 * 60_000;
const MAX_PASSKEYS_PER_USER = 20;
const MAX_PROJECTS_PER_USER = 20;
const MAX_KEYS_PER_USER = 20;
/** Devices with push notifications for one person. A new one replaces the oldest. */
const MAX_PUSH_DEVICES = 10;
/** One person gets at most one push in this time: one notification says "look at the inbox". */
const PUSH_GAP_MS = 20_000;
const HOUR = 3_600_000;

export const GITHUB_HEADERS = {
  "User-Agent": "gitring",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

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

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  created_at: number;
  last_seen: number;
};

type ProjectRow = {
  id: string;
  name: string;
  owner_id: string | null;
  visibility: A.Visibility;
  source: string;
  created_at: number;
  archived: number;
};

type StateData =
  | { kind: "manifest"; origin: string }
  | { kind: "signin"; provider: A.Provider; origin: string; returnTo: string; verifier?: string; nonce?: string; linkUserId?: string }
  /** create: a new account named `name`; add: the signed-in person `userId` adds a passkey; login: sign in. */
  | { kind: "passkey"; mode: "create" | "add" | "login"; challenge: string; origin: string; rpId: string; userId?: string; name?: string };

/** A profile from a provider, after the code exchange. */
interface Profile {
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

const GITHUB_TOKEN_PURPOSE = "github-user-v1";
/** Refresh an access token when it has less than this left. */
const GITHUB_REFRESH_EARLY_MS = 5 * 60_000;

export type GithubRepoAccess =
  | { ok: true; token: string; expiresAt: number; permissions: Record<string, string> }
  | { ok: false; state: "no-app" | "not-installed" | "error"; message: string; installUrl?: string };

export class Directory extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** OAuth 2.1 for MCP clients (src/directory/oauth.ts). */
  private readonly oauth: OAuthStore;
  /** Installation tokens per repository (lowercase "owner/name"). */
  private readonly repoTokens = new Map<string, { token: string; expiresAt: number; permissions: Record<string, string> }>();
  /** Repositories without the app, for a few minutes (lowercase "owner/name"). */
  private readonly repoMisses = new Map<string, { until: number; answer: GithubRepoAccess }>();
  /** GitHub token calls per GitHub account run one at a time: refresh tokens are single-use. */
  private readonly githubRefreshes = new Map<string, Promise<GithubUserTokenResult>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const s of SCHEMA) this.sql.exec(s);
    for (const s of PASSKEY_SCHEMA) this.sql.exec(s);
    this.oauth = new OAuthStore({ sql: this.sql as never });
  }

  /* ════════════════════ OAuth for MCP clients ════════════════════ */

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
  async oauthDevice(userCode: string, userId: string): Promise<{ ok: true; device: PendingDevice } | { ok: false; reason: "unknown" | "locked" }> {
    return this.oauth.deviceLookup(userCode, userId);
  }

  /** The person allows the device sign-in, or not. Null when the code does not wait any more. */
  async oauthDeviceDecide(userCode: string, userId: string, allow: boolean): Promise<PendingDevice | null> {
    if (!this.userInfo(userId)) return null;
    return this.oauth.deviceDecide(userCode, userId, allow);
  }

  /* ════════════════════ sealed config ════════════════════ */

  private secret(): string {
    const s = this.env.GITRING_SECRET;
    if (!s) throw new Error("GITRING_SECRET is not set. Set it with: npx wrangler secret put GITRING_SECRET");
    return s;
  }

  private async getSealed<T>(key: string): Promise<T | undefined> {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM config WHERE key = ?", key).toArray()[0];
    return row ? unseal<T>(this.secret(), row.value) : undefined;
  }

  private async putSealed(key: string, value: unknown): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", key, await seal(this.secret(), value));
  }

  async providers(): Promise<ProvidersInfo> {
    const gh = await this.getSealed<GithubAppConfig>("github_app").catch(() => undefined);
    const gg = await this.getSealed<GoogleConfig>("google").catch(() => undefined);
    return {
      github: gh ? { slug: gh.slug, appId: gh.id, htmlUrl: gh.htmlUrl, installUrl: `https://github.com/apps/${gh.slug}/installations/new`, webhook: Boolean(gh.webhookSecret) } : null,
      google: gg ? { clientId: gg.clientId } : null,
    };
  }

  /** Worker-only: the GitHub App credentials (webhook verification, installation tokens). */
  async githubApp(): Promise<GithubAppConfig | null> {
    return (await this.getSealed<GithubAppConfig>("github_app")) ?? null;
  }

  /**
   * A short-lived token of the GitHub App for one repository ("owner/name"), scoped to that repository.
   * Worker-only (RPC from a project coordinator). Tokens are cached until 5 minutes before they expire.
   */
  async githubRepoAccess(repo: string, fresh = false): Promise<GithubRepoAccess> {
    const name = String(repo ?? "").trim();
    if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(name)) return { ok: false, state: "error", message: "Give the GitHub repository as owner/name." };
    const key = name.toLowerCase();
    const hit = this.repoTokens.get(key);
    if (!fresh && hit && hit.expiresAt - Date.now() > 5 * 60_000) return { ok: true, token: hit.token, expiresAt: hit.expiresAt, permissions: hit.permissions };
    // "Not installed" is kept for five minutes: guesses and imports ask often for the same names.
    const miss = this.repoMisses.get(key);
    if (!fresh && miss && miss.until > Date.now()) return miss.answer;
    const app = await this.githubApp().catch(() => null);
    if (!app) return { ok: false, state: "no-app", message: "This gitring has no GitHub App. An owner of the deployment sets it up on /setup." };
    const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
    const jwt = await githubAppJwt(app.id, app.pem);
    const auth = { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` };
    const inst = await fetch(`https://api.github.com/repos/${name}/installation`, { headers: auth });
    if (inst.status === 404) {
      const answer: GithubRepoAccess = { ok: false, state: "not-installed", message: `The gitring GitHub App is not installed on ${name}.`, installUrl };
      if (this.repoMisses.size > 2000) this.repoMisses.clear();
      this.repoMisses.set(key, { until: Date.now() + 5 * 60_000, answer });
      return answer;
    }
    this.repoMisses.delete(key);
    if (!inst.ok) return { ok: false, state: "error", message: `GitHub answered ${inst.status} for the installation on ${name}.` };
    const { id } = await inst.json<{ id: number }>();
    const tok = await fetch(`https://api.github.com/app/installations/${id}/access_tokens`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ repositories: [name.split("/")[1]] }),
    });
    if (!tok.ok) return { ok: false, state: "error", message: `GitHub did not give a token for ${name} (${tok.status}).`, installUrl };
    const t = await tok.json<{ token: string; expires_at: string; permissions?: Record<string, string> }>();
    const entry = { token: t.token, expiresAt: Date.parse(t.expires_at) || Date.now() + 50 * 60_000, permissions: t.permissions ?? {} };
    this.repoTokens.set(name.toLowerCase(), entry);
    return { ok: true, ...entry };
  }

  /**
   * What this person may do in a GitHub repository, as GitHub says now: read, push, and whether the
   * repository is private. gitring asks with the person's own GitHub token (exact, and it sees renames);
   * without a token, it asks with the app token for the person's GitHub account id (not the login,
   * which can change hands). Also says whether the gitring app is installed there.
   */
  async githubPermission(userId: string, repo: string): Promise<{ installed: boolean; read: boolean; push: boolean; private?: boolean; message: string; installUrl?: string }> {
    const access = await this.githubRepoAccess(repo);
    const installed = access.ok;
    const installUrl = access.ok ? undefined : access.installUrl;
    const base = { installed, ...(installUrl ? { installUrl } : {}) };
    const tok = await this.githubUserToken(userId).catch(() => null);
    if (tok?.ok) {
      const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${tok.token}` } }).catch(() => null);
      if (res?.status === 200) {
        const r = await res.json<{ private?: boolean; permissions?: { pull?: boolean; push?: boolean; maintain?: boolean; admin?: boolean } }>();
        const push = Boolean(r.permissions?.push || r.permissions?.maintain || r.permissions?.admin);
        return { ...base, read: true, push, private: Boolean(r.private), message: push ? `${tok.login} can push to ${repo}.` : `Your GitHub account (${tok.login}) cannot push to ${repo}.` };
      }
      if (res && (res.status === 404 || res.status === 403)) return { ...base, read: false, push: false, message: `Your GitHub account (${tok.login}) cannot see ${repo}.` };
    }
    const ids = this.sql
      .exec<{ subject: string; login: string | null }>("SELECT subject, login FROM identities WHERE user_id = ? AND provider = 'github'", userId)
      .toArray()
      .filter((r): r is { subject: string; login: string } => Boolean(r.login));
    if (!ids.length) return { ...base, read: false, push: false, message: "Sign in with GitHub, so that gitring can check what you may do in the repository." };
    if (!access.ok) return { ...base, read: false, push: false, message: access.message };
    const appAuth = { ...GITHUB_HEADERS, Authorization: `Bearer ${access.token}` };
    // Whether the repository is private, as the app sees it: a public repository is readable by anyone.
    const info = await fetch(`https://api.github.com/repos/${repo}`, { headers: appAuth }).catch(() => null);
    const isPrivate = info?.status === 200 ? Boolean((await info.json<{ private?: boolean }>()).private) : undefined;
    const known = isPrivate === undefined ? {} : { private: isPrivate };
    for (const id of ids) {
      const res = await fetch(`https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(id.login)}/permission`, { headers: appAuth }).catch(() => null);
      if (!res?.ok) continue;
      const p = await res.json<{ permission?: string; role_name?: string; user?: { id?: number } }>();
      // The login must still belong to this person's GitHub account.
      if (String(p.user?.id ?? "") !== id.subject) continue;
      const push = ["admin", "maintain", "write"].includes(p.role_name ?? "") || ["admin", "write"].includes(p.permission ?? "");
      const read = push || ["read", "triage"].includes(p.role_name ?? "") || p.permission === "read" || isPrivate === false;
      return { ...base, ...known, read, push, message: push ? `${id.login} can push to ${repo}.` : `Your GitHub account (${id.login}) cannot push to ${repo}.` };
    }
    return { ...base, ...known, read: isPrivate === false, push: false, message: `Your GitHub account cannot push to ${repo}.` };
  }

  /** Can this person push to the GitHub repository (and is the app installed there)? */
  async githubCanPush(userId: string, repo: string): Promise<{ ok: boolean; message: string; installUrl?: string }> {
    const p = await this.githubPermission(userId, repo);
    if (!p.installed) return { ok: false, message: p.message.includes("not installed") ? p.message : `The gitring GitHub App is not installed on ${repo}.`, ...(p.installUrl ? { installUrl: p.installUrl } : {}) };
    return { ok: p.push, message: p.message };
  }

  /** True the first time a webhook delivery id arrives (kept for a day). */
  async firstDelivery(id: string): Promise<boolean> {
    if (!id) return true;
    const now = Date.now();
    this.sql.exec("DELETE FROM deliveries WHERE at < ?", now - 24 * 3600_000);
    if (this.sql.exec("SELECT id FROM deliveries WHERE id = ?", id).toArray()[0]) return false;
    this.sql.exec("INSERT INTO deliveries (id, at) VALUES (?, ?)", id.slice(0, 100), now);
    return true;
  }

  /** "public" or "private" (null: unknown or archived project). */
  async visibilityOf(projectId: string): Promise<A.Visibility | null> {
    return this.projectRow(projectId)?.visibility ?? null;
  }

  /** Forget "not installed" answers (after someone installed the app or changed its repositories). */
  async forgetGithubMisses(): Promise<void> {
    this.repoMisses.clear();
  }

  /** A project links a GitHub repository (or none). Worker-only, RPC from the project coordinator. */
  async githubLink(projectId: string, repo: string | null): Promise<void> {
    this.sql.exec("DELETE FROM github_links WHERE project_id = ?", projectId);
    if (repo) this.sql.exec("INSERT OR REPLACE INTO github_links (repo, project_id) VALUES (?, ?)", repo.toLowerCase(), projectId);
  }

  /** Projects (not archived) that link this GitHub repository. */
  async githubLinkedProjects(repo: string): Promise<string[]> {
    return this.sql
      .exec<{ project_id: string }>("SELECT l.project_id FROM github_links l JOIN projects p ON p.id = l.project_id WHERE l.repo = ? AND p.archived = 0", String(repo ?? "").toLowerCase())
      .toArray()
      .map((r) => r.project_id);
  }

  /* ════════════════════ GitHub user tokens (repository list, imports) ════════════════════ */

  /** The GitHub sign-in of a person that holds a token (the newest one when there are several). */
  private githubIdentity(userId: string): { subject: string; login: string; token: string | null } | null {
    const rows = this.sql
      .exec<{ subject: string; login: string | null; token: string | null }>("SELECT subject, login, token FROM identities WHERE user_id = ? AND provider = 'github' ORDER BY token IS NULL", userId)
      .toArray();
    const r = rows[0];
    return r ? { subject: r.subject, login: r.login ?? "", token: r.token } : null;
  }

  /** The GitHub connection of a person, without a call to GitHub. */
  async githubConnection(userId: string): Promise<A.GithubConnection> {
    const id = this.githubIdentity(userId);
    if (!id) return { connected: false, reason: "Connect GitHub to see your repositories." };
    if (!id.token) return { connected: false, login: id.login, reason: "Connect GitHub again: gitring has no GitHub token for you." };
    const t = await this.openToken(id.token);
    if (!t) return { connected: false, login: id.login, reason: "Connect GitHub again." };
    if (t.refreshExpiresAt && t.refreshExpiresAt < Date.now()) return { connected: false, login: id.login, reason: "Your GitHub sign-in expired. Connect GitHub again." };
    return { connected: true, login: id.login };
  }

  private async openToken(sealed: string): Promise<GithubUserToken | null> {
    try {
      return await unseal<GithubUserToken>(this.secret(), sealed, GITHUB_TOKEN_PURPOSE);
    } catch {
      return null;
    }
  }

  /**
   * A valid GitHub user token for a person (Worker-only, RPC). Refreshes it when it has less than five
   * minutes left, or when the caller saw GitHub refuse it (`invalid`). One refresh at a time per
   * account: GitHub refresh tokens work once, so a second parallel refresh would sign the person out.
   */
  async githubUserToken(userId: string, invalid?: string): Promise<GithubUserTokenResult> {
    const first = this.githubIdentity(userId);
    if (!first) return { ok: false, state: "not-connected", reason: "Connect GitHub to see your repositories." };
    // Calls for the same GitHub account run one after the other: the second one sees the token that the
    // first one refreshed.
    const subject = first.subject;
    const prev = this.githubRefreshes.get(subject) ?? Promise.resolve(null as unknown as GithubUserTokenResult);
    const run = prev.catch(() => undefined).then(() => this.githubUserTokenNow(userId, invalid));
    this.githubRefreshes.set(subject, run);
    try {
      return await run;
    } finally {
      if (this.githubRefreshes.get(subject) === run) this.githubRefreshes.delete(subject);
    }
  }

  private async githubUserTokenNow(userId: string, invalid?: string): Promise<GithubUserTokenResult> {
    const id = this.githubIdentity(userId);
    if (!id) return { ok: false, state: "not-connected", reason: "Connect GitHub to see your repositories." };
    if (!id.token) return { ok: false, state: "expired", reason: "Connect GitHub again." };
    const t = await this.openToken(id.token);
    if (!t) return { ok: false, state: "expired", reason: "Connect GitHub again." };
    const stale = invalid !== undefined && sameStringSafe(invalid, t.access);
    const expiring = t.expiresAt !== undefined && t.expiresAt - Date.now() < GITHUB_REFRESH_EARLY_MS;
    if (!stale && !expiring) return { ok: true, token: t.access, login: id.login, expiresAt: t.expiresAt ?? null };
    if (!t.refresh) {
      // No refresh token: the token cannot be renewed. Forget it so the person connects again.
      this.sql.exec("UPDATE identities SET token = NULL WHERE provider = 'github' AND subject = ?", id.subject);
      return { ok: false, state: "expired", reason: "GitHub refused the saved sign-in. Connect GitHub again." };
    }
    return this.refreshGithub(id.subject, id.login, t, id.token);
  }

  /**
   * Refresh a token at GitHub. The new token is stored only where the old sealed token still is: a
   * disconnect (or a new sign-in) that happened meanwhile wins, and the new token is revoked again.
   */
  private async refreshGithub(subject: string, login: string, t: GithubUserToken, sealedOld: string): Promise<GithubUserTokenResult> {
    const app = await this.githubApp().catch(() => null);
    if (!app) return { ok: false, state: "no-app", reason: "This gitring has no GitHub App." };
    if (t.refreshExpiresAt && t.refreshExpiresAt < Date.now()) {
      this.sql.exec("UPDATE identities SET token = NULL WHERE provider = 'github' AND subject = ?", subject);
      return { ok: false, state: "expired", reason: "Your GitHub sign-in expired. Connect GitHub again." };
    }
    let answer: GithubTokenAnswer;
    try {
      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "gitring" },
        body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, grant_type: "refresh_token", refresh_token: t.refresh }),
      });
      answer = await res.json<GithubTokenAnswer>();
    } catch (e) {
      // A network failure is not a refusal: keep the tokens, try again on the next call.
      return { ok: false, state: "error", reason: `gitring could not reach GitHub: ${String((e as Error).message ?? e)}` };
    }
    if (!answer.access_token) {
      // bad_refresh_token and similar: the refresh token is used or revoked.
      this.sql.exec("UPDATE identities SET token = NULL WHERE provider = 'github' AND subject = ?", subject);
      return { ok: false, state: "expired", reason: "GitHub asks you to sign in again. Connect GitHub again." };
    }
    const next = githubUserToken(answer);
    const sealedNext = await seal(this.secret(), next, GITHUB_TOKEN_PURPOSE);
    this.sql.exec("UPDATE identities SET token = ? WHERE provider = 'github' AND subject = ? AND token = ?", sealedNext, subject, sealedOld);
    const stored = this.sql.exec<{ token: string | null }>("SELECT token FROM identities WHERE provider = 'github' AND subject = ?", subject).toArray()[0]?.token;
    if (stored !== sealedNext) {
      // The person disconnected GitHub (or signed in again) while GitHub made the token: it is not used.
      await this.revokeGithubToken(app, next.access);
      return { ok: false, state: "expired", reason: "Connect GitHub again." };
    }
    return { ok: true, token: next.access, login, expiresAt: next.expiresAt ?? null };
  }

  /** DELETE /applications/{client_id}/token revokes one user token (best effort). */
  private async revokeGithubToken(app: GithubAppConfig, access: string): Promise<void> {
    await fetch(`https://api.github.com/applications/${encodeURIComponent(app.clientId)}/token`, {
      method: "DELETE",
      headers: { ...GITHUB_HEADERS, Authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: access }),
    }).catch(() => undefined);
  }

  /**
   * Disconnect GitHub: revoke the token at GitHub and forget it. The GitHub sign-in stays. A refresh in
   * flight for the account finishes first, so that the token it made is the one revoked here.
   */
  async githubDisconnect(userId: string): Promise<void> {
    const app = await this.githubApp().catch(() => null);
    for (const r of this.sql.exec<{ subject: string }>("SELECT subject FROM identities WHERE user_id = ? AND provider = 'github'", userId).toArray()) {
      await this.githubRefreshes.get(r.subject)?.catch(() => undefined);
    }
    const rows = this.sql.exec<{ subject: string; token: string | null }>("SELECT subject, token FROM identities WHERE user_id = ? AND provider = 'github'", userId).toArray();
    for (const r of rows) {
      if (!r.token) continue;
      const t = await this.openToken(r.token);
      this.sql.exec("UPDATE identities SET token = NULL WHERE provider = 'github' AND subject = ?", r.subject);
      if (t && app) await this.revokeGithubToken(app, t.access);
    }
  }

  async setGoogle(cfg: GoogleConfig): Promise<void> {
    const clientId = String(cfg.clientId ?? "").trim();
    const clientSecret = String(cfg.clientSecret ?? "").trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error("The client ID must end with .apps.googleusercontent.com.");
    if (clientSecret.length < 10) throw new Error("Give the client secret.");
    await this.putSealed("google", { clientId, clientSecret });
  }

  /* ════════════════════ one-time states (OAuth, manifest) ════════════════════ */

  private putState(data: StateData, ttl = STATE_MS): string {
    const state = randomToken(24);
    const now = Date.now();
    this.sql.exec("DELETE FROM states WHERE expires_at < ?", now);
    this.sql.exec("INSERT INTO states (state, data, expires_at) VALUES (?, ?, ?)", state, JSON.stringify(data), now + ttl);
    return state;
  }

  /** Read a one-time state without using it up. */
  private peekState(state: string): StateData {
    const row = this.sql.exec<{ data: string; expires_at: number }>("SELECT data, expires_at FROM states WHERE state = ?", String(state ?? "")).toArray()[0];
    if (!row || row.expires_at < Date.now()) throw new Error("The setup link expired or was used already. Start again.");
    return JSON.parse(row.data) as StateData;
  }

  private takeState(state: string): StateData {
    const row = this.sql.exec<{ data: string; expires_at: number }>("SELECT data, expires_at FROM states WHERE state = ?", String(state ?? "")).toArray()[0];
    this.sql.exec("DELETE FROM states WHERE state = ?", String(state ?? ""));
    if (!row || row.expires_at < Date.now()) throw new Error("The sign-in link expired or was used already. Start again.");
    return JSON.parse(row.data) as StateData;
  }

  /* ════════════════════ GitHub App: create from a manifest ════════════════════ */

  /** The manifest form for https://github.com/settings/apps/new. */
  async githubManifest(origin: string): Promise<{ postUrl: string; manifest: string }> {
    const state = this.putState({ kind: "manifest", origin });
    const host = new URL(origin).hostname;
    const tag = host.endsWith(".workers.dev") ? host.split(".").slice(-3, -2)[0] : host.split(".")[0];
    // GitHub cannot deliver webhooks to a local dev server, so an app for localhost has no webhook.
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host);
    const webhook = local ? {} : { hook_attributes: { url: `${origin}/hooks/github-app`, active: true }, default_events: ["issues", "push"] };
    const manifest = {
      // GitHub reserves app names with "gitring" in them (an account has that login), so the app is "git-ring".
      name: `git-ring ${tag}`.slice(0, 34),
      url: origin,
      ...webhook,
      redirect_url: `${origin}/setup/github/callback`,
      callback_urls: [`${origin}/auth/github/callback`],
      setup_url: `${origin}/setup/github/installed`,
      setup_on_update: true,
      description: "gitring: many coding agents change one codebase at the same time. Sign in, open tasks from issues, send merged code to GitHub.",
      public: true,
      default_permissions: { contents: "write", pull_requests: "write", issues: "read", metadata: "read" },
      request_oauth_on_install: false,
    };
    return { postUrl: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(manifest) };
  }

  /**
   * GitHub redirects back with a one-time code: convert it into the app's credentials.
   * The conversion is an unauthenticated GitHub API call, and Workers share outbound addresses, so
   * GitHub can answer 403 or 429. Then the setup page converts the code in the owner's browser and
   * sends the result to githubAppSave (the state stays valid for that).
   */
  async githubManifestDone(code: string, state: string): Promise<{ slug: string; htmlUrl: string } | { browser: true }> {
    const st = this.peekState(state);
    if (st.kind !== "manifest") throw new Error("This link is not a GitHub App setup link.");
    const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST", headers: GITHUB_HEADERS });
    if (res.status === 403 || res.status === 429) return { browser: true };
    this.takeState(state);
    if (!res.ok) throw new Error(`GitHub did not create the app credentials (status ${res.status}). Start again.`);
    return this.saveGithubApp(await res.json<ManifestConversion>());
  }

  /** The browser converted the manifest code: check the credentials with GitHub, then seal them. */
  async githubAppSave(state: string, app: ManifestConversion): Promise<{ slug: string; htmlUrl: string }> {
    const st = this.takeState(state);
    if (st.kind !== "manifest") throw new Error("This link is not a GitHub App setup link.");
    // webhook_secret is null for an app without a webhook (made for localhost).
    if (!app || typeof app.id !== "number" || !app.slug || !app.client_id || !app.client_secret || !app.pem) {
      throw new Error("GitHub did not send complete app credentials. Start again.");
    }
    // The private key must belong to the app: GitHub answers GET /app only to a JWT signed with it.
    const jwt = await githubAppJwt(app.id, app.pem);
    const check = await fetch("https://api.github.com/app", { headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` } });
    if (!check.ok) throw new Error(`GitHub did not accept the app key (status ${check.status}). Start again.`);
    const me = await check.json<{ id: number; slug: string }>();
    if (me.id !== app.id) throw new Error("The app key belongs to another app. Start again.");
    return this.saveGithubApp(app);
  }

  private async saveGithubApp(j: ManifestConversion): Promise<{ slug: string; htmlUrl: string }> {
    await this.putSealed("github_app", {
      id: j.id,
      slug: j.slug,
      clientId: j.client_id,
      clientSecret: j.client_secret,
      webhookSecret: j.webhook_secret ?? "",
      pem: j.pem,
      htmlUrl: j.html_url,
      owner: j.owner?.login,
    } satisfies GithubAppConfig);
    return { slug: j.slug, htmlUrl: j.html_url };
  }

  /* ════════════════════ sign-in ════════════════════ */

  /**
   * The provider's sign-in URL. With `linkUserId` (a signed-in person adds a sign-in), the provider
   * account joins that person instead of signing in.
   */
  async signInUrl(provider: A.Provider, origin: string, returnTo: string, linkUserId?: string): Promise<string> {
    const back = safeReturn(returnTo);
    const link = linkUserId && this.userInfo(linkUserId) ? { linkUserId } : {};
    if (provider === "github") {
      const gh = await this.getSealed<GithubAppConfig>("github_app");
      if (!gh) throw new Error("GitHub sign-in is not set up on this gitring yet.");
      const state = this.putState({ kind: "signin", provider, origin, returnTo: back, ...link });
      const q = new URLSearchParams({ client_id: gh.clientId, redirect_uri: `${origin}/auth/github/callback`, state, allow_signup: "true" });
      return `https://github.com/login/oauth/authorize?${q}`;
    }
    const gg = await this.getSealed<GoogleConfig>("google");
    if (!gg) throw new Error("Google sign-in is not set up on this gitring yet.");
    const verifier = randomToken(48);
    const nonce = randomToken(16);
    const state = this.putState({ kind: "signin", provider, origin, returnTo: back, verifier, nonce, ...link });
    const q = new URLSearchParams({
      client_id: gg.clientId,
      redirect_uri: `${origin}/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: await sha256B64url(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  /**
   * Finish a sign-in, and answer what went wrong instead of throwing (the Worker sends the person back to
   * the page they came from, with the reason).
   */
  async completeSignIn(
    provider: A.Provider,
    code: string,
    state: string,
  ): Promise<{ ok: true; token: string | null; returnTo: string; user: A.UserInfo; linked?: boolean } | { ok: false; code: "expired" | "taken" | "failed"; message: string; returnTo: string }> {
    let returnTo = "/";
    try {
      const st = this.peekState(state);
      if (st.kind === "signin") returnTo = st.returnTo;
    } catch {
      return { ok: false, code: "expired", message: "The sign-in took too long, or it was used already. Try again.", returnTo };
    }
    try {
      return { ok: true, ...(await this.finishSignIn(provider, code, state)) };
    } catch (e) {
      const message = String((e as Error).message ?? e);
      return { ok: false, code: /belongs to another gitring account/.test(message) ? "taken" : "failed", message, returnTo };
    }
  }

  /** The page a sign-in returns to; uses the state up (the provider answered with an error). */
  async abandonSignIn(state: string): Promise<string> {
    try {
      const st = this.takeState(state);
      return st.kind === "signin" ? st.returnTo : "/";
    } catch {
      return "/";
    }
  }

  /** The providers and the GitHub connection of a person, in one call (GET /api/me). */
  async meInfo(userId: string | null): Promise<{ providers: ProvidersInfo; github?: A.GithubConnection }> {
    const providers = await this.providers();
    return { providers, ...(userId ? { github: await this.githubConnection(userId) } : {}) };
  }

  /**
   * Finish a sign-in: exchange the code, upsert the person, open a session. A link (a signed-in person
   * added a sign-in) adds the provider account to that person and opens no new session (`token` null).
   */
  async finishSignIn(provider: A.Provider, code: string, state: string): Promise<{ token: string | null; returnTo: string; user: A.UserInfo; linked?: boolean }> {
    const st = this.takeState(state);
    if (st.kind !== "signin" || st.provider !== provider) throw new Error("This sign-in link does not match. Start again.");
    const profile = provider === "github" ? await this.githubProfile(code, st.origin) : await this.googleProfile(code, st.origin, st.verifier ?? "");
    if (st.linkUserId) {
      const owner = this.sql.exec<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = ? AND subject = ?", profile.provider, profile.subject).toArray()[0]?.user_id;
      if (owner && owner !== st.linkUserId) {
        throw new Error(`This ${provider === "github" ? "GitHub" : "Google"} account belongs to another gitring account. Sign in with it, or remove it there first.`);
      }
      await this.upsert(profile, st.linkUserId);
      return { token: null, returnTo: st.returnTo, user: this.userInfo(st.linkUserId)!, linked: true };
    }
    const userId = await this.upsert(profile);
    const token = randomToken(32);
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", now);
    this.sql.exec("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", await sha256B64url(token), userId, now, now + SESSION_MS);
    return { token, returnTo: st.returnTo, user: this.userInfo(userId)! };
  }

  /** Sign out everywhere: end every browser session of the person. API keys and connected apps stay. */
  async endAllSessions(userId: string): Promise<number> {
    const n = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE user_id = ?", userId).one().n;
    this.sql.exec("DELETE FROM sessions WHERE user_id = ?", userId);
    return n;
  }

  private async githubProfile(code: string, origin: string): Promise<Profile> {
    const gh = await this.getSealed<GithubAppConfig>("github_app");
    if (!gh) throw new Error("GitHub sign-in is not set up.");
    const tok = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "gitring" },
      body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code, redirect_uri: `${origin}/auth/github/callback` }),
    });
    const t = await tok.json<GithubTokenAnswer>();
    if (!t.access_token) throw new Error(`GitHub refused the sign-in: ${t.error_description ?? t.error ?? tok.status}.`);
    const res = await fetch("https://api.github.com/user", { headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${t.access_token}` } });
    if (!res.ok) throw new Error(`GitHub did not return the profile (status ${res.status}).`);
    const u = await res.json<{ id: number; login: string; name?: string | null; email?: string | null; avatar_url?: string }>();
    // gitring keeps the user token sealed: it lists the repositories that the person can import.
    return { provider: "github", subject: String(u.id), name: u.name || u.login, login: u.login, email: u.email ?? undefined, avatar: u.avatar_url, github: githubUserToken(t) };
  }

  private async googleProfile(code: string, origin: string, verifier: string): Promise<Profile> {
    const gg = await this.getSealed<GoogleConfig>("google");
    if (!gg) throw new Error("Google sign-in is not set up.");
    const tok = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: gg.clientId,
        client_secret: gg.clientSecret,
        redirect_uri: `${origin}/auth/google/callback`,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    const t = await tok.json<{ access_token?: string; error?: string; error_description?: string }>();
    if (!t.access_token) throw new Error(`Google refused the sign-in: ${t.error_description ?? t.error ?? tok.status}.`);
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } });
    if (!res.ok) throw new Error(`Google did not return the profile (status ${res.status}).`);
    const u = await res.json<{ sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }>();
    if (!u.email || !u.email_verified) throw new Error("Google did not confirm the email address of this account.");
    return { provider: "google", subject: u.sub, name: u.name || u.email, email: u.email.toLowerCase(), emailVerified: true, avatar: u.picture };
  }

  /**
   * Find or create the person for a provider profile; link by a verified email when possible.
   * `linkTo`: the signed-in person who adds this sign-in (the caller checked that it is free).
   */
  private async upsert(p: Profile, linkTo?: string): Promise<string> {
    const now = Date.now();
    const known = this.sql.exec<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = ? AND subject = ?", p.provider, p.subject).toArray()[0];
    let userId = linkTo ?? known?.user_id;
    if (!userId && p.email && (p.emailVerified || p.provider === "github")) {
      userId = this.sql.exec<{ id: string }>("SELECT id FROM users WHERE lower(email) = ?", p.email.toLowerCase()).toArray()[0]?.id;
    }
    if (!userId) {
      userId = `u_${rand(10)}`;
      this.sql.exec("INSERT INTO users (id, name, email, avatar, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)", userId, p.name.slice(0, 80), p.email ?? null, p.avatar ?? null, now, now);
    } else {
      this.sql.exec(
        "UPDATE users SET last_seen = ?, avatar = COALESCE(avatar, ?), email = COALESCE(email, ?) WHERE id = ?",
        now,
        p.avatar ?? null,
        p.email ?? null,
        userId,
      );
    }
    // GitHub: the user token, sealed (AES-GCM). Google: no token (sign-in only).
    const sealedToken = p.github ? await seal(this.secret(), p.github, GITHUB_TOKEN_PURPOSE) : null;
    this.sql.exec(
      "INSERT INTO identities (provider, subject, user_id, login, email, token) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (provider, subject) DO UPDATE SET user_id = excluded.user_id, login = excluded.login, email = excluded.email, token = excluded.token",
      p.provider,
      p.subject,
      userId,
      p.login ?? null,
      p.email ?? null,
      sealedToken,
    );
    // Invites by login or email become memberships.
    const handles = [p.login && `github:${p.login.toLowerCase()}`, p.email && `email:${p.email.toLowerCase()}`].filter(Boolean) as string[];
    for (const h of handles) this.sql.exec("UPDATE members SET user_id = ? WHERE handle = ? AND user_id IS NULL", userId, h);
    return userId;
  }

  /* ════════════════════ passkeys (WebAuthn) ════════════════════ */

  /** A one-time passkey state: null when it is unknown, expired, used, or of another kind. */
  private takePasskeyState(state: string): Extract<StateData, { kind: "passkey" }> | null {
    const row = this.sql.exec<{ data: string; expires_at: number }>("SELECT data, expires_at FROM states WHERE state = ?", String(state ?? "")).toArray()[0];
    if (!row) return null;
    this.sql.exec("DELETE FROM states WHERE state = ?", String(state ?? ""));
    const data = JSON.parse(row.data) as StateData;
    return row.expires_at >= Date.now() && data.kind === "passkey" ? data : null;
  }

  private passkeyRows(userId: string) {
    return this.sql
      .exec<{ id: string; name: string; transports: string | null; created_at: number; last_used: number | null }>("SELECT id, name, transports, created_at, last_used FROM passkeys WHERE user_id = ? ORDER BY created_at", userId)
      .toArray();
  }

  /** A new browser session for a person (only a SHA-256 of the token is stored). */
  private async openSession(userId: string): Promise<string> {
    const token = randomToken(32);
    const hash = await sha256B64url(token);
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", now);
    this.sql.exec("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", hash, userId, now, now + SESSION_MS);
    return token;
  }

  /**
   * Options for navigator.credentials.create(). With `userId` (a signed-in person), the passkey joins
   * that person; else it makes a new account with the display name `name`. `origin` and `rpId` come
   * from the request (the RP id is its host name). Returns the one-time state for the browser cookie.
   */
  async passkeyRegisterOptions(input: { origin: string; rpId: string; name?: string; userId?: string }): Promise<{ state: string; options: A.PasskeyCreationOptions }> {
    let mode: "create" | "add";
    let userId: string;
    let name: string;
    let account: string;
    let exclude: A.PasskeyDescriptor[] = [];
    if (input.userId) {
      const user = this.userInfo(input.userId);
      if (!user) throw new Error("Sign in again, then add the passkey.");
      const rows = this.passkeyRows(user.id);
      if (rows.length >= MAX_PASSKEYS_PER_USER) throw new Error(`You have ${MAX_PASSKEYS_PER_USER} passkeys. Remove one first.`);
      mode = "add";
      userId = user.id;
      name = user.name;
      account = user.email ?? user.name;
      // The browser makes no second passkey for this account on an authenticator that has one.
      exclude = rows.map((r) => ({ type: "public-key", id: r.id, ...transportsOf(r.transports) }));
    } else {
      name = cleanName(input.name);
      if (!name) throw new Error("Give your name. Other people in your projects see it.");
      mode = "create";
      userId = `u_${rand(10)}`;
      while (this.userInfo(userId)) userId = `u_${rand(10)}`;
      account = name;
    }
    const challenge = randomToken(32);
    const state = this.putState({ kind: "passkey", mode, challenge, origin: input.origin, rpId: input.rpId, userId, name }, PASSKEY_STATE_MS);
    return {
      state,
      options: {
        challenge,
        rp: { id: input.rpId, name: "gitring" },
        user: { id: userHandleOf(userId), name: account, displayName: name },
        pubKeyCredParams: PASSKEY_ALGS.map((alg) => ({ type: "public-key" as const, alg })),
        timeout: PASSKEY_STATE_MS,
        attestation: "none",
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
        excludeCredentials: exclude,
      },
    };
  }

  /**
   * Check the browser's new passkey and keep it. A new account opens a session (`token`); a passkey that
   * a signed-in person added opens none. `userId` is the person who is signed in now (or none), `label`
   * the name that the browser suggests for the passkey.
   */
  async passkeyRegister(state: string, credential: unknown, opts: { origin: string; userId?: string; label?: string }): Promise<{ token: string | null; user: A.UserInfo; passkey: A.PasskeyInfo }> {
    const st = this.takePasskeyState(state);
    if (!st || st.mode === "login" || !st.userId) throw new Error("The passkey request expired or was used already. Start again.");
    if (st.origin !== opts.origin) throw new Error("The passkey request is for another site. Start again.");
    if (st.mode === "add" && st.userId !== opts.userId) throw new Error("Sign in again, then add the passkey.");
    let pk: NewPasskey;
    try {
      pk = await verifyRegistration(credential, { challenge: st.challenge, origin: st.origin, rpId: st.rpId });
    } catch (e) {
      throw new Error(e instanceof PasskeyError ? e.message : "gitring could not read the passkey. Try again.");
    }
    if (this.sql.exec("SELECT id FROM passkeys WHERE id = ?", pk.id).toArray()[0]) throw new Error("gitring has this passkey already. Sign in with it.");
    const userId = st.userId;
    const now = Date.now();
    if (st.mode === "create") {
      if (this.userInfo(userId)) throw new Error("The passkey request was used already. Start again.");
      this.sql.exec("INSERT INTO users (id, name, email, avatar, created_at, last_seen) VALUES (?, ?, NULL, NULL, ?, ?)", userId, st.name || "gitring user", now, now);
    } else if (!this.userInfo(userId)) {
      throw new Error("Sign in again, then add the passkey.");
    } else if (this.passkeyRows(userId).length >= MAX_PASSKEYS_PER_USER) {
      throw new Error(`You have ${MAX_PASSKEYS_PER_USER} passkeys. Remove one first.`);
    }
    const name = cleanName(opts.label) || "Passkey";
    const lastUsed = st.mode === "create" ? now : null;
    this.sql.exec(
      "INSERT INTO passkeys (id, user_id, public_key, alg, sign_count, transports, name, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      pk.id,
      userId,
      JSON.stringify(pk.jwk),
      pk.alg,
      pk.signCount,
      pk.transports.length ? JSON.stringify(pk.transports) : null,
      name,
      now,
      lastUsed,
    );
    const token = st.mode === "create" ? await this.openSession(userId) : null;
    return { token, user: this.userInfo(userId)!, passkey: { id: pk.id, name, createdAt: now, ...(lastUsed ? { lastUsed } : {}) } };
  }

  /**
   * Options for navigator.credentials.get(). allowCredentials stays empty: every gitring passkey is a
   * discoverable credential, so the browser offers the passkeys that it has for this site. (A typed
   * name would also tell anyone which names have an account.)
   */
  async passkeyLoginOptions(input: { origin: string; rpId: string }): Promise<{ state: string; options: A.PasskeyRequestOptions }> {
    const challenge = randomToken(32);
    const state = this.putState({ kind: "passkey", mode: "login", challenge, origin: input.origin, rpId: input.rpId }, PASSKEY_STATE_MS);
    return { state, options: { challenge, rpId: input.rpId, timeout: PASSKEY_STATE_MS, userVerification: "preferred", allowCredentials: [] } };
  }

  /** Check a passkey sign-in and open the same session as other sign-ins. */
  async passkeyLogin(state: string, credential: unknown, opts: { origin: string }): Promise<{ token: string; user: A.UserInfo }> {
    const st = this.takePasskeyState(state);
    if (!st || st.mode !== "login") throw new Error("The passkey sign-in expired or was used already. Start again.");
    if (st.origin !== opts.origin) throw new Error("The passkey sign-in is for another site. Start again.");
    let id: string;
    try {
      id = credentialIdOf(credential);
    } catch (e) {
      throw new Error((e as Error).message);
    }
    const unknown = "gitring does not know this passkey. Use another passkey, or create an account.";
    const row = this.sql
      .exec<{ user_id: string; public_key: string; alg: number; sign_count: number }>("SELECT user_id, public_key, alg, sign_count FROM passkeys WHERE id = ?", id)
      .toArray()[0];
    if (!row) throw new Error(unknown);
    let res: { signCount: number; userHandle: string | null };
    try {
      res = await verifyAssertion(credential, { challenge: st.challenge, origin: st.origin, rpId: st.rpId }, { jwk: JSON.parse(row.public_key) as JsonWebKey, alg: row.alg as PasskeyAlg, signCount: row.sign_count });
    } catch (e) {
      throw new Error(e instanceof PasskeyError ? e.message : "gitring could not read the passkey. Try again.");
    }
    if (res.userHandle && res.userHandle !== userHandleOf(row.user_id)) throw new Error("The passkey does not belong to this account. gitring did not sign you in.");
    // Another sign-in with this passkey can finish during the check, and the person can remove the
    // passkey: read the row again (no await from here to the update, so the two steps are one).
    const current = this.sql.exec<{ user_id: string; public_key: string; sign_count: number }>("SELECT user_id, public_key, sign_count FROM passkeys WHERE id = ?", id).toArray()[0];
    if (!current || current.user_id !== row.user_id || current.public_key !== row.public_key) throw new Error(unknown);
    if (!signCountOk(current.sign_count, res.signCount)) throw new Error("The passkey counter went back. This can mean a copy of the passkey. gitring did not sign you in.");
    const now = Date.now();
    this.sql.exec("UPDATE passkeys SET sign_count = ?, last_used = ? WHERE id = ?", res.signCount, now, id);
    this.sql.exec("UPDATE users SET last_seen = ? WHERE id = ?", now, row.user_id);
    const user = this.userInfo(row.user_id);
    if (!user) throw new Error(unknown);
    return { token: await this.openSession(row.user_id), user };
  }

  async listPasskeys(userId: string): Promise<A.PasskeyInfo[]> {
    return this.passkeyRows(userId).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, ...(r.last_used ? { lastUsed: r.last_used } : {}) }));
  }

  async renamePasskey(userId: string, id: string, name: string): Promise<A.PasskeyInfo> {
    const clean = cleanName(name);
    if (!clean) throw new Error("Give the passkey a name.");
    this.sql.exec("UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?", clean, id, userId);
    const found = (await this.listPasskeys(userId)).find((p) => p.id === id);
    if (!found) throw new Error("You have no passkey with this id.");
    return found;
  }

  /** Remove a passkey. One way to sign in always stays: a person without identities keeps one passkey. */
  async removePasskey(userId: string, id: string): Promise<void> {
    const rows = this.passkeyRows(userId);
    if (!rows.some((r) => r.id === id)) throw new Error("You have no passkey with this id.");
    const identities = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM identities WHERE user_id = ?", userId).one().n;
    if (rows.length === 1 && identities === 0) throw new Error("This passkey is your only way to sign in. Add another passkey or sign-in first.");
    this.sql.exec("DELETE FROM passkeys WHERE id = ? AND user_id = ?", id, userId);
  }

  /* ════════════════════ people ════════════════════ */

  private owners(): string[] {
    return (this.env.GITRING_OWNERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * An owner of the deployment (GITRING_OWNERS): "user:<account id>" (any person, also one with
   * passkeys only), "github:<login>", "github-id:<number>", "google:<email>" or a bare email. A login
   * matches only the account that matched it first: when an owner renames their GitHub account, GitHub
   * releases the old login, and whoever registers it later does not become an owner.
   */
  private isAdmin(userId: string): boolean {
    const owners = this.owners();
    if (!owners.length) return false;
    // Account ids never change hands: no pin needed.
    if (owners.includes(`user:${userId.toLowerCase()}`)) return true;
    for (const i of this.sql.exec<{ provider: string; subject: string; login: string | null; email: string | null }>("SELECT provider, subject, login, email FROM identities WHERE user_id = ?", userId).toArray()) {
      if (owners.includes(`${i.provider}-id:${String(i.subject).toLowerCase()}`)) return true;
      const handle = i.login ? `${i.provider}:${i.login.toLowerCase()}` : null;
      if (handle && owners.includes(handle) && this.ownerPinOk(handle, i.provider, i.subject)) return true;
      if (i.email && (owners.includes(`${i.provider}:${i.email.toLowerCase()}`) || owners.includes(i.email.toLowerCase()))) return true;
    }
    return false;
  }

  private ownerPinOk(handle: string, provider: string, subject: string): boolean {
    const pin = this.sql.exec<{ provider: string; subject: string }>("SELECT provider, subject FROM owner_pins WHERE handle = ?", handle).toArray()[0];
    if (!pin) {
      this.sql.exec("INSERT OR IGNORE INTO owner_pins (handle, provider, subject, pinned_at) VALUES (?, ?, ?, ?)", handle, provider, String(subject), Date.now());
      return true;
    }
    return pin.provider === provider && pin.subject === String(subject);
  }

  private userInfo(userId: string): A.UserInfo | null {
    const u = this.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", userId).toArray()[0];
    if (!u) return null;
    const identities = this.sql
      .exec<{ provider: A.Provider; login: string | null; email: string | null }>("SELECT provider, login, email FROM identities WHERE user_id = ?", userId)
      .toArray()
      .map((i) => ({ provider: i.provider, login: i.login ?? undefined, email: i.email ?? undefined }));
    const passkeys = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", userId).one().n;
    return { id: u.id, name: u.name, email: u.email ?? undefined, avatar: u.avatar ?? undefined, identities, passkeys, admin: this.isAdmin(u.id) };
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

  /* ════════════════════ API keys ════════════════════ */

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

  /* ════════════════════ projects + roles ════════════════════ */

  private projectRow(id: string): ProjectRow | undefined {
    return this.sql.exec<ProjectRow>("SELECT * FROM projects WHERE id = ? AND archived = 0", id).toArray()[0];
  }

  private roleIn(row: ProjectRow, userId: string | null): A.Role | null {
    if (userId) {
      if (this.isAdmin(userId)) return "owner";
      const m = this.sql.exec<{ role: A.Role }>("SELECT role FROM members WHERE project_id = ? AND user_id = ?", row.id, userId).toArray()[0];
      if (m) return m.role;
    }
    return row.visibility === "public" ? "viewer" : null;
  }

  private info(row: ProjectRow, userId: string | null): A.ProjectInfo {
    const owner = row.owner_id ? this.sql.exec<{ name: string }>("SELECT name FROM users WHERE id = ?", row.owner_id).toArray()[0]?.name : "gitring";
    return {
      id: row.id,
      name: row.name,
      visibility: row.visibility,
      source: JSON.parse(row.source) as ProjectSource,
      createdAt: row.created_at,
      ownerName: owner,
      role: this.roleIn(row, userId),
    };
  }

  async project(id: string, userId: string | null): Promise<A.ProjectInfo | null> {
    const row = this.projectRow(id);
    if (!row) return null;
    const info = this.info(row, userId);
    return info.role ? info : null;
  }

  /** The caller's role on a project (null: the project is unknown or hidden from the caller). */
  async role(id: string, userId: string | null): Promise<A.Role | null> {
    const row = this.projectRow(id);
    return row ? this.roleIn(row, userId) : null;
  }

  async exists(id: string): Promise<boolean> {
    return Boolean(this.projectRow(id));
  }

  /**
   * Projects imported from (or linked to) a GitHub repository in which the sender of an issue may open
   * intents: a member or owner, matched by GitHub account id (a login can be renamed and taken by
   * someone else), or a pending invite of the login (nobody accepted it yet, so the login is all there is).
   * An issue event from an installed repository only reaches these.
   */
  async projectsForGithubLogin(url: string, login: string, senderId?: number): Promise<string[]> {
    const want = normalizeRemote(url);
    const l = String(login ?? "").toLowerCase();
    if (!l) return [];
    const userId = senderId !== undefined ? (this.sql.exec<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?", String(senderId)).toArray()[0]?.user_id ?? null) : null;
    const out: string[] = [];
    const repo = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i.exec(url)?.[1]?.toLowerCase() ?? "";
    const linked = new Set(repo ? this.sql.exec<{ project_id: string }>("SELECT project_id FROM github_links WHERE repo = ?", repo).toArray().map((r) => r.project_id) : []);
    for (const row of this.sql.exec<ProjectRow>("SELECT * FROM projects WHERE archived = 0").toArray()) {
      const s = JSON.parse(row.source) as ProjectSource;
      const match = (s.kind === "git" && normalizeRemote(s.url) === want) || (s.kind === "github" && s.repo.toLowerCase() === repo) || linked.has(row.id);
      if (!match) continue;
      const role = userId ? this.roleIn(row, userId) : null;
      const invited = this.sql.exec<{ role: A.Role }>("SELECT role FROM members WHERE project_id = ? AND handle = ? AND user_id IS NULL", row.id, `github:${l}`).toArray()[0]?.role ?? null;
      if ((role === "owner" || role === "member") || invited === "owner" || invited === "member") out.push(row.id);
    }
    return out;
  }

  /** Projects that a person can see. `all`: every project (the operator key acts as the deployment). */
  async listProjects(userId: string | null, all = false): Promise<A.ProjectInfo[]> {
    const rows = this.sql.exec<ProjectRow>("SELECT * FROM projects WHERE archived = 0 ORDER BY created_at DESC").toArray();
    if (all) return rows.map((r) => ({ ...this.info(r, null), role: "owner" as const }));
    return rows.map((r) => this.info(r, userId)).filter((p) => p.role !== null);
  }

  /**
   * Make a project. ownerId null: the operator key made it, and no person owns it (deployment owners act
   * on it). `id`: a free id that a guess offered (it must start with the name's slug); otherwise a new one.
   */
  async createProject(input: { name: string; visibility?: A.Visibility; source: ProjectSource; ownerId: string | null; id?: string }): Promise<A.ProjectInfo> {
    const owner = input.ownerId === null ? null : this.userInfo(input.ownerId);
    if (input.ownerId !== null && !owner) throw new Error("Sign in first.");
    const name = String(input.name ?? "").trim().slice(0, 80);
    if (!name) throw new Error("Give the project a name.");
    if (owner && !owner.admin) {
      const n = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM projects WHERE owner_id = ? AND archived = 0", owner.id).one().n;
      if (n >= MAX_PROJECTS_PER_USER) throw new Error(`You have ${MAX_PROJECTS_PER_USER} projects. Archive one first.`);
    }
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "project";
    const taken = (x: string) => Boolean(this.sql.exec("SELECT id FROM projects WHERE id = ?", x).toArray()[0]);
    const asked = input.id && PROJECT_ID.test(input.id) && input.id.startsWith(`${base}-`) ? input.id : undefined;
    let id = asked && !taken(asked) ? asked : `${base}-${rand(4)}`;
    while (taken(id)) id = `${base}-${rand(4)}`;
    if (!PROJECT_ID.test(id)) throw new Error("gitring could not make an id for this name. Use letters and digits.");
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO projects (id, name, owner_id, visibility, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      name,
      owner?.id ?? null,
      input.visibility === "public" ? "public" : "private",
      JSON.stringify(input.source),
      now,
    );
    if (!owner) return { ...this.info(this.projectRow(id)!, null), role: "owner" };
    this.sql.exec("INSERT INTO members (project_id, handle, user_id, role) VALUES (?, ?, ?, 'owner')", id, `user:${owner.id}`, owner.id);
    return this.info(this.projectRow(id)!, owner.id);
  }

  /** Undo a creation whose repository could not be made. */
  async dropProject(id: string): Promise<void> {
    this.sql.exec("DELETE FROM members WHERE project_id = ?", id);
    this.sql.exec("DELETE FROM projects WHERE id = ?", id);
  }

  async archiveProject(id: string): Promise<void> {
    this.sql.exec("UPDATE projects SET archived = 1 WHERE id = ?", id);
  }

  async updateProject(id: string, patch: { name?: string; visibility?: A.Visibility }): Promise<A.ProjectInfo> {
    const row = this.projectRow(id);
    if (!row) throw new Error("Unknown project.");
    if (patch.name?.trim()) this.sql.exec("UPDATE projects SET name = ? WHERE id = ?", patch.name.trim().slice(0, 80), id);
    if (patch.visibility === "public" || patch.visibility === "private") this.sql.exec("UPDATE projects SET visibility = ? WHERE id = ?", patch.visibility, id);
    return this.info(this.projectRow(id)!, null);
  }

  async members(id: string): Promise<A.MemberInfo[]> {
    const rows = this.sql
      .exec<{ handle: string; user_id: string | null; role: A.Role; name: string | null }>(
        "SELECT m.handle, m.user_id, m.role, u.name FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.role DESC, u.name",
        id,
      )
      .toArray();
    return rows.map((r) => ({
      userId: r.user_id ?? undefined,
      name: r.name ?? r.handle.replace(/^(github|email|user):/, ""),
      handle: r.handle.replace(/^(github|email|user):/, ""),
      role: r.role,
      pending: !r.user_id,
    }));
  }

  /**
   * Add a person by account id ("u_…", also "user:u_…": a person who exists, for example with passkeys
   * only), or invite by email or GitHub login (no @). An invite becomes a role at the next sign-in.
   */
  async addMember(id: string, who: string, role: A.Role): Promise<A.MemberInfo[]> {
    if (!this.projectRow(id)) throw new Error("Unknown project.");
    if (!["owner", "member", "viewer"].includes(role)) throw new Error("Use the role owner, member or viewer.");
    const raw = String(who ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!raw) throw new Error("Give an account id, an email or a GitHub login.");
    const account = /^(?:user:)?(u_[a-z0-9]{10})$/.exec(raw)?.[1];
    if (account) {
      if (!this.userInfo(account)) throw new Error("gitring has no account with this id.");
      this.sql.exec("DELETE FROM members WHERE project_id = ? AND user_id = ?", id, account);
      this.sql.exec("INSERT OR REPLACE INTO members (project_id, handle, user_id, role) VALUES (?, ?, ?, ?)", id, `user:${account}`, account, role);
      return this.members(id);
    }
    const handle = raw.includes("@") ? `email:${raw}` : `github:${raw}`;
    if (!/^(email:[^\s@]+@[^\s@]+\.[^\s@]+|github:[a-z0-9-]{1,39})$/.test(handle)) throw new Error("This is not an account id, an email or a GitHub login.");
    const known = raw.includes("@")
      ? this.sql.exec<{ user_id: string }>("SELECT user_id FROM identities WHERE lower(email) = ? LIMIT 1", raw).toArray()[0]
      : this.sql.exec<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = 'github' AND lower(login) = ? LIMIT 1", raw).toArray()[0];
    if (known) this.sql.exec("DELETE FROM members WHERE project_id = ? AND user_id = ?", id, known.user_id);
    this.sql.exec("INSERT OR REPLACE INTO members (project_id, handle, user_id, role) VALUES (?, ?, ?, ?)", id, handle, known?.user_id ?? null, role);
    return this.members(id);
  }

  async removeMember(id: string, handleOrUser: string): Promise<A.MemberInfo[]> {
    const owners = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM members WHERE project_id = ? AND role = 'owner' AND user_id IS NOT NULL", id).one().n;
    const target = this.sql
      .exec<{ handle: string; role: A.Role; user_id: string | null }>(
        "SELECT handle, role, user_id FROM members WHERE project_id = ? AND (user_id = ? OR handle LIKE ?)",
        id,
        handleOrUser,
        `%:${String(handleOrUser).toLowerCase()}`,
      )
      .toArray()[0];
    if (!target) throw new Error("This person is not a member.");
    if (target.role === "owner" && target.user_id && owners <= 1) throw new Error("A project needs at least one owner.");
    this.sql.exec("DELETE FROM members WHERE project_id = ? AND handle = ?", id, target.handle);
    return this.members(id);
  }

  /* ════════════════════ preferences and push ════════════════════ */

  /** The preferences of a person (contract C3). A person who never set one has the defaults. */
  async prefs(userId: string): Promise<A.PersonPrefs> {
    const row = this.sql.exec<{ data: string }>("SELECT data FROM prefs WHERE user_id = ?", userId).toArray()[0];
    return cleanPrefs(row ? JSON.parse(row.data) : undefined);
  }

  /** Change some preferences. A value that is not known is refused: the person must see that nothing changed. */
  async setPrefs(userId: string, patch: Partial<A.PersonPrefs>): Promise<A.PersonPrefs> {
    if (!this.userInfo(userId)) throw new Error("Unknown user.");
    const now = await this.prefs(userId);
    if (patch.approvalsIn !== undefined && !APPROVALS_IN.includes(patch.approvalsIn)) throw new Error('Give approvalsIn: "agent", "app" or "both".');
    const next = cleanPrefs({ ...now, ...patch });
    this.sql.exec("INSERT OR REPLACE INTO prefs (user_id, data) VALUES (?, ?)", userId, JSON.stringify(next));
    return next;
  }

  /** Push for this person: is it on for the deployment, the public key for the browser, and how many devices get it. */
  async pushStatus(userId: string): Promise<{ available: boolean; publicKey?: string; devices: number }> {
    const keys = pushKeys(this.env);
    const devices = this.pushDevices(userId);
    return keys ? { available: true, publicKey: keys.publicKey, devices } : { available: false, devices };
  }

  private pushDevices(userId: string): number {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM push_subs WHERE user_id = ?", userId).one().n;
  }

  /** A device of this person gets push notifications. The address belongs to one person: a new person takes it over. */
  async pushSubscribe(userId: string, endpoint: string): Promise<{ devices: number }> {
    if (!this.userInfo(userId)) throw new Error("Unknown user.");
    if (!pushKeys(this.env)) throw new Error("Push notifications are off on this gitring.");
    if (!pushEndpointOk(endpoint)) throw new Error("This push address is not valid. Use the address that the browser gives.");
    this.sql.exec("INSERT OR REPLACE INTO push_subs (endpoint, user_id, created_at) VALUES (?, ?, ?)", endpoint, userId, Date.now());
    const extra = this.sql.exec<{ endpoint: string }>("SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?", userId, MAX_PUSH_DEVICES).toArray();
    for (const e of extra) this.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", e.endpoint);
    return { devices: this.pushDevices(userId) };
  }

  /** The device stops: no more push notifications to it. Without an address, every device of the person stops. */
  async pushUnsubscribe(userId: string, endpoint?: string): Promise<{ devices: number }> {
    if (endpoint) this.sql.exec("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?", endpoint, userId);
    else this.sql.exec("DELETE FROM push_subs WHERE user_id = ?", userId);
    return { devices: this.pushDevices(userId) };
  }

  /** When each person got the last push (in this instance): see PUSH_GAP_MS. */
  private readonly lastPush = new Map<string, number>();

  /**
   * Something new waits in the inbox of people of a project: send an empty push to their devices. `users`: the
   * people who answer (the senders); empty: every person of the project with the role `need` or higher. A person
   * who answers merge questions only in the chat of the agent (approvalsIn "agent") gets no push for a merge
   * question. Answers how many pushes went out.
   */
  async pushInbox(projectId: string, target: { users: string[]; need: "owner" | "member"; kind: "approval" | "question" }): Promise<number> {
    const keys = pushKeys(this.env);
    const row = this.projectRow(projectId);
    if (!keys || !row) return 0;
    const people = target.users.length
      ? target.users.filter((u) => atLeast(this.roleIn(row, u), "member"))
      : this.sql
          .exec<{ user_id: string; role: A.Role }>("SELECT user_id, role FROM members WHERE project_id = ? AND user_id IS NOT NULL", projectId)
          .toArray()
          .filter((m) => atLeast(m.role, target.need))
          .map((m) => m.user_id);
    const now = Date.now();
    let sent = 0;
    for (const userId of new Set(people)) {
      if (target.kind === "approval" && (await this.prefs(userId)).approvalsIn === "agent") continue;
      if (now - (this.lastPush.get(userId) ?? 0) < PUSH_GAP_MS) continue;
      const subs = this.sql.exec<{ endpoint: string }>("SELECT endpoint FROM push_subs WHERE user_id = ?", userId).toArray();
      if (!subs.length) continue;
      this.lastPush.set(userId, now);
      for (const sub of subs) {
        const r = await sendPush(keys, sub.endpoint);
        if (r === "gone") this.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", sub.endpoint);
        if (r === "sent") sent += 1;
      }
    }
    if (this.lastPush.size > 5000) this.lastPush.clear();
    return sent;
  }

  /* ════════════════════ AI budget ════════════════════ */

  /**
   * Take up to n units from rolling one-hour windows: one per person (perUser) and one for the
   * deployment (global). Pools: "ai" (built-in agent starts) and "checks" (container check runs).
   * Returns how many it granted and when the next slot frees.
   */
  async budgetTake(owner: string | null, n: number, perUser: number, global: number, pool: "ai" | "checks" = "ai"): Promise<{ granted: number; retryAt: number }> {
    const now = Date.now();
    const key = (k: string) => (pool === "ai" ? k : `${pool}:${k}`);
    const read = (k: string) =>
      (JSON.parse(this.sql.exec<{ starts: string }>("SELECT starts FROM budgets WHERE owner = ?", key(k)).toArray()[0]?.starts ?? "[]") as number[])
        .filter((t) => now - t < HOUR)
        .sort((a, b) => a - b);
    const g = read("*");
    const u = owner ? read(owner) : [];
    const count = Math.max(0, Math.min(16, Math.round(Number(n) || 0)));
    const room = Math.min(global - g.length, owner ? perUser - u.length : Number.POSITIVE_INFINITY);
    const granted = Math.max(0, Math.min(count, room));
    const stamps = Array.from({ length: granted }, () => now);
    const g2 = [...g, ...stamps];
    const u2 = [...u, ...stamps];
    this.sql.exec("INSERT OR REPLACE INTO budgets (owner, starts) VALUES (?, ?)", key("*"), JSON.stringify(g2));
    if (owner) this.sql.exec("INSERT OR REPLACE INTO budgets (owner, starts) VALUES (?, ?)", key(owner), JSON.stringify(u2));
    const frees = [g2.length >= global ? g2[0] + HOUR : 0, owner && u2.length >= perUser ? u2[0] + HOUR : 0];
    const retryAt = Math.max(now + 1000, ...frees) + 1000;
    return { granted, retryAt };
  }
}

/** A display name or a passkey name: one line, at most 80 characters. */
function cleanName(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** The transports column (JSON) as a part of a credential descriptor. */
function transportsOf(raw: string | null): { transports?: string[] } {
  if (!raw) return {};
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) && list.length ? { transports: list.filter((t): t is string => typeof t === "string") } : {};
  } catch {
    return {};
  }
}

function normalizeRemote(url: string): string {
  return String(url ?? "").trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

/** Only same-site paths may follow a sign-in. */
/** GitHub's answer at https://github.com/login/oauth/access_token (code exchange and refresh). */
interface GithubTokenAnswer {
  access_token?: string;
  refresh_token?: string;
  /** Seconds. */
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

function githubUserToken(t: GithubTokenAnswer, now = Date.now()): GithubUserToken {
  return {
    access: t.access_token!,
    ...(t.refresh_token ? { refresh: t.refresh_token } : {}),
    ...(t.expires_in ? { expiresAt: now + t.expires_in * 1000 } : {}),
    ...(t.refresh_token_expires_in ? { refreshExpiresAt: now + t.refresh_token_expires_in * 1000 } : {}),
  };
}

function sameStringSafe(a: string, b: string): boolean {
  return typeof a === "string" && typeof b === "string" && sameString(a, b);
}

/**
 * A same-site path to come back to after a sign-in, else "/". Browsers drop tabs and line breaks from
 * URLs and read "\\" as "/", so "/<tab>/evil.example" would leave the site: such paths are refused, and
 * the result must resolve to this origin.
 */
export function safeReturn(to: string): string {
  const s = String(to ?? "/").slice(0, 500);
  if (!s.startsWith("/") || s.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(s)) return "/";
  try {
    const u = new URL(s, "https://gitring.invalid");
    const out = `${u.pathname}${u.search}${u.hash}`;
    // Dot segments can turn "/.//evil.example" into "//evil.example": check the result too.
    return u.origin === "https://gitring.invalid" && out.startsWith("/") && !out.startsWith("//") && !out.includes("\\") ? out : "/";
  } catch {
    return "/";
  }
}

