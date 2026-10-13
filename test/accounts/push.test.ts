/**
 * Web Push without content (src/worker/push.ts) and the push parts of the Directory: the VAPID signature that
 * push services check, the addresses that gitring accepts, the devices of a person, and who gets a push when
 * something new waits in an inbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Directory } from "../../src/directory/directory";
import { b64url, fromB64url } from "../../src/directory/crypto";
import { pushEndpointOk, pushKeys, sendPush, vapidAuthorization, type PushKeys } from "../../src/worker/push";
import type { Env } from "../../src/worker/env";
import { sqliteCtx } from "../support/sqlite-storage";

const ORIGIN = "https://gitring.example.workers.dev";

/** A real P-256 key pair, in the form of the secrets VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. */
async function makeKeys(): Promise<PushKeys & { verify: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64url(raw), privateKey: jwk.d!, subject: "mailto:robin@example.org", verify: pair.publicKey };
}

describe("the push keys of the deployment", () => {
  it("are off when one key is absent or has a wrong form", async () => {
    const k = await makeKeys();
    expect(pushKeys({})).toBeNull();
    expect(pushKeys({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey })).toBeNull();
    expect(pushKeys({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: "robin" })).toBeNull();
    expect(pushKeys({ VAPID_PUBLIC_KEY: "short", VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: k.subject })).toBeNull();
    expect(pushKeys({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: k.subject })).toEqual({ publicKey: k.publicKey, privateKey: k.privateKey, subject: k.subject });
  });

  it("sign a VAPID token (ES256) for the origin of the push service, valid for 12 hours", async () => {
    const k = await makeKeys();
    const now = Date.UTC(2026, 9, 13, 12, 0, 0);
    const header = await vapidAuthorization(k, "https://push.example.org/send/abc?x=1", now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m).not.toBeNull();
    expect(m[4]).toBe(k.publicKey);
    const dec = (s: string) => JSON.parse(new TextDecoder().decode(fromB64url(s)));
    expect(dec(m[1])).toEqual({ typ: "JWT", alg: "ES256" });
    expect(dec(m[2])).toEqual({ aud: "https://push.example.org", exp: now / 1000 + 12 * 3600, sub: "mailto:robin@example.org" });
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.verify, fromB64url(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });

  it("accept only https push addresses on a public host", () => {
    expect(pushEndpointOk("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(pushEndpointOk("https://web.push.apple.com/QGx")).toBe(true);
    for (const bad of ["http://push.example.org/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.1/x", "https://u:p@push.example.org/x", "https://push.example.org:8443/x", "nope", 42]) {
      expect(pushEndpointOk(bad), String(bad)).toBe(false);
    }
  });

  it("send an empty push, and say when the device is gone", async () => {
    const k = await makeKeys();
    const seen: { url: string; init: RequestInit }[] = [];
    const answer = (status: number) => (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(null, { status }))) as unknown as typeof fetch;
    expect(await sendPush(k, "https://push.example.org/a", answer(201))).toBe("sent");
    const h = seen[0].init.headers as Record<string, string>;
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.body).toBeUndefined();
    expect(h).toMatchObject({ ttl: "86400", urgency: "high", "content-length": "0" });
    expect(h.authorization).toMatch(/^vapid t=/);
    expect(await sendPush(k, "https://push.example.org/a", answer(410))).toBe("gone");
    expect(await sendPush(k, "https://push.example.org/a", answer(404))).toBe("gone");
    expect(await sendPush(k, "https://push.example.org/a", answer(500))).toBe("failed");
    expect(await sendPush(k, "http://push.example.org/a", answer(201))).toBe("gone");
  });
});

describe("the devices and pushes of people (Directory)", () => {
  const pushes: string[] = [];
  let gone = new Set<string>();

  beforeEach(() => {
    pushes.length = 0;
    gone = new Set();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://push.example.org/")) {
        pushes.push(url);
        return new Response(null, { status: gone.has(url) ? 410 : 201 });
      }
      if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_x", expires_in: 28800 });
      if (url === "https://api.github.com/user") return Response.json({ id: Number(signingIn.id), login: signingIn.login, name: signingIn.login, email: null, avatar_url: "" });
      if (url.startsWith("https://api.github.com/app-manifests/")) {
        return Response.json({ id: 42, slug: "gitring-test", client_id: "Iv1.abc", client_secret: "shh", webhook_secret: "whsec", pem: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", html_url: "https://github.com/apps/gitring-test" });
      }
      return Response.json({ message: "not stubbed" }, { status: 599 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  let signingIn = { id: "1", login: "robin" };

  async function setup(withKeys = true) {
    const k = await makeKeys();
    const env = { GITRING_SECRET: "test-secret-0123456789abcdef", ...(withKeys ? { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: k.subject } : {}) };
    const dir = new Directory(sqliteCtx() as never, env as unknown as Env);
    const m = await dir.githubManifest(ORIGIN);
    await dir.githubManifestDone("code", new URL(m.postUrl).searchParams.get("state")!);
    const person = async (login: string, id: string) => {
      signingIn = { id, login };
      const url = await dir.signInUrl("github", ORIGIN, "/");
      return (await dir.finishSignIn("github", "code", new URL(url).searchParams.get("state")!)).user.id;
    };
    const robin = await person("robin", "1");
    const sam = await person("sam", "2");
    const kim = await person("kim", "3");
    const p = await dir.createProject({ name: "Shop", source: { kind: "empty" }, ownerId: robin });
    await dir.addMember(p.id, "sam", "member");
    await dir.addMember(p.id, "kim", "viewer");
    return { dir, robin, sam, kim, project: p.id, publicKey: k.publicKey };
  }

  it("keeps the devices of a person and says if push is on", async () => {
    const { dir, robin, publicKey } = await setup();
    expect(await dir.pushStatus(robin)).toEqual({ available: true, publicKey, devices: 0 });
    expect(await dir.pushSubscribe(robin, "https://push.example.org/robin-phone")).toEqual({ devices: 1 });
    expect(await dir.pushSubscribe(robin, "https://push.example.org/robin-phone")).toEqual({ devices: 1 });
    await expect(dir.pushSubscribe(robin, "http://push.example.org/x")).rejects.toThrow(/not valid/);
    expect(await dir.pushUnsubscribe(robin, "https://push.example.org/robin-phone")).toEqual({ devices: 0 });
    const off = await setup(false);
    expect(await off.dir.pushStatus(off.robin)).toEqual({ available: false, devices: 0 });
    await expect(off.dir.pushSubscribe(off.robin, "https://push.example.org/x")).rejects.toThrow(/off/);
  });

  it("sends a push to the people who answer, and to nobody without a device", async () => {
    const { dir, robin, sam, kim, project } = await setup();
    await dir.pushSubscribe(robin, "https://push.example.org/robin");
    await dir.pushSubscribe(sam, "https://push.example.org/sam");
    await dir.pushSubscribe(kim, "https://push.example.org/kim");
    // The sender answers: only sam.
    expect(await dir.pushInbox(project, { users: [sam], need: "member", kind: "approval" })).toBe(1);
    expect(pushes).toEqual(["https://push.example.org/sam"]);
    // No sender: every member and owner, never a viewer. Sam got a push a moment ago, so this one is for robin only.
    pushes.length = 0;
    expect(await dir.pushInbox(project, { users: [], need: "member", kind: "question" })).toBe(1);
    expect(pushes).toEqual(["https://push.example.org/robin"]);
    // The rule "owner": only owners answer.
    pushes.length = 0;
    expect(await dir.pushInbox(project, { users: [], need: "owner", kind: "question" })).toBe(0);
  });

  it("sends no merge push to a person who answers in the chat only, and forgets a device that is gone", async () => {
    const { dir, robin, sam, project } = await setup();
    await dir.pushSubscribe(sam, "https://push.example.org/sam");
    await dir.setPrefs(sam, { approvalsIn: "agent" });
    expect(await dir.pushInbox(project, { users: [sam], need: "member", kind: "approval" })).toBe(0);
    // A question cannot be answered in the chat: it gets a push.
    expect(await dir.pushInbox(project, { users: [sam], need: "member", kind: "question" })).toBe(1);
    await dir.pushSubscribe(robin, "https://push.example.org/robin");
    gone.add("https://push.example.org/robin");
    expect(await dir.pushInbox(project, { users: [robin], need: "member", kind: "question" })).toBe(0);
    expect((await dir.pushStatus(robin)).devices).toBe(0);
  });

  it("sends one push per person in a short time: one notification says that the inbox has news", async () => {
    const { dir, sam, project } = await setup();
    await dir.pushSubscribe(sam, "https://push.example.org/sam");
    expect(await dir.pushInbox(project, { users: [sam], need: "member", kind: "question" })).toBe(1);
    expect(await dir.pushInbox(project, { users: [sam], need: "member", kind: "question" })).toBe(0);
  });

  it("keeps the preferences of a person, and refuses an unknown value", async () => {
    const { dir, robin } = await setup(false);
    expect(await dir.prefs(robin)).toEqual({ approvalsIn: "both" });
    expect(await dir.setPrefs(robin, { approvalsIn: "app" })).toEqual({ approvalsIn: "app" });
    await expect(dir.setPrefs(robin, { approvalsIn: "never" as never })).rejects.toThrow(/approvalsIn/);
    expect(await dir.prefs(robin)).toEqual({ approvalsIn: "app" });
  });
});
