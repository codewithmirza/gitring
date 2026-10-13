/**
 * Passkeys in the Directory: a new account with a passkey only, sign-in, a passkey added to a person who
 * signed in with GitHub, rename and remove (one way to sign in stays), owners by account id, and the
 * refusals (a used challenge, another site, a counter that goes back). The Durable Object runs on
 * node:sqlite; the browser and the authenticator are test/support/passkey-authenticator.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Directory } from "../../src/directory/directory";
import type { Env } from "../../src/worker/env";
import { userHandleOf } from "../../src/directory/passkeys";
import { sqliteCtx } from "../support/sqlite-storage";
import { SoftAuthenticator, type Tamper } from "../support/passkey-authenticator";
import { steViolations } from "../coord/ste";

const ORIGIN = "https://gitring.example.com";
const RP = { origin: ORIGIN, rpId: "gitring.example.com" };

type Fake = { status?: number; json: unknown };
let routes: Record<string, Fake> = {};

beforeEach(() => {
  routes = {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: "not stubbed" }), { status: 599 });
    return new Response(JSON.stringify(routes[key].json), { status: routes[key].status ?? 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function make(env: Partial<Env> = {}) {
  return new Directory(sqliteCtx() as never, { GITRING_SECRET: "test-secret-0123456789abcdef", ...env } as Env);
}

/** Messages that people see. */
const said: string[] = [];
async function refusal(p: Promise<unknown>, match: RegExp): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as Error,
  );
  expect(e, `expected a refusal like ${match}`).toBeInstanceOf(Error);
  expect(e!.message).toMatch(match);
  said.push(e!.message);
}

async function createAccount(dir: Directory, name = "Robin", alg: -7 | -8 | -257 = -7, t: Tamper = {}) {
  const key = await SoftAuthenticator.create(alg);
  const { state, options } = await dir.passkeyRegisterOptions({ ...RP, name });
  const res = await dir.passkeyRegister(state, await key.register(options, ORIGIN, t), { origin: ORIGIN, label: "Passkey (Windows)" });
  return { key, ...res };
}

async function signIn(dir: Directory, key: SoftAuthenticator, t: Tamper = {}) {
  const { state, options } = await dir.passkeyLoginOptions(RP);
  return dir.passkeyLogin(state, await key.login(options, ORIGIN, t), { origin: ORIGIN });
}

async function githubSignIn(dir: Directory, user: { id: number; login: string }) {
  routes["https://api.github.com/app-manifests/"] = {
    json: { id: 42, slug: "git-ring-test", client_id: "Iv1.abc", client_secret: "shh", webhook_secret: "whsec", pem: "x", html_url: "https://github.com/apps/git-ring-test" },
  };
  const m = await dir.githubManifest(ORIGIN);
  await dir.githubManifestDone("code-1", new URL(m.postUrl).searchParams.get("state")!);
  routes["https://github.com/login/oauth/access_token"] = { json: { access_token: `gho_${user.login}` } };
  routes["https://api.github.com/user"] = { json: { id: user.id, login: user.login, name: null, email: null } };
  const url = await dir.signInUrl("github", ORIGIN, "/");
  return dir.finishSignIn("github", "code", new URL(url).searchParams.get("state")!);
}

