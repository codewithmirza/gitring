/**
 * Small pure functions that the Directory layers share: name cleaning, URL checks and the shape of a GitHub token.
 *
 * No storage and no network here. src/worker/sign-in-page.ts imports safeReturn through directory.ts.
 */
import { sameString } from "./crypto";
import type { GithubTokenAnswer, GithubUserToken } from "./types";

/** A display name or a passkey name: one line, at most 80 characters. */
export function cleanName(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** The transports column (JSON) as a part of a credential descriptor. */
export function transportsOf(raw: string | null): { transports?: string[] } {
  if (!raw) return {};
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) && list.length ? { transports: list.filter((t): t is string => typeof t === "string") } : {};
  } catch {
    return {};
  }
}

export function normalizeRemote(url: string): string {
  return String(url ?? "").trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

export function githubUserToken(t: GithubTokenAnswer, now = Date.now()): GithubUserToken {
  return {
    access: t.access_token!,
    ...(t.refresh_token ? { refresh: t.refresh_token } : {}),
    ...(t.expires_in ? { expiresAt: now + t.expires_in * 1000 } : {}),
    ...(t.refresh_token_expires_in ? { refreshExpiresAt: now + t.refresh_token_expires_in * 1000 } : {}),
  };
}

export function sameStringSafe(a: string, b: string): boolean {
  return typeof a === "string" && typeof b === "string" && sameString(a, b);
}

/**
 * A same-site path to come back to after a sign-in, else "/". Browsers drop tabs and line breaks from
 * URLs and read "\\" as "/", so "/<tab>/evil.example" would leave the site: such paths are refused, and
 * the result must resolve to this origin.
 */
export function safeReturn(to: string): string {
  const s = String(to ?? "/").slice(0, 500);
  if (!s.startsWith("/") || s.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(s)) return "/";
  try {
    const u = new URL(s, "https://gitring.invalid");
    const out = `${u.pathname}${u.search}${u.hash}`;
    // Dot segments can turn "/.//evil.example" into "//evil.example": check the result too.
    return u.origin === "https://gitring.invalid" && out.startsWith("/") && !out.startsWith("//") && !out.includes("\\") ? out : "/";
  } catch {
    return "/";
  }
}
