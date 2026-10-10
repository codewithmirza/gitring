/** Project actions that more than one view starts. Each one reports its result in a toast. */
import { toast } from "../design/components";
import { harbor } from "../state/api";

/** Start built-in AI agents on every open task. Over the hourly AI budget, new agents wait in a queue. */
export async function launchAllNow(): Promise<boolean> {
  try {
    const r = await harbor().launchAll();
    toast({
      tone: "info",
      title: r.launched ? `${r.launched} AI ${r.launched === 1 ? "agent starts" : "agents start"}` : "No agents start now",
      text: r.queued
        ? `${r.queued} more wait for the hourly AI budget and start by themselves. Watch the activity.`
        : r.launched
          ? "Watch the overview. AI agents need 5 to 8 minutes."
          : "No open task needs an agent. Write a task first.",
    });
    return true;
  } catch (e) {
    toast({ tone: "danger", title: "The agents did not start", text: (e as Error).message });
    return false;
  }
}
