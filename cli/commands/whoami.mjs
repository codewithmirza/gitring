/**
 * The command whoami: shows the name of the signed-in person and the server.
 * Called through commands/index.mjs. It is the quickest check that a sign-in or a key works.
 * Never show a token.
 */
import { CliError } from "../lib/errors.mjs";
import { printJson } from "../lib/format.mjs";
import { okJson, rest } from "../lib/rest.mjs";
import { session } from "../lib/session.mjs";

/** gitring whoami: print the name of the person and the server. */
export async function whoami(ctx) {
  const s = session(ctx);
  const me = okJson(s, await rest(ctx, s, "GET", "/api/me"));
  if (ctx.flags.json) return printJson(ctx, { server: s.origin, user: me?.user ?? null, via: s.kind });
  if (!me?.user) throw new CliError(`The server does not know this sign-in. Run: gitring login --server ${s.origin}`);
  ctx.out(`${me.user.name} on ${s.origin}${s.kind === "key" ? " (personal API key)" : ""}`);
  return 0;
}
