/**
 * Keys, commands and state filters for callers outside the project object: hook key, pull command, viewer state.
 * Called by the Worker (src/worker/index.ts) and by ../master/records.ts. Never let a viewer see webhook addresses.
 */
import type * as T from "../../core/types";
import { hmacSha256Hex } from "../../directory/crypto";

/**
 * The key in a plain webhook URL of one project (/hooks/slack, /hooks/github): the shared secret of the
 * deployment, bound to the project. Someone who knows the shared secret still cannot aim a hook at
 * another project.
 */
export async function hookKey(secret: string, kind: "slack" | "github", projectId: string): Promise<string> {
  return (await hmacSha256Hex(secret, `hook:${kind}:${projectId}`)).slice(0, 32);
}

/**
 * The command that merges main into a git work copy. The token goes in an HTTP header and not in the remote
 * URL: git writes a remote URL to FETCH_HEAD and prints it in errors, and a shell keeps it in its history.
 */
export function gitPullCommand(remote: string, token: string, branch: string): string {
  const secret = token.split("?expires=")[0];
  return `git -c http.extraHeader="Authorization: Basic ${btoa(`x:${secret}`)}" pull --no-rebase ${remote} ${branch}`;
}

/** The project state for a viewer: outbound webhook addresses (they can hold secrets) stay with members. */
export function viewerState(state: T.ProjectState): T.ProjectState {
  return { ...state, project: { ...state.project, settings: { ...state.project.settings, webhooks: [] } } };
}

/** One event as a viewer gets it. Add a case here for every event that carries member-only data. */
export function forViewer(ev: T.GitringEvent): T.GitringEvent {
  switch (ev.type) {
    case "snapshot":
      return { ...ev, state: viewerState(ev.state) };
    default:
      return ev;
  }
}
