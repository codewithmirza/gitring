/**
 * Plain words for the moments when the page waits.
 * They follow STE (no "-ing" forms). The module is pure, so tests can read it.
 */

/** The short label of a busy button or a placeholder. */
export const PLEASE_WAIT = "Please wait";

/** The label of a placeholder for one named part of the page, for example "Please wait for the inbox". */
export function waitFor(what: string): string {
  return `${PLEASE_WAIT} for ${what}`;
}

/** The meta line of a change request that the agent did not get yet. */
export const NOT_SENT_YET = "Not sent to the agent yet";

/** A task on its way to the server. */
export const TASK_ON_ITS_WAY = "On its way";
