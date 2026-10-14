/**
 * The GitHub user token of a person: stored sealed, refreshed on time, revoked on disconnect.
 *
 * GitHub refresh tokens work once. Calls for one GitHub account run one at a time (githubRefreshes).
 * Never log a token.
 */
import type * as A from "../../core/accounts";
import { seal, unseal } from "../crypto";
import { GITHUB_HEADERS, GITHUB_REFRESH_EARLY_MS, GITHUB_TOKEN_PURPOSE } from "../constants";
import type { GithubAppConfig, GithubTokenAnswer, GithubUserToken, GithubUserTokenResult } from "../types";
import { githubUserToken, sameStringSafe } from "../helpers";
import { DirectoryGithubApp } from "./github-app";

export abstract class DirectoryGithubTokens extends DirectoryGithubApp {
  /** GitHub token calls per GitHub account run one at a time: refresh tokens are single-use. */
  private readonly githubRefreshes = new Map<string, Promise<GithubUserTokenResult>>();

  // ───── The GitHub sign-in of a person ─────

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

  // ───── A valid user token ─────

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

  // ───── Disconnect GitHub ─────

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
}
