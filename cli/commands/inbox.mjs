/**
 * The command inbox: lists what waits for the person in all projects, with the command that answers each item.
 * Called through commands/index.mjs. commands/answer.mjs reads the same list (inboxItems).
 * Never answer an item here. This command only reads.
 */
import { age, printJson } from "../lib/format.mjs";
import { okJson, rest } from "../lib/rest.mjs";
import { session } from "../lib/session.mjs";

/** The items of the inbox of the person, for all projects, in the order of the server. */
export async function inboxItems(ctx, s) {
  const res = okJson(s, await rest(ctx, s, "GET", "/api/me/inbox"));
  return Array.isArray(res?.items) ? res.items : [];
}

/** gitring inbox: print each item with the command that answers it. */
export async function inbox(ctx) {
  const s = session(ctx);
  const items = await inboxItems(ctx, s);
  if (ctx.flags.json) return printJson(ctx, { items });
  if (!items.length) {
    ctx.out("No item waits for you.");
    return 0;
  }
  const now = ctx.now();
  for (const it of items) {
    ctx.out(`${it.key}  ${it.projectName ?? it.project}  ${it.headline ?? it.title}  (${age(now - Number(it.at ?? now))})`);
    if (it.title && it.headline) ctx.out(`  Task: ${it.title}${it.agent ? `. Agent: ${it.agent}` : ""}${it.line ? `. ${it.line}` : ""}`);
    for (const why of (it.why ?? []).slice(0, 3)) ctx.out(`  ${why}`);
    if (it.kind === "approval" || it.kind === "stopped") ctx.out(`  Answer: gitring yes ${it.key}, or gitring back ${it.key} "note"`);
    else ctx.out("  Answer in the gitring app.");
    if (it.link) ctx.out(`  ${it.link.startsWith("/") ? `${s.origin}${it.link}` : it.link}`);
  }
  return 0;
}
