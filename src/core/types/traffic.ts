/**
 * What an agent sees about the other work copies near it.
 *
 * Reached through `src/core/types.ts`, the front door. It has no runtime code.
 */
import type { Range } from "./conflict-check";
import type { SymbolKey } from "./plan-and-changes";
import type { AttemptStatus } from "./work-copies";

export interface TrafficVessel {
  attemptId: string;
  agentId: string;
  callsign: string;
  intentId: string;
  intentTitle: string;
  status: AttemptStatus;
  approach: string;
  files: string[];
  symbols: SymbolKey[];
  /** The latest log lines of that vessel (its live context). */
  recentLogs: string[];
  range: Range;
  closing: boolean;
}

export interface TrafficReport {
  attemptId: string;
  vessels: TrafficVessel[];
  mainSha: string;
  /** Intents that landed after this attempt's base (upstream). */
  landedSinceBase: { intentId: string; title: string; sha: string; files: string[] }[];
}
