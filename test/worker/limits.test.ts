/** Rate limits: which paths fall under which limit, and how a limiter answer turns into a 429. */
import { describe, expect, it } from "vitest";
import { clientAddress, hasCredential, limitFor, overLimit, tooMany } from "../../src/worker/limits";
import type { Env } from "../../src/worker/env";

describe("rate limits", () => {
  it("puts each path under the right limit", () => {
    expect(limitFor("POST", "/oauth/register")).toBe("auth");
    expect(limitFor("GET", "/oauth/authorize")).toBe("auth");
    expect(limitFor("GET", "/auth/github/start")).toBe("auth");
    // The device grant: a program starts a sign-in, and a person types its code.
    expect(limitFor("POST", "/oauth/device_authorization")).toBe("auth");
    expect(limitFor("POST", "/device")).toBe("auth");
    expect(limitFor("POST", "/oauth/token")).toBe("token");
    expect(limitFor("POST", "/oauth/revoke")).toBe("token");
    expect(limitFor("GET", "/api/projects")).toBe("api");
    expect(limitFor("GET", "/ws/shop")).toBe("api");
    expect(limitFor("GET", "/api/health")).toBeNull();
    expect(limitFor("GET", "/auth/github/callback")).toBeNull();
    expect(limitFor("GET", "/projects")).toBeNull();
  });

  it("asks the binding with a key per kind, and never blocks when the binding fails or is absent", async () => {
    const keys: string[] = [];
    const env = {
      RL_API: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: keys.length < 3 }) },
      RL_MCP: { limit: async () => Promise.reject(new Error("down")) },
    } as unknown as Env;
    expect(await overLimit(env, "api", "u_1")).toBe(false);
    expect(await overLimit(env, "api", "u_1")).toBe(false);
    expect(await overLimit(env, "api", "u_1")).toBe(true);
    expect(keys[0]).toBe("api:u_1");
    expect(await overLimit(env, "mcp", "u_1")).toBe(false);
    expect(await overLimit(env, "auth", "1.2.3.4")).toBe(false);
  });

  it("sees a credential that needs a lookup", () => {
    expect(hasCredential(new Request("https://x/api/me", { headers: { authorization: "Bearer gk_abc" } }))).toBe(true);
    expect(hasCredential(new Request("https://x/api/me", { headers: { cookie: "gitring_last=github; __Host-gitring=tok" } }))).toBe(true);
    expect(hasCredential(new Request("https://x/api/me", { headers: { cookie: "gitring_last=github" } }))).toBe(false);
    expect(hasCredential(new Request("https://x/api/me"))).toBe(false);
  });

  it("answers 429 with Retry-After, and reads the client address", async () => {
    const r = tooMany(30, true);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(clientAddress(new Request("https://x/", { headers: { "cf-connecting-ip": "203.0.113.9" } }))).toBe("203.0.113.9");
    expect(clientAddress(new Request("https://x/"))).toBe("unknown");
  });
});
