/**
 * Passkeys (WebAuthn), the parts without the Directory: the CBOR decoder, COSE keys → JWK, signature
 * checks, authenticator data, and the checks of a registration and a sign-in answer. Keys are made in
 * the test with Web Crypto (Node), by a software authenticator (test/support/passkey-authenticator.ts).
 */
import { describe, expect, it } from "vitest";
import { b64url, fromB64url } from "../../src/directory/crypto";
import {
  checkClientData,
  coseToJwk,
  decodeCbor,
  decodeCborItem,
  derToRaw,
  parseAuthData,
  passkeyLabel,
  PasskeyError,
  signCountOk,
  userHandleOf,
  verifyAssertion,
  verifyPasskeySignature,
  verifyRegistration,
  type PasskeyAlg,
} from "../../src/directory/passkeys";
import type { PasskeyCreationOptions, PasskeyRequestOptions } from "../../src/core/accounts";
import { cbor, rawToDer, SoftAuthenticator, type Tamper } from "../support/passkey-authenticator";
import { steViolations } from "../coord/ste";

const ORIGIN = "https://gitring.example.com";
const RP = "gitring.example.com";
const hex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

function createOptions(challenge = b64url(crypto.getRandomValues(new Uint8Array(32)))): PasskeyCreationOptions {
  return {
    challenge,
    rp: { id: RP, name: "gitring" },
    user: { id: userHandleOf("u_robin00001"), name: "Robin", displayName: "Robin" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: 300000,
    attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
    excludeCredentials: [],
  };
}

function requestOptions(challenge = b64url(crypto.getRandomValues(new Uint8Array(32)))): PasskeyRequestOptions {
  return { challenge, rpId: RP, timeout: 300000, userVerification: "preferred", allowCredentials: [] };
}

/** Messages that people see must follow the STE rules. */
const refusals: string[] = [];
async function refused(p: Promise<unknown>, match: RegExp): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(PasskeyError);
  expect((e as Error).message).toMatch(match);
  refusals.push((e as Error).message);
}

