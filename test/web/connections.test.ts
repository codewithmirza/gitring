import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedGet, invalidate, listGrants, revokeGrant } from "../../web/src/state/connections";

type Call = { url: string; init: RequestInit; resolve: (v: Response) => void };

function fakeFetch() {
  const calls: Call[] = [];
  const fn = vi.fn((url: string, init: RequestInit = {}) => {
    return new Promise<Response>((resolve, reject) => {
      calls.push({ url, init, resolve });
      init.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  invalidate("/");
});

describe("cachedGet", () => {
  it("shares one request between callers and caches the answer", async () => {
    const { calls } = fakeFetch();
    const a = cachedGet<number[]>("/api/x");
    const b = cachedGet<number[]>("/api/x");
    expect(calls).toHaveLength(1);
    calls[0].resolve(ok([1, 2]));
    expect(await a).toEqual([1, 2]);
    expect(await b).toEqual([1, 2]);
    expect(await cachedGet<number[]>("/api/x")).toEqual([1, 2]);
    expect(calls).toHaveLength(1);
    // maxAge 0 asks again.
    const c = cachedGet<number[]>("/api/x", { maxAge: 0 });
    expect(calls).toHaveLength(2);
    calls[1].resolve(ok([3]));
    expect(await c).toEqual([3]);
  });

  it("keeps the shared request while one caller still waits", async () => {
    const { calls } = fakeFetch();
    const one = new AbortController();
    const first = cachedGet<string>("/api/y", { signal: one.signal });
    const second = cachedGet<string>("/api/y", { signal: new AbortController().signal });
    one.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0].init.signal?.aborted).toBe(false);
    calls[0].resolve(ok("done"));
    expect(await second).toBe("done");
  });

  it("aborts the request when every caller left", async () => {
    const { calls } = fakeFetch();
    const ctl = new AbortController();
    const p = cachedGet<string>("/api/z", { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0].init.signal?.aborted).toBe(true);
    // A new caller starts a new request.
    const again = cachedGet<string>("/api/z");
    expect(calls).toHaveLength(2);
    calls[1].resolve(ok("fresh"));
    expect(await again).toBe("fresh");
  });
});

describe("grants", () => {
  it("drops a revoked grant from the cached list", async () => {
    const { calls } = fakeFetch();
    const list = listGrants();
    calls[0].resolve(ok([{ id: "g1" }, { id: "g2" }]));
    expect(await list).toHaveLength(2);
    const del = revokeGrant("g1");
    expect(calls[1].url).toBe("/api/oauth/grants/g1");
    expect(calls[1].init.method).toBe("DELETE");
    calls[1].resolve(new Response(null, { status: 204 }));
    await del;
    expect(await listGrants()).toEqual([{ id: "g2" }]);
    expect(calls).toHaveLength(2);
  });

  it("says what happened when the server refuses", async () => {
    const { calls } = fakeFetch();
    const p = listGrants({ maxAge: 0 });
    calls[0].resolve(new Response(JSON.stringify({ error: "Sign in first." }), { status: 401 }));
    await expect(p).rejects.toMatchObject({ status: 401, message: "Sign in first." });
  });
});
