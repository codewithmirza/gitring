/**
 * Loads the state of one project over HTTP and checks that the reply is a project state.
 * Used by the boot and by the live socket (after a reconnect that sends no snapshot).
 */
import type { ProjectState } from "../../../../src/core/types";
import type { Role } from "../../../../src/core/accounts";
import { getJson, HttpError } from "../http";

function looksLikeState(x: unknown): x is ProjectState {
  const s = x as ProjectState;
  return Boolean(s && typeof s === "object" && s.project && Array.isArray(s.intents) && Array.isArray(s.attempts));
}

/* ───────────── state ───────────── */

/** The state of a project, without the caller's role (the store keeps that apart). */
export async function fetchState(projectId: string, timeoutMs = 10_000): Promise<{ state: ProjectState; access: Role | null }> {
  const st = await getJson<unknown>(`/api/projects/${encodeURIComponent(projectId)}/state`, { timeoutMs });
  if (!looksLikeState(st)) throw new HttpError(0, "The server sent a reply that is not a project state.");
  const { access, ...state } = st as ProjectState & { access?: Role };
  return { state: state as ProjectState, access: access ?? null };
}
