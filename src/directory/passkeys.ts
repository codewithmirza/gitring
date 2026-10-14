/**
 * The WebAuthn checks for passkeys: read a new passkey and check a sign-in. No storage.
 *
 * A person signs in with a key on their own device, and gitring needs no outside account.
 * Web Crypto only, no dependencies. It runs in Workers and in Node.
 * Read next: src/directory/layers/passkey-accounts.ts (where the passkeys are kept).
 */
import { b64url, fromB64url, sameString } from "./crypto";

/*
 * The parts of this file:
 *
 *   CBOR      a small decoder for the attestation object and COSE keys (definite lengths only)
 *   COSE      public keys → JWK: ES256 (-7), EdDSA with Ed25519 (-8), RS256 (-257)
 *   register  clientDataJSON (type, challenge, origin), authenticator data (RP id hash, user present,
 *             attested credential), attestation "none" or "packed" self attestation
 *   sign in   the same checks, the signature over authenticatorData ‖ SHA-256(clientDataJSON) and the
 *             sign count (a counter that goes back can mean a copied key)
 *
 * gitring asks for no attestation and trusts no attestation chain: a "packed" statement with
 * certificates, or another format, counts as "none". The RP id is the host name of the request.
 * The Directory keeps the credentials (table passkeys) and the one-time challenges (table states).
 */

