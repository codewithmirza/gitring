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

/** The MCP URL of this gitring. Agents add it as a connector and sign in with OAuth. */
export function mcpUrl(): string {
  return `${location.origin}/mcp`;
}

export async function copyText(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ tone: "clear", title: `${what} copied`, text });
    return true;
  } catch {
    toast({ tone: "info", title: `Copy the ${what.toLowerCase()} by hand`, text });
    return false;
  }
}

export const copyMcpUrl = () => copyText(mcpUrl(), "MCP URL");

/** When built-in agents wait for the hourly AI budget, the time they start (else null). */
export function budgetWait(attempts: { waitsForBudget?: number }[]): number | null {
  const t = attempts.map((a) => a.waitsForBudget ?? 0).filter((x) => x > Date.now());
  return t.length ? Math.min(...t) : null;
}

export function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
