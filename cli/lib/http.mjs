/**
 * Sends one HTTP call and gives the answer in a plain shape: status, headers, text and JSON.
 * Called by session.mjs, rest.mjs, mcp.mjs and the login command.
 * Never put a token in a message. A network failure becomes a CliError with plain words.
 */
import { CliError } from "./errors.mjs";
import { VERSION } from "./constants.mjs";

/** One HTTP call. A network failure becomes a CliError with plain words. */
export async function http(ctx, method, url, { headers = {}, body } = {}) {
  let res;
  try {
    res = await ctx.fetch(url, { method, headers: { "user-agent": `gitring-cli/${VERSION}`, ...headers }, body });
  } catch (e) {
    throw new CliError(`The command line could not reach ${new URL(url).origin}. Check the address and your network. (${e?.message ?? e})`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

export function postForm(ctx, url, fields) {
  return http(ctx, "POST", url, { headers: FORM, body: new URLSearchParams(fields).toString() });
}

/** A server answer that is not JSON at a route that a newer server has: the route does not exist here. */
export function isMissingRoute(res) {
  return res.status === 404 && !(res.json && typeof res.json === "object" && ("error" in res.json || "message" in res.json));
}

/** The plain words of an error answer. */
export function errorText(res) {
  const j = res.json;
  if (j && typeof j === "object") {
    const words = j.error_description ?? j.message ?? j.error;
    if (typeof words === "string" && words) return words;
  }
  return `The server answered ${res.status}.`;
}
