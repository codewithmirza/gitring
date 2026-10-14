/**
 * The gitring command line (cli/gitring.mjs) in the Worker.
 *
 * The command line signs in with the device grant (src/worker/device.ts) and gets an OAuth token for /mcp.
 * OAuth tokens of other apps work only at the MCP endpoint they were issued for (RFC 8707). The token of
 * gitring's own command line also works for the REST routes of its commands, and only for these: the
 * list below. It never works for settings, members, API keys or project deletion.
 */
import { CLI_CLIENT_ID } from "../directory/device";

/** The REST routes of the command line's commands: method and path. */
const CLI_ROUTES: readonly [string, RegExp][] = [
  ["GET", /^\/api\/me$/], // gitring login, gitring whoami
  ["GET", /^\/api\/me\/inbox$/], // gitring inbox
  ["GET", /^\/api\/projects$/], // gitring projects
  ["POST", /^\/api\/projects$/], // gitring new
  ["POST", /^\/api\/projects\/[^/]+\/intents$/], // gitring task
  ["POST", /^\/api\/projects\/[^/]+\/clone-token$/], // gitring clone
  ["POST", /^\/api\/projects\/[^/]+\/attempts\/[^/]+\/decide$/], // gitring yes, gitring back
  ["POST", /^\/api\/projects\/[^/]+\/questions\/[^/]+\/answer$/], // gitring yes on a question
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

/**
 * May an answer to a merge question from the command line count as the person's answer? Only when the
 * person allows answers outside the gitring app: the preference "approvalsIn" (contract C3) is "agent" or
 * "both". The default is "both". With "app", only the gitring app counts.
 */
export function cliMayAnswer(p: { via: string | null; clientId?: string; user?: unknown }, approvalsIn: "agent" | "app" | "both" | undefined): boolean {
  return isCli(p) && Boolean(p.user) && (approvalsIn ?? "both") !== "app";
}
