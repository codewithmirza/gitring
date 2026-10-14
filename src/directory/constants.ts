/**
 * The fixed numbers and headers of the Directory: session and state lifetimes, limits for each person, GitHub settings.
 *
 * Read next: src/directory/layers/ (where each number is used).
 */

export const SESSION_MS = 30 * 24 * 3600_000;
export const STATE_MS = 15 * 60_000;
/** A passkey challenge works once, for 5 minutes. */
export const PASSKEY_STATE_MS = 5 * 60_000;
export const MAX_PASSKEYS_PER_USER = 20;
export const MAX_PROJECTS_PER_USER = 20;
export const MAX_KEYS_PER_USER = 20;
/** Devices with push notifications for one person. A new one replaces the oldest. */
export const MAX_PUSH_DEVICES = 10;
/** One person gets at most one push in this time: one notification says "look at the inbox". */
export const PUSH_GAP_MS = 20_000;
export const HOUR = 3_600_000;

export const GITHUB_HEADERS = {
  "User-Agent": "gitring",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

export const GITHUB_TOKEN_PURPOSE = "github-user-v1";
/** Refresh an access token when it has less than this left. */
export const GITHUB_REFRESH_EARLY_MS = 5 * 60_000;
