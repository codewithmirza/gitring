/**
 * The routes of the device grant (RFC 8628): a sign-in for programs that have no browser.
 *
 * Called by app.ts. The logic is in the Directory (src/directory/oauth-store/devices.ts).
 * The answer form is bound to the browser that showed it, and the Worker refuses cross-site posts.
 * Read next: src/directory/device.ts (the codes) and src/worker/oauth.ts (the token route).
 */
import type { Context, Hono } from "hono";
import type { Env } from "./env";
import { directory, esc, lastProvider, page, providerButtons, readCookie, type Principal } from "./auth";
import { consentAccess, CORS, formOf } from "./oauth";
import { basicAuth, SCOPE, type PendingDevice } from "../directory/oauth";
import { formatUserCode, normalizeUserCode, DEVICE_TTL_S } from "../directory/device";
import { randomToken, sameString } from "../directory/crypto";
import { clientAddress } from "./limits";

/*
 * The routes:
 *
 *   POST /oauth/device_authorization   a program (the gitring command line) asks for a sign-in: a device
 *                                      code for itself, and a user code for the person
 *   GET  /device[?code=…]              the person signs in, types the user code, and reads what the
 *                                      program asks for
 *   POST /device                       the person's answer: allow or cancel (same-origin form)
 *
 * The program then asks POST /oauth/token (src/worker/oauth.ts) until the person answers. The logic lives
 * in the Directory (src/directory/oauth.ts). The answer form is bound to the browser that showed it: a
 * short-lived cookie holds a random value that the form carries too, and the Worker refuses cross-site
 * posts of a browser session.
 */

type HonoEnv = { Bindings: Env; Variables: { principal: Principal } };
type C = Context<HonoEnv>;

const DEVICE_COOKIE = "__Host-gitring-device";
const CLEAR_DEVICE_COOKIE = `${DEVICE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
const TITLE = "Connect a device";

/** Why a sign-in on the way to /device did not finish (the sign-in routes add ?signin_error=). */
const SIGNIN_WORDS: Record<string, string> = {
  stopped: "You stopped the sign-in.",
  expired: "The sign-in took too long. Try again.",
  taken: "This account belongs to another gitring account.",
  failed: "The sign-in did not finish. Try again.",
};

/** What gitring's own command line can do. Its token works at /mcp and for its own commands (src/worker/cli.ts). */
export function cliAccess(scope: string): { label: string; can: string; cannot: string } {
  if (scope !== SCOPE) {
    const read = consentAccess(scope);
    return { ...read, cannot: "Change project settings or members, see your API keys, or act after you remove it (Account → Connected apps)." };
  }
  return {
    label: "Read and change",
    can:
      "List your projects, their tasks and your inbox. Make projects and tasks. Get read tokens to clone projects. " +
      "Send plans and write code to work copies. Run tests and ask gitring to merge the work. " +
      "It answers merge questions for you only when you allow answers outside the gitring app.",
    cannot: "Change project settings or members, see your API keys, or act after you remove it (Account → Connected apps).",
  };
}

/** "less than a minute ago", "1 minute ago", "4 minutes ago". */
function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? "less than a minute ago" : m === 1 ? "1 minute ago" : `${m} minutes ago`;
}

function whoText(user: NonNullable<Principal["user"]>): string {
  return user.identities.find((i) => i.login)?.login ?? user.email ?? user.name;
}

async function signInPage(c: C, code: string | null, error?: string): Promise<Response> {
  const providers = await directory(c.env)
    .providers()
    .catch(() => ({ github: null, google: null }));
  const back = code ? `/device?code=${formatUserCode(code)}` : "/device";
  const buttons = providerButtons({ github: Boolean(providers.github), google: Boolean(providers.google) }, back, lastProvider(c.req.raw));
  const note = error && SIGNIN_WORDS[error] ? `<p class="warn">${esc(SIGNIN_WORDS[error])}</p>` : "";
  return page(
    TITLE,
    `<h1>Connect a device to gitring</h1>
<p class="muted">Sign in to gitring. Then type the code that your device shows.</p>${note}
<div class="card">${providers.github || providers.google ? buttons : "<p>Sign-in is not set up on this server.</p>"}</div>`,
  );
}

function codeFormPage(user: NonNullable<Principal["user"]>, note?: string, status = 200): Response {
  return page(
    TITLE,
    `<h1>Connect a device to gitring</h1>
<p class="muted">You are signed in as ${esc(whoText(user))}. Type the code that your device shows.</p>${note ? `<p class="warn">${esc(note)}</p>` : ""}
<form method="get" action="/device" class="card">
<label for="code">Code</label>
<input id="code" name="code" required autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" placeholder="BCDF-GHJK">
<p><button type="submit">Continue</button></p>
</form>`,
    status,
  );
}

function confirmPage(user: NonNullable<Principal["user"]>, d: PendingDevice, now: number): Response {
  const nonce = randomToken(24);
  const access = cliAccess(d.scope);
  // Anyone can register an app with any name. Only gitring's own command line is a name that gitring checked.
  const heading = d.builtin ? `Allow the gitring command line to use gitring as ${esc(user.name)}?` : `Allow a device to use gitring as ${esc(user.name)}?`;
  const says = d.builtin ? "" : `<p>The app calls itself “${esc(d.clientName)}”${d.clientUri ? ` and says that it is from <code>${esc(d.clientUri)}</code>` : ""}. gitring did not check this.</p>`;
  const from = d.address && d.address !== "unknown" ? ` from the address <code>${esc(d.address)}</code>` : "";
  return page(
    TITLE,
    `<style>
