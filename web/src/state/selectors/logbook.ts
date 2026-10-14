/**
 * The rows of the why-record: one row for each merge, newest first, joined with its task, work copy and agent.
 */
import type { AgentInfo, Attempt, Intent, Landing, ProjectState } from "../../../../src/core/types";
import { byId, memo } from "./memo";

export interface LogbookRow {
  landing: Landing;
  intent?: Intent;
  attempt?: Attempt;
  agent?: AgentInfo;
  corrections: number;
}

const logbookMemo = memo((landings: Landing[], intents: Intent[], attempts: Attempt[], agents: AgentInfo[]): LogbookRow[] => {
  const ib = byId(intents);
  const ab = byId(attempts);
  const gb = byId(agents);
  return [...landings]
    .sort((a, b) => b.at - a.at)
    .map((l) => {
      const attempt = ab.get(l.attemptId);
      return {
        landing: l,
        intent: ib.get(l.intentId),
        attempt,
        agent: gb.get(l.agentId),
        corrections: l.correctionsApplied ?? attempt?.corrections.length ?? 0,
      };
    });
});

export function selectLogbook(st: ProjectState): LogbookRow[] {
  return logbookMemo(st.landings, st.intents, st.attempts, st.agents);
}
