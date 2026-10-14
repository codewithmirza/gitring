/**
 * The small types that all other type files use: time, actors, people and agents.
 *
 * Reached through `src/core/types.ts`, the front door. It has no runtime code and no imports.
 */

export type Millis = number;

export type ActorKind = "human" | "agent" | "system";

export interface Actor {
  kind: ActorKind;
  /** Human: a display name. Agent: the agent id. System: "gitring". */
  id: string;
  name: string;
}

export type AgentKind = "builtin" | "mcp" | "git";

export interface AgentInfo {
  id: string;
  /** Radio callsign shown in the UI, for example "KESTREL-7". */
  callsign: string;
  kind: AgentKind;
  /** Model id, for example "@cf/zai-org/glm-5.3-flash" or "claude-code". */
  model?: string;
  /** Client name for external agents: "claude-code", "codex", "cursor", … */
  client?: string;
  /** Index into the identity palette (0–11). */
  color: number;
  status: "idle" | "underway" | "waiting" | "offline";
  attemptId?: string;
  lastSeen: Millis;
}

/** A person, as gitring shows them: the account id and the name. */
export interface Person {
  id: string;
  name: string;
}
