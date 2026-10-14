/**
 * The tasks of a project grouped by status for the task rail: needs a yes, at work, open, merged, paused.
 */
import type { Intent, IntentStatus, ProjectState } from "../../../../src/core/types";
import { memo } from "./memo";

export const INTENT_GROUPS: { id: string; label: string; statuses: IntentStatus[] }[] = [
  { id: "judging", label: "Needs a yes", statuses: ["judging"] },
  { id: "underway", label: "At work", statuses: ["underway", "landing"] },
  { id: "open", label: "Open", statuses: ["open", "draft"] },
  { id: "landed", label: "Merged", statuses: ["landed"] },
  { id: "parked", label: "Paused", statuses: ["parked", "merged-into"] },
];

export interface IntentGroup {
  id: string;
  label: string;
  intents: Intent[];
}

const groupsMemo = memo((intents: Intent[]): IntentGroup[] =>
  INTENT_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    intents: intents
      .filter((i) => g.statuses.includes(i.status))
      .sort((a, b) => (g.id === "landed" ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt)),
  })).filter((g) => g.intents.length > 0),
);

export function selectIntentGroups(st: ProjectState): IntentGroup[] {
  return groupsMemo(st.intents);
}