describe("a new account with a passkey", () => {
  it("needs no outside account: the person exists with a passkey only and gets a session", async () => {
    const dir = make();
    const { state, options } = await dir.passkeyRegisterOptions({ ...RP, name: "  Robin \n Quill  " });
    expect(options.rp).toEqual({ id: "gitring.example.com", name: "gitring" });
    expect(options.user.displayName).toBe("Robin Quill");
    expect(options.attestation).toBe("none");
    expect(options.authenticatorSelection).toEqual({ residentKey: "required", requireResidentKey: true, userVerification: "preferred" });
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8, -257]);
    expect(options.excludeCredentials).toEqual([]);
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const key = await SoftAuthenticator.create();
    const res = await dir.passkeyRegister(state, await key.register(options, ORIGIN), { origin: ORIGIN, label: "Passkey (Mac)" });
    expect(res.token).toBeTruthy();
    expect(res.user).toMatchObject({ name: "Robin Quill", identities: [], passkeys: 1, admin: false });
    expect(options.user.id).toBe(userHandleOf(res.user.id));
    expect(res.passkey).toMatchObject({ id: key.credentialId, name: "Passkey (Mac)" });
    expect((await dir.sessionUser(res.token!))?.id).toBe(res.user.id);
    expect(await dir.listPasskeys(res.user.id)).toEqual([{ id: key.credentialId, name: "Passkey (Mac)", createdAt: res.passkey.createdAt, lastUsed: res.passkey.createdAt }]);
  });

  it("needs a name, and works with each key type", async () => {
    const dir = make();
    await refusal(dir.passkeyRegisterOptions({ ...RP, name: "  " }), /Give your name/);
    for (const alg of [-7, -8, -257] as const) {
      const { key, user } = await createAccount(dir, `Robin ${alg}`, alg);
      expect((await signIn(dir, key)).user.id).toBe(user.id);
    }
  });

  it("accepts packed self attestation", async () => {
    const dir = make();
    const { user } = await createAccount(dir, "Robin", -7, { fmt: "packed" });
    expect(user.passkeys).toBe(1);
  });
});

describe("passkey sign-in", () => {
  it("opens the same kind of session as other sign-ins and keeps the sign count", async () => {
    const dir = make();
    const { key, user } = await createAccount(dir);
    const { options } = await dir.passkeyLoginOptions(RP);
    expect(options).toMatchObject({ rpId: "gitring.example.com", userVerification: "preferred", allowCredentials: [] });
    const res = await signIn(dir, key);
    expect(res.user.id).toBe(user.id);
    expect((await dir.sessionUser(res.token))?.id).toBe(user.id);
    // The browser session ends like any other.
    await dir.endSession(res.token);
    expect(await dir.sessionUser(res.token)).toBeNull();
    // The stored count follows the authenticator.
    const sql = (dir as unknown as { sql: { exec(q: string, ...b: unknown[]): { toArray(): { sign_count: number }[] } } }).sql;
    expect(sql.exec("SELECT sign_count FROM passkeys WHERE id = ?", key.credentialId).toArray()[0].sign_count).toBe(2);
  });

  it("refuses a challenge used twice, a sign-in state used for a new passkey, and an old state", async () => {
    const dir = make();
    const { key } = await createAccount(dir);
    const { state, options } = await dir.passkeyLoginOptions(RP);
    const answer = await key.login(options, ORIGIN);
    await dir.passkeyLogin(state, answer, { origin: ORIGIN });
    await refusal(dir.passkeyLogin(state, answer, { origin: ORIGIN }), /expired or was used/);

    const login = await dir.passkeyLoginOptions(RP);
    await refusal(dir.passkeyRegister(login.state, await key.register({ ...(await dir.passkeyRegisterOptions({ ...RP, name: "x" })).options, challenge: login.options.challenge }, ORIGIN), { origin: ORIGIN }), /expired or was used/);

    const reg = await dir.passkeyRegisterOptions({ ...RP, name: "Robin" });
    await refusal(dir.passkeyLogin(reg.state, await key.login({ ...login.options, challenge: reg.options.challenge }, ORIGIN), { origin: ORIGIN }), /expired or was used/);

    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    const late = await dir.passkeyLoginOptions(RP);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    await refusal(dir.passkeyLogin(late.state, await key.login(late.options, ORIGIN), { origin: ORIGIN }), /expired or was used/);
  });

  it("refuses an answer for another challenge, another site, or another origin than the request", async () => {
    const dir = make();
    const { key } = await createAccount(dir);
    const a = await dir.passkeyLoginOptions(RP);
    const b = await dir.passkeyLoginOptions(RP);
    // The answer to request b, sent with the state of request a (another browser's challenge).
    await refusal(dir.passkeyLogin(a.state, await key.login(b.options, ORIGIN), { origin: ORIGIN }), /another request/);
    const c = await dir.passkeyLoginOptions(RP);
    await refusal(dir.passkeyLogin(c.state, await key.login(c.options, "https://evil.example"), { origin: ORIGIN }), /another site/);
    const d = await dir.passkeyLoginOptions(RP);
    await refusal(dir.passkeyLogin(d.state, await key.login(d.options, ORIGIN), { origin: "https://other.example.com" }), /another site/);
  });

  it("refuses a counter that goes back, and keeps the stored count", async () => {
    const dir = make();
    const { key } = await createAccount(dir);
    await signIn(dir, key); // count 2
    await refusal(signIn(dir, key, { signCount: 2 }), /counter went back/);
    await refusal(signIn(dir, key, { signCount: 1 }), /counter went back/);
    // The real authenticator goes on at 3.
    expect((await signIn(dir, key)).token).toBeTruthy();
  });

  it("refuses a missing UP flag, a bad signature, an unknown passkey and a user handle of another account", async () => {
    const dir = make();
    const { key } = await createAccount(dir);
    const other = await createAccount(dir, "Sam");
    await refusal(signIn(dir, key, { noUp: true }), /person is present/);
    await refusal(signIn(dir, key, { breakSignature: true }), /signature is not valid/);
    await refusal(signIn(dir, await SoftAuthenticator.create()), /does not know this passkey/);
    await refusal(signIn(dir, key, { userHandle: userHandleOf(other.user.id) }), /does not belong to this account/);
    await refusal(dir.passkeyLogin((await dir.passkeyLoginOptions(RP)).state, { id: 5 }, { origin: ORIGIN }), /not complete/);
  });
});

