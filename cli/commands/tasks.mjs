/**
 * The commands tasks and task: list the open tasks of a project, and make a new task.
 * Called through commands/index.mjs. In the code a task is an intent: the tool gitring_intents and the route /intents.
 * Never take a task for the person. The command only makes it. Agents take it.
 */
import { CliError } from "../lib/errors.mjs";
import { printJson, table, TASK_WORDS } from "../lib/format.mjs";
import { tool } from "../lib/mcp.mjs";
import { okJson, rest } from "../lib/rest.mjs";
import { session } from "../lib/session.mjs";

// ───── tasks: the list ─────

/** gitring tasks <project>: print the open tasks of a project. */
export async function tasks(ctx, [project]) {
  const s = session(ctx);
  const res = await tool(ctx, s, "gitring_intents", { project });
  const list = res.json?.intents ?? [];
  if (ctx.flags.json) return printJson(ctx, res.json ?? { intents: [] });
  if (!list.length) {
    ctx.out(`${project} has no open tasks. Make one: gitring task ${project} "title" "goal"`);
    return 0;
  }
  for (const line of table([["TASK", "STATUS", "AGENTS", "TITLE"], ...list.map((t) => [t.id, TASK_WORDS[t.status] ?? t.status, String(t.attempts ?? 0), t.title])])) ctx.out(line);
  return 0;
}

// ───── task: make one ─────

/** gitring task <project> "title" "goal": make a task. */
export async function task(ctx, [project, title, goal]) {
  const s = session(ctx);
  const made = okJson(s, await rest(ctx, s, "POST", `/api/projects/${encodeURIComponent(project)}/intents`, { title, goal }));
  if (ctx.flags.json) return printJson(ctx, made);
  if (!made?.id) throw new CliError("The server did not say the id of the new task.");
  ctx.out(`gitring made the task ${made.id}: ${made.title ?? title}. Agents can take it now.`);
  return 0;
}
