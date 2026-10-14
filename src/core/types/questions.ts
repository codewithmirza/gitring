/**
 * A question for a person that is not an approval: a conflict, a redo, a steward note or a revert.
 *
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Millis, Person } from "./basics";
import type { Correction, CorrectionKind } from "./change-requests";

/**
 * A question for a person that is not "say yes to a merge" (that is an Approval):
 *
 *   escalation  a conflict check could not decide which of two work copies adapts. A person chooses one,
 *               or says that the two do not conflict. Both agents continue while they wait.
 *   redo        the work could not merge, and no agent may try again (the redo limit, or the agent did not
 *               answer in time). A person starts a redo on the new main, or pauses the task.
 *   steward     the steward noticed an anomaly (a test that fails again and again, change requests that
 *               bounce, hot lines, a test that flaps, a merge queue that does not move). The one answer
 *               is "Seen": the note closes.
 *
 * The first valid answer counts. A question closes without an answer when its work copies close.
 */
/** "revert": gitring reverted a merge that a person said yes to (tests failed on main); the person hears it here. */
export type QuestionKind = "escalation" | "redo" | "steward" | "revert";

export type QuestionStatus = "open" | "answered" | "closed";

/** One answer that a person can give. `label` is the plain text of the button. */
export interface QuestionOption {
  id: string;
  label: string;
}

export interface Question {
  /** q_… */
  id: string;
  kind: QuestionKind;
  status: QuestionStatus;
  /** The task of the first work copy. */
  intentId: string;
  /** The two work copies of an escalation (the incoming one first), or the work copy that did not merge. */
  attemptIds: string[];
  /** Escalation: the conflict check that asked (the latest one, when the same pair asks again). */
  checkId?: string;
  /** Plain sentences: what gitring knows. */
  facts: string[];
  options: QuestionOption[];
  /**
   * Escalation: the change request for each option where one side adapts, drafted when gitring asked. The
   * answer sends it to that side.
   */
  drafts?: Record<string, { attemptId: string; standOnAttemptId: string; kind: CorrectionKind; message: string; constraints: Correction["constraints"] }>;
  /** Steward: the key of the fact (harbor/steward.ts Finding.key). One open note for one fact. */
  fact?: string;
  /** Steward: how large the fact was (runs, requests or minutes). A note comes again when this doubles. */
  measure?: number;
  askedAt: Millis;
  updatedAt: Millis;
  answer?: { by: Person; option: string; note?: string; at: Millis };
  /** Closed without an answer: the plain reason. */
  closed?: string;
}

/** What a person sends to answer a question. */
export interface QuestionAnswer {
  option: string;
  note?: string;
}

/** The result of an answer to a question. "refused": this person may not answer. "already" and "closed": nothing changed. */
export interface QuestionResult {
  outcome: "answered" | "already" | "closed" | "refused";
  question: Question;
  message: string;
}
