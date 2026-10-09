import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromB64url, githubAppJwt, hmacSha256Hex, pkcs1ToPkcs8, pemBody, randomToken, sameString, seal, sha256B64url, unseal } from "../../src/directory/crypto";
import { atLeast } from "../../src/core/accounts";
import { normalizeGitUrl, textEligible } from "../../src/core/repo-rules";

const SECRET = "a-test-secret-that-is-long-enough-1234";

describe("sealed values", () => {
  it("round-trips JSON and uses a fresh IV each time", async () => {
    const value = { clientId: "x.apps.googleusercontent.com", clientSecret: "s3cret", n: 3 };
    const a = await seal(SECRET, value);
    const b = await seal(SECRET, value);
    expect(a).not.toBe(b);
    expect(await unseal(SECRET, a)).toEqual(value);
  });

  it("refuses a wrong secret, a wrong purpose and a changed byte", async () => {
    const sealed = await seal(SECRET, { k: 1 });
    await expect(unseal("another-secret-that-is-long-enough", sealed)).rejects.toThrow();
    await expect(unseal(SECRET, sealed, "token-v1")).rejects.toThrow();
    const raw = fromB64url(sealed);
    raw[raw.length - 1] ^= 1;
    const tampered = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(unseal(SECRET, tampered)).rejects.toThrow();
  });

  it("needs a secret of at least 16 characters", async () => {
    await expect(seal("short", {})).rejects.toThrow(/BEARING_SECRET/);
  });
});

describe("tokens and hashes", () => {
  it("makes URL-safe random tokens", () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(t);
  });

  it("hashes are stable; compare is exact", async () => {
    expect(await sha256B64url("abc")).toBe(await sha256B64url("abc"));
    expect(sameString("abc", "abc")).toBe(true);
    expect(sameString("abc", "abd")).toBe(false);
    expect(sameString("abc", "abcd")).toBe(false);
  });

  it("HMAC-SHA256 matches the GitHub webhook test vector", async () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
    expect(await hmacSha256Hex("It's a Secret to Everybody", "Hello, World!")).toBe("757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
  });
});

describe("GitHub App JWT (RS256)", () => {
  it("signs with a PKCS#1 key (the format GitHub gives) and verifies with the public key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    expect(pem).toMatch(/BEGIN RSA PRIVATE KEY/);
    const now = Date.UTC(2026, 9, 9, 12, 0, 0);
    const jwt = await githubAppJwt(12345, pem, now);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(p)));
    expect(payload.iss).toBe("12345");
    expect(payload.exp - payload.iat).toBe(540);
    expect(payload.iat).toBe(now / 1000 - 60);
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey(publicKey.export({ type: "spki", format: "pem" })), Buffer.from(fromB64url(s)));
    expect(ok).toBe(true);
  });

  it("wraps PKCS#1 as PKCS#8 like OpenSSL does", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const pkcs1 = pemBody(privateKey.export({ type: "pkcs1", format: "pem" }).toString()).der;
    const pkcs8 = pemBody(privateKey.export({ type: "pkcs8", format: "pem" }).toString()).der;
    expect(Buffer.from(pkcs1ToPkcs8(pkcs1)).equals(Buffer.from(pkcs8))).toBe(true);
  });
});

describe("roles", () => {
  it("orders viewer < member < owner", () => {
    expect(atLeast("owner", "member")).toBe(true);
    expect(atLeast("member", "member")).toBe(true);
    expect(atLeast("viewer", "member")).toBe(false);
    expect(atLeast(null, "viewer")).toBe(false);
  });
});

describe("imports", () => {
  it("accepts public https remotes and refuses credentials, plain http and private hosts", () => {
    expect(normalizeGitUrl("https://github.com/cloudflare/workers-sdk/")).toBe("https://github.com/cloudflare/workers-sdk");
    expect(normalizeGitUrl("https://gitlab.com/group/project.git#x")).toBe("https://gitlab.com/group/project.git");
    expect(() => normalizeGitUrl("http://github.com/a/b")).toThrow(/https/);
    expect(() => normalizeGitUrl("https://user:pw@github.com/a/b")).toThrow(/credentials/);
    expect(() => normalizeGitUrl("https://localhost/a/b")).toThrow(/private host/);
    expect(() => normalizeGitUrl("not a url")).toThrow(/https URL/);
  });

  it("loads the text of source files, not of vendored or binary files", () => {
    expect(textEligible("src/index.ts")).toBe(true);
    expect(textEligible("README.md")).toBe(true);
    expect(textEligible("node_modules/react/index.js")).toBe(false);
    expect(textEligible("web/dist/app.js")).toBe(false);
    expect(textEligible("assets/logo.png")).toBe(false);
    expect(textEligible("fonts/x.woff2")).toBe(false);
  });
});
