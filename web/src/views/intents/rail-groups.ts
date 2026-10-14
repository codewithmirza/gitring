/**
 * The pure parts of the task rail: which tasks match a filter, and how a long group splits by day.
 * Read by ../../app/IntentsRail.tsx. The tests are in test/web/rail-groups.test.ts.
 */
import type { Intent } from "../../../../src/core/types";
import type { IntentGroup } from "../../state/selectors";
import { dayLabel } from "../labels";

/** A group with more tasks than this is split by day. */
export const SPLIT_BY_DAY_FROM = 20;

/** A group of tasks, or the part of it that one day holds. */
export interface RowGroup {
  key: string;
  label?: string;
  intents: Intent[];
}

/** The tasks that have every word of the filter, in the title or the goal. An empty list of words keeps all tasks. */
export function matchFilter(i: Intent, words: string[]): boolean {
  const text = `${i.title} ${i.goal}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Splits a long group by the day that each task was opened (merged tasks: the day of the merge). A short group stays whole. */
export function splitByDay(g: IntentGroup, now: number): RowGroup[] {
  if (g.intents.length <= SPLIT_BY_DAY_FROM) return [{ key: g.id, intents: g.intents }];
  const days: RowGroup[] = [];
  for (const i of g.intents) {
    const label = dayLabel(g.id === "landed" ? i.updatedAt : i.createdAt, now);
    const last = days[days.length - 1];
    if (last?.label === label) last.intents.push(i);
    else days.push({ key: `${g.id}-${days.length}`, label, intents: [i] });
  }
  return days;
}
