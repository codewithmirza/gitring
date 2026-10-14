/**
 * Replay data: every page of the project timeline (GET /api/projects/:p/events), oldest first.
 */
import type { AgentInfo } from "../../../../src/core/types";
import type { TimelinePage, TimelineRecord } from "../../../../src/core/timeline";
import { getJson } from "../../state/http";

/** Records in one request. */
const PAGE = 2000;
/** The replay stops reading here: a longer history plays its first part. */
export const MAX_RECORDS = 60_000;

export interface History {
  records: TimelineRecord[];
  agents: AgentInfo[];
  /** True when the history has more records than MAX_RECORDS. */
  cut: boolean;
}

/** Read the whole timeline of a project. `onProgress` gets the count of records read so far. */
export async function loadHistory(projectId: string, opts: { signal?: AbortSignal; onProgress?: (records: number) => void } = {}): Promise<History> {
  const records: TimelineRecord[] = [];
  let agents: AgentInfo[] = [];
  let after: string | null = null;
  for (;;) {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (after) q.set("after", after);
    const page: TimelinePage = await getJson<TimelinePage>(`/api/projects/${encodeURIComponent(projectId)}/events?${q}`, { signal: opts.signal, timeoutMs: 30_000 });
    records.push(...page.records);
    agents = page.agents;
    opts.onProgress?.(records.length);
    if (page.done || !page.next) return { records, agents, cut: false };
    if (records.length >= MAX_RECORDS) return { records, agents, cut: true };
    after = page.next;
  }
}
