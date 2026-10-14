/**
 * Web Push for people on the go, without content (RFC 8030 with VAPID, RFC 8292).
 *
 * gitring sends an empty push message to the push service of a device. The message has no content, so
 * gitring needs no encryption keys of the device and no text leaves gitring: the service worker of the app
 * (public/sw.js) gets the push, reads GET /api/me/inbox with the cookie of the person, and shows a
 * notification. A tap opens /inbox.
 *
 * The keys of the deployment are three secrets (names only here):
 *   VAPID_PUBLIC_KEY   the P-256 public key, uncompressed (65 bytes), base64url
 *   VAPID_PRIVATE_KEY  the private scalar (32 bytes), base64url
 *   VAPID_SUBJECT      a contact for the push services: "mailto:…" or "https://…"
 * Make them with: npx web-push generate-vapid-keys. When one is absent, push is off and the app hides the switch.
 */
import type { Env } from "./env";
import { b64url, fromB64url } from "../directory/crypto";
import { publicHostname } from "../core/repo-rules";

export interface PushKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** The push keys of the deployment, or null when push is off (a key is absent or has a wrong form). */
export function pushKeys(env: Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">): PushKeys | null {
  const publicKey = String(env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = String(env.VAPID_SUBJECT ?? "").trim();
  if (!publicKey || !privateKey || !/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) return null;
  try {
    if (fromB64url(publicKey).length !== 65 || fromB64url(privateKey).length !== 32) return null;
  } catch {
    return null;
  }
  return { publicKey, privateKey, subject };
}

/**
 * A push address that gitring may send to: https, a public host, no credentials. The browser gives this address;
 * the check keeps gitring from sending requests to its own network.
 */
export function pushEndpointOk(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 1000) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && publicHostname(u.hostname);
  } catch {
    return false;
  }
}

/** The most time that one push may take. */
export const PUSH_TIMEOUT_MS = 10_000;

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

/** The signing key from the two base64url keys (WebCrypto takes a P-256 private key as a JWK). */
function signingKey(k: PushKeys): Promise<CryptoKey> {
  const id = `${k.publicKey}\u0000${k.privateKey}`;
  let key = keyCache.get(id);
  if (!key) {
    const pub = fromB64url(k.publicKey);
    const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: k.privateKey, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: false };
    key = crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    keyCache.set(id, key);
    key.catch(() => keyCache.delete(id));
  }
  return key;
}

/**
 * The Authorization header of one push (RFC 8292): a JWT signed with ES256 for the origin of the push service,
 * valid for 12 hours, and the public key.
 */
export async function vapidAuthorization(k: PushKeys, endpoint: string, now = Date.now()): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: k.subject })));
  const data = `${header}.${claims}`;
  // WebCrypto signs ECDSA in the raw form r || s (64 bytes): the form that a JWS needs.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(k), enc.encode(data)));
  return `vapid t=${data}.${b64url(sig)}, k=${k.publicKey}`;
}

/**
 * Send one empty push. "gone": the device is not subscribed any more (404 or 410), so forget the address.
 * "failed": the push service did not take it now. A push lives one day at the service, then it expires.
 */
export async function sendPush(k: PushKeys, endpoint: string, fetcher: typeof fetch = fetch): Promise<"sent" | "gone" | "failed"> {
  if (!pushEndpointOk(endpoint)) return "gone";
  try {
    const res = await fetcher(endpoint, {
      method: "POST",
      // A push service answers fast; a slow or hostile address must not hold gitring. A redirect is not followed.
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers: { authorization: await vapidAuthorization(k, endpoint), ttl: "86400", urgency: "high", "content-length": "0" },
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
