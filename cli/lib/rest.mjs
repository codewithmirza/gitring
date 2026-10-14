/**
 * Makes REST calls to the server with the credential of the command, and reads the answers.
 * Called by the commands that use a REST route (everything except the tool commands).
 * Never show a response body to the person: okJson gives the plain words of the server instead.
 */
import { TOO_OLD } from "./constants.mjs";
import { CliError } from "./errors.mjs";
import { errorText, http, isMissingRoute } from "./http.mjs";
import { bearer } from "./session.mjs";

/** A REST call with the credential. A 401 with a sign-in renews the token once. */
export async function rest(ctx, s, method, path, body) {
  const send = async (token) =>
    http(ctx, method, `${s.origin}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let res = await send(await bearer(ctx, s));
  if (res.status === 401 && s.kind === "oauth") res = await send(await bearer(ctx, s, true));
  return res;
}

/** The JSON of a REST answer that worked; else a CliError with the words of the server. */
export function okJson(s, res) {
  if (res.status >= 200 && res.status < 300) return res.json;
  if (isMissingRoute(res)) throw new CliError(TOO_OLD);
  if (res.status === 401) {
    throw new CliError(s.kind === "key" ? "The key in GITRING_TOKEN is not valid." : `Your sign-in to ${s.origin} does not work for this. Run: gitring login --server ${s.origin}`);
  }
  throw new CliError(errorText(res));
}
