/**
 * What gitring may do in a GitHub repository: app tokens, a person's rights, and the webhook delivery log.
 *
 * A token of the GitHub App is kept until 5 minutes before it expires. A repository without the app is remembered for 5 minutes.
 */
import { githubAppJwt } from "../crypto";
import { GITHUB_HEADERS } from "../constants";
import type { GithubRepoAccess } from "../types";
import { githubUserToken } from "../helpers";
import { DirectoryGithubTokens } from "./github-tokens";

export abstract class DirectoryGithubRepos extends DirectoryGithubTokens {
  /** Installation tokens per repository (lowercase "owner/name"). */
  private readonly repoTokens = new Map<string, { token: string; expiresAt: number; permissions: Record<string, string> }>();

  /** Repositories without the app, for a few minutes (lowercase "owner/name"). */
  private readonly repoMisses = new Map<string, { until: number; answer: GithubRepoAccess }>();

  // ───── Access to a repository ─────

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

  // ───── What a person may do in a repository ─────

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

  // ───── Webhook deliveries ─────

  /** True the first time a webhook delivery id arrives (kept for a day). */
  async firstDelivery(id: string): Promise<boolean> {
    if (!id) return true;
    const now = Date.now();
    this.sql.exec("DELETE FROM deliveries WHERE at < ?", now - 24 * 3600_000);
    if (this.sql.exec("SELECT id FROM deliveries WHERE id = ?", id).toArray()[0]) return false;
    this.sql.exec("INSERT INTO deliveries (id, at) VALUES (?, ?)", id.slice(0, 100), now);
    return true;
  }

  /** Forget "not installed" answers (after someone installed the app or changed its repositories). */
  async forgetGithubMisses(): Promise<void> {
    this.repoMisses.clear();
  }
}
