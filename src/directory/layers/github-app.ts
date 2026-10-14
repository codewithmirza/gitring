/**
 * The sign-in providers: the GitHub App (made from a manifest) and the Google client, sealed in the config.
 *
 * The webhook secret and the private key never leave this object except to verify and to sign.
 * Read next: src/worker/auth.ts (the setup page that calls these methods).
 */
import { githubAppJwt, seal } from "../crypto";
import { GITHUB_HEADERS } from "../constants";
import type { GithubAppConfig, GoogleConfig, ManifestConversion, ProvidersInfo } from "../types";
import { DirectoryPrefsPush } from "./prefs-push";

export abstract class DirectoryGithubApp extends DirectoryPrefsPush {
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

  async setGoogle(cfg: GoogleConfig): Promise<void> {
    const clientId = String(cfg.clientId ?? "").trim();
    const clientSecret = String(cfg.clientSecret ?? "").trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error("The client ID must end with .apps.googleusercontent.com.");
    if (clientSecret.length < 10) throw new Error("Give the client secret.");
    await this.putSealed("google", { clientId, clientSecret });
  }

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
      description: "gitring: many agents change one codebase at the same time. Sign in, open tasks from issues, send merged code to GitHub.",
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
}
