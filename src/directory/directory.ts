/**
 * Directory — one Durable Object for the whole deployment: who people are, which projects exist,
 * who may do what, and the sealed credentials of the sign-in providers.
 *
 *   users + identities   one person, one or more sign-ins (GitHub, Google)
 *   sessions             browser sessions (only a SHA-256 of the cookie token is stored)
 *   api_keys             personal keys for MCP clients, hooks and scripts (only a hash is stored)
 *   projects + members   project registry and roles (owner, member, viewer); invites by login or email
 *   config               sealed (AES-GCM) provider credentials: the GitHub App and the Google client
 *   budgets              rolling one-hour windows of built-in AI agent starts (per user and global)
 *
 * The HarborMaster of each project holds the project's state; the Directory only knows that it exists.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../worker/env";
import type * as A from "../core/accounts";
import { PROJECT_ID } from "../core/accounts";
import type { ProjectSource } from "../core/types";
import { rand } from "../harbor/ids";
import { githubAppJwt, randomToken, seal, sha256B64url, unseal } from "./crypto";

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
];

const SESSION_MS = 30 * 24 * 3600_000;
const STATE_MS = 15 * 60_000;
const MAX_PROJECTS_PER_USER = 20;
const MAX_KEYS_PER_USER = 20;
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
  webhook_secret: string;
  pem: string;
  html_url: string;
  owner?: { login?: string };
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export interface ProvidersInfo {
  github: { slug: string; appId: number; htmlUrl: string; installUrl: string } | null;
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
  | { kind: "signin"; provider: A.Provider; origin: string; returnTo: string; verifier?: string; nonce?: string };

/** A profile from a provider, after the code exchange. */
interface Profile {
  provider: A.Provider;
  subject: string;
  name: string;
  login?: string;
  email?: string;
  emailVerified?: boolean;
  avatar?: string;
  /** Sealed provider token (GitHub user-to-server token for repo listing later). */
  token?: string;
}

