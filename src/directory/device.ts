/**
 * The device authorization grant (RFC 8628): the names, the codes and the limits.
 *
 * For programs on a computer where a browser sign-in is not easy: the gitring command line, or an agent on a server.
 * The store logic is in src/directory/oauth-store/devices.ts. The page is in src/worker/device.ts.
 */
import { randomToken } from "./crypto";

/*
 * The steps of a device sign-in:
 *
 *   start   POST /oauth/device_authorization gives a device code (a secret for the program) and a user
 *           code (8 letters for the person). Both work for 10 minutes.
 *   page    On /device, a signed-in person types the user code, reads what the program asks for, and
 *           allows it or not (src/worker/device.ts).
 *   token   The program asks POST /oauth/token (grant_type urn:ietf:params:oauth:grant-type:device_code)
 *           every few seconds. After "Allow" it gets an access token for /mcp and a refresh token.
 *
 * The store logic is in OAuthStore (src/directory/oauth.ts). This file holds the names and the codes.
 */

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * gitring's own command line (cli/gitring.mjs): a public client that every gitring knows. It has no
 * redirect URI, so it can only use the device grant (and refresh its tokens).
 */
export const CLI_CLIENT_ID = "gitring-cli";
export const CLI_CLIENT_NAME = "gitring command line";

/** How long a device code and its user code work. */
export const DEVICE_TTL_S = 600;
/** How long a program waits between two token requests. A program that asks sooner waits 5 seconds more. */
export const DEVICE_INTERVAL_S = 5;
/** Wrong user codes per person before the /device page stops for a while (guesses of other people's codes). */
export const DEVICE_MISSES_MAX = 10;
export const DEVICE_MISSES_WINDOW_MS = 10 * 60_000;

/** Consonants only (RFC 8628 §6.1): no words can form, and no letter looks like a digit. */
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

/** A new user code: 8 letters from the alphabet above (about 34 bits), with no bias. */
export function newUserCode(): string {
  const out: string[] = [];
  while (out.length < USER_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const b of bytes) {
      // 240 is the largest multiple of 20 below 256: higher bytes would make some letters more likely.
      if (b < 240 && out.length < USER_CODE_LENGTH) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join("");
}

/** The user code as people read it: "BCDF-GHJK". */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The user code that a person typed, in the stored form (8 capital letters), or null when it cannot be a
 * code. Spaces, dashes and lowercase letters are fine.
 */
export function normalizeUserCode(raw: string | null | undefined): string | null {
  const s = String(raw ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "");
  if (s.length !== USER_CODE_LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

/** A new device code: the secret that only the program knows. */
export function newDeviceCode(): string {
  return `god_${randomToken(32)}`;
}
