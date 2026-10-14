/**
 * The sign-in choices of a server page: passkey buttons with their script, and the provider buttons.
 *
 * The script is static: nothing from the request goes into it. The passkey buttons need the nonce of the page.
 * Read next: src/worker/passkey-routes.ts (the routes that the script calls).
 */
import type * as A from "../core/accounts";
import { safeReturn } from "../directory/directory";
import { LAST_PROVIDER_COOKIE, readCookie } from "./auth-kit";
import { esc } from "./pages";

/*
 * GitHub mark ("mark-github", 16 px) from @primer/octicons (MIT, Copyright GitHub Inc.), unchanged.
 * Rules: https://github.com/logos (no changes to shape, proportions or color).
 */
const GITHUB_MARK =
  "M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656";

/**
 * "Continue with GitHub" and "Continue with Google" for server pages, with the providers' own marks
 * (the Google "G" from Google's sign-in assets is /brand/google-g.svg). The provider used last comes first.
 */
export function providerButtons(providers: { github: boolean; google: boolean }, returnPath: string, last?: string | null): string {
  const back = encodeURIComponent(returnPath);
  const items = [
    providers.github
      ? { id: "github", html: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${GITHUB_MARK}"/></svg><span>Continue with GitHub</span>` }
      : null,
    providers.google ? { id: "google", html: `<img src="/brand/google-g.svg" alt="" width="20" height="20"><span>Continue with Google</span>` } : null,
  ].filter((x): x is { id: string; html: string } => Boolean(x));
  items.sort((a, b) => Number(b.id === last) - Number(a.id === last));
  return `<div class="providers">${items
    .map((x) => `<a class="provider" href="/auth/${x.id}/start?return=${back}">${x.html}${x.id === last && items.length > 1 ? '<span class="last">Last used</span>' : ""}</a>`)
    .join("")}</div>`;
}

export function lastProvider(req: Request): A.SignInKind | null {
  const v = readCookie(req, LAST_PROVIDER_COOKIE);
  return v === "github" || v === "google" || v === "passkey" ? v : null;
}

/** A key (passkeys), drawn for gitring. */
const PASSKEY_ICON = `<svg class="pk" viewBox="0 0 24 24" aria-hidden="true" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8 20 3M16.5 6.5l3 3M14 9l2.5 2.5"/></svg>`;

/**
 * The script of the passkey buttons on server pages. It asks /auth/passkey/* for options, calls the
 * browser's WebAuthn API, sends the answer, then opens the path in data-back (signed in). It is static:
 * nothing from the request goes into it.
 */
const PASSKEY_PAGE_JS = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const msg = $("pk-msg");
  const say = (t) => { msg.textContent = t; msg.hidden = !t; };
  if (!window.PublicKeyCredential || !navigator.credentials) {
    for (const el of $("pk").querySelectorAll("button, input")) el.disabled = true;
    say("This browser cannot use passkeys. Use another browser or another sign-in.");
    return;
  }
  const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
  const text = (b) => { let s = ""; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const ids = (list) => (list || []).map((d) => Object.assign({}, d, { id: bytes(d.id) }));
  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || "gitring did not answer. Try again.");
    return out;
  }
  async function run(button, task) {
    say("");
    button.disabled = true;
    try {
      await task();
      location.assign($("pk").dataset.back || "/");
    } catch (e) {
      button.disabled = false;
      say(e && (e.name === "NotAllowedError" || e.name === "AbortError") ? "You stopped the passkey. gitring made no change." : (e && e.message) || String(e));
    }
  }
  $("pk-in").addEventListener("click", (ev) => run(ev.currentTarget, async () => {
    const o = (await post("/auth/passkey/login/options")).options;
    const c = await navigator.credentials.get({ publicKey: Object.assign({}, o, { challenge: bytes(o.challenge), allowCredentials: ids(o.allowCredentials) }) });
    const r = c.response;
    await post("/auth/passkey/login/verify", { credential: { id: c.id, rawId: text(c.rawId), type: c.type, response: { clientDataJSON: text(r.clientDataJSON), authenticatorData: text(r.authenticatorData), signature: text(r.signature), userHandle: r.userHandle ? text(r.userHandle) : null } } });
  }));
  $("pk-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    run(ev.submitter || $("pk-form").querySelector("button"), async () => {
      const o = (await post("/auth/passkey/register/options", { name: $("pk-name").value })).options;
      const c = await navigator.credentials.create({ publicKey: Object.assign({}, o, { challenge: bytes(o.challenge), user: Object.assign({}, o.user, { id: bytes(o.user.id) }), excludeCredentials: ids(o.excludeCredentials) }) });
      const r = c.response;
      await post("/auth/passkey/register/verify", { credential: { id: c.id, rawId: text(c.rawId), type: c.type, response: { clientDataJSON: text(r.clientDataJSON), attestationObject: text(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } } });
    });
  });
})();
`;

/**
 * The sign-in choices of a server page (connect an app): passkeys first, then the providers that this
 * gitring has, the provider used last first. The passkey buttons need the page's script nonce. After a
 * passkey sign-in the browser opens `returnPath` (a path on this site).
 */
export function signInChoices(providers: { github: boolean; google: boolean }, returnPath: string, last: A.SignInKind | null, nonce: string): string {
  const others = providers.github || providers.google ? `<p class="or">or</p>${providerButtons(providers, returnPath, last === "passkey" ? null : last)}` : "";
  const tag = last === "passkey" && others ? '<span class="last">Last used</span>' : "";
  const back = safeReturn(returnPath);
  return `<div id="pk" class="providers" data-back="${esc(back)}">
<button type="button" class="provider" id="pk-in">${PASSKEY_ICON}<span>Sign in with a passkey</span>${tag}</button>
<details class="pk-new"><summary class="provider">${PASSKEY_ICON}<span>Create an account with a passkey</span></summary>
<form id="pk-form"><label for="pk-name">Your name</label><input id="pk-name" name="name" required maxlength="80" autocomplete="name">
<p class="muted">Your device keeps the passkey. gitring keeps only its public key.</p><p><button type="submit">Create the account</button></p></form></details>
<p id="pk-msg" class="warn" role="alert" hidden></p></div>${others}
<script nonce="${nonce}">${PASSKEY_PAGE_JS}</script>`;
}
