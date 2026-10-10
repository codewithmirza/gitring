import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCount, getJson, getText, HttpError, invalidate, isAbort, Lru, noteWrite, peek, resetHttpCache, send } from "../../web/src/state/http";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

let calls: Call[] = [];
let respond: (c: Call) => Response | Promise<Response>;

function json(body: unknown, init: ResponseInit & { etag?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json", ...(init.etag ? { etag: init.etag } : {}) });
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

beforeEach(() => {
  calls = [];
  resetHttpCache();
  respond = () => json({ ok: true });
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const c: Call = { url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, signal: init.signal as AbortSignal };
    calls.push(c);
    return new Promise<Response>((resolve, reject) => {
      if (c.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      c.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      Promise.resolve(respond(c)).then(resolve, reject);
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared GET requests", () => {
  it("share one fetch for identical requests in flight", async () => {
    let release!: () => void;
    respond = () => new Promise((r) => (release = () => r(json({ n: 1 }))));
    const a = getJson<{ n: number }>("/api/x");
    const b = getJson<{ n: number }>("/api/x");
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    release();
    expect(await a).toEqual({ n: 1 });
    expect(await b).toBe(await a);
  });

  it("serve an answer from memory for maxAge, then ask again", async () => {
    await getJson("/api/me", { maxAge: 60_000 });
    await getJson("/api/me", { maxAge: 60_000 });
    expect(calls).toHaveLength(1);
    await getJson("/api/me");
    expect(calls).toHaveLength(2);
  });

  it("abort only the caller that leaves; the fetch stops when nobody waits", async () => {
    let release!: () => void;
    respond = () => new Promise((r) => (release = () => r(json({ ok: 1 }))));
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = getJson("/api/y", { signal: c1.signal });
    const p2 = getJson("/api/y", { signal: c2.signal });
    c1.abort();
    await expect(p1).rejects.toSatisfy(isAbort);
    expect(calls[0].signal.aborted).toBe(false);
    release();
    expect(await p2).toEqual({ ok: 1 });

    respond = () => new Promise(() => undefined);
    const c3 = new AbortController();
    const p3 = getJson("/api/z", { signal: c3.signal });
    c3.abort();
    await expect(p3).rejects.toSatisfy(isAbort);
    expect(calls[1].signal.aborted).toBe(true);
  });

  it("revalidate with If-None-Match and reuse the value on 304", async () => {
    respond = () => json({ files: [1, 2] }, { etag: '"t-1"' });
    const first = await getJson("/api/projects/p/tree?ref=at_1", { etag: true });
    respond = (c) => (c.headers["if-none-match"] === '"t-1"' ? new Response(null, { status: 304 }) : json({ files: [] }));
    const second = await getJson("/api/projects/p/tree?ref=at_1", { etag: true });
    expect(calls[1].headers["if-none-match"]).toBe('"t-1"');
    expect(second).toBe(first);
  });

  it("read text answers", async () => {
    respond = () => new Response("const a = 1;\n", { headers: { "content-type": "text/plain" } });
    expect(await getText("/api/projects/p/file?ref=main&path=a.js")).toBe("const a = 1;\n");
  });

  it("turn errors into plain sentences with the status", async () => {
    respond = () => json({ error: "Unknown ref x." }, { status: 404 });
    await expect(getJson("/api/projects/p/tree?ref=x")).rejects.toMatchObject({ status: 404, message: "Unknown ref x." });
    respond = () => new Response("", { status: 500 });
    await expect(getJson("/api/q")).rejects.toMatchObject({ status: 500, message: "gitring had a problem. Try again." });
    respond = () => Promise.reject(new TypeError("Failed to fetch"));
    const e = await getJson("/api/q2").catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(0);
  });
});

describe("writes drop the cached answers they change", () => {
  it("a project write drops the project list; a sign-in change drops /api/me", async () => {
    await getJson("/api/projects", { maxAge: 30_000 });
    await getJson("/api/me", { maxAge: 60_000 });
    expect(peek("/api/projects")).toBeDefined();
    await send("PATCH", "/api/projects/p1", { name: "x" });
    expect(peek("/api/projects")).toBeUndefined();
    expect(peek("/api/me")).toBeDefined();
    noteWrite("/auth/logout");
    expect(peek("/api/me")).toBeUndefined();
  });

  it("drops by exact URL or prefix on request", async () => {
    await getJson("/api/projects/p/connect", { maxAge: 60_000 });
    invalidate("/api/projects/p/", { prefix: true });
    expect(peek("/api/projects/p/connect")).toBeUndefined();
    const before = fetchCount();
    await getJson("/api/projects/p/connect", { maxAge: 60_000 });
    expect(fetchCount()).toBe(before + 1);
  });
});

describe("Lru", () => {
  it("drops the least recently used entries by count and by weight", () => {
    const l = new Lru<string, string>(3, 10);
    l.set("a", "1", 2);
    l.set("b", "2", 2);
    l.set("c", "3", 2);
    l.get("a");
    l.set("d", "4", 2);
    expect(l.keys()).toEqual(["c", "a", "d"]);
    l.set("e", "5", 6);
    expect(l.weight).toBeLessThanOrEqual(10);
    expect(l.has("e")).toBe(true);
    l.set("huge", "x", 11);
    expect(l.has("huge")).toBe(false);
  });
});
