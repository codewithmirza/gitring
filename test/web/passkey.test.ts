/**
 * Passkeys in the browser (web/src/state/passkey.ts): JSON options → the bytes that WebAuthn wants, the
 * browser's answer → JSON, and the sign-in flow against a stubbed Worker and navigator.credentials. The
 * answers come from the software authenticator, and the Worker's own check accepts what the client sends.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertionJSON,
  bytesOf,
  creationOptions,
  passkeyErrorText,
  PasskeyStopped,
  registrationJSON,
  requestOptions,
  signInWithPasskey,
  textOf,
  type CredentialLike,
} from "../../web/src/state/passkey";
import { resetHttpCache } from "../../web/src/state/http";
import { userHandleOf, verifyAssertion, verifyRegistration } from "../../src/directory/passkeys";
import type { PasskeyCreationOptions, PasskeyRequestOptions } from "../../src/core/accounts";
import { SoftAuthenticator } from "../support/passkey-authenticator";
import { steViolations } from "../coord/ste";

const ORIGIN = "https://gitring.example.com";
const RP = "gitring.example.com";

afterEach(() => {
  vi.unstubAllGlobals();
  resetHttpCache();
});

/** The error that `run` throws (or null). */
function captured(run: () => unknown): Error | null {
  try {
    run();
    return null;
  } catch (e) {
    return e as Error;
  }
}

function create(): PasskeyCreationOptions {
  return {
    challenge: "q2X9-_aa",
    rp: { id: RP, name: "gitring" },
    user: { id: userHandleOf("u_robin00001"), name: "Robin", displayName: "Robin" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: 300000,
    attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
    excludeCredentials: [{ type: "public-key", id: "AQID", transports: ["internal"] }],
  };
}

/** What the browser hands back: the same answer as the authenticator's JSON, with ArrayBuffers. */
function asBrowser(json: { id: string; rawId: string; type: string; response: Record<string, unknown> }): CredentialLike {
  const r = json.response;
  const buf = (k: string) => (typeof r[k] === "string" ? bytesOf(r[k] as string).buffer : undefined);
  return {
    id: json.id,
    rawId: bytesOf(json.rawId).buffer,
    type: json.type,
    response: {
      clientDataJSON: buf("clientDataJSON")!,
      attestationObject: buf("attestationObject"),
      authenticatorData: buf("authenticatorData"),
      signature: buf("signature"),
      userHandle: r.userHandle ? bytesOf(r.userHandle as string).buffer : null,
      ...(Array.isArray(r.transports) ? { getTransports: () => r.transports as string[] } : {}),
    },
  };
}

describe("base64url", () => {
  it("round-trips bytes, also with lengths that need padding", () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      expect(bytesOf(textOf(b))).toEqual(b);
      expect(textOf(b)).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });
});

describe("options", () => {
  it("turn the strings of the Worker into bytes for navigator.credentials", () => {
    const o = creationOptions(create());
    expect(new Uint8Array(o.challenge as ArrayBuffer)).toEqual(bytesOf("q2X9-_aa"));
    expect(new TextDecoder().decode(o.user.id as Uint8Array)).toBe("u_robin00001");
    expect(o.excludeCredentials).toEqual([{ type: "public-key", id: new Uint8Array([1, 2, 3]), transports: ["internal"] }]);
    expect(o.authenticatorSelection).toEqual({ residentKey: "required", requireResidentKey: true, userVerification: "preferred" });
    const r = requestOptions({ challenge: "AAAA", rpId: RP, timeout: 1000, userVerification: "preferred", allowCredentials: [] });
    expect(r).toEqual({ challenge: new Uint8Array([0, 0, 0]), rpId: RP, timeout: 1000, userVerification: "preferred", allowCredentials: [] });
  });
});

