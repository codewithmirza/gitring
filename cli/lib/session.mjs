/**
 * Finds the server and the credential of one command, and renews an access token that ends soon.
 * Called by every command that needs a sign-in, and by rest.mjs and mcp.mjs.
 * Never print a token. A personal API key in GITRING_TOKEN is used as it is and never renewed.
 */
import { CLIENT_ID } from "./constants.mjs";
import { serverOrigin } from "./config.mjs";
import { CliError } from "./errors.mjs";
import { errorText, postForm } from "./http.mjs";
import { forget, readCredentials, remember, tokensOf } from "./credentials.mjs";

/** The server and the credential of this call: GITRING_TOKEN (a key), or the stored sign-in. */
export function session(ctx) {
  const key = ctx.env.GITRING_TOKEN;
  if (key) {
    const raw = ctx.flags.server ?? ctx.env.GITRING_URL;
    if (!raw) throw new CliError("GITRING_TOKEN is set. Set GITRING_URL or --server to the address of your gitring too.", 2);
    return { origin: serverOrigin(raw), kind: "key", token: key };
  }
  const creds = readCredentials(ctx.configDir);
  const raw = ctx.flags.server ?? ctx.env.GITRING_URL ?? creds.current;
  if (!raw) throw new CliError("Sign in first: gitring login --server https://your-gitring.example.com");
  const origin = serverOrigin(raw);
  if (!creds.servers[origin]) throw new CliError(`You are not signed in to ${origin}. Run: gitring login --server ${origin}`);
  return { origin, kind: "oauth" };
}

/** The access token of a sign-in, renewed when it ends within a minute (or now, with `force`). */
export async function bearer(ctx, s, force = false) {
  if (s.kind === "key") return s.token;
  const entry = readCredentials(ctx.configDir).servers[s.origin];
  if (!entry) throw new CliError(`You are not signed in to ${s.origin}. Run: gitring login --server ${s.origin}`);
  if (!force && Number(entry.expiresAt) - ctx.now() > 60_000) return entry.accessToken;
  const res = await postForm(ctx, `${s.origin}/oauth/token`, { grant_type: "refresh_token", refresh_token: entry.refreshToken, client_id: CLIENT_ID });
  if (res.status !== 200 || !res.json?.access_token) {
    if (res.json?.error === "invalid_grant" || res.json?.error === "invalid_client") {
      forget(ctx, s.origin);
      throw new CliError(`Your sign-in to ${s.origin} ended. Run: gitring login --server ${s.origin}`);
    }
    throw new CliError(`The command line could not renew your sign-in. ${errorText(res)} Try again.`);
  }
  remember(ctx, s.origin, { ...entry, ...tokensOf(ctx, res.json) });
  return res.json.access_token;
}
