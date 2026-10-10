/**
 * Addresses that start a sign-in. A small module of its own: the shell (main bundle) needs them, and it
 * should not load the GitHub data module for that.
 */

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