export const PASSKEY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL, transports TEXT, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER)`,
  `CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id)`,
];

/** COSE algorithms that gitring accepts, in the order of preference that it sends to the browser. */
export const PASSKEY_ALGS = [-7, -8, -257] as const;
export type PasskeyAlg = (typeof PASSKEY_ALGS)[number];

/** Transports that the browser may report (WebAuthn AuthenticatorTransport). */
const TRANSPORTS = new Set(["usb", "nfc", "ble", "internal", "hybrid", "smart-card"]);

/** A passkey answer that gitring refuses. The message is for people (one or two short sentences). */
export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyError";
  }
}

const INCOMPLETE = "The passkey answer is not complete. Try again.";
const OTHER_SITE = "The passkey answer is for another site. Use a passkey of this gitring.";
const UNSUPPORTED = "This passkey uses a key type that gitring does not support. Use another passkey.";

const enc = new TextEncoder();

/* ───────────── CBOR (RFC 8949), the part that WebAuthn uses ───────────── */

const MAX_DEPTH = 16;

/**
 * Decode one CBOR item at `start`. Maps become `Map` (keys: numbers or strings), byte strings become
 * Uint8Array. Indefinite lengths, duplicate map keys and integers above 2^53 are refused.
 */
export function decodeCborItem(bytes: Uint8Array, start = 0): { value: unknown; end: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = start;
  const need = (n: number) => {
    if (n < 0 || pos + n > bytes.length) throw new PasskeyError(INCOMPLETE);
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return bytes[pos++];
    }
    if (info === 25) {
      need(2);
      const v = view.getUint16(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = view.getUint32(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = view.getBigUint64(pos);
      pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new PasskeyError(INCOMPLETE);
      return Number(v);
    }
    // 28-30 are reserved; 31 is an indefinite length, which WebAuthn data does not use.
    throw new PasskeyError(INCOMPLETE);
  };
  const item = (depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new PasskeyError(INCOMPLETE);
    need(1);
    const head = bytes[pos++];
    const major = head >> 5;
    const info = head & 31;
    if (major === 7) return simple(info);
    const n = length(info);
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2: {
        need(n);
        const out = bytes.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        need(n);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(pos, pos + n));
        } catch {
          throw new PasskeyError(INCOMPLETE);
        }
        pos += n;
        return text;
      }
      case 4: {
        // Each item takes one byte at least: a longer count is a lie.
        need(n);
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        need(2 * n);
        const out = new Map<number | string, unknown>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          if ((typeof k !== "number" && typeof k !== "string") || out.has(k)) throw new PasskeyError(INCOMPLETE);
          out.set(k, item(depth + 1));
        }
        return out;
      }
      default:
        // Major type 6: a tag. The tagged value counts.
        return item(depth + 1);
    }
  };
  const simple = (info: number): unknown => {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22) return null;
    if (info === 23) return undefined;
    if (info === 25) {
      need(2);
      const h = view.getUint16(pos);
      pos += 2;
      return half(h);
    }
    if (info === 26) {
      need(4);
      const v = view.getFloat32(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = view.getFloat64(pos);
      pos += 8;
      return v;
    }
    throw new PasskeyError(INCOMPLETE);
  };
  const value = item(0);
  return { value, end: pos };
}

/** Decode a buffer that holds exactly one CBOR item. */
export function decodeCbor(bytes: Uint8Array): unknown {
  const { value, end } = decodeCborItem(bytes, 0);
  if (end !== bytes.length) throw new PasskeyError(INCOMPLETE);
  return value;
}

function half(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/* ───────────── COSE keys → JWK ───────────── */

function bytesOf(v: unknown, size?: number): Uint8Array {
  if (!(v instanceof Uint8Array) || (size !== undefined && v.length !== size)) throw new PasskeyError(UNSUPPORTED);
  return v;
}

/**
 * A COSE_Key (RFC 9052/9053) as a JWK: EC2 P-256 with ES256, OKP Ed25519 with EdDSA, RSA with RS256
 * (2048 to 8192 bits: a larger key only makes each check slow). Other keys are refused.
 */
export function coseToJwk(key: unknown): { jwk: JsonWebKey; alg: PasskeyAlg } {
  if (!(key instanceof Map)) throw new PasskeyError(INCOMPLETE);
  const kty = key.get(1);
  const alg = key.get(3);
  if (alg === -7 && kty === 2 && key.get(-1) === 1) {
    return { jwk: { kty: "EC", crv: "P-256", x: b64url(bytesOf(key.get(-2), 32)), y: b64url(bytesOf(key.get(-3), 32)) }, alg };
  }
  if (alg === -8 && kty === 1 && key.get(-1) === 6) {
    return { jwk: { kty: "OKP", crv: "Ed25519", x: b64url(bytesOf(key.get(-2), 32)) }, alg };
  }
  if (alg === -257 && kty === 3) {
    const n = bytesOf(key.get(-1));
    const e = bytesOf(key.get(-2));
    // A leading zero byte does not count: the modulus must have 2048 bits at least.
    const bits = n.length * 8 - (n[0] === 0 ? 8 : 0);
    if (bits < 2048 || bits > 8192 || e.length < 1 || e.length > 8) throw new PasskeyError(UNSUPPORTED);
    return { jwk: { kty: "RSA", n: b64url(n), e: b64url(e) }, alg };
  }
  throw new PasskeyError(UNSUPPORTED);
}

function importParams(alg: PasskeyAlg) {
  if (alg === -7) return { name: "ECDSA", namedCurve: "P-256" };
  if (alg === -257) return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  return { name: "Ed25519" };
}

function verifyParams(alg: PasskeyAlg) {
  if (alg === -7) return { name: "ECDSA", hash: "SHA-256" };
  if (alg === -257) return { name: "RSASSA-PKCS1-v1_5" };
  return { name: "Ed25519" };
}

/** The public key of a passkey for crypto.subtle.verify. Throws when the key is not valid. */
export async function importPasskeyKey(jwk: JsonWebKey, alg: PasskeyAlg): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, importParams(alg), false, ["verify"]);
}

/**
 * An ECDSA signature in DER (SEQUENCE of two INTEGERs, as WebAuthn sends it) → raw r ‖ s, each `size`
 * bytes (as Web Crypto wants it).
 */
export function derToRaw(sig: Uint8Array, size = 32): Uint8Array {
  let pos = 0;
  const fail = () => new PasskeyError("The passkey signature is not valid.");
  const readLen = (): number => {
    if (pos >= sig.length) throw fail();
    const first = sig[pos++];
    if (first < 0x80) return first;
    if (first !== 0x81 || pos >= sig.length) throw fail();
    return sig[pos++];
  };
  if (sig[pos++] !== 0x30) throw fail();
  if (readLen() !== sig.length - pos) throw fail();
  const out = new Uint8Array(size * 2);
  for (const at of [0, size]) {
    if (sig[pos++] !== 0x02) throw fail();
    const n = readLen();
    if (n < 1 || pos + n > sig.length) throw fail();
    let int = sig.subarray(pos, pos + n);
    pos += n;
    while (int.length > 1 && int[0] === 0) int = int.subarray(1);
    if (int.length > size) throw fail();
    out.set(int, at + size - int.length);
  }
  if (pos !== sig.length) throw fail();
  return out;
}

/** True when `sig` is a valid signature of `data` by the passkey. A broken signature is false, not an error. */
export async function verifyPasskeySignature(jwk: JsonWebKey, alg: PasskeyAlg, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    const key = await importPasskeyKey(jwk, alg);
    const raw = alg === -7 ? derToRaw(sig) : sig;
    return await crypto.subtle.verify(verifyParams(alg), key, raw as unknown as ArrayBuffer, data as unknown as ArrayBuffer);
  } catch {
    return false;
  }
}

/* ───────────── authenticator data and client data ───────────── */

export interface AuthData {
  rpIdHash: Uint8Array;
  /** UP: a person touched the authenticator. UV: the authenticator checked who it is (PIN, biometrics). */
  flags: { up: boolean; uv: boolean; backupEligible: boolean; backedUp: boolean; attested: boolean; extensions: boolean };
  signCount: number;
  /** Registration only: the new credential. */
  credential?: { aaguid: Uint8Array; id: Uint8Array; publicKey: unknown };
}

/** Parse authenticator data (WebAuthn §6.1). Trailing bytes are refused. */
export function parseAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) throw new PasskeyError(INCOMPLETE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f = bytes[32];
  const flags = { up: Boolean(f & 0x01), uv: Boolean(f & 0x04), backupEligible: Boolean(f & 0x08), backedUp: Boolean(f & 0x10), attested: Boolean(f & 0x40), extensions: Boolean(f & 0x80) };
  const out: AuthData = { rpIdHash: bytes.slice(0, 32), flags, signCount: view.getUint32(33) };
  let pos = 37;
  if (flags.attested) {
    if (bytes.length < pos + 18) throw new PasskeyError(INCOMPLETE);
    const aaguid = bytes.slice(pos, pos + 16);
    const idLen = view.getUint16(pos + 16);
    pos += 18;
    if (idLen < 1 || idLen > 1023 || pos + idLen > bytes.length) throw new PasskeyError(INCOMPLETE);
    const id = bytes.slice(pos, pos + idLen);
    pos += idLen;
    const key = decodeCborItem(bytes, pos);
    pos = key.end;
    out.credential = { aaguid, id, publicKey: key.value };
  }
  if (flags.extensions) {
    const ext = decodeCborItem(bytes, pos);
    if (!(ext.value instanceof Map)) throw new PasskeyError(INCOMPLETE);
    pos = ext.end;
  }
  if (pos !== bytes.length) throw new PasskeyError(INCOMPLETE);
  return out;
}

export interface PasskeyExpect {
  /** The challenge that gitring sent (base64url). */
  challenge: string;
  /** The origin of the page, for example https://gitring.example.com. */
  origin: string;
  /** The RP id: the host name of the page. */
  rpId: string;
}

/** clientDataJSON (WebAuthn §5.8.1): type, challenge and origin must be the ones of this ceremony. */
export function checkClientData(raw: Uint8Array, type: "webauthn.create" | "webauthn.get", want: PasskeyExpect): void {
  let c: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    c = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as typeof c;
  } catch {
    throw new PasskeyError(INCOMPLETE);
  }
  if (!c || typeof c !== "object") throw new PasskeyError(INCOMPLETE);
  if (c.type !== type) throw new PasskeyError(type === "webauthn.create" ? "The passkey answer is not for a new passkey. Try again." : "The passkey answer is not a sign-in. Try again.");
  if (typeof c.challenge !== "string" || !sameString(c.challenge, want.challenge)) throw new PasskeyError("The passkey answer is for another request. Start again.");
  if (c.origin !== want.origin) throw new PasskeyError(OTHER_SITE);
  if (c.crossOrigin === true) throw new PasskeyError("The passkey answer came from a frame of another site. Open gitring directly.");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

async function checkAuthData(auth: AuthData, rpId: string): Promise<void> {
  const want = await sha256(enc.encode(rpId));
  if (b64url(auth.rpIdHash) !== b64url(want)) throw new PasskeyError(OTHER_SITE);
  if (!auth.flags.up) throw new PasskeyError("The passkey did not confirm that a person is present. Touch the key or unlock the device, then try again.");
  // WebAuthn §6.1.3: a passkey that cannot have a backup (BE not set) cannot be backed up (BS set).
  if (auth.flags.backedUp && !auth.flags.backupEligible) throw new PasskeyError(INCOMPLETE);
}

/* ───────────── the JSON that the browser sends ───────────── */

/** PublicKeyCredential.toJSON() of navigator.credentials.create(): bytes are base64url strings. */
export interface RegistrationJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

/** PublicKeyCredential.toJSON() of navigator.credentials.get(). */
export interface AssertionJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

const B64URL = /^[A-Za-z0-9_-]*$/;

function field(o: unknown, key: string, max: number): string {
  const v = (o as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string" || !v || v.length > max || !B64URL.test(v)) throw new PasskeyError(INCOMPLETE);
  return v;
}

function bytesField(o: unknown, key: string, max: number): Uint8Array {
  try {
    return fromB64url(field(o, key, max));
  } catch (e) {
    if (e instanceof PasskeyError) throw e;
    throw new PasskeyError(INCOMPLETE);
  }
}

/** The credential id of a browser answer (base64url), checked for shape only. */
export function credentialIdOf(cred: unknown): string {
  const id = field(cred, "id", 1400);
  if ((cred as { type?: unknown }).type !== "public-key") throw new PasskeyError(INCOMPLETE);
  return id;
}

/* ───────────── ceremonies ───────────── */

export interface NewPasskey {
  /** Credential id, base64url. */
  id: string;
  jwk: JsonWebKey;
  alg: PasskeyAlg;
  signCount: number;
  transports: string[];
  /** The authenticator checked the person (PIN, biometrics). */
  uv: boolean;
}

/**
 * Check the answer of navigator.credentials.create() (WebAuthn §7.1) and return the new passkey.
 * Throws PasskeyError with a sentence for people when the answer is refused.
 */
export async function verifyRegistration(cred: unknown, want: PasskeyExpect): Promise<NewPasskey> {
  const id = credentialIdOf(cred);
  if (field(cred, "rawId", 1400) !== id) throw new PasskeyError(INCOMPLETE);
  const r = (cred as { response?: unknown }).response;
  const clientData = bytesField(r, "clientDataJSON", 4096);
  checkClientData(clientData, "webauthn.create", want);
  const att = decodeCbor(bytesField(r, "attestationObject", 16384));
  if (!(att instanceof Map)) throw new PasskeyError(INCOMPLETE);
  const fmt = att.get("fmt");
  const stmt = att.get("attStmt");
  const authBytes = att.get("authData");
  if (typeof fmt !== "string" || !(stmt instanceof Map) || !(authBytes instanceof Uint8Array)) throw new PasskeyError(INCOMPLETE);
  const auth = parseAuthData(authBytes);
  await checkAuthData(auth, want.rpId);
  if (!auth.credential) throw new PasskeyError(INCOMPLETE);
  if (b64url(auth.credential.id) !== id) throw new PasskeyError(INCOMPLETE);
  const { jwk, alg } = coseToJwk(auth.credential.publicKey);
  try {
    await importPasskeyKey(jwk, alg);
  } catch {
    throw new PasskeyError(UNSUPPORTED);
  }
  if (fmt === "packed" && !stmt.has("x5c")) {
    // Self attestation: the new key signs authData ‖ SHA-256(clientDataJSON) with its own algorithm.
    const sig = stmt.get("sig");
    const signed = concat(authBytes, await sha256(clientData));
    if (stmt.get("alg") !== alg || !(sig instanceof Uint8Array) || !(await verifyPasskeySignature(jwk, alg, sig, signed))) {
      throw new PasskeyError("The passkey attestation is not valid. Try again, or use another passkey.");
    }
  }
  // "none", "packed" with certificates and other formats: gitring asked for no attestation and trusts
  // no certificate chain, so the passkey counts as one without attestation.
  const listed = (r as { transports?: unknown }).transports;
  const transports = Array.isArray(listed) ? [...new Set(listed.filter((t): t is string => typeof t === "string" && TRANSPORTS.has(t)))] : [];
  return { id, jwk, alg, signCount: auth.signCount, transports, uv: auth.flags.uv };
}

/**
 * Check the answer of navigator.credentials.get() (WebAuthn §7.2) against a stored passkey. Returns the
 * new sign count. A sign count that does not go up (when the authenticator counts at all) is refused.
 */
export async function verifyAssertion(
  cred: unknown,
  want: PasskeyExpect,
  stored: { jwk: JsonWebKey; alg: PasskeyAlg; signCount: number },
): Promise<{ signCount: number; uv: boolean; userHandle: string | null }> {
  const id = credentialIdOf(cred);
  if (field(cred, "rawId", 1400) !== id) throw new PasskeyError(INCOMPLETE);
  const r = (cred as { response?: unknown }).response;
  const clientData = bytesField(r, "clientDataJSON", 4096);
  checkClientData(clientData, "webauthn.get", want);
  const authBytes = bytesField(r, "authenticatorData", 4096);
  const auth = parseAuthData(authBytes);
  await checkAuthData(auth, want.rpId);
  const sig = bytesField(r, "signature", 1024);
  if (!(await verifyPasskeySignature(stored.jwk, stored.alg, sig, concat(authBytes, await sha256(clientData))))) {
    throw new PasskeyError("The passkey signature is not valid. gitring did not sign you in.");
  }
  if (!signCountOk(stored.signCount, auth.signCount)) {
    throw new PasskeyError("The passkey counter went back. This can mean a copy of the passkey. gitring did not sign you in.");
  }
  const handle = (r as { userHandle?: unknown }).userHandle;
  const userHandle = typeof handle === "string" && handle && B64URL.test(handle) ? handle : null;
  return { signCount: auth.signCount, uv: auth.flags.uv, userHandle };
}

/**
 * WebAuthn §7.2 step 21: when the authenticator counts (either number is not 0), the new count must be
 * larger than the stored one. Many passkeys always send 0: that is not a copy.
 */
export function signCountOk(stored: number, next: number): boolean {
  if (stored === 0 && next === 0) return true;
  return next > stored;
}

/**
 * A first name for a new passkey, from the browser's User-Agent: "Passkey (Windows)". The person can
 * rename it on the Account page.
 */
export function passkeyLabel(userAgent: string | null | undefined): string {
  const ua = String(userAgent ?? "");
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Mac OS X|Macintosh/.test(ua)
              ? "Mac"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
  return device ? `Passkey (${device})` : "Passkey";
}

/** The WebAuthn user handle of a gitring person: the UTF-8 bytes of the user id, base64url. */
export function userHandleOf(userId: string): string {
  return b64url(enc.encode(userId));
}
