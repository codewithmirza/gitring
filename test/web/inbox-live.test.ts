/**
 * The inbox stays fresh without a socket of its own (web/src/state/inbox.ts): it loads every 20 seconds while
 * the page shows, at once when the page shows again, soon after the open project changes, and not at all for a
 * person who is not signed in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../../src/core/types";

let loads = 0;
let visibility = "visible";
const docListeners = new Map<string, () => void>();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers();
  loads = 0;
  visibility = "visible";
  docListeners.clear();
  (globalThis as { location?: unknown }).location = { pathname: "/inbox", search: "", hash: "", origin: "http://gitring.test" };
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: string, fn: () => void) => docListeners.set(type, fn),
    removeEventListener: (type: string) => docListeners.delete(type),
  });
  vi.stubGlobal("fetch", async (url: string) => {
    expect(url).toBe("/api/me/inbox");
    loads += 1;
    return json({ items: [{ key: "ap:1", kind: "approval", project: "shop", intentId: "i1", title: "Add a search box", headline: "Merge this work into main?", why: [], at: 1, link: "/", actions: [] }] });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the answers of the fake fetch arrive. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

describe("the live inbox", async () => {
  const { store } = await import("../../web/src/state/store");
  const { INBOX_POLL_MS, refreshInbox, startInbox } = await import("../../web/src/state/inbox");

  it("loads every 20 seconds while the page shows, and not while it is hidden", async () => {
    store.setMe({ user: { id: "u_robin", name: "Robin" } } as never);
    const stop = startInbox();
    await flush();
    expect(loads).toBe(1);
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS);
    expect(loads).toBe(2);
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 3);
    expect(loads).toBe(2);
    // The page shows again: the inbox loads at once.
    visibility = "visible";
    docListeners.get("visibilitychange")?.();
    await flush();
    expect(loads).toBe(3);
    stop();
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 3);
    expect(loads).toBe(3);
  });

  it("loads soon after the open project changes (its socket brings the news)", async () => {
    store.setMe({ user: { id: "u_robin", name: "Robin" } } as never);
    const base = { project: { id: "shop", settings: {} }, intents: [], attempts: [], checks: [], landings: [], decisions: [], questions: [], logs: [], radar: [], files: [], agents: [] } as unknown as ProjectState;
    store.dispatch({ type: "snapshot", state: base });
    const stop = startInbox();
    await flush();
    const before = loads;
    store.dispatch({ type: "question", question: { id: "q_1", kind: "redo", status: "open", intentId: "i1", attemptIds: ["a1"], facts: [], options: [], askedAt: 1, updatedAt: 1 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(loads).toBe(before + 1);
    stop();
  });

  it("does not load for a person who is not signed in", async () => {
    store.setMe({ user: null } as never);
    const stop = startInbox();
    await flush();
    await refreshInbox();
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 2);
    expect(loads).toBe(0);
    stop();
  });
});
