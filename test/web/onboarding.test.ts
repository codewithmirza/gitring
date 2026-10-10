/**
 * Web app: the shared GET layer (dedupe, cache, abort), and the pure helpers of the new-project picker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubRepo } from "../../src/core/accounts";
import { forget, getJson, guessUrl, isAbort, mergeRepos, peekJson, reposUrl, RequestError, resetRequestCache } from "../../web/src/state/github";
import { agoIso, nameOfRepo, nameOfUrl, rankRepos, readPasted, reasonFor, sizeText, validBranch } from "../../web/src/views/newproject/match";
import { draftFromLink, EMPTY_DRAFT } from "../../web/src/views/newproject/draft";

function repo(fullName: string, extra: Partial<GithubRepo> = {}): GithubRepo {
  return { fullName, private: false, defaultBranch: "main", htmlUrl: `https://github.com/${fullName}`, canPush: true, ...extra };
}

function answer(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("getJson", () => {
  beforeEach(() => resetRequestCache());
  afterEach(() => vi.unstubAllGlobals());

  it("shares one fetch between identical requests in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = vi.fn(async () => {
      await gate;
      return answer({ n: 1 });
    });
    vi.stubGlobal("fetch", fetch);
    const a = getJson<{ n: number }>("/api/x");
    const b = getJson<{ n: number }>("/api/x");
    release();
    expect(await a).toEqual({ n: 1 });
    expect(await b).toEqual({ n: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an answer for its TTL, and `fresh` skips the cache", async () => {
    const fetch = vi.fn(async () => answer({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await getJson("/api/y", { ttl: 60_000 });
    await getJson("/api/y", { ttl: 60_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(peekJson("/api/y", 60_000)).toEqual({ ok: true });
    await getJson("/api/y", { ttl: 60_000, fresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    forget("/api/y");
    expect(peekJson("/api/y", 60_000)).toBeNull();
  });

  it("does not cache without a TTL", async () => {
    const fetch = vi.fn(async () => answer([]));
    vi.stubGlobal("fetch", fetch);
    await getJson("/api/z");
    await getJson("/api/z");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("an abort stops one wait; the fetch stops only when nobody waits", async () => {
    let seen: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen = init.signal ?? undefined;
        await gate;
        return answer({ v: 2 });
      }),
    );
    const one = new AbortController();
    const two = new AbortController();
    const a = getJson("/api/a", { signal: one.signal });
    const b = getJson("/api/a", { signal: two.signal });
    one.abort();
    await expect(a).rejects.toSatisfy(isAbort);
    expect(seen?.aborted).toBe(false);
    release();
    expect(await b).toEqual({ v: 2 });

    // Every waiter leaves: the shared fetch stops.
    let seen2: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen2 = init.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    const c = new AbortController();
    const p = getJson("/api/b", { signal: c.signal });
    await Promise.resolve();
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
    expect(seen2?.aborted).toBe(true);
  });

  it("an aborted signal rejects at once", async () => {
    const fetch = vi.fn(async () => answer({}));
    vi.stubGlobal("fetch", fetch);
    const c = new AbortController();
    c.abort();
    await expect(getJson("/api/c", { signal: c.signal })).rejects.toSatisfy(isAbort);
  });

  it("turns error answers into RequestError with the status, the message and the data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({ error: "An owner of acme must approve the GitHub app.", installUrl: "https://github.com/apps/x" }, 403)));
    const e = (await getJson("/api/d").catch((x) => x)) as RequestError;
    expect(e).toBeInstanceOf(RequestError);
    expect(e.status).toBe(403);
    expect(e.message).toBe("An owner of acme must approve the GitHub app.");
    expect(e.data.installUrl).toBe("https://github.com/apps/x");
  });

  it("gives a plain message for a network failure and for an empty error answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    const e1 = (await getJson("/api/e").catch((x) => x)) as RequestError;
    expect(e1.status).toBe(0);
    expect(e1.message).toMatch(/did not answer/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    const e2 = (await getJson("/api/f").catch((x) => x)) as RequestError;
    expect(e2.status).toBe(502);
    expect(e2.message).toMatch(/gitring had a problem/);
  });

  it("does not keep a failed answer: the next call asks again", async () => {
    const fetch = vi.fn(async () => answer({ error: "no" }, 500));
    vi.stubGlobal("fetch", fetch);
    await getJson("/api/g", { ttl: 60_000 }).catch(() => undefined);
    await getJson("/api/g", { ttl: 60_000 }).catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("URLs", () => {
  it("encodes the query and the repository", () => {
    expect(reposUrl("")).toBe("/api/github/repos");
    expect(reposUrl("  git ring ")).toBe("/api/github/repos?q=git%20ring");
    expect(guessUrl("mirza/gitring")).toBe("/api/github/guess?repo=mirza%2Fgitring");
    expect(guessUrl("mirza/gitring", "dev/x")).toBe("/api/github/guess?repo=mirza%2Fgitring&branch=dev%2Fx");
  });
});

describe("readPasted", () => {
  it("reads GitHub URLs and owner/name", () => {
    expect(readPasted("https://github.com/mirza/gitring")).toEqual({ kind: "github", repo: "mirza/gitring", url: "https://github.com/mirza/gitring" });
    expect(readPasted("github.com/mirza/gitring.git")).toMatchObject({ kind: "github", repo: "mirza/gitring" });
    expect(readPasted("git@github.com:mirza/gitring.git")).toMatchObject({ kind: "github", repo: "mirza/gitring" });
    expect(readPasted("mirza/gitring")).toMatchObject({ kind: "github", repo: "mirza/gitring" });
  });
  it("reads other https git URLs", () => {
    expect(readPasted("https://gitlab.com/acme/tool/")).toEqual({ kind: "git", url: "https://gitlab.com/acme/tool" });
    expect(readPasted("https://codeberg.org/x/y.git")).toEqual({ kind: "git", url: "https://codeberg.org/x/y.git" });
  });
  it("explains what gitring cannot import", () => {
    expect(readPasted("http://gitlab.com/acme/tool")).toMatchObject({ kind: "bad" });
    expect(readPasted("git@gitlab.com:acme/tool.git")).toMatchObject({ kind: "bad" });
    expect(readPasted("https://user:pw@gitlab.com/acme/tool")).toMatchObject({ kind: "bad" });
  });
  it("treats plain words as a search", () => {
    expect(readPasted("")).toBeNull();
    expect(readPasted("gitring")).toBeNull();
    expect(readPasted("my repo")).toBeNull();
    expect(readPasted("https://example.com")).toBeNull();
  });
});

describe("rankRepos", () => {
  const list = [repo("acme/website", { description: "Marketing site" }), repo("mirza/gitring-web"), repo("mirza/gitring"), repo("mirza/dotfiles", { language: "Shell" }), repo("acme/payments")];
  it("puts exact and prefix matches first", () => {
    expect(rankRepos(list, "gitring").map((r) => r.fullName)).toEqual(["mirza/gitring", "mirza/gitring-web"]);
    // A name that starts with the word beats a later word of a name.
    expect(rankRepos(list, "web").map((r) => r.fullName)).toEqual(["acme/website", "mirza/gitring-web"]);
  });
  it("needs every word to match", () => {
    expect(rankRepos(list, "acme pay").map((r) => r.fullName)).toEqual(["acme/payments"]);
    expect(rankRepos(list, "acme zzz")).toEqual([]);
  });
  it("matches the owner, the description and the language", () => {
    expect(rankRepos(list, "acme").map((r) => r.fullName)).toEqual(["acme/website", "acme/payments"]);
    expect(rankRepos(list, "marketing").map((r) => r.fullName)).toEqual(["acme/website"]);
    expect(rankRepos(list, "shell").map((r) => r.fullName)).toEqual(["mirza/dotfiles"]);
  });
  it("keeps the server order without a query", () => {
    expect(rankRepos(list, "  ")).toBe(list);
  });
  it("merges server results without duplicates", () => {
    const merged = mergeRepos([repo("a/b")], [repo("A/B"), repo("c/d")]);
    expect(merged.map((r) => r.fullName)).toEqual(["a/b", "c/d"]);
  });
});

describe("small helpers", () => {
  it("names", () => {
    expect(nameOfRepo("mirza/gitring")).toBe("gitring");
    expect(nameOfUrl("https://gitlab.com/acme/tool.git")).toBe("tool");
    expect(nameOfUrl("https://gitlab.com/acme/tool/")).toBe("tool");
  });
  it("branches", () => {
    expect(validBranch("main")).toBe(true);
    expect(validBranch("feature/x-1.2")).toBe(true);
    expect(validBranch("a..b")).toBe(false);
    expect(validBranch("bad branch")).toBe(false);
    expect(validBranch("/x")).toBe(false);
  });
  it("times and sizes", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(agoIso("2026-10-10T11:58:00Z", now)).toBe("2 min ago");
    expect(agoIso("2026-10-07T12:00:00Z", now)).toBe("3 d ago");
    expect(agoIso(undefined, now)).toBe("");
    expect(sizeText(640_000)).toBe("640 KB");
    expect(sizeText(3_400_000)).toBe("3.4 MB");
  });
  it("finds the reason for each guess", () => {
    const reasons = ["The default branch is trunk.", "package-lock.json is in the repository, so the install command is npm ci.", "package.json has a test script: npm test.", "You can push to this repository, so merged code goes to a pull request."];
    expect(reasonFor(reasons, "branch")).toBe(reasons[0]);
    expect(reasonFor(reasons, "install")).toBe(reasons[1]);
    expect(reasonFor(reasons, "test")).toBe(reasons[2]);
    expect(reasonFor(reasons, "sync")).toBe(reasons[3]);
  });
});

describe("draftFromLink", () => {
  const params = (q: string) => new URLSearchParams(q);
  it("opens the list and keeps an earlier draft", () => {
    const prev = { ...EMPTY_DRAFT, query: "gitr" };
    expect(draftFromLink(params("new=1"), prev)).toBe(prev);
    expect(draftFromLink(params("new=1&q=next"), prev)).toMatchObject({ query: "next", step: { kind: "list" } });
  });
  it("opens a source", () => {
    expect(draftFromLink(params("new=push"), EMPTY_DRAFT).step).toEqual({ kind: "push" });
    expect(draftFromLink(params("new=empty"), EMPTY_DRAFT).step).toEqual({ kind: "empty" });
    expect(draftFromLink(params("new=folder"), EMPTY_DRAFT).step).toEqual({ kind: "upload" });
    expect(draftFromLink(params("new=git&url=https%3A%2F%2Fgitlab.com%2Fa%2Fb"), EMPTY_DRAFT).step).toEqual({ kind: "git", url: "https://gitlab.com/a/b" });
    expect(draftFromLink(params("new=1&repo=mirza%2Fgitring"), EMPTY_DRAFT).step).toEqual({ kind: "github", repo: "mirza/gitring" });
  });
  it("treats the old sample link as the list", () => {
    expect(draftFromLink(params("new=sample"), EMPTY_DRAFT)).toBe(EMPTY_DRAFT);
  });
  it("ignores a bad repository", () => {
    expect(draftFromLink(params("new=1&repo=not a repo"), EMPTY_DRAFT).step).toEqual({ kind: "list" });
  });
});