button[value=allow]{animation:arm 1s step-end forwards;pointer-events:none}
@keyframes arm{to{pointer-events:auto}}
</style>
<h1>${heading}</h1>
<p class="muted">You are signed in as ${esc(whoText(user))}.</p>
<div class="card">
<h2>Check the code</h2>
<p>Your device must show the code <code>${esc(d.userCode)}</code>. The sign-in started ${ago(now - d.createdAt)}${from}.</p>${says}
<p class="warn">Allow it only when you started this sign-in yourself, on a computer that you trust. A person who sends you a code wants access to your account.</p>
</div>
<div class="card">
<h2>Access: ${access.label}</h2>
<h2>It can</h2>
<p>${access.can}</p>
<h2>It cannot</h2>
<p>${access.cannot}</p>
</div>
<form method="post" action="/device">
<input type="hidden" name="code" value="${esc(d.userCode)}">
<input type="hidden" name="confirm" value="${nonce}">
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny" class="btn secondary">Cancel</button>
</form>`,
    200,
    { "set-cookie": `${DEVICE_COOKIE}=${nonce}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DEVICE_TTL_S}` },
  );
}

function goneCodePage(): Response {
  return page(
    TITLE,
    `<h1>This code does not work any more</h1><p>The code expired, or somebody answered it already. Start the sign-in again on your device.</p><p><a class="btn secondary" href="/device">Type another code</a></p>`,
    400,
    { "set-cookie": CLEAR_DEVICE_COOKIE },
  );
}

function lockedPage(): Response {
  return page(TITLE, `<h1>Too many wrong codes</h1><p>Wait 10 minutes. Then type the code again.</p>`, 429, { "retry-after": "600" });
}

export function deviceRoutes(app: Hono<HonoEnv>): void {
  app.options("/oauth/device_authorization", () => new Response(null, { status: 204, headers: CORS }));

  app.post("/oauth/device_authorization", async (c) => {
    const form = await formOf(c);
    const res = await directory(c.env).oauthDeviceStart(form, basicAuth(c.req.header("authorization")), new URL(c.req.url).origin, clientAddress(c.req.raw));
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json", ...CORS, ...(res.headers ?? {}) } });
  });

  app.get("/device", async (c) => {
    const p = c.get("principal");
    const typed = c.req.query("code");
    const code = normalizeUserCode(typed);
    if (p.via !== "session" || !p.user) return signInPage(c, code, c.req.query("signin_error"));
    if (!typed) return codeFormPage(p.user);
    const found = await directory(c.env).oauthDevice(typed, p.user.id, clientAddress(c.req.raw));
    if (!found.ok) {
      if (found.reason === "locked") return lockedPage();
      return codeFormPage(p.user, code ? "This code does not work. It expired, or it is not the code of your device. Check it and type it again." : "A code has 8 letters, for example BCDF-GHJK.", 400);
    }
    return confirmPage(p.user, found.device, Date.now());
  });

  app.post("/device", async (c) => {
    const p = c.get("principal");
    const form = await formOf(c);
    if (p.via !== "session" || !p.user) return page(TITLE, `<h1>Sign in again</h1><p>Your sign-in to gitring ended. Type the code again after you sign in.</p><p><a class="btn" href="/device">Continue</a></p>`, 401);
    const bound = readCookie(c.req.raw, DEVICE_COOKIE) ?? "";
    if (!form.confirm || !sameString(bound, form.confirm)) {
      return page(TITLE, `<h1>Open this page in the same browser</h1><p>Type the code again on this page.</p><p><a class="btn" href="/device">Continue</a></p>`, 400);
    }
    const allow = form.decision === "allow";
    const d = await directory(c.env).oauthDeviceDecide(form.code ?? "", p.user.id, allow, clientAddress(c.req.raw));
    if (d === "locked") return lockedPage();
    if (!d) return goneCodePage();
    const name = d.builtin ? "The gitring command line" : `The app “${esc(d.clientName)}”`;
    return allow
      ? page(
          TITLE,
          `<h1>Your device is connected</h1><p>${name} can now use gitring as ${esc(p.user.name)}. Go back to your device.</p><p class="muted">To remove it, open Account → Connected apps in gitring.</p>`,
          200,
          { "set-cookie": CLEAR_DEVICE_COOKIE },
        )
      : page(TITLE, `<h1>You stopped the sign-in</h1><p>The device did not get access. You can close this page.</p>`, 200, { "set-cookie": CLEAR_DEVICE_COOKIE });
  });
}
