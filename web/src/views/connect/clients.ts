/**
 * The agent apps that the connect page names, how a connected agent is named, and the Cursor install link.
 */
import type { AgentInfo } from "../../../../src/core/types";

export type Client = "claude" | "claude-code" | "cursor" | "codex" | "other";
export const CLIENTS: { id: Client; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "other", label: "Other" },
];
export const CLIENT_IDS = CLIENTS.map((c) => c.id);

const CLIENT_NAMES: Record<string, string> = {
  claude: "Claude",
  "claude-ai": "Claude",
  "claude.ai": "Claude",
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

export function clientName(a: AgentInfo): string {
  const c = (a.client ?? "").toLowerCase();
  return CLIENT_NAMES[c] ?? a.client ?? a.callsign;
}

export function cursorLink(url: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=gitring&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}`;
}
