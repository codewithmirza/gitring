/**
 * Server pages: the page shell with its style and strict policy, and the pages of the GitHub App setup.
 *
 * A page has no script unless it names one by nonce. The policy is in pagePolicy.
 * Read next: src/worker/sign-in-page.ts (the sign-in buttons) and src/worker/setup-routes.ts.
 */
import { randomToken } from "../directory/crypto";

// ───── The page shell ─────

export interface PageOptions {
  /** Nonce of the page's inline script, if it has one (<script nonce="…">). */
  nonce?: string;
  /** Extra hosts that the page's script may call. */
  connect?: string[];
  /** Extra form targets, and the places a form's answer may redirect to (an OAuth client). */
  formAction?: string[];
}

/** A strict Content Security Policy for server pages: no scripts unless a page names one by nonce. */
function pagePolicy(o: PageOptions): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com https://*.googleusercontent.com",
    `form-action 'self'${o.formAction?.length ? ` ${o.formAction.join(" ")}` : ""}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    ...(o.nonce ? [`script-src 'nonce-${o.nonce}'`] : []),
    ...(o.connect?.length ? [`connect-src ${o.connect.join(" ")}`] : []),
  ].join("; ");
}

export function page(title: string, body: string, status = 200, extraHeaders: Record<string, string> = {}, opts: PageOptions = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · gitring</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark;--bg:#f8fbfd;--ink:#17202c;--muted:#5b6672;--line:#d5dde3;--card:#fff;--accent:#0e6f7a;--ok:#1d7a46;--warn:#9a5b00}
@media (prefers-color-scheme:dark){:root{--bg:#090f16;--ink:#e0e5e9;--muted:#98a4ae;--line:#24303b;--card:#0f1721;--accent:#5fb7c2;--ok:#5cc28a;--warn:#e0a64b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:0 0 8px}
p{margin:8px 0}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:16px 0}
.ok{color:var(--ok);font-weight:600}.warn{color:var(--warn);font-weight:600}
button,.btn{display:inline-block;font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none}
.btn.secondary{background:transparent;color:var(--accent)}label{display:block;font-weight:600;margin:12px 0 4px}
input{width:100%;font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
code{font-family:ui-monospace,monospace;font-size:14px;background:color-mix(in srgb,var(--line) 40%,transparent);padding:1px 5px;border-radius:4px;word-break:break-all}
ol{padding-left:20px}li{margin:4px 0}
.providers{display:flex;flex-direction:column;gap:10px;max-width:340px}
.provider{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;border:1px solid #747775;background:#fff;color:#1f1f1f;font:500 15px/20px system-ui,-apple-system,"Segoe UI",sans-serif;text-decoration:none}
.provider:hover{background:#f2f2f2}.provider:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.provider svg,.provider img{width:20px;height:20px;flex:none}.provider .last{margin-left:auto;font-size:12px;color:#5f6368}
@media (prefers-color-scheme:dark){.provider{background:#131314;border-color:#8e918f;color:#e3e3e3}.provider:hover{background:#1f1f20}.provider svg{fill:#fff}.provider .last{color:#9aa0a6}}
.provider svg.pk{fill:none;stroke:currentColor}summary.provider{list-style:none;cursor:pointer}summary.provider::-webkit-details-marker{display:none}
.pk-new form{padding:4px 2px 0}.or{display:flex;align-items:center;gap:10px;max-width:340px;color:var(--muted);font-size:13px;margin:14px 0}.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": pagePolicy(opts),
      "referrer-policy": "same-origin",
      ...extraHeaders,
    },
  });
}

export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// ───── Pages of the GitHub App setup ─────

export function appReadyPage(slug: string): Response {
  const safe = /^[a-z0-9-]{1,80}$/.test(slug) ? slug : "";
  return page(
    "GitHub App ready",
    `<h1>The GitHub App is ready</h1>${safe ? `<p class="ok">${esc(safe)}</p>` : ""}
<p>Next: sign in with GitHub as an owner, then install the app on the repositories that gitring may import.</p>
<p><a class="btn" href="/auth/github/start?return=%2Fsetup">Sign in with GitHub</a>${safe ? ` <a class="btn secondary" href="https://github.com/apps/${esc(safe)}/installations/new">Install on repositories</a>` : ""}</p>`,
  );
}

/**
 * GitHub limits unauthenticated API calls per address, and Workers share addresses. This page asks
 * GitHub for the app credentials from the owner's browser instead, then sends them to gitring, which
 * checks them with GitHub before it seals them.
 */
export function browserConversionPage(code: string, state: string): Response {
  const data = JSON.stringify({ code, state }).replace(/</g, "\\u003c");
  const nonce = randomToken(16);
  return page(
    "GitHub App",
    `<h1>Saving the GitHub App</h1><p id="msg" class="muted">Your browser gets the app credentials from GitHub. Keep this page open.</p>
<script nonce="${nonce}">
(async () => {
  const { code, state } = ${data};
  const msg = document.getElementById("msg");
  try {
    const gh = await fetch("https://api.github.com/app-manifests/" + encodeURIComponent(code) + "/conversions", { method: "POST", headers: { Accept: "application/vnd.github+json" } });
    if (!gh.ok) throw new Error("GitHub answered " + gh.status + ". Start again from the setup page.");
    const app = await gh.json();
    const res = await fetch("/setup/github/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, app }) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "gitring did not save the app.");
    location.replace("/setup/github/ready");
  } catch (e) {
    msg.className = "warn";
    msg.textContent = "The GitHub App was not saved. " + (e && e.message ? e.message : e);
  }
})();
</script>`,
    200,
    {},
    { nonce, connect: ["'self'", "https://api.github.com"] },
  );
}
