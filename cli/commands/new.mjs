/**
 * The command new: makes a project. With --template or --describe it calls the MCP tool of agent-first projects.
 * Called through commands/index.mjs. Without them it uses the REST route POST /api/projects.
 * Never guess a name for the person. The name is the first argument.
 */
import { CliError } from "../lib/errors.mjs";
import { printJson, titleFrom } from "../lib/format.mjs";
import { headline, tool } from "../lib/mcp.mjs";
import { okJson, rest } from "../lib/rest.mjs";
import { session } from "../lib/session.mjs";

/** gitring new <name>: make a project, from a template or a description, or an empty one. */
export async function newProject(ctx, [name]) {
  const s = session(ctx);
  const visibility = ctx.flags.public ? "public" : "private";
  const { template, describe } = ctx.flags;
  if (template || describe) {
    // A template or a description: the MCP tool of agent-first projects (contract C5) does it in one call.
    const args = {
      name,
      visibility,
      start: template ? { kind: "template", template } : { kind: "empty" },
      ...(describe ? { description: describe, firstTask: { title: titleFrom(describe), goal: describe }, launch: 1 } : {}),
    };
    const res = await tool(ctx, s, "gitring_create_project", args);
    if (ctx.flags.json) return printJson(ctx, res.json ?? { text: res.text });
    ctx.out(headline(res.text));
    return 0;
  }
  const made = okJson(s, await rest(ctx, s, "POST", "/api/projects", { name, visibility, source: { kind: "empty" } }));
  const id = made?.project?.id;
  if (!id) throw new CliError("The server did not say the id of the new project.");
  if (ctx.flags.json) return printJson(ctx, made.project);
  ctx.out(`gitring made the project ${id} (${visibility}).`);
  ctx.out(`Open it: ${s.origin}/overview?project=${encodeURIComponent(id)}`);
  ctx.out(`Make a task: gitring task ${id} "title" "goal"`);
  return 0;
}
