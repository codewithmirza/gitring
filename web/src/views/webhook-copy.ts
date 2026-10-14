/** The words of the webhook part of Settings: the secret of each webhook, and how a receiver checks it. */

/** How a receiver checks a request. The same header as src/harbor/webhooks.ts (SIGNATURE_HEADER). */
export const SIGNATURE_HELP =
  "gitring signs each request with the secret of its webhook. The header gitring-signature holds t=<time> and v1=<signature>. " +
  "The signature is the HMAC-SHA256 (hex) of the time, a dot and the body, with the secret as the key. " +
  "Compute the same value and compare. Refuse a request with an old time. A server error or a network error gets 3 more tries.";

/** Under a new secret, after the save. */
export const SECRET_ONCE = "Copy the secret now and give it to the receiver. gitring shows it only once.";

/**
 * The secret line of one webhook in the list. `before`: the saved webhook with the same id (absent: a new one).
 * The server makes a new secret for a new webhook, for a new URL, and when the person asks for one.
 */
export function secretLine(w: { url: string; secretHint?: string; newSecret?: boolean }, before: { url: string } | undefined): string {
  if (!before) return "gitring makes a secret for this webhook when you save.";
  if (w.newSecret || before.url !== w.url.trim()) return "gitring makes a new secret when you save. The old secret stops.";
  if (w.secretHint) return `Secret: ${w.secretHint}`;
  return "This webhook has no secret. Its requests have no signature. Make a new secret.";
}
