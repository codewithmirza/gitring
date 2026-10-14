/**
 * The command projects: lists the projects of the signed-in person, one line for each.
 * Called through commands/index.mjs. It uses the REST route GET /api/projects.
 * Never change anything. This command only reads.
 */
import { printJson, table } from "../lib/format.mjs";
import { okJson, rest } from "../lib/rest.mjs";
import { session } from "../lib/session.mjs";

/** gitring projects: print one line for each project. */
export async function projects(ctx) {
  const s = session(ctx);
  const list = okJson(s, await rest(ctx, s, "GET", "/api/projects")) ?? [];
  if (ctx.flags.json) return printJson(ctx, list);
  if (!list.length) {
    ctx.out("You have no projects. Make one: gitring new <name>");
    return 0;
  }
  for (const line of table([["PROJECT", "ROLE", "NAME"], ...list.map((p) => [p.id, p.role ?? "", p.name])])) ctx.out(line);
  return 0;
}
