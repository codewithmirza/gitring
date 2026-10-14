/**
 * Outbound webhooks: the signing secret of each webhook, the signature header, and the delivery with retries.
 * Called by HarborRecords.webhook (master/records.ts) and HarborSettings (master/settings.ts).
 * Never put a secret in the settings: it would reach the live state of the project.
 * Read next: master/records.ts.
 */
import { hmacSha256Hex, randomToken } from "../directory/crypto";

/**
 * Each webhook has its own secret ("whsec_…"). gitring makes it when a person adds the webhook, shows it once
 * in the answer of the settings change, and keeps it sealed in the project object (never in the settings, so
 * it never reaches the live state of the project). Each request carries
 *
 *   gitring-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 *
 * The receiver computes the same HMAC with its copy of the secret, compares, and refuses an old t.
 */
export const SIGNATURE_HEADER = "gitring-signature";
/** The seal purpose of webhook secrets (a key of its own, from GITRING_SECRET). */
export const SECRET_SEAL = "webhook-secret-v1";

/** A new signing secret: "whsec_" and 32 random bytes (base64url). */
export function newWebhookSecret(): string {
  return `whsec_${randomToken(32)}`;
}

/** The start of a secret, so that a person can tell which secret is in use ("whsec_Ab12…"). */
export function secretHint(secret: string): string {
  return `${secret.slice(0, 10)}…`;
}

/** The value of the signature header for a body at a time (milliseconds). */
export async function signatureHeader(secret: string, body: string, at = Date.now()): Promise<string> {
  const t = Math.floor(at / 1000);
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

/** The waits before the second, third and fourth try: a server error or a network error gets 3 more tries. */
export const RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
/** One try may take this long. */
const TRY_TIMEOUT_MS = 10_000;

export interface Delivery {
  ok: boolean;
  /** The number of tries. */
  tries: number;
  /** The HTTP status of the last try (absent after a network error). */
  status?: number;
  error?: string;
}

/**
 * Post a body to a webhook. A 5xx answer or a network error gets a new try after each wait of RETRY_DELAYS_MS;
 * other answers end the delivery. Each try has a fresh signature (a fresh time). Never throws.
 */
export async function deliverWebhook(
  url: string,
  body: string,
  secret: string | undefined,
  io: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; delays?: number[] } = {},
): Promise<Delivery> {
  const send = io.fetch ?? fetch;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = io.delays ?? RETRY_DELAYS_MS;
  let last: Delivery = { ok: false, tries: 0 };
  for (let n = 0; n <= delays.length; n++) {
    if (n > 0) await sleep(delays[n - 1]);
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "gitring-webhook" };
    if (secret) headers[SIGNATURE_HEADER] = await signatureHeader(secret, body, (io.now ?? Date.now)());
    try {
      const res = await send(url, { method: "POST", headers, body, signal: AbortSignal.timeout(TRY_TIMEOUT_MS) });
      await res.body?.cancel().catch(() => undefined);
      last = { ok: res.ok, tries: n + 1, status: res.status };
      if (res.status < 500) return last;
    } catch (e) {
      last = { ok: false, tries: n + 1, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }
  return last;
}
