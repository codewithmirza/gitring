/**
 * The first load knows who is here before it says "ready". With the waitlist gate on, /api/projects refuses a
 * visitor at once (401) while /api/me still runs. The app chooses between the waitlist and the app on "ready",
 * so "ready" before /api/me answers showed the app for a moment, and then the waitlist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHttpCache } from "../../web/src/state/http";
import { store } from "../../web/src/state/store";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const VISITOR = { user: null, providers: { github: true, google: true }, setupNeeded: false, waitlist: { on: true, allowed: false } };

beforeEach(() => {
  resetHttpCache();
  vi.stubGlobal("location", new URL("https://gitring.test/"));
  vi.stubGlobal("fetch", (url: string) => {
    if (url.startsWith("/api/projects")) return Promise.resolve(json({ error: "Sign in first.", code: "sign_in" }, 401));
    if (url.startsWith("/api/me")) return new Promise<Response>((r) => setTimeout(() => r(json(VISITOR)), 30));
    return Promise.resolve(json({}, 404));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the first load of the account", () => {
  it("is ready only after /api/me answers, also when /api/projects fails first", async () => {
    const meAtReady: unknown[] = [];
    const unsubscribe = store.subscribe(() => {
      const s = store.get();
      if (s.accountReady && meAtReady.length === 0) meAtReady.push(s.me);
    });
    const { boot } = await import("../../web/src/state/api/boot");
    await boot();
    unsubscribe();
    expect(store.get().accountReady).toBe(true);
    expect(meAtReady).toHaveLength(1);
    expect(meAtReady[0]).toMatchObject({ user: null, waitlist: { allowed: false } });
  });
});
