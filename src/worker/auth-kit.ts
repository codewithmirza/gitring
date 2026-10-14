/**
 * Small helpers of the sign-in files: the cookies of a browser session, of a sign-in and of a passkey, and the origin.
 *
 * Every cookie of gitring is set here, so that its rules (Secure, HttpOnly, SameSite) stay in one place.
 * Read next: src/worker/principal.ts (who is calling) and src/worker/sign-in-routes.ts.
 */
import type { C } from "./http";

// ───── Cookies ─────

export const SESSION_COOKIE = "__Host-gitring";
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, maxAge = SESSION_MAX_AGE_S): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export const SIGNIN_COOKIE = "__Host-gitring-signin";
/** Not secret: the sign-in popover shows the provider that the person used last ("Last used"). */
export const LAST_PROVIDER_COOKIE = "gitring_last";

/** The one-time passkey state of this browser (a challenge works only where it was asked for). */
export const PASSKEY_COOKIE = "__Host-gitring-passkey";

export function passkeyCookie(state: string, maxAge = 300): string {
  return `${PASSKEY_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

// ───── The request ─────

export function origin(c: C): string {
  return new URL(c.req.url).origin;
}
