/** The repositories a person can import (installations of the app), pagination and ETag reuse. */
import { beforeEach, describe, expect, it } from "vitest";
import { clearGithubCache, GithubClient, nextLink } from "../../src/platform/github/api";
import { listUserRepos } from "../../src/platform/github/repos";

const repo = (n: string, extra: Record<string, unknown> = {}) => ({ full_name: n, private: false, default_branch: "main", html_url: `https://github.com/${n}`, pushed_at: "2026-10-01T00:00:00Z", permissions: { push: true }, ...extra });

function fake(routes: Record<string, (req: Request) => Response>) {
  const calls: { url: string; inm: string | null }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(String(input), init);
    calls.push({ url: req.url, inm: req.headers.get("if-none-match") });
    const u = new URL(req.url);
    const key = Object.keys(routes).find((k) => `${u.pathname}${u.search}`.startsWith(k));
    return key ? routes[key](req) : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

beforeEach(() => clearGithubCache());

describe("listUserRepos", () => {
  it("lists repositories of every installation, newest push first, with pages", async () => {
    const { f } = fake({
      "/user/installations?": () => Response.json({ installations: [{ id: 1, account: { login: "robin", type: "User" }, repository_selection: "selected" }, { id: 2, account: { login: "acme", type: "Organization" }, repository_selection: "all" }] }),
      "/user/installations/1/repositories?per_page=100&page=2": () => Response.json({ repositories: [repo("robin/b", { pushed_at: "2026-10-09T00:00:00Z" })] }),
      "/user/installations/1/repositories?per_page=100": () =>
        new Response(JSON.stringify({ repositories: [repo("robin/a", { private: true, permissions: { pull: true } })] }), {
          headers: { link: '<https://api.github.com/user/installations/1/repositories?per_page=100&page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"' },
        }),
      "/user/installations/2/repositories": () => Response.json({ repositories: [repo("acme/site", { archived: true }), repo("acme/api", { pushed_at: "2026-10-05T00:00:00Z" })] }),
    });
    const out = await listUserRepos(new GithubClient("ghu_x", { fetch: f, cacheKey: "u:1" }));
    expect(out.repos.map((r) => r.fullName)).toEqual(["robin/b", "acme/api", "robin/a"]);
    expect(out.repos.find((r) => r.fullName === "robin/a")).toMatchObject({ private: true, canPush: false });
    expect(out.installations).toEqual([
      { id: 1, account: "robin", type: "User", selection: "selected", repos: 2 },
      { id: 2, account: "acme", type: "Organization", selection: "all", repos: 1 },
    ]);
    expect(out.complete).toBe(true);
  });
});

describe("GithubClient", () => {
  it("sends If-None-Match and reuses the body on 304", async () => {
    let n = 0;
    const { f, calls } = fake({
      "/repos/a/b": (req) => {
        n++;
        if (req.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304 });
        return new Response(JSON.stringify({ full_name: "a/b" }), { headers: { etag: '"v1"' } });
      },
    });
    const gh = new GithubClient("t", { fetch: f, cacheKey: "u:1" });
    expect(await gh.json<{ full_name: string }>("/repos/a/b")).toEqual({ full_name: "a/b" });
    expect(await gh.json<{ full_name: string }>("/repos/a/b")).toEqual({ full_name: "a/b" });
    expect(n).toBe(2);
    expect(calls[1].inm).toBe('"v1"');
    // Another person does not get the first person's cached answer.
    const other = new GithubClient("t2", { fetch: f, cacheKey: "u:2" });
    await other.json("/repos/a/b");
    expect(calls[2].inm).toBeNull();
  });

  it("reads Link headers", () => {
    expect(nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"')).toBe("https://x/a?page=2");
    expect(nextLink('<https://x/a?page=9>; rel="last"')).toBeNull();
    expect(nextLink(null)).toBeNull();
  });
});