describe("passkeys of a signed-in person", () => {
  it("adds a passkey to a GitHub account, and the browser skips authenticators that have one", async () => {
    const dir = make();
    const gh = await githubSignIn(dir, { id: 7, login: "robin" });
    const first = await SoftAuthenticator.create();
    const o1 = await dir.passkeyRegisterOptions({ ...RP, userId: gh.user.id });
    expect(o1.options.user.displayName).toBe("robin");
    const added = await dir.passkeyRegister(o1.state, await first.register(o1.options, ORIGIN), { origin: ORIGIN, userId: gh.user.id, label: "Passkey (iPhone)" });
    expect(added.token).toBeNull();
    expect(added.user).toMatchObject({ id: gh.user.id, passkeys: 1 });
    expect(added.passkey.lastUsed).toBeUndefined();
    const o2 = await dir.passkeyRegisterOptions({ ...RP, userId: gh.user.id });
    expect(o2.options.excludeCredentials).toEqual([{ type: "public-key", id: first.credentialId, transports: ["internal", "hybrid"] }]);
    // The same passkey cannot join twice.
    await refusal(dir.passkeyRegister(o2.state, await first.register(o2.options, ORIGIN), { origin: ORIGIN, userId: gh.user.id }), /has this passkey already/);
    // The passkey signs in to the same person.
    expect((await signIn(dir, first)).user.id).toBe(gh.user.id);
  });

  it("adds the passkey only to the person who asked", async () => {
    const dir = make();
    const gh = await githubSignIn(dir, { id: 7, login: "robin" });
    const o = await dir.passkeyRegisterOptions({ ...RP, userId: gh.user.id });
    const key = await SoftAuthenticator.create();
    await refusal(dir.passkeyRegister(o.state, await key.register(o.options, ORIGIN), { origin: ORIGIN, userId: "u_someoneels" }), /Sign in again/);
    const o2 = await dir.passkeyRegisterOptions({ ...RP, userId: gh.user.id });
    await refusal(dir.passkeyRegister(o2.state, await key.register(o2.options, ORIGIN), { origin: ORIGIN }), /Sign in again/);
  });

  it("renames and removes passkeys, and keeps one way to sign in", async () => {
    const dir = make();
    const { key, user } = await createAccount(dir);
    await refusal(dir.removePasskey(user.id, key.credentialId), /only way to sign in/);
    expect(await dir.listPasskeys(user.id)).toHaveLength(1);
    // A second passkey: now either one can go.
    const second = await SoftAuthenticator.create();
    const o = await dir.passkeyRegisterOptions({ ...RP, userId: user.id });
    await dir.passkeyRegister(o.state, await second.register(o.options, ORIGIN), { origin: ORIGIN, userId: user.id, label: "Security key" });
    expect((await dir.renamePasskey(user.id, second.credentialId, "  Blue key \t")).name).toBe("Blue key");
    await refusal(dir.renamePasskey(user.id, second.credentialId, " "), /Give the passkey a name/);
    await refusal(dir.renamePasskey("u_someoneels", second.credentialId, "Mine"), /no passkey with this id/);
    await refusal(dir.removePasskey("u_someoneels", second.credentialId), /no passkey with this id/);
    await dir.removePasskey(user.id, key.credentialId);
    expect((await dir.listPasskeys(user.id)).map((p) => p.name)).toEqual(["Blue key"]);
    // The removed passkey does not sign in any more.
    await refusal(signIn(dir, key), /does not know this passkey/);
  });

  it("lets a person with a GitHub sign-in remove the only passkey", async () => {
    const dir = make();
    const gh = await githubSignIn(dir, { id: 7, login: "robin" });
    const key = await SoftAuthenticator.create();
    const o = await dir.passkeyRegisterOptions({ ...RP, userId: gh.user.id });
    await dir.passkeyRegister(o.state, await key.register(o.options, ORIGIN), { origin: ORIGIN, userId: gh.user.id });
    await dir.removePasskey(gh.user.id, key.credentialId);
    expect(await dir.listPasskeys(gh.user.id)).toEqual([]);
  });
});

