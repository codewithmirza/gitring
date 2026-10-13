/**
 * Line requests: a person selects lines on the diff of a work copy (the task lane or the Code view) and asks
 * the agent to change them. The agent gets a change request in the answer of its next call.
 */
import { linesText, toast, type LineRequestInput } from "../design/components";
import { requestChange } from "../state/inbox";

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
