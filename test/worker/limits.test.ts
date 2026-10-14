/** Rate limits: which paths fall under which limit, and how a limiter answer turns into a 429. */
import { afterEach, describe, expect, it } from "vitest";
import { clientAddress, hasCredential, hookLimitKey, hookUrlKey, limitFor, overLimit, tooMany } from "../../src/worker/limits";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";
import { sha256Hex } from "../../src/directory/crypto";
import { ORIGIN, World } from "../harbor/world";

describe("rate limits", () => {
  it("puts each path under the right limit", () => {
    expect(limitFor("POST", "/oauth/register")).toBe("auth");
    expect(limitFor("GET", "/oauth/authorize")).toBe("auth");
    expect(limitFor("GET", "/auth/github/start")).toBe("auth");
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

describe("limits on hooks and previews", () => {
  it("puts hooks and live previews under their own limits", () => {
    expect(limitFor("POST", "/hooks/slack")).toBe("hook");
    expect(limitFor("POST", "/hooks/claude/shop")).toBe("hook");
    expect(limitFor("GET", "/preview/shop/main/index.html")).toBe("preview");
  });

  it("counts a hook per person, per URL key (as a digest), or per address", async () => {
    const withKey = new Request("https://x/hooks/slack?project=shop&key=k3y-of-robin", { headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(hookUrlKey(withKey)).toBe("k3y-of-robin");
    expect(await hookLimitKey(withKey, "u_robin")).toBe("who:u_robin");
    const byKey = await hookLimitKey(withKey, null);
    expect(byKey).toBe(`key:${(await sha256Hex("k3y-of-robin")).slice(0, 24)}`);
    expect(byKey).not.toContain("k3y");
    const bare = new Request("https://x/hooks/github-app", { headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(hookUrlKey(bare)).toBeNull();
    expect(await hookLimitKey(bare, null)).toBe("ip:203.0.113.9");
  });
});

describe("the limits in the Worker", () => {
  const worlds: World[] = [];
  afterEach(async () => {
    for (const w of worlds.splice(0)) await w.close();
  });

  /** Rate limit bindings that record each key, and refuse the kinds in `deny`. */
  function limiters(deny: string[] = []) {
    const keys: string[] = [];
    const env: Record<string, unknown> = {};
    for (const name of ["RL_AUTH", "RL_TOKEN", "RL_MCP", "RL_API", "RL_CRED", "RL_HOOK", "RL_PREVIEW"]) {
      env[name] = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: !deny.includes(name) }) };
    }
    return { keys, env };
  }

  async function worldWith(deny: string[] = []) {
    const rl = limiters(deny);
    const world = new World();
    worlds.push(world);
    await world.init({ env: rl.env });
    const { key, userId } = await world.signIn("robin", 1);
    rl.keys.length = 0;
    return { world, key, userId, keys: rl.keys };
  }

  function send(world: World, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", "203.0.113.9");
    const ctx = { waitUntil: (p: Promise<unknown>) => void world.pending.push(p.catch(() => undefined)), passThroughOnException() {}, props: {} };
    return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), world.env as never, ctx as never);
  }

  it("limits live previews per address, before any lookup", async () => {
    const { world, keys } = await worldWith(["RL_PREVIEW"]);
    const res = await send(world, "/preview/shop/main/index.html");
    expect(res.status).toBe(429);
    expect(keys).toEqual(["preview:203.0.113.9"]);
  });

  it("limits hooks per key, and counts the key in a hook URL as a credential lookup", async () => {
    const { world, keys } = await worldWith(["RL_HOOK"]);
    const res = await send(world, "/hooks/slack?project=shop&key=k3y-of-robin", { method: "POST", body: "text=hi" });
    expect(res.status).toBe(429);
    expect(keys).toEqual(["cred:203.0.113.9", `hook:key:${(await sha256Hex("k3y-of-robin")).slice(0, 24)}`]);
  });

  it("counts a hook with an API key for the person of the key", async () => {
    const { world, key, userId, keys } = await worldWith(["RL_HOOK"]);
    const res = await send(world, "/hooks/intents", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ project: "shop", title: "Robin" }) });
    expect(res.status).toBe(429);
    expect(keys).toEqual(["cred:203.0.113.9", `hook:who:${userId}`]);
  });

  it("limits credential lookups on every route that reads a credential, not only the API", async () => {
    const { world, keys } = await worldWith(["RL_CRED"]);
    for (const path of ["/.well-known/oauth-authorization-server", "/preview/shop/main/index.html", "/auth/me"]) {
      keys.length = 0;
      const res = await send(world, path, { headers: { authorization: "Bearer gk_not_a_key" } });
      expect(res.status, path).toBe(429);
      expect(keys.at(-1), path).toBe("cred:203.0.113.9");
    }
    // Without a credential, no lookup and no credential limit.
    keys.length = 0;
    await send(world, "/.well-known/oauth-authorization-server");
    expect(keys).toEqual([]);
  });
});
