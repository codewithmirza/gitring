/**
 * The approval hash: what a person said yes to, as a string that changes when the agent changes its work.
 * Called by ../master/work-views.ts. Never change a hash format: stored answers hold old hashes (see legacyDigest).
 */
import { sha256Hex } from "../../directory/crypto";
import { type AttemptView } from "../views";

/** The start of an approval hash of the agent's contribution (see digestOf). */
export const DIGEST_V2 = "v2:";

/** The approval hash of older versions: each changed text file and its new text. */
export async function legacyDigest(v: AttemptView): Promise<string> {
  const rows = await Promise.all(v.changed.map(async (c) => `${c.path}\0${c.head === null ? "-" : await sha256Hex(c.head)}`));
  return sha256Hex(rows.sort().join("\n"));
}
