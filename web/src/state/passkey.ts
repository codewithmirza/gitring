/**
 * Passkeys in the browser (WebAuthn): sign in, create an account, and add, rename or remove a passkey.
 * The Worker sends the options as JSON with base64url strings (src/worker/auth.ts, /auth/passkey/*).
 * The browser API wants bytes, and its answer has bytes too.
 */
import type { PasskeyCreationOptions, PasskeyInfo, PasskeyRequestOptions, UserInfo } from "../../../src/core/accounts";
import { getJson, HttpError, invalidate, send } from "./http";

/** The person stopped the passkey dialog, or it timed out: gitring made no change. */
export class PasskeyStopped extends Error {
  constructor() {
    super("You stopped the passkey. gitring made no change.");
    this.name = "PasskeyStopped";
  }
}

/** True when this browser can make and use passkeys (WebAuthn, on https or localhost). */
export function passkeysWork(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && typeof navigator.credentials?.create === "function";
  } catch {
    return false;
  }
}

/* ───────────── base64url ↔ bytes ───────────── */

export function bytesOf(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function textOf(b: ArrayBuffer | ArrayBufferView): string {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ───────────── options (JSON → browser) ───────────── */

function descriptors(list: { type: "public-key"; id: string; transports?: string[] }[]): PublicKeyCredentialDescriptor[] {
  return list.map((d) => ({ type: d.type, id: bytesOf(d.id), ...(d.transports?.length ? { transports: d.transports as AuthenticatorTransport[] } : {}) }));
}

export function creationOptions(o: PasskeyCreationOptions): PublicKeyCredentialCreationOptions {
  return {
    challenge: bytesOf(o.challenge),
    rp: o.rp,
    user: { id: bytesOf(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: o.pubKeyCredParams,
    timeout: o.timeout,
    attestation: o.attestation,
    authenticatorSelection: o.authenticatorSelection,
    excludeCredentials: descriptors(o.excludeCredentials),
  };
}

export function requestOptions(o: PasskeyRequestOptions): PublicKeyCredentialRequestOptions {
  return { challenge: bytesOf(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification, allowCredentials: descriptors(o.allowCredentials) };
}

/* ───────────── answers (browser → JSON) ───────────── */

/** The parts of a PublicKeyCredential that gitring reads (a real one, or a test double). */
export interface CredentialLike {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    getTransports?: () => string[];
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
  };
}

export function registrationJSON(c: CredentialLike) {
  const r = c.response;
  if (!r.attestationObject) throw new Error("The browser did not send a new passkey. Try again.");
  return {
    id: c.id,
    rawId: textOf(c.rawId),
    type: c.type,
    response: { clientDataJSON: textOf(r.clientDataJSON), attestationObject: textOf(r.attestationObject), transports: typeof r.getTransports === "function" ? r.getTransports() : [] },
  };
}

export function assertionJSON(c: CredentialLike) {
  const r = c.response;
  if (!r.authenticatorData || !r.signature) throw new Error("The browser did not send a passkey sign-in. Try again.");
  return {
    id: c.id,
    rawId: textOf(c.rawId),
    type: c.type,
    response: { clientDataJSON: textOf(r.clientDataJSON), authenticatorData: textOf(r.authenticatorData), signature: textOf(r.signature), userHandle: r.userHandle ? textOf(r.userHandle) : null },
  };
}

/* ───────────── ceremonies ───────────── */

/** A dialog that the person closed (NotAllowedError) or that timed out becomes PasskeyStopped. */
async function ask<T>(run: () => Promise<T | null>): Promise<T> {
  let out: T | null;
  try {
    out = await run();
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === "NotAllowedError" || name === "AbortError") throw new PasskeyStopped();
    if (name === "InvalidStateError") throw new Error("This device has a passkey for this account already.");
    throw e;
  }
  if (!out) throw new PasskeyStopped();
  return out;
}

async function register(name?: string): Promise<{ user: UserInfo; passkey: PasskeyInfo }> {
  const { options } = await send<{ options: PasskeyCreationOptions }>("POST", "/auth/passkey/register/options", name === undefined ? {} : { name });
  const cred = await ask(() => navigator.credentials.create({ publicKey: creationOptions(options) }) as Promise<CredentialLike | null>);
  const res = await send<{ user: UserInfo; passkey: PasskeyInfo }>("POST", "/auth/passkey/register/verify", { credential: registrationJSON(cred) });
  invalidate(PASSKEYS);
  return res;
}

/** Sign in with a passkey that the browser offers (no name to type). */
export async function signInWithPasskey(): Promise<UserInfo> {
  const { options } = await send<{ options: PasskeyRequestOptions }>("POST", "/auth/passkey/login/options", {});
  const cred = await ask(() => navigator.credentials.get({ publicKey: requestOptions(options) }) as Promise<CredentialLike | null>);
  const res = await send<{ user: UserInfo }>("POST", "/auth/passkey/login/verify", { credential: assertionJSON(cred) });
  return res.user;
}

/** A new gitring account with a passkey only. `name` is the name that other people see. */
export async function createAccountWithPasskey(name: string): Promise<UserInfo> {
  return (await register(name)).user;
}

/** A passkey for the signed-in person (another device or a security key). */
export async function addPasskey(): Promise<PasskeyInfo> {
  return (await register()).passkey;
}

/* ───────────── the person's passkeys ───────────── */

const PASSKEYS = "/api/me/passkeys";

export function listPasskeys(opts: { signal?: AbortSignal; maxAge?: number } = {}): Promise<PasskeyInfo[]> {
  return getJson<PasskeyInfo[]>(PASSKEYS, { signal: opts.signal, maxAge: opts.maxAge ?? 0 });
}

export function renamePasskey(id: string, name: string): Promise<PasskeyInfo> {
  return send<PasskeyInfo>("PATCH", `${PASSKEYS}/${encodeURIComponent(id)}`, { name });
}

/** Remove a passkey. The Worker refuses to remove the last way to sign in (409). */
export async function removePasskey(id: string): Promise<void> {
  await send<void>("DELETE", `${PASSKEYS}/${encodeURIComponent(id)}`);
}

/** The words of an error for the person (HttpError has the Worker's sentence). */
export function passkeyErrorText(e: unknown): string {
  if (e instanceof PasskeyStopped) return e.message;
  if (e instanceof HttpError) return e.message;
  return (e as Error)?.message || "The passkey did not work. Try again.";
}
