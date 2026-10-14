/**
 * The owner's setup page, and the privacy and terms pages.
 *
 * Setup is open to owners of the deployment, or with the setup token. A GitHub App link never names the app: the slug comes from the saved setup.
 * Read next: src/directory/layers/github-app.ts (what the setup saves).
 */
import type { Hono } from "hono";
import type { ManifestConversion } from "../directory/directory";
import { sameString } from "../directory/crypto";
import { privacyBody, termsBody } from "./legal";
import { origin } from "./auth-kit";
import { directory } from "./principal";
import { appReadyPage, browserConversionPage, esc, page } from "./pages";
import type { C, HonoEnv } from "./http";

function setupAllowed(c: C, token?: string | null): boolean {
  const p = c.get("principal");
  if (p.user?.admin) return true;
  const want = c.env.GITRING_SETUP_TOKEN;
  return Boolean(want && token && sameString(String(token), want));
}

async function setupPage(c: C, token: string | null, note?: string): Promise<Response> {
  const dir = directory(c.env);
  const providers = await dir.providers();
  const o = origin(c);
  const owners = (c.env.GITRING_OWNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const tokenField = token ? `<input type="hidden" name="token" value="${esc(token)}">` : "";
  let gh: string;
  if (providers.github) {
    gh = `<p class="ok">Connected: ${esc(providers.github.slug)}</p>
<p>People sign in with GitHub through this app. Install it on a repository to open tasks from its issues and to send merged code to it (Settings → GitHub in a project).</p>
<p><a class="btn" href="${esc(providers.github.installUrl)}">Install on repositories</a> <a class="btn secondary" href="${esc(providers.github.htmlUrl)}">App settings</a></p>`;
  } else {
    const m = await dir.githubManifest(o);
    gh = `<p class="warn">Not set up.</p>
<p>One click creates a GitHub App for this gitring with the right callback URLs, webhook and permissions (contents write, issues read, metadata read). GitHub shows it to you before it creates it.</p>
<form method="post" action="${esc(m.postUrl)}"><input type="hidden" name="manifest" value="${esc(m.manifest)}"><button type="submit">Create the gitring GitHub App</button></form>`;
  }
  const gg = providers.google
    ? `<p class="ok">Connected: <code>${esc(providers.google.clientId)}</code></p><p class="muted">Paste a new client below to replace it.</p>`
    : `<p class="warn">Not set up.</p>`;
  return page(
    "Set up gitring",
    `<h1>Set up gitring</h1><p class="muted">${esc(o)}</p>${note ? `<div class="card"><p>${note}</p></div>` : ""}
<div class="card"><h2>1. Passkeys</h2><p class="ok">Ready. Passkeys need no setup.</p>
<p>People create an account with a passkey on their device: a fingerprint, a face, a PIN or a security key. gitring keeps only the public key of each passkey.</p></div>
<div class="card"><h2>2. Owners</h2>${
      owners.length
        ? `<p>These people own this gitring (they may open this page after they sign in):</p><ul>${owners.map((x) => `<li><code>${esc(x)}</code></li>`).join("")}</ul>`
        : `<p class="warn">No owner is set.</p><p>Set the secret GITRING_OWNERS, for example <code>user:u_0123456789</code>. Each person finds their account id on the Account page. You can also use <code>google:you@example.com</code> or <code>github:your-login</code>.</p>`
    }
<p><a class="btn" href="/">Open gitring</a></p></div>
<div class="card"><h2>3. Optional: sign in with Google</h2>${gg}
<ol><li>Open <a href="https://console.cloud.google.com/apis/credentials">Google Cloud console → Credentials</a>. Create an <b>OAuth client ID</b> of type <b>Web application</b>.</li>
<li>Authorized JavaScript origin: <code>${esc(o)}</code></li>
<li>Authorized redirect URI: <code>${esc(o)}/auth/google/callback</code></li>
<li>Paste the client ID and the client secret here. gitring seals them; nobody can read them back.</li></ol>
<form method="post" action="/setup/google">${tokenField}<label for="cid">Client ID</label><input id="cid" name="clientId" required autocomplete="off" placeholder="…apps.googleusercontent.com">
<label for="cs">Client secret</label><input id="cs" name="clientSecret" required autocomplete="off" type="password"><p><button type="submit">Save Google sign-in</button></p></form></div>
<div class="card"><h2>4. Optional: GitHub (sign-in, imports and sync)</h2>${gh}</div>`,
    200,
    {},
    { formAction: ["https://github.com"] },
  );
}

export function setupRoutes(app: Hono<HonoEnv>): void {
  legalRoutes(app);
  ownerSetupRoutes(app);
  githubAppSetupRoutes(app);
}

/** The privacy and terms pages. */
function legalRoutes(app: Hono<HonoEnv>): void {
  // Privacy policy and terms (the Google consent screen links to them).
  const contact = (c: C): string | null => {
    const v = (c.env.GITRING_CONTACT ?? "").trim();
    if (!v) return null;
    return /^[^\s@<>"']+@[^\s@<>"']+$/.test(v) ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v);
  };
  app.get("/privacy", (c) => page("Privacy", privacyBody(contact(c))));
  app.get("/terms", (c) => page("Terms", termsBody(contact(c))));
}

/** The setup page and the Google sign-in settings. */
function ownerSetupRoutes(app: Hono<HonoEnv>): void {
  app.get("/setup", async (c) => {
    const token = c.req.query("token") ?? null;
    if (!setupAllowed(c, token)) return page("Setup", `<h1>Setup is closed</h1><p>Open the setup link with its token, or sign in as an owner of this gitring.</p><p><a class="btn" href="/">Open gitring</a></p>`, 403);
    return setupPage(c, token);
  });

  app.post("/setup/google", async (c) => {
    const form = await c.req.parseBody();
    const token = typeof form.token === "string" ? form.token : null;
    if (!setupAllowed(c, token)) return page("Setup", `<h1>Setup is closed</h1>`, 403);
    try {
      await directory(c.env).setGoogle({ clientId: String(form.clientId ?? ""), clientSecret: String(form.clientSecret ?? "") });
      return setupPage(c, token, "Google sign-in is ready.");
    } catch (e) {
      return setupPage(c, token, esc((e as Error).message));
    }
  });
}

/** The GitHub App setup: the callback, save, ready and installed pages. */
function githubAppSetupRoutes(app: Hono<HonoEnv>): void {
  app.get("/setup/github/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return page("GitHub App", `<h1>GitHub did not send a code</h1><p>Start again from the setup page.</p>`, 400);
    try {
      const res = await directory(c.env).githubManifestDone(code, state);
      if ("browser" in res) return browserConversionPage(code, state);
      return appReadyPage(res.slug);
    } catch (e) {
      return page("GitHub App", `<h1>The GitHub App was not saved</h1><p>${esc((e as Error).message)}</p>`, 400);
    }
  });

  /** The owner's browser converted the manifest code (GitHub refused the Worker's call). */
  app.post("/setup/github/save", async (c) => {
    const body = await c.req.json<{ state?: string; app?: ManifestConversion }>().catch(() => ({}) as { state?: string; app?: ManifestConversion });
    try {
      const saved = await directory(c.env).githubAppSave(String(body.state ?? ""), body.app as ManifestConversion);
      return c.json(saved);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // The app's slug comes from the saved setup, never from the link: a link with another slug would send
  // the owner to install someone else's app.
  app.get("/setup/github/ready", async (c) => {
    const providers = await directory(c.env)
      .providers()
      .catch(() => ({ github: null }));
    return appReadyPage(providers.github?.slug ?? "");
  });

  // The GitHub App's setup URL: GitHub sends people here after they install the app or change its
  // repositories. The installation_id in the URL is not trusted; the app reloads the list with the
  // person's own token.
  app.get("/setup/github/installed", async (c) => {
    await directory(c.env).forgetGithubMisses().catch(() => undefined);
    return c.redirect("/projects?github=installed", 302);
  });
}
