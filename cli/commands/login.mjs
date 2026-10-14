/**
 * The commands login and logout: sign in with a code in the browser, and sign out on this computer.
 * Called through commands/index.mjs. Read next: lib/device-grant.mjs for the sign-in itself.
 * Never print a token. Logout must always forget the sign-in here, even when the server does not answer.
 */
import { CLIENT_ID } from "../lib/constants.mjs";
import { serverOrigin } from "../lib/config.mjs";
import { CliError } from "../lib/errors.mjs";
import { postForm } from "../lib/http.mjs";
import { forget, readCredentials, remember } from "../lib/credentials.mjs";
import { requestDeviceCode, showDevicePrompt, waitForDeviceToken } from "../lib/device-grant.mjs";
import { okJson, rest } from "../lib/rest.mjs";

// ───── login ─────

/** gitring login: ask for a code, wait until the person allows it in the browser, store the sign-in. */
export async function login(ctx) {
  const creds = readCredentials(ctx.configDir);
  const raw = ctx.flags.server ?? ctx.env.GITRING_URL ?? creds.current;
  if (!raw) throw new CliError("Give the address of your gitring: gitring login --server https://your-gitring.example.com", 2);
  const origin = serverOrigin(raw);
  const d = await requestDeviceCode(ctx, origin);
  showDevicePrompt(ctx, origin, d);
  await waitForDeviceToken(ctx, origin, d);
  const s = { origin, kind: "oauth" };
  const me = okJson(s, await rest(ctx, s, "GET", "/api/me"));
  const name = me?.user?.name ?? "you";
  const entry = readCredentials(ctx.configDir).servers[origin];
  remember(ctx, origin, { ...entry, user: name }, true);
  ctx.out(`You are signed in to ${origin} as ${name}.`);
  return 0;
}

// ───── logout ─────

/** gitring logout: end the sign-in on the server (RFC 7009) and forget it on this computer. */
export async function logout(ctx) {
  const creds = readCredentials(ctx.configDir);
  const raw = ctx.flags.server ?? ctx.env.GITRING_URL ?? creds.current;
  if (!raw) {
    ctx.out("You are not signed in.");
    return 0;
  }
  const origin = serverOrigin(raw);
  const entry = creds.servers[origin];
  if (!entry) {
    ctx.out(`You are not signed in to ${origin}.`);
    return 0;
  }
  // End the sign-in on the server too (RFC 7009). The refresh token ends all tokens of this sign-in.
  let revoked = false;
  try {
    const res = await postForm(ctx, `${origin}/oauth/revoke`, { token: entry.refreshToken, token_type_hint: "refresh_token", client_id: CLIENT_ID });
    revoked = res.status === 200;
  } catch {
    revoked = false;
  }
  forget(ctx, origin);
  ctx.out(`You are signed out of ${origin}.`);
  if (!revoked) ctx.out("The server did not confirm the end of the sign-in. To end it there, open Account, Connected apps in gitring.");
  return 0;
}
