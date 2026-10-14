/**
 * The part of the Worker that serves the gitring command line (cli/gitring.mjs).
 *
 * The command line signs in with the device grant (src/worker/device.ts) and gets an OAuth token for /mcp.
 * That token also works for the REST routes of its commands (the list below), and for no other route.
 * It never works for settings, members, API keys or project deletion.
 * An answer to a merge question from the command line counts only when the person allows it (contract C3, answerWay).
 */
import type { Principal } from "./auth";
import { CLI_CLIENT_ID } from "../directory/device";
import { SCOPE } from "../directory/oauth";

/** The REST routes of the command line's commands: method and path. */
const CLI_ROUTES: readonly [string, RegExp][] = [
  ["GET", /^\/api\/me$/], // gitring login, gitring whoami
  ["GET", /^\/api\/me\/inbox$/], // gitring inbox
  ["GET", /^\/api\/projects$/], // gitring projects
  ["POST", /^\/api\/projects$/], // gitring new
  ["POST", /^\/api\/projects\/[^/]+\/intents$/], // gitring task
  ["POST", /^\/api\/projects\/[^/]+\/clone-token$/], // gitring clone
  ["POST", /^\/api\/projects\/[^/]+\/attempts\/[^/]+\/decide$/], // gitring yes, gitring back
  ["GET", /^\/ws\/[^/]+$/], // gitring watch
];

/** May the command line's own token call this route? */
export function cliMayCall(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return CLI_ROUTES.some(([want, re]) => want === m && re.test(path));
}

/** Is this caller gitring's own command line (signed in with its own OAuth client)? */
export function isCli(p: { via: string | null; clientId?: string }): boolean {
  return p.via === "oauth" && p.clientId === CLI_CLIENT_ID;
}

/** Where a person answers merge questions (contract C3). */
export type ApprovalsIn = "agent" | "app" | "both";

/**
 * May an answer to a merge question from the command line count as the person's answer? Only when the
 * person allows answers outside the gitring app: the preference "approvalsIn" (contract C3) is "agent" or
 * "both". The default is "both". With "app", only the gitring app counts. A read-only sign-in never answers.
 */
export function cliMayAnswer(p: { via: string | null; clientId?: string; scope?: string; user?: unknown }, approvalsIn: ApprovalsIn | undefined): boolean {
  return isCli(p) && p.scope === SCOPE && Boolean(p.user) && (approvalsIn ?? "both") !== "app";
}

/**
 * The preference of a person (contract C3), from the Directory. When the Directory cannot say (it has no
 * preferences, or the call fails), the answer is "app": an answer from outside the app must never count by mistake.
 */
export async function approvalsInOf(directory: object, userId: string): Promise<ApprovalsIn> {
  try {
    const dir = directory as { prefs(userId: string): Promise<{ approvalsIn?: unknown } | null> };
    const v = (await dir.prefs(userId))?.approvalsIn;
    return v === "agent" || v === "app" || v === "both" ? v : "both";
  } catch {
    return "app";
  }
}

/** What the command line reads when the person answers merge questions only in the gitring app. */
export const CLI_APP_ONLY = "You answer merge questions only in the gitring app. You can change this in the gitring app: Account, Merge questions.";

/**
 * How the answer of this caller to a merge question counts: "app" (a browser session) or "cli" (gitring's own
 * command line, when the person allows it). `refused`: it does not count, and the words say why.
 */
export async function answerWay(directory: object, p: Principal): Promise<{ how: "app" | "cli" } | { refused: string }> {
  if (p.via === "session" && p.user) return { how: "app" };
  if (isCli(p) && p.user) return cliMayAnswer(p, await approvalsInOf(directory, p.user.id)) ? { how: "cli" } : { refused: CLI_APP_ONLY };
  return { refused: "A person must answer in the gitring app. A key or an agent token cannot say yes for a person." };
}