describe("CBOR", () => {
  it("decodes the items that WebAuthn uses (RFC 8949 Appendix A)", () => {
    expect(decodeCbor(hex("00"))).toBe(0);
    expect(decodeCbor(hex("17"))).toBe(23);
    expect(decodeCbor(hex("1818"))).toBe(24);
    expect(decodeCbor(hex("1903e8"))).toBe(1000);
    expect(decodeCbor(hex("1a000f4240"))).toBe(1000000);
    expect(decodeCbor(hex("1b000000e8d4a51000"))).toBe(1000000000000);
    expect(decodeCbor(hex("20"))).toBe(-1);
    expect(decodeCbor(hex("3863"))).toBe(-100);
    expect(decodeCbor(hex("390100"))).toBe(-257);
    expect(decodeCbor(hex("4401020304"))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(decodeCbor(hex("6449455446"))).toBe("IETF");
    expect(decodeCbor(hex("62c3bc"))).toBe("ü");
    expect(decodeCbor(hex("83010203"))).toEqual([1, 2, 3]);
    expect(decodeCbor(hex("8301820203820405"))).toEqual([1, [2, 3], [4, 5]]);
    expect(decodeCbor(hex("a201020304"))).toEqual(
      new Map([
        [1, 2],
        [3, 4],
      ]),
    );
    expect(decodeCbor(hex("a26161016162820203"))).toEqual(
      new Map<string, unknown>([
        ["a", 1],
        ["b", [2, 3]],
      ]),
    );
    expect(decodeCbor(hex("f4"))).toBe(false);
    expect(decodeCbor(hex("f5"))).toBe(true);
    expect(decodeCbor(hex("f6"))).toBeNull();
    expect(decodeCbor(hex("f7"))).toBeUndefined();
    expect(decodeCbor(hex("f93c00"))).toBe(1);
    expect(decodeCbor(hex("f9c400"))).toBe(-4);
    expect(decodeCbor(hex("f97c00"))).toBe(Infinity);
    expect(decodeCbor(hex("fa47c35000"))).toBe(100000);
    expect(decodeCbor(hex("fb3ff199999999999a"))).toBe(1.1);
    // A tag: the tagged value counts.
    expect(decodeCbor(hex("c11a514b67b0"))).toBe(1363896240);
  });

  it("tells where an item ends (authenticator data holds a key, then more)", () => {
    const bytes = new Uint8Array([...cbor(new Map([[1, 2]])), 0xaa, 0xbb]);
    expect(decodeCborItem(bytes, 0)).toEqual({ value: new Map([[1, 2]]), end: 3 });
    expect(() => decodeCbor(bytes)).toThrow(PasskeyError);
  });

  it("refuses broken or hostile input", () => {
    for (const bad of [
      "", // nothing
      "5f42010243030405ff", // indefinite byte string
      "9fff", // indefinite array
      "1c", // reserved length
      "1b0020000000000000", // above 2^53
      "4401020", // short byte string (odd hex: ignored nibble)
      "8301", // array with fewer items than its count
      "9b00000000ffffffff", // a count longer than the input
      "a201020103", // duplicate key
      "a1f601", // a key that is not a number or a string
      "62c328", // text that is not UTF-8
      "f8ff", // simple value that WebAuthn does not use
    ]) {
      expect(() => decodeCbor(hex(bad)), bad).toThrow(PasskeyError);
    }
    // Deep nesting stops.
    expect(() => decodeCbor(new Uint8Array(40).fill(0x81))).toThrow(PasskeyError);
  });
});

describe("COSE keys", () => {
  it("turns ES256, EdDSA and RS256 keys into JWKs that Web Crypto accepts", async () => {
    for (const alg of [-7, -8, -257] as const) {
      const a = await SoftAuthenticator.create(alg);
      const { jwk, alg: got } = coseToJwk(decodeCbor(a.coseKey()));
      expect(got).toBe(alg);
      const data = new TextEncoder().encode(`data for ${alg}`);
      expect(await verifyPasskeySignature(jwk, alg, await a.sign(data), data)).toBe(true);
      // A changed byte breaks the signature.
      const other = data.slice();
      other[0] ^= 1;
      expect(await verifyPasskeySignature(jwk, alg, await a.sign(data), other)).toBe(false);
    }
  });

  it("refuses keys that gitring does not support", () => {
    const x = new Uint8Array(32).fill(1);
    const cases: Map<number, unknown>[] = [
      new Map<number, unknown>([[1, 2], [3, -35], [-1, 2], [-2, new Uint8Array(48)], [-3, new Uint8Array(48)]]), // ES384 on P-384
      new Map<number, unknown>([[1, 2], [3, -7], [-1, 2], [-2, x], [-3, x]]), // ES256 alg, but curve P-384
      new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(31)], [-3, x]]), // short x
      new Map<number, unknown>([[1, 3], [3, -257], [-1, new Uint8Array(128).fill(0xff)], [-2, new Uint8Array([1, 0, 1])]]), // RSA 1024
      new Map<number, unknown>([[1, 3], [3, -257], [-1, new Uint8Array(1025).fill(0xff)], [-2, new Uint8Array([1, 0, 1])]]), // RSA 8200
      new Map<number, unknown>([[1, 1], [3, -8], [-1, 4], [-2, x]]), // OKP, but X25519
      new Map<number, unknown>([[1, 2], [-1, 1], [-2, x], [-3, x]]), // no alg
    ];
    for (const key of cases) expect(() => coseToJwk(key)).toThrow(/key type that gitring does not support/);
    expect(() => coseToJwk([1, 2])).toThrow(PasskeyError);
  });
});

describe("ECDSA signatures", () => {
  it("turn DER into raw r ‖ s, also with leading zeros and high bits", () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80; // r needs a 0x00 byte in DER
    raw[31] = 7;
    raw[33] = 0x01; // s is shorter than 32 bytes in DER
    raw[63] = 9;
    const der = rawToDer(raw);
    expect(der[0]).toBe(0x30);
    expect(derToRaw(der)).toEqual(raw);
  });

  it("refuse broken DER", () => {
    for (const bad of ["31060201010201 01", "3006020101020201", "300602010102010100", "3006030101020101", "30060221010201 01"]) {
      expect(() => derToRaw(hex(bad.replace(/\s/g, "")))).toThrow(PasskeyError);
    }
  });
});

