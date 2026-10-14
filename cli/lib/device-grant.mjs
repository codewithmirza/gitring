/**
 * Signs in with the OAuth device grant (RFC 8628): ask for a code, show it, and wait for the person.
 * Called by commands/login.mjs. Read next: src/directory/device.ts for the server side.
 * Never print a token here. Never open a page that is not a page of the server (see safePage).
 */
import { CLIENT_ID, DEVICE_GRANT, TOO_OLD } from "./constants.mjs";
import { CliError } from "./errors.mjs";
import { errorText, isMissingRoute, postForm } from "./http.mjs";
import { remember, tokensOf } from "./credentials.mjs";

/** A page of the server with only plain URL characters: safe to give to the browser of the system (no shell words). */
export function safePage(url, origin) {
  try {
    return new URL(url).origin === origin && /^[A-Za-z0-9\-._~:/?=%#]+$/.test(url);
  } catch {
    return false;
  }
}

/** Ask the server for a device code. Answers the answer of the server: the codes, the page and the times. */
export async function requestDeviceCode(ctx, origin) {
  const start = await postForm(ctx, `${origin}/oauth/device_authorization`, { client_id: CLIENT_ID, scope: "mcp", resource: `${origin}/mcp` });
  if (isMissingRoute(start)) throw new CliError(TOO_OLD);
  if (start.status !== 200 || !start.json?.device_code) throw new CliError(`gitring did not start the sign-in. ${errorText(start)}`);
  return start.json;
}

/** Show the page and the code to the person. With --open, open the page when it is a page of the server. */
export function showDevicePrompt(ctx, origin, d) {
  const page = d.verification_uri_complete ?? d.verification_uri;
  ctx.out("Open this page in a browser, and sign in to gitring:");
  ctx.out(`  ${page}`);
  ctx.out(`Check that the page shows this code: ${d.user_code}`);
  ctx.out(`The code works for ${Math.max(1, Math.round(Number(d.expires_in ?? 600) / 60))} minutes. The command line waits for your answer.`);
  if (ctx.flags.open) {
    if (safePage(page, origin)) ctx.openUrl(page);
    else ctx.out("The command line did not open the page: it is not a page of your gitring. Check the address.");
  }
}

/** Ask the server again and again until the person allows the code. Then store the sign-in. */
export async function waitForDeviceToken(ctx, origin, d) {
  let interval = Math.max(1, Number(d.interval) || 5);
  const deadline = ctx.now() + Number(d.expires_in ?? 600) * 1000;
  let faults = 0;
  for (;;) {
    await ctx.sleep(interval * 1000);
    if (ctx.now() > deadline) throw new CliError("The code expired. Run gitring login again.");
    let res;
    try {
      res = await postForm(ctx, `${origin}/oauth/token`, { grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: CLIENT_ID });
    } catch (e) {
      // A short network fault: ask again. Many faults in a row stop the sign-in.
      if (++faults >= 5) throw e;
      continue;
    }
    if (res.status === 200 && res.json?.access_token) {
      remember(ctx, origin, { clientId: CLIENT_ID, ...tokensOf(ctx, res.json) }, true);
      break;
    }
    const code = res.json?.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval += 5;
      continue;
    }
    if (code === "access_denied") throw new CliError("You stopped the sign-in in the browser. The command line got no access.");
    if (code === "expired_token") throw new CliError("The code expired. Run gitring login again.");
    if ((res.status >= 500 || res.status === 429) && ++faults < 5) continue;
    throw new CliError(`gitring refused the sign-in. ${errorText(res)}`);
  }
}
