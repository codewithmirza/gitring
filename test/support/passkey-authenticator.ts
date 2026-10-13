/**
 * A software authenticator for passkey tests: it makes keys with Web Crypto (Node), answers
 * navigator.credentials.create() and .get() the way a browser sends them (PublicKeyCredential.toJSON()),
 * and lets a test break one part of the answer at a time.
 */
import { b64url, fromB64url } from "../../src/directory/crypto";
import type { PasskeyCreationOptions, PasskeyRequestOptions } from "../../src/core/accounts";
import type { AssertionJSON, RegistrationJSON } from "../../src/directory/passkeys";

const enc = new TextEncoder();

/* ───────────── a small CBOR encoder (definite lengths) ───────────── */

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  if (n < 0x100000000) return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const hi = Math.floor(n / 0x100000000);
  return [(major << 5) | 27, (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function cbor(v: unknown): Uint8Array {
  const out: number[] = [];
  const put = (x: unknown) => {
    if (typeof x === "number" && Number.isInteger(x)) out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (typeof x === "string") {
      const b = enc.encode(x);
      out.push(...head(3, b.length), ...b);
    } else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      for (const i of x) put(i);
    } else if (x instanceof Map) {
      out.push(...head(5, x.size));
      for (const [k, val] of x) {
        put(k);
        put(val);
      }
    } else if (x === false) out.push(0xf4);
    else if (x === true) out.push(0xf5);
    else if (x === null) out.push(0xf6);
    else throw new Error(`cbor: cannot encode ${String(x)}`);
  };
  put(v);
  return new Uint8Array(out);
}

/* ───────────── signatures ───────────── */

/** Raw r ‖ s (Web Crypto ECDSA) → DER (WebAuthn). */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    const body = v[0] & 0x80 ? [0, ...v] : [...v];
    return [0x02, body.length, ...body];
  };
  const half = raw.length / 2;
  const seq = [...int(raw.subarray(0, half)), ...int(raw.subarray(half))];
  return new Uint8Array([0x30, seq.length, ...seq]);
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b as unknown as ArrayBuffer));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export type TestAlg = -7 | -8 | -257;

const FLAG = { up: 0x01, uv: 0x04, be: 0x08, bs: 0x10, at: 0x40, ed: 0x80 };

/** Ways to break an answer: each test changes one thing. */
export interface Tamper {
  origin?: string;
  rpId?: string;
  challenge?: string;
  type?: string;
  crossOrigin?: boolean;
  /** Leave out the user-present flag. */
  noUp?: boolean;
  /** The sign count to send (default: the next one). */
  signCount?: number;
  /** Change one byte of the signed data after the signature. */
  breakSignature?: boolean;
  /** "packed" self attestation instead of "none". */
  fmt?: "none" | "packed" | "fido-u2f";
  /** A wrong alg in the packed statement. */
  packedAlg?: number;
  /** A user handle other than the one of the account. */
  userHandle?: string | null;
}

export class SoftAuthenticator {
  readonly id: Uint8Array;
  signCount = 0;
  userHandle = "";
  private keys!: CryptoKeyPair;
  private cose!: Map<number, unknown>;

  private constructor(
    readonly alg: TestAlg,
    readonly counts: boolean,
  ) {
    this.id = crypto.getRandomValues(new Uint8Array(32));
  }

  /** A new authenticator with one key. `counts`: false for passkeys that always send sign count 0. */
  static async create(alg: TestAlg = -7, counts = true): Promise<SoftAuthenticator> {
    const a = new SoftAuthenticator(alg, counts);
    if (alg === -7) {
      a.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", a.keys.publicKey);
      a.cose = new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64url(jwk.x!)],
        [-3, fromB64url(jwk.y!)],
      ]);
    } else if (alg === -257) {
      a.keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", a.keys.publicKey);
      a.cose = new Map<number, unknown>([
        [1, 3],
        [3, -257],
        [-1, fromB64url(jwk.n!)],
        [-2, fromB64url(jwk.e!)],
      ]);
    } else {
      a.keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", a.keys.publicKey);
      a.cose = new Map<number, unknown>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, fromB64url(jwk.x!)],
      ]);
    }
    return a;
  }

  get credentialId(): string {
    return b64url(this.id);
  }

  /** The COSE public key (CBOR bytes), as it sits in authenticator data. */
  coseKey(): Uint8Array {
    return cbor(this.cose);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    if (this.alg === -7) return rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, data as unknown as ArrayBuffer)));
    if (this.alg === -257) return new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, this.keys.privateKey, data as unknown as ArrayBuffer));
    return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, this.keys.privateKey, data as unknown as ArrayBuffer));
  }

  private clientData(type: string, challenge: string, origin: string, t: Tamper): Uint8Array {
    return enc.encode(JSON.stringify({ type: t.type ?? type, challenge: t.challenge ?? challenge, origin: t.origin ?? origin, crossOrigin: t.crossOrigin ?? false }));
  }

  private async authData(rpId: string, flags: number, count: number, attested?: Uint8Array): Promise<Uint8Array> {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, count);
    return concat(await sha256(enc.encode(rpId)), new Uint8Array([flags]), c, attested ?? new Uint8Array());
  }

  /** navigator.credentials.create() for these options, at `origin`. */
  async register(options: PasskeyCreationOptions, origin: string, t: Tamper = {}): Promise<RegistrationJSON> {
    this.userHandle = options.user.id;
    const clientData = this.clientData("webauthn.create", options.challenge, origin, t);
    const idLen = new Uint8Array([this.id.length >> 8, this.id.length & 0xff]);
    const attested = concat(new Uint8Array(16), idLen, this.id, this.coseKey());
    const count = t.signCount ?? (this.counts ? ++this.signCount : 0);
    const flags = (t.noUp ? 0 : FLAG.up) | FLAG.uv | FLAG.be | FLAG.bs | FLAG.at;
    const authData = await this.authData(t.rpId ?? options.rp.id, flags, count, attested);
    const fmt = t.fmt ?? "none";
    let attStmt = new Map<string, unknown>();
    if (fmt === "packed") {
      const sig = await this.sign(concat(authData, await sha256(clientData)));
      if (t.breakSignature) sig[sig.length - 1] ^= 1;
      attStmt = new Map<string, unknown>([
        ["alg", t.packedAlg ?? this.alg],
        ["sig", sig],
      ]);
    } else if (fmt === "fido-u2f") {
      attStmt = new Map<string, unknown>([
        ["sig", new Uint8Array([1, 2, 3])],
        ["x5c", [new Uint8Array([4, 5, 6])]],
      ]);
    }
    const attestationObject = cbor(
      new Map<string, unknown>([
        ["fmt", fmt],
        ["attStmt", attStmt],
        ["authData", authData],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestationObject), transports: ["internal", "hybrid", "warp-drive"] },
    };
  }

  /** navigator.credentials.get() for these options, at `origin`. */
  async login(options: PasskeyRequestOptions, origin: string, t: Tamper = {}): Promise<AssertionJSON> {
    const clientData = this.clientData("webauthn.get", options.challenge, origin, t);
    const count = t.signCount ?? (this.counts ? ++this.signCount : 0);
    const authData = await this.authData(t.rpId ?? options.rpId, (t.noUp ? 0 : FLAG.up) | FLAG.uv, count);
    const signed = concat(authData, await sha256(clientData));
    const sig = await this.sign(signed);
    if (t.breakSignature) sig[sig.length - 1] ^= 1;
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(sig),
        userHandle: t.userHandle === undefined ? this.userHandle || null : t.userHandle,
      },
    };
  }
}