describe("authenticator data", () => {
  it("reads the RP id hash, the flags, the sign count and the new credential", async () => {
    const a = await SoftAuthenticator.create();
    const reg = await a.register(createOptions(), ORIGIN);
    const att = decodeCbor(fromB64url(reg.response.attestationObject)) as Map<string, unknown>;
    const auth = parseAuthData(att.get("authData") as Uint8Array);
    expect(auth.flags).toEqual({ up: true, uv: true, backupEligible: true, backedUp: true, attested: true, extensions: false });
    expect(auth.signCount).toBe(1);
    expect(b64url(auth.credential!.id)).toBe(a.credentialId);
    expect(auth.rpIdHash).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP))));
  });

  it("reads extensions and refuses trailing bytes and short data", () => {
    const base = new Uint8Array(37);
    base[32] = 0x81; // UP and ED
    const withExt = new Uint8Array([...base, ...cbor(new Map([["credProtect", 2]]))]);
    expect(parseAuthData(withExt).flags.extensions).toBe(true);
    expect(() => parseAuthData(new Uint8Array([...withExt, 0]))).toThrow(PasskeyError);
    expect(() => parseAuthData(new Uint8Array(36))).toThrow(PasskeyError);
    const attested = new Uint8Array(37);
    attested[32] = 0x41; // UP and AT, but no credential data
    expect(() => parseAuthData(attested)).toThrow(PasskeyError);
  });
});

describe("client data", () => {
  const want = { challenge: "abc", origin: ORIGIN, rpId: RP };
  const cd = (o: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: "abc", origin: ORIGIN, ...o }));
  it("must have the type, challenge and origin of the ceremony", () => {
    expect(() => checkClientData(cd({}), "webauthn.get", want)).not.toThrow();
    expect(() => checkClientData(cd({ type: "webauthn.create" }), "webauthn.get", want)).toThrow(/not a sign-in/);
    expect(() => checkClientData(cd({ challenge: "abd" }), "webauthn.get", want)).toThrow(/another request/);
    expect(() => checkClientData(cd({ origin: "https://evil.example" }), "webauthn.get", want)).toThrow(/another site/);
    expect(() => checkClientData(cd({ origin: "http://gitring.example.com" }), "webauthn.get", want)).toThrow(/another site/);
    expect(() => checkClientData(cd({ crossOrigin: true }), "webauthn.get", want)).toThrow(/frame of another site/);
    expect(() => checkClientData(new TextEncoder().encode("{not json"), "webauthn.get", want)).toThrow(/not complete/);
  });
});

describe("registration", () => {
  const want = (o: PasskeyCreationOptions) => ({ challenge: o.challenge, origin: ORIGIN, rpId: RP });

  it("accepts attestation none, packed self attestation and unchecked formats, with each key type", async () => {
    for (const alg of [-7, -8, -257] as PasskeyAlg[]) {
      for (const fmt of ["none", "packed", "fido-u2f"] as const) {
        const a = await SoftAuthenticator.create(alg);
        const o = createOptions();
        const pk = await verifyRegistration(await a.register(o, ORIGIN, { fmt }), want(o));
        expect(pk.id).toBe(a.credentialId);
        expect(pk.alg).toBe(alg);
        expect(pk.signCount).toBe(1);
        expect(pk.uv).toBe(true);
        // Unknown transports are dropped.
        expect(pk.transports).toEqual(["internal", "hybrid"]);
        const data = new TextEncoder().encode("check");
        expect(await verifyPasskeySignature(pk.jwk, pk.alg, await a.sign(data), data)).toBe(true);
      }
    }
  });

  it("refuses answers that do not belong to this request or this site", async () => {
    const a = await SoftAuthenticator.create();
    const o = createOptions();
    const cases: [Tamper, RegExp][] = [
      [{ origin: "https://evil.example" }, /another site/],
      [{ rpId: "evil.example" }, /another site/],
      [{ challenge: "replayed-challenge" }, /another request/],
      [{ type: "webauthn.get" }, /not for a new passkey/],
      [{ crossOrigin: true }, /frame of another site/],
      [{ noUp: true }, /person is present/],
      [{ bsWithoutBe: true }, /not complete/],
      [{ fmt: "packed", breakSignature: true }, /attestation is not valid/],
      [{ fmt: "packed", packedAlg: -257 }, /attestation is not valid/],
    ];
    for (const [t, match] of cases) await refused(verifyRegistration(await a.register(o, ORIGIN, t), want(o)), match);
  });

  it("refuses an answer whose id is not the id of the new credential", async () => {
    const a = await SoftAuthenticator.create();
    const o = createOptions();
    const reg = await a.register(o, ORIGIN);
    await refused(verifyRegistration({ ...reg, id: "AAAA", rawId: "AAAA" }, want(o)), /not complete/);
    await refused(verifyRegistration({ ...reg, rawId: "AAAA" }, want(o)), /not complete/);
    await refused(verifyRegistration({ ...reg, type: "password" }, want(o)), /not complete/);
    await refused(verifyRegistration({ ...reg, response: { ...reg.response, attestationObject: "!!" } }, want(o)), /not complete/);
    await refused(verifyRegistration(null, want(o)), /not complete/);
  });
});

