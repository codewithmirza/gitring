/**
 * The command clone: asks for a read token and runs git clone. The token does not stay in the folder.
 * Called through commands/index.mjs. The token goes to git in the environment (git 2.31 or later).
 * Never put the token in the command line, in the folder or in the output.
 */
import { CliError } from "../lib/errors.mjs";
import { printJson } from "../lib/format.mjs";
import { okJson, rest } from "../lib/rest.mjs";
import { session } from "../lib/session.mjs";

/** The git header for a read token of Artifacts (Basic, user "x"). The token text can end in "?expires=…". */
export function gitAuthHeader(token) {
  const secret = String(token).split("?expires=")[0];
  return `Authorization: Basic ${Buffer.from(`x:${secret}`).toString("base64")}`;
}

/** gitring clone <project> [folder]: run git clone with a read token that git gets in its environment. */
export async function clone(ctx, [project, folder]) {
  const s = session(ctx);
  const access = okJson(s, await rest(ctx, s, "POST", `/api/projects/${encodeURIComponent(project)}/clone-token`, {}));
  if (!access?.remote || !access?.token) throw new CliError("The server did not give a clone address.");
  const dir = folder ?? project;
  const branch = typeof access.branch === "string" && access.branch ? ["--branch", access.branch] : [];
  if (ctx.flags.json) return printJson(ctx, { project, remote: access.remote, folder: dir, ...(branch.length ? { branch: access.branch } : {}), ...(access.expiresAt ? { expiresAt: access.expiresAt } : {}) });
  ctx.out(`gitring runs: git clone ${[...branch, access.remote, dir].join(" ")}`);
  // The token goes to git in the environment (git 2.31 or later), not in the command line or the folder.
  // "--" ends the options of git: a folder name that starts with a dash stays a folder name.
  const code = await ctx.run("git", ["clone", ...branch, "--", access.remote, dir], {
    env: { ...ctx.processEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: gitAuthHeader(access.token), GIT_TERMINAL_PROMPT: "0" },
  });
  if (code !== 0) throw new CliError("git clone did not finish. Check that git 2.31 or later is installed, and read the git message above.");
  ctx.out(`gitring cloned ${project} into ${dir}. The read token is not in the folder.`);
  return 0;
}
