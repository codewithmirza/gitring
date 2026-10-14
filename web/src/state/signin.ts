/**
 * The addresses that start a sign-in, and the order of the sign-in choices.
 * A small module of its own: the shell (main bundle) needs them, and it should not load the GitHub data module for that.
 */
import type { Provider, SignInKind } from "../../../src/core/accounts";

/**
 * The address that signs in with GitHub, or connects GitHub to the signed-in account (link=1: the
 * Worker ignores it for a visitor), then comes back to `returnTo`.
 */
export function githubConnectUrl(returnTo: string): string {
  return `/auth/github/start?link=1&return=${encodeURIComponent(returnTo)}`;
}

/** Sign in with GitHub (a visitor). */
export function githubSignInUrl(returnTo: string): string {
  return `/auth/github/start?return=${encodeURIComponent(returnTo)}`;
}

export function googleSignInUrl(returnTo: string): string {
  return `/auth/google/start?return=${encodeURIComponent(returnTo)}`;
}

/**
 * The outside providers that this gitring has, in a neutral order: the one used last first, then the
 * others alphabetically by name. Passkeys come before all of them (they need no outside account).
 */
export function orderedProviders(available: { github: boolean; google: boolean }, last: SignInKind | null): Provider[] {
  const list = (["github", "google"] as Provider[]).filter((p) => available[p]);
  return last && last !== "passkey" && list.includes(last) ? [last, ...list.filter((p) => p !== last)] : list;
}