describe("sign-in", () => {
  async function registered(alg: PasskeyAlg = -7, counts = true) {
    const a = await SoftAuthenticator.create(alg, counts);
    const o = createOptions();
    const pk = await verifyRegistration(await a.register(o, ORIGIN), { challenge: o.challenge, origin: ORIGIN, rpId: RP });
    return { a, stored: { jwk: pk.jwk, alg: pk.alg, signCount: pk.signCount } };
  }

  it("checks the signature over authenticatorData ‖ SHA-256(clientDataJSON), with each key type", async () => {
    for (const alg of [-7, -8, -257] as PasskeyAlg[]) {
      const { a, stored } = await registered(alg);
      const o = requestOptions();
      const res = await verifyAssertion(await a.login(o, ORIGIN), { challenge: o.challenge, origin: ORIGIN, rpId: RP }, stored);
      expect(res.signCount).toBe(2);
      expect(res.userHandle).toBe(userHandleOf("u_robin00001"));
    }
  });

  it("refuses a wrong origin, a wrong challenge, a bad signature, a missing UP flag and a counter that goes back", async () => {
    const { a, stored } = await registered();
    const o = requestOptions();
    const want = { challenge: o.challenge, origin: ORIGIN, rpId: RP };
    await refused(verifyAssertion(await a.login(o, "https://evil.example"), want, stored), /another site/);
    await refused(verifyAssertion(await a.login(o, ORIGIN, { rpId: "evil.example" }), want, stored), /another site/);
    await refused(verifyAssertion(await a.login(requestOptions(), ORIGIN), want, stored), /another request/);
    await refused(verifyAssertion(await a.login(o, ORIGIN, { breakSignature: true }), want, stored), /signature is not valid/);
    await refused(verifyAssertion(await a.login(o, ORIGIN, { noUp: true }), want, stored), /person is present/);
    // Backed up (BS) but not eligible for a backup (BE): the flags cannot be true together.
    await refused(verifyAssertion(await a.login(o, ORIGIN, { bsWithoutBe: true }), want, stored), /not complete/);
    await refused(verifyAssertion(await a.login(o, ORIGIN, { type: "webauthn.create" }), want, stored), /not a sign-in/);
    await refused(verifyAssertion(await a.login(o, ORIGIN, { signCount: 1 }), want, stored), /counter went back/);
    await refused(verifyAssertion(await a.login(o, ORIGIN, { signCount: 0 }), want, stored), /counter went back/);
    // A signature of another key does not count.
    const other = await SoftAuthenticator.create();
    const forged = await other.login(o, ORIGIN);
    await refused(verifyAssertion({ ...forged, id: a.credentialId, rawId: a.credentialId }, want, stored), /signature is not valid/);
  });

  it("accepts passkeys that always send the sign count 0", async () => {
    const { a, stored } = await registered(-7, false);
    expect(stored.signCount).toBe(0);
    for (let i = 0; i < 2; i++) {
      const o = requestOptions();
      expect((await verifyAssertion(await a.login(o, ORIGIN), { challenge: o.challenge, origin: ORIGIN, rpId: RP }, stored)).signCount).toBe(0);
    }
  });

  it("follows the sign count rule of WebAuthn §7.2", () => {
    expect(signCountOk(0, 0)).toBe(true);
    expect(signCountOk(0, 1)).toBe(true);
    expect(signCountOk(5, 6)).toBe(true);
    expect(signCountOk(5, 5)).toBe(false);
    expect(signCountOk(5, 4)).toBe(false);
    expect(signCountOk(5, 0)).toBe(false);
  });
});

describe("names and words", () => {
  it("names a new passkey after the device", () => {
    expect(passkeyLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36")).toBe("Passkey (Windows)");
    expect(passkeyLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15")).toBe("Passkey (Mac)");
    expect(passkeyLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148")).toBe("Passkey (iPhone)");
    expect(passkeyLabel("Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36")).toBe("Passkey (Android)");
    expect(passkeyLabel("Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 Chrome/140.0")).toBe("Passkey (ChromeOS)");
    expect(passkeyLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Passkey (Linux)");
    expect(passkeyLabel(undefined)).toBe("Passkey");
  });

  it("refusals follow the STE rules", () => {
    expect(refusals.length).toBeGreaterThan(10);
    for (const m of new Set(refusals)) expect(steViolations(m)).toEqual([]);
  });
});
