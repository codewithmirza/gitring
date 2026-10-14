/**
 * Sign-in with GitHub or Google: the sign-in link, the code exchange, and finding or making the person.
 *
 * A sign-in link works once. A person who adds a sign-in to an account opens no new session.
 * Read next: src/worker/sign-in-routes.ts (the routes that call these methods).
 */
import type * as A from "../../core/accounts";
import { rand } from "../../harbor/ids";
import type { WaitlistState } from "../../core/waitlist";
import { randomToken, seal, sha256B64url } from "../crypto";
import { GITHUB_HEADERS, GITHUB_TOKEN_PURPOSE, SESSION_MS } from "../constants";
import type { GithubAppConfig, GithubTokenAnswer, GoogleConfig, Profile, ProvidersInfo } from "../types";
import { githubUserToken, safeReturn } from "../helpers";
import { DirectoryGithubRepos } from "./github-repos";

export abstract class DirectorySignIn extends DirectoryGithubRepos {
  // ───── Start and finish a sign-in ─────

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
  async meInfo(userId: string | null): Promise<{ providers: ProvidersInfo; github?: A.GithubConnection; waitlist?: WaitlistState }> {
    const providers = await this.providers();
    const waitlist = this.waitlistState(userId);
    // A person that the gate keeps out has no use for their GitHub connection: skip the lookup.
    return { providers, ...(waitlist ? { waitlist } : {}), ...(userId && (!waitlist || waitlist.allowed) ? { github: await this.githubConnection(userId) } : {}) };
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

  // ───── Profiles from the providers ─────

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

  // ───── The person of a profile ─────

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
}