describe("owners and members by account id", () => {
  it("makes a passkey-only person an owner with user:<id>", async () => {
    const dir = make({ GITRING_OWNERS: "github:somebody" });
    const { user } = await createAccount(dir);
    expect(user.admin).toBe(false);
    const owned = make({ GITRING_OWNERS: "" });
    const robin = await createAccount(owned);
    (owned as unknown as { env: Env }).env.GITRING_OWNERS = `google:x@example.com, user:${robin.user.id.toUpperCase()}`;
    expect((await signIn(owned, robin.key)).user.admin).toBe(true);
    const sam = await createAccount(owned, "Sam");
    expect(sam.user.admin).toBe(false);
  });

  it("adds a passkey-only person to a project by account id", async () => {
    const dir = make();
    const owner = await createAccount(dir);
    const sam = await createAccount(dir, "Sam");
    const p = await dir.createProject({ name: "Shop", source: { kind: "empty" }, ownerId: owner.user.id });
    const members = await dir.addMember(p.id, sam.user.id, "member");
    expect(members.find((m) => m.userId === sam.user.id)).toMatchObject({ name: "Sam", handle: sam.user.id, role: "member", pending: false });
    expect(await dir.role(p.id, sam.user.id)).toBe("member");
    await dir.addMember(p.id, `user:${sam.user.id}`, "viewer");
    expect(await dir.role(p.id, sam.user.id)).toBe("viewer");
    await refusal(dir.addMember(p.id, "u_nobody0000", "member"), /no account with this id/);
    await dir.removeMember(p.id, sam.user.id);
    expect(await dir.role(p.id, sam.user.id)).toBeNull();
  });
});

describe("words", () => {
  it("follow the STE rules", () => {
    expect(said.length).toBeGreaterThan(10);
    for (const m of new Set(said)) expect(steViolations(m)).toEqual([]);
  });
});
