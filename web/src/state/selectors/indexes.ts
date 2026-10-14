/**
 * The status lists and the lookup maps of one project: tasks, work copies, agents, checks, merges and answers by id.
 * Read by every selector that joins two kinds of record. Rebuilds only when one of the lists changes.
 */
import type {
  AgentInfo,
  Attempt,
  AttemptStatus,
  Correction,
  CourseCheck,
  Decision,
  Intent,
  Landing,
  ProjectState,
} from "../../../../src/core/types";
import { byId, memo } from "./memo";

export const ACTIVE_STATUSES: AttemptStatus[] = [
  "declared",
  "underway",
  "submitted",
  "checking",
  "ready",
  "landing",
  "stale",
  "rederiving",
];

export function isActiveAttempt(a: Attempt): boolean {
  return ACTIVE_STATUSES.includes(a.status);
}

export const vesselColor = (index: number) => `var(--v${((index % 12) + 12) % 12})`;

/* ───────────── indexes ───────────── */

export interface Indexes {
  intentById: Map<string, Intent>;
  attemptById: Map<string, Attempt>;
  agentById: Map<string, AgentInfo>;
  attemptsByIntent: Map<string, Attempt[]>;
  correctionsByAttempt: Map<string, Correction[]>;
  checksByAttempt: Map<string, CourseCheck[]>;
  checkById: Map<string, CourseCheck>;
  landingByAttempt: Map<string, Landing>;
  decisionsByIntent: Map<string, Decision[]>;
}

const indexesMemo = memo(
  (
    intents: Intent[],
    attempts: Attempt[],
    agents: AgentInfo[],
    corrections: Correction[],
    checks: CourseCheck[],
    landings: Landing[],
    decisions: Decision[],
  ): Indexes => {
    const attemptsByIntent = new Map<string, Attempt[]>();
    for (const a of [...attempts].sort((x, y) => x.createdAt - y.createdAt)) {
      const list = attemptsByIntent.get(a.intentId) ?? [];
      list.push(a);
      attemptsByIntent.set(a.intentId, list);
    }
    const correctionsByAttempt = new Map<string, Correction[]>();
    for (const c of corrections) {
      const list = correctionsByAttempt.get(c.attemptId) ?? [];
      list.push(c);
      correctionsByAttempt.set(c.attemptId, list);
    }
    const checksByAttempt = new Map<string, CourseCheck[]>();
    for (const c of checks) {
      const list = checksByAttempt.get(c.attemptId) ?? [];
      list.push(c);
      checksByAttempt.set(c.attemptId, list);
    }
    const decisionsByIntent = new Map<string, Decision[]>();
    for (const d of decisions) {
      const list = decisionsByIntent.get(d.intentId) ?? [];
      list.push(d);
      decisionsByIntent.set(d.intentId, list);
    }
    return {
      intentById: byId(intents),
      attemptById: byId(attempts),
      agentById: byId(agents),
      attemptsByIntent,
      correctionsByAttempt,
      checksByAttempt,
      checkById: byId(checks),
      landingByAttempt: new Map(landings.map((l) => [l.attemptId, l])),
      decisionsByIntent,
    };
  },
);

export function indexes(st: ProjectState): Indexes {
  return indexesMemo(st.intents, st.attempts, st.agents, st.corrections, st.checks, st.landings, st.decisions);
}