describe("answers", () => {
  it("become JSON that the Worker accepts", async () => {
    const key = await SoftAuthenticator.create();
    const o = { ...create(), challenge: textOf(crypto.getRandomValues(new Uint8Array(32))) };
    const sent = registrationJSON(asBrowser(await key.register(o, ORIGIN)));
    const pk = await verifyRegistration(sent, { challenge: o.challenge, origin: ORIGIN, rpId: RP });
    expect(pk.id).toBe(key.credentialId);
    const ro: PasskeyRequestOptions = { challenge: textOf(crypto.getRandomValues(new Uint8Array(32))), rpId: RP, timeout: 1000, userVerification: "preferred", allowCredentials: [] };
    const signed = assertionJSON(asBrowser(await key.login(ro, ORIGIN)));
    expect(signed.response.userHandle).toBe(userHandleOf("u_robin00001"));
    const res = await verifyAssertion(signed, { challenge: ro.challenge, origin: ORIGIN, rpId: RP }, { jwk: pk.jwk, alg: pk.alg, signCount: pk.signCount });
    expect(res.signCount).toBe(2);
  });
});

describe("signInWithPasskey", () => {
  it("asks for options, lets the browser sign, and sends the answer", async () => {
    const key = await SoftAuthenticator.create();
    await key.register({ ...create(), challenge: "AAAA" }, ORIGIN);
    const ro: PasskeyRequestOptions = { challenge: textOf(crypto.getRandomValues(new Uint8Array(32))), rpId: RP, timeout: 1000, userVerification: "preferred", allowCredentials: [] };
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      const body = url.endsWith("/options") ? { options: ro } : { user: { id: "u_robin00001", name: "Robin", identities: [], admin: false } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    let asked: PublicKeyCredentialRequestOptions | undefined;
    vi.stubGlobal("navigator", {
      credentials: {
        get: async (o: { publicKey: PublicKeyCredentialRequestOptions }) => {
          asked = o.publicKey;
          return asBrowser(await key.login(ro, ORIGIN));
        },
      },
    });
    const user = await signInWithPasskey();
    expect(user.name).toBe("Robin");
    expect(posts.map((p) => p.url)).toEqual(["/auth/passkey/login/options", "/auth/passkey/login/verify"]);
    expect(textOf(asked!.challenge as Uint8Array)).toBe(ro.challenge);
    const sent = (posts[1].body as { credential: { id: string } }).credential;
    expect(sent.id).toBe(key.credentialId);
  });

  it("says that nothing changed when the person closes the dialog", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ options: { challenge: "AAAA", rpId: RP, timeout: 1000, userVerification: "preferred", allowCredentials: [] } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("navigator", {
      credentials: {
        get: async () => {
          const e = new Error("The operation either timed out or was not allowed.");
          e.name = "NotAllowedError";
          throw e;
        },
      },
    });
    await expect(signInWithPasskey()).rejects.toBeInstanceOf(PasskeyStopped);
  });

  it("uses plain words for each problem", async () => {
    const said: string[] = [new PasskeyStopped().message, passkeyErrorText(new Error("")), passkeyErrorText(null)];
    const empty: CredentialLike = { id: "x", rawId: new ArrayBuffer(1), type: "public-key", response: { clientDataJSON: new ArrayBuffer(1) } };
    expect(() => registrationJSON(empty)).toThrow(/did not send a new passkey/);
    expect(() => assertionJSON(empty)).toThrow(/did not send a passkey sign-in/);
    for (const run of [registrationJSON, assertionJSON]) said.push(captured(() => run(empty))?.message ?? "");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ options: { challenge: "AAAA", rpId: RP, timeout: 1000, userVerification: "preferred", allowCredentials: [] } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("navigator", {
      credentials: {
        get: async () => {
          throw Object.assign(new Error("x"), { name: "InvalidStateError" });
        },
      },
    });
    said.push(await signInWithPasskey().then(() => "", (e: Error) => e.message));
    expect(said.every(Boolean)).toBe(true);
    for (const m of said) expect(steViolations(m), m).toEqual([]);
  });

  it("shows the Worker's reason when it refuses the passkey", async () => {
    const key = await SoftAuthenticator.create();
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/options")
        ? new Response(JSON.stringify({ options: { challenge: "AAAA", rpId: RP, timeout: 1000, userVerification: "preferred", allowCredentials: [] } }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: "gitring does not know this passkey. Use another passkey, or create an account." }), { status: 400, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("navigator", { credentials: { get: async () => asBrowser(await key.login({ challenge: "AAAA", rpId: RP, timeout: 1, userVerification: "preferred", allowCredentials: [] }, ORIGIN)) } });
    await expect(signInWithPasskey()).rejects.toThrow(/does not know this passkey/);
  });
});
