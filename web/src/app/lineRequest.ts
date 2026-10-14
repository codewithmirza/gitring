/**
 * Line requests: a person selects lines on the diff of a work copy and asks the agent to change them.
 * Used by the task lane and the Code view. The agent gets a change request in the answer of its next call.
 */
import type { Attempt } from "../../../src/core/types";
import { linesText, toast, type LineRequestInput } from "../design/components";
import { requestChange } from "../state/inbox";
import { isActiveAttempt } from "../state/selectors";

/**
 * A person may ask for a line change only while the agent works on the copy. A stale copy is over on the server
 * (a redo or a person decides), so its lines are not buttons.
 */
export function mayRequestLines(a: Pick<Attempt, "status">): boolean {
  return a.status !== "stale" && isActiveAttempt(a as Attempt);
}

/**
 * The sender of line requests for one work copy. It rejects with the plain sentence of the server when the
 * request did not go out (the form shows it), and says in a toast when it did.
 */
export function lineRequester(projectId: string, attemptId: string, callsign: string): (input: LineRequestInput) => Promise<void> {
  return async (input) => {
    await requestChange(projectId, attemptId, input);
    toast({ tone: "info", title: "Request sent", text: `${callsign} gets it in the answer of its next call: ${input.path} ${linesText(input.from, input.to)}.` });
  };
}
