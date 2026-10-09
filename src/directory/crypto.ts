/**
 * Small Web Crypto helpers for accounts: random tokens, hashes, sealed config values and the
 * RS256 JSON Web Token that a GitHub App signs. No dependencies; runs in Workers and in Node.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A random URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256B64url(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

/** Constant-time compare of two strings of the same alphabet. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ───────────── sealed values (AES-GCM, key from BEARING_SECRET via HKDF) ───────────── */

const keyCache = new Map<string, Promise<CryptoKey>>();

function sealKey(secret: string, purpose: string): Promise<CryptoKey> {
  const id = `${purpose}\u0000${secret}`;
  let k = keyCache.get(id);
  if (!k) {
    k = (async () => {
      const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("bearing"), info: enc.encode(purpose) },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(id, k);
  }
  return k;
}

/** Encrypt a JSON value. Output: base64url(12-byte IV ‖ ciphertext ‖ tag). */
export async function seal(secret: string, value: unknown, purpose = "config-v1"): Promise<string> {
  if (!secret || secret.length < 16) throw new Error("BEARING_SECRET is missing or too short (use 32 random bytes).");
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(secret, purpose), enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

export async function unseal<T>(secret: string, sealed: string, purpose = "config-v1"): Promise<T> {
  const raw = fromB64url(sealed);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await sealKey(secret, purpose), raw.slice(12));
  return JSON.parse(dec.decode(pt)) as T;
}

/* ───────────── RS256 JWT for a GitHub App ───────────── */

/** DER length bytes. */
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

/** Wrap a PKCS#1 RSAPrivateKey (BEGIN RSA PRIVATE KEY) as PKCS#8 (BEGIN PRIVATE KEY) for Web Crypto. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length)];
  const body = version.length + algId.length + octet.length + pkcs1.length;
  const head = [0x30, ...derLen(body), ...version, ...algId, ...octet];
  const out = new Uint8Array(head.length + pkcs1.length);
  out.set(head);
  out.set(pkcs1, head.length);
  return out;
}

export function pemBody(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { der, pkcs1 };
}

const appKeyCache = new Map<string, Promise<CryptoKey>>();

/** A GitHub App JWT: iss = app id, valid for 9 minutes (GitHub allows 10), backdated 60 s for clock skew. */
export async function githubAppJwt(appId: string | number, pem: string, now = Date.now()): Promise<string> {
  let key = appKeyCache.get(pem);
  if (!key) {
    const { der, pkcs1 } = pemBody(pem);
    key = crypto.subtle.importKey("pkcs8", (pkcs1 ? pkcs1ToPkcs8(der) : der) as unknown as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    appKeyCache.set(pem, key);
  }
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify({ iat, exp: iat + 9 * 60, iss: String(appId) })));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await key, enc.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(sig)}`;
}
