/**
 * The waitlist in the UI: keep, change and take back the choice of a pack.
 * The gate itself comes with GET /api/me (me.waitlist), so the store always knows if the person may use gitring.
 */
import type { PlanId } from "../../../src/core/plans";
import type { WaitlistEntry } from "../../../src/core/waitlist";
import { send, invalidate } from "./http";
import { loadMe } from "./account";

/** Keep the choice (a new one or a change). The store shows the new record after this. */
export async function saveChoice(pack: PlanId, note: string): Promise<WaitlistEntry> {
  const entry = await send<WaitlistEntry>("PUT", "/api/waitlist", { pack, note });
  invalidate("/api/me");
  await loadMe().catch(() => undefined);
  return entry;
}

/** Take the interest back. */
export async function leaveWaitlist(): Promise<void> {
  await send("DELETE", "/api/waitlist");
  invalidate("/api/me");
  await loadMe().catch(() => undefined);
}
