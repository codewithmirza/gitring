/**
 * The commands yes and back: answer a merge question. Yes lets the work merge. Back sends it to the agent.
 * Called through commands/index.mjs. The server decides if this person may answer from the command line.
 * Never decide for the person. Never answer an item that is not a merge question.
 */
import { CliError } from "../lib/errors.mjs";
import { printJson } from "../lib/format.mjs";
import { errorText } from "../lib/http.mjs";
import { okJson, rest } from "../lib/rest.mjs";
import { session } from "../lib/session.mjs";
import { inboxItems } from "./inbox.mjs";

/** An item of the inbox by its key, or by a start of the key that only one item has. */
function findItem(items, key) {
  const exact = items.find((x) => x.key === key);
  if (exact) return exact;
  const hits = items.filter((x) => String(x.key).startsWith(key));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new CliError(`More than one item starts with ${key}. Give more of the key.`);
  throw new CliError(`No item ${key} waits for you. Run gitring inbox to see the items.`);
}

/** gitring yes <item> and gitring back <item> "note". Answers 0 when the answer counted, 1 when it changed nothing. */
export async function answer(ctx, [key, note], approve) {
  const s = session(ctx);
  const item = findItem(await inboxItems(ctx, s), key);
  const link = item.link ? (item.link.startsWith("/") ? `${s.origin}${item.link}` : item.link) : `${s.origin}/`;
  if ((item.kind !== "approval" && item.kind !== "stopped") || !item.attemptId || !item.approvalId) {
    throw new CliError(`This item is not a merge question. Answer it in the gitring app: ${link}`);
  }
  const res = await rest(ctx, s, "POST", `/api/projects/${encodeURIComponent(item.project)}/attempts/${encodeURIComponent(item.attemptId)}/decide`, {
    approvalId: item.approvalId,
    answer: approve ? "approve" : "send-back",
    ...(note ? { note } : {}),
  });
  // "refused": this person may not answer this question (the rules of the project). The gitring app does not change that.
  if (res.status === 403 && res.json?.outcome === "refused") throw new CliError(res.json.message || errorText(res));
  if (res.status === 403) throw new CliError(`${errorText(res)} Answer in the gitring app: ${link}`);
  const out = okJson(s, res);
  if (ctx.flags.json) printJson(ctx, out);
  else ctx.out(out?.message ?? (approve ? "gitring took your yes." : "gitring sent the work back."));
  // "already" and "withdrawn": the answer changed nothing (another answer came first, or the work changed).
  return out?.outcome === "approved" || out?.outcome === "sent-back" ? 0 : 1;
}