export class Directory extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const s of SCHEMA) this.sql.exec(s);
    // The public sample project of the deployment (owned by the deployment, not by a person).
    this.sql.exec(
      "INSERT OR IGNORE INTO projects (id, name, owner_id, visibility, source, created_at) VALUES ('demo', 'Saltmarsh Books (sample)', NULL, 'public', ?, ?)",
      JSON.stringify({ kind: "sample" }),
      Date.now(),
    );
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
      github: gh ? { slug: gh.slug, appId: gh.id, htmlUrl: gh.htmlUrl, installUrl: `https://github.com/apps/${gh.slug}/installations/new` } : null,
      google: gg ? { clientId: gg.clientId } : null,
    };
  }

  /** Worker-only: the GitHub App credentials (webhook verification, installation tokens). */
  async githubApp(): Promise<GithubAppConfig | null> {
    return (await this.getSealed<GithubAppConfig>("github_app")) ?? null;
  }

  async setGoogle(cfg: GoogleConfig): Promise<void> {
    const clientId = String(cfg.clientId ?? "").trim();
    const clientSecret = String(cfg.clientSecret ?? "").trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error("The client ID must end with .apps.googleusercontent.com.");
    if (clientSecret.length < 10) throw new Error("Give the client secret.");
    await this.putSealed("google", { clientId, clientSecret });
  }

  /* ════════════════════ one-time states (OAuth, manifest) ════════════════════ */

  private putState(data: StateData): string {
    const state = randomToken(24);
    const now = Date.now();
    this.sql.exec("DELETE FROM states WHERE expires_at < ?", now);
    this.sql.exec("INSERT INTO states (state, data, expires_at) VALUES (?, ?, ?)", state, JSON.stringify(data), now + STATE_MS);
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
    const manifest = {
      // GitHub reserves app names with "gitring" in them (an account has that login), so the app is "git-ring".
      name: `git-ring ${tag}`.slice(0, 34),
      url: origin,
      hook_attributes: { url: `${origin}/hooks/github-app`, active: true },
      redirect_url: `${origin}/setup/github/callback`,
      callback_urls: [`${origin}/auth/github/callback`],
      setup_url: `${origin}/setup/github/installed`,
      setup_on_update: true,
      description: "gitring: many coding agents change one codebase at the same time. Sign in, import repositories, mirror landings.",
      public: true,
      default_permissions: { contents: "write", issues: "read", metadata: "read" },
      default_events: ["issues", "push"],
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
    if (!app || typeof app.id !== "number" || !app.slug || !app.client_id || !app.client_secret || !app.pem || !app.webhook_secret) {
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
      webhookSecret: j.webhook_secret,
      pem: j.pem,
      htmlUrl: j.html_url,
      owner: j.owner?.login,
    } satisfies GithubAppConfig);
    return { slug: j.slug, htmlUrl: j.html_url };
  }

  /* ════════════════════ sign-in ════════════════════ */

  async signInUrl(provider: A.Provider, origin: string, returnTo: string): Promise<string> {
    const back = safeReturn(returnTo);
    if (provider === "github") {
      const gh = await this.getSealed<GithubAppConfig>("github_app");
      if (!gh) throw new Error("GitHub sign-in is not set up on this gitring yet.");
      const state = this.putState({ kind: "signin", provider, origin, returnTo: back });
      const q = new URLSearchParams({ client_id: gh.clientId, redirect_uri: `${origin}/auth/github/callback`, state, allow_signup: "true" });
      return `https://github.com/login/oauth/authorize?${q}`;
    }
    const gg = await this.getSealed<GoogleConfig>("google");
    if (!gg) throw new Error("Google sign-in is not set up on this gitring yet.");
    const verifier = randomToken(48);
    const nonce = randomToken(16);
    const state = this.putState({ kind: "signin", provider, origin, returnTo: back, verifier, nonce });
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

  /** Finish a sign-in: exchange the code, upsert the person, open a session. */
  async finishSignIn(provider: A.Provider, code: string, state: string): Promise<{ token: string; returnTo: string; user: A.UserInfo }> {
    const st = this.takeState(state);
    if (st.kind !== "signin" || st.provider !== provider) throw new Error("This sign-in link does not match. Start again.");
    const profile = provider === "github" ? await this.githubProfile(code, st.origin) : await this.googleProfile(code, st.origin, st.verifier ?? "");
    const userId = await this.upsert(profile);
    const token = randomToken(32);
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", now);
    this.sql.exec("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", await sha256B64url(token), userId, now, now + SESSION_MS);
    return { token, returnTo: st.returnTo, user: this.userInfo(userId)! };
  }

  private async githubProfile(code: string, origin: string): Promise<Profile> {
    const gh = await this.getSealed<GithubAppConfig>("github_app");
    if (!gh) throw new Error("GitHub sign-in is not set up.");
    const tok = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "gitring" },
      body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code, redirect_uri: `${origin}/auth/github/callback` }),
    });
    const t = await tok.json<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }>();
    if (!t.access_token) throw new Error(`GitHub refused the sign-in: ${t.error_description ?? t.error ?? tok.status}.`);
    const res = await fetch("https://api.github.com/user", { headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${t.access_token}` } });
    if (!res.ok) throw new Error(`GitHub did not return the profile (status ${res.status}).`);
    const u = await res.json<{ id: number; login: string; name?: string | null; email?: string | null; avatar_url?: string }>();
    const sealed = await seal(this.secret(), { access: t.access_token, refresh: t.refresh_token, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined }, "token-v1");
    return { provider: "github", subject: String(u.id), name: u.name || u.login, login: u.login, email: u.email ?? undefined, avatar: u.avatar_url, token: sealed };
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

  /** Find or create the person for a provider profile; link by a verified email when possible. */
  private async upsert(p: Profile): Promise<string> {
    const now = Date.now();
    const known = this.sql.exec<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = ? AND subject = ?", p.provider, p.subject).toArray()[0];
    let userId = known?.user_id;
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
    this.sql.exec(
      "INSERT INTO identities (provider, subject, user_id, login, email, token) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (provider, subject) DO UPDATE SET login = excluded.login, email = excluded.email, token = COALESCE(excluded.token, identities.token)",
      p.provider,
      p.subject,
      userId,
      p.login ?? null,
      p.email ?? null,
      p.token ?? null,
    );
    // Invites by login or email become memberships.
    const handles = [p.login && `github:${p.login.toLowerCase()}`, p.email && `email:${p.email.toLowerCase()}`].filter(Boolean) as string[];
    for (const h of handles) this.sql.exec("UPDATE members SET user_id = ? WHERE handle = ? AND user_id IS NULL", userId, h);
    return userId;
  }

  /* ════════════════════ people ════════════════════ */

  private owners(): string[] {
    return (this.env.GITRING_OWNERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  private isAdmin(userId: string): boolean {
    const owners = this.owners();
    if (!owners.length) return false;
    for (const i of this.sql.exec<{ provider: string; login: string | null; email: string | null }>("SELECT provider, login, email FROM identities WHERE user_id = ?", userId)) {
      if (i.login && owners.includes(`${i.provider}:${i.login.toLowerCase()}`)) return true;
      if (i.email && (owners.includes(`${i.provider}:${i.email.toLowerCase()}`) || owners.includes(i.email.toLowerCase()))) return true;
    }
    return false;
  }

  private userInfo(userId: string): A.UserInfo | null {
    const u = this.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", userId).toArray()[0];
    if (!u) return null;
    const identities = this.sql
      .exec<{ provider: A.Provider; login: string | null; email: string | null }>("SELECT provider, login, email FROM identities WHERE user_id = ?", userId)
      .toArray()
      .map((i) => ({ provider: i.provider, login: i.login ?? undefined, email: i.email ?? undefined }));
    return { id: u.id, name: u.name, email: u.email ?? undefined, avatar: u.avatar ?? undefined, identities, admin: this.isAdmin(u.id) };
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
   * Projects imported from a GitHub repository in which a GitHub login may open intents (member or
   * owner, also as a pending invite). An issue event from an installed repository only reaches these.
   */
  async projectsForGithubLogin(url: string, login: string): Promise<string[]> {
    const want = normalizeRemote(url);
    const l = String(login ?? "").toLowerCase();
    if (!l) return [];
    const userId = this.sql.exec<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = 'github' AND lower(login) = ?", l).toArray()[0]?.user_id ?? null;
    const out: string[] = [];
    for (const row of this.sql.exec<ProjectRow>("SELECT * FROM projects WHERE archived = 0").toArray()) {
      const s = JSON.parse(row.source) as ProjectSource;
      if (s.kind !== "git" || normalizeRemote(s.url) !== want) continue;
      const role = userId ? this.roleIn(row, userId) : null;
      const invited = this.sql.exec<{ role: A.Role }>("SELECT role FROM members WHERE project_id = ? AND handle = ?", row.id, `github:${l}`).toArray()[0]?.role ?? null;
      if ((role === "owner" || role === "member") || invited === "owner" || invited === "member") out.push(row.id);
    }
    return out;
  }

  async listProjects(userId: string | null): Promise<A.ProjectInfo[]> {
    const rows = this.sql.exec<ProjectRow>("SELECT * FROM projects WHERE archived = 0 ORDER BY created_at DESC").toArray();
    return rows.map((r) => this.info(r, userId)).filter((p) => p.role !== null);
  }

  /** Make a project. ownerId null: the operator key made it, and no person owns it (deployment owners act on it). */
  async createProject(input: { name: string; visibility?: A.Visibility; source: ProjectSource; ownerId: string | null }): Promise<A.ProjectInfo> {
    const owner = input.ownerId === null ? null : this.userInfo(input.ownerId);
    if (input.ownerId !== null && !owner) throw new Error("Sign in first.");
    const name = String(input.name ?? "").trim().slice(0, 80);
    if (!name) throw new Error("Give the project a name.");
    if (owner && !owner.admin) {
      const n = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM projects WHERE owner_id = ? AND archived = 0", owner.id).one().n;
      if (n >= MAX_PROJECTS_PER_USER) throw new Error(`You have ${MAX_PROJECTS_PER_USER} projects. Archive one first.`);
    }
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "project";
    let id = `${base}-${rand(4)}`;
    while (this.projectRow(id)) id = `${base}-${rand(4)}`;
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
    this.sql.exec("DELETE FROM projects WHERE id = ? AND id != 'demo'", id);
  }

  async archiveProject(id: string): Promise<void> {
    if (id === "demo") throw new Error("The public sample cannot be archived.");
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

  /** Invite by GitHub login (no @) or email. The person gets the role at their next sign-in. */
  async addMember(id: string, who: string, role: A.Role): Promise<A.MemberInfo[]> {
    if (!this.projectRow(id)) throw new Error("Unknown project.");
    if (!["owner", "member", "viewer"].includes(role)) throw new Error("Use the role owner, member or viewer.");
    const raw = String(who ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!raw) throw new Error("Give a GitHub login or an email.");
    const handle = raw.includes("@") ? `email:${raw}` : `github:${raw}`;
    if (!/^(email:[^\s@]+@[^\s@]+\.[^\s@]+|github:[a-z0-9-]{1,39})$/.test(handle)) throw new Error("This is not a GitHub login or an email.");
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

function normalizeRemote(url: string): string {
  return String(url ?? "").trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

/** Only same-site paths may follow a sign-in. */
function safeReturn(to: string): string {
  const s = String(to ?? "/");
  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") ? s.slice(0, 500) : "/";
}

