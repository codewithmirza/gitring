/**
 * An approval: a merge that waits for a person to say yes.
 *
 * The rules that decide when gitring asks are in `src/core/approvals.ts`.
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Millis, Person } from "./basics";

/**
 * An approval is a merge that waits for a person. gitring asks for one when the work is ready, its tests
 * pass, and a person must say yes (see approvalNeeded in core/approvals.ts).
 *
 *   waiting    asked; nobody answered yet. The work copy is "ready" and does not merge.
 *   approved   a person said yes. The work copy goes to the merge queue.
 *   sent-back  a person said "not yet" and gave a note. The note went to the agent as a change request.
 *   withdrawn  the answer cannot come any more: the agent changed the work, or the work copy closed.
 *
 * Only one answer counts: the first valid one. The same answer twice has no second effect.
 */
export type ApprovalStatus = "waiting" | "approved" | "sent-back" | "withdrawn";

export type ApprovalReason =
  | "no-test-ran" // nothing is verified
  | "competing" // other work copies compete on the same task
  | "project-asks" // the project asks before every merge
  | "looks-risky" // the project asks when a change looks risky, and this one does
  | "folder-rule" // a rule by folder of the project asks for the yes of an owner
  | "merge-stopped"; // the merge did not finish after several tries

export interface Approval {
  id: string;
  status: ApprovalStatus;
  /** The main reason. `why` has all of them. */
  reason: ApprovalReason;
  /** Plain sentences for people: why a person must say yes. */
  why: string[];
  /**
   * A hash of what the person sees: the base of the work copy and each changed file. An answer counts for
   * this work only. If the agent changes the work, the approval is withdrawn and gitring asks again.
   */
  digest: string;
  /** The person who answers: the sender of the work copy. Absent: any member. Owners can always answer. */
  approver?: Person;
  /** Only an owner answers: a rule by folder asks for the yes of an owner (`approver` is then absent). */
  ownerOnly?: boolean;
  askedAt: Millis;
  /** how: in the gitring app, in the chat of the agent, or with the gitring command line. */
  answer?: { by: Person; how: "app" | "chat" | "cli"; note?: string; at: Millis };
  /** Withdrawn: the plain reason. */
  closed?: string;
}
