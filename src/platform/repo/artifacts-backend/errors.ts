/**
 * Error helpers of the Artifacts backend: error codes, errors that are worth a second try, branch conflicts.
 *
 * The service can drop custom error fields over RPC, so a code is also guessed from the message.
 */
import { type CommitInput, RepoConflictError } from "../backend";
import { GitProtocolError, PushRejectedError } from "../push";

/** The changeset path cannot do this here, and the clone path can. */
export class ChangesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangesetError";
  }
}

/** True for a failure of the changeset path that the clone path may get past (never a conflict). */
export function fallsBack(err: unknown): boolean {
  return err instanceof ChangesetError || err instanceof PushRejectedError || err instanceof GitProtocolError;
}

const MESSAGE_CODES: [RegExp, string][] = [
  [/FORK_IN_PROGRESS|fork(ing)? (is )?(already )?in progress|still forking/i, "FORK_IN_PROGRESS"],
  [/CREATE_IN_PROGRESS|still being created/i, "CREATE_IN_PROGRESS"],
  [/IMPORT_IN_PROGRESS|still importing/i, "IMPORT_IN_PROGRESS"],
  [/ALREADY_EXISTS|already exists/i, "ALREADY_EXISTS"],
  [/NOT_FOUND|not found|does not exist/i, "NOT_FOUND"],
  [/INTERNAL_ERROR|internal error occurred/i, "INTERNAL_ERROR"],
];

/** `ArtifactsError.code`, or a code guessed from the message (RPC can drop custom fields). */
export function artifactsErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (e && typeof e.code === "string") return e.code;
  const message = typeof e?.message === "string" ? e.message : "";
  for (const [re, code] of MESSAGE_CODES) if (re.test(message)) return code;
  return undefined;
}

/** Answers of a service that has a short problem. A second request usually works (the first real run saw one 500 in about 300 requests). */
export const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

/** A connection that broke (not our own time limit: waiting a second time for a slow request would take too long). */
export function transientNetworkError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return false;
  return e instanceof TypeError || /network|connection|socket|reset|fetch failed|ECONN|EAI_AGAIN/i.test(String(e?.message ?? ""));
}

export function gitErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export function branchConflict(input: Pick<CommitInput, "repo" | "branch" | "parent">, actual: string | null): RepoConflictError {
  return new RepoConflictError(
    `branch ${input.branch} of ${input.repo} is at ${actual ?? "(no commit)"}, expected ${input.parent || "(no commit)"}`,
    input.parent,
    actual,
  );
}
