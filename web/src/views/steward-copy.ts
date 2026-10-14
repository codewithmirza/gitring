/**
 * The words of the Settings page for the helper agent (the "steward" of the code: project setting `steward`, see src/harbor/steward.ts).
 * Plain style (ASD-STE100): short sentences, one meaning per word.
 */

export const STEWARD_LABEL = "A helper agent watches for stuck work";

/** Help under the switch: what the steward reports when it is on, and why to turn it on when it is off. */
export function stewardHelp(on: boolean): string {
  return on
    ? "Every few minutes, while agents work, the helper checks the records of the project. It reports a test that fails again and again, and a test that passes and fails by turns. It reports change requests that bounce, the same lines in many change requests, and a merge queue that is stuck. Each note has one answer: Seen."
    : "Turn this on to get a note in the inbox when the agents are stuck or go in circles.";
}
