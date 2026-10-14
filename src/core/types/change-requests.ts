/**
 * A change request (code name correction): what gitring tells one agent so that two plans do not collide.
 *
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Millis } from "./basics";
import type { RuleOfTheRoad } from "./conflict-check";
import type { LineRange, SymbolKey } from "./plans";

export type CorrectionKind =
  | "interface" // use the new signature of a symbol another vessel changes
  | "region" // keep out of lines another vessel is changing
  | "duplicate" // another vessel does the same work; merge or narrow scope
  | "upstream" // main moved under you; adapt to the landed change
  | "intent-amended" // a human changed the intent
  | "review" // a person sent the work back with a note
  | "reverted"; // gitring reverted the merge of the work: tests failed on main (post-merge test mode)

export interface Correction {
  id: string;
  /** The give-way attempt. It receives the correction. */
  attemptId: string;
  /** The stand-on attempt, if any. */
  standOnAttemptId?: string;
  /**
   * More attempts that edit the same lines at the same time. The agent gets one change request for the lines,
   * not one for each of them. `standOnAttemptId` is the one that declared last. An agent that waits for that
   * one stands in a row behind the others. If every agent waited for the first one, all would wake up together.
   */
  alsoStandOn?: string[];
  kind: CorrectionKind;
  rule: RuleOfTheRoad | "human";
  /** Instruction text for the agent (ASD-STE100 style, imperative, short). */
  message: string;
  /** Machine-readable constraints, mirrored into the intent constraints. */
  constraints: {
    avoidRegions?: { path: string; lines: LineRange }[];
    useSignatures?: { symbol: SymbolKey; signature: string }[];
    notes?: string[];
    /** Files to change again on the new main: gitring kept the main version; the diff is the agent's earlier change. */
    reapply?: { path: string; diff: string }[];
    /** Set when gitring moved the work onto a new main (re-plot). */
    replot?: { mainSha: string };
  };
  checkId: string;
  /**
   * "acknowledged": the agent confirmed it (and the code check did not fail). "closed": the work merged
   * before the agent confirmed it.
   */
  status: "pending" | "delivered" | "acknowledged" | "superseded" | "closed";
  /** Severity of the situation when issued (higher = closer / more overlap). gitring re-sends only when it grows. */
  severity?: number;
  /** How many times the advice was refreshed in place without a new delivery. */
  refreshes?: number;
  createdAt: Millis;
  deliveredAt?: Millis;
  acknowledgedAt?: Millis;
  ackNote?: string;
  /**
   * The code check at the last confirmation of the agent: does the code of the work copy keep the
   * constraints? `applied` is null when the constraints have nothing that gitring can check.
   * With `applied: false` the change request stays open.
   */
  check?: { applied: boolean | null; reason: string; at: Millis };
}
