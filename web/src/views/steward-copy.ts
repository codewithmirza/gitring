/**
 * The words of the Settings page for the steward (project setting `steward`, see src/harbor/steward.ts).
 * Plain style (ASD-STE100): short sentences, one meaning per word.
 */

export const STEWARD_LABEL = "A steward watches the agents and puts what it notices in the inbox";

/** Help under the switch: what the steward reports when it is on, and why to turn it on when it is off. */
export function stewardHelp(on: boolean): string {
  return on
    ? "Every few minutes while agents work, gitring counts the facts in its records. It reports a test that fails again and again, change requests that bounce, and hot lines. It also reports a test that flaps and a merge queue that does not move. A model words each note in one plain sentence. The note has one answer: Seen."
    : "Turn this on to get a note in the inbox when the agents are stuck or go in circles.";
}
