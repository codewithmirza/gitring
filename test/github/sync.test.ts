/**
 * GitHub sync over the Git Data API, against the git test double (gitring side) and an in-memory
 * GitHub (blobs, trees, commits, refs, pull requests).
 */
import { describe, expect, it } from "vitest";
import { syncToGithub, treeChanges } from "../../src/platform/github/sync";
import type { RepoBackend } from "../../src/platform/repo/backend";
import { author, backendOf, FakeGithub, filesOf } from "./fake";

/** A project imported from GitHub (one commit), then two merges in gitring. */
async function project() {
  const b = backendOf();
  await b.ensureRepo("shop");
  const c0 = await b.commit({
    repo: "shop",
    branch: "main",
    parent: "",
    message: "Import",
    author,
    changes: [
      { path: "README.md", content: "# Shop\n" },
      { path: "src/price.js", content: "export const price = 1;\n" },
      { path: "src/old/legacy.js", content: "old\n" },
    ],
  });
  const gh = new FakeGithub();
  await gh.adopt(b, "shop", c0.sha);
  gh.refs.set("heads/main", c0.sha);
  const c1 = await b.commit({ repo: "shop", branch: "main", parent: c0.sha, message: "Show prices in euro\n\nGitring-Intent: i_1", author, changes: [{ path: "src/price.js", content: "export const price = 2;\n" }] });
  const c2 = await b.commit({
    repo: "shop",
    branch: "main",
    parent: c1.sha,
    message: "Add search",
    author,
    changes: [
      { path: "src/search.js", content: "export const search = () => [];\n" },
      { path: "src/old/legacy.js", content: null },
    ],
  });
  return { b, gh, c0, c1, c2 };
}

const input = (b: RepoBackend, mainSha: string, over: Partial<Parameters<typeof syncToGithub>[1]> = {}) => ({
  backend: b,
  source: "shop",
  mainSha,
  mode: "pull-request" as const,
  branch: "gitring",
  known: {},
  pr: { title: "gitring: merged work", body: "Merged by gitring." },
  ...over,
});

describe("treeChanges", () => {
  it("lists added, changed and deleted paths, and a file that becomes a folder", async () => {
    const b = backendOf();
    await b.ensureRepo("r");
    const a = await b.commit({ repo: "r", branch: "main", parent: "", message: "a", author, changes: [{ path: "x/a.txt", content: "1" }, { path: "y", content: "file" }, { path: "z/gone.txt", content: "g" }] });
    const c = await b.commit({ repo: "r", branch: "main", parent: a.sha, message: "b", author, changes: [{ path: "x/a.txt", content: "2" }, { path: "y", content: null }, { path: "y/inner.txt", content: "i" }, { path: "z/gone.txt", content: null }] });
    const ch = await treeChanges(b, "r", a.tree, c.tree);
    const byPath = Object.fromEntries(ch.map((x) => [x.path, x.sha === null ? "delete" : x.type]));
    expect(byPath).toEqual({ "x/a.txt": "blob", y: "delete", "y/inner.txt": "blob", "z/gone.txt": "delete" });
  });
});

describe("syncToGithub", () => {
  it("pull request mode: makes the missing commits, the branch and one pull request", async () => {
    const { b, gh, c0, c1, c2 } = await project();
    const out = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, input(b, c2.sha));
    expect(out.status.state).toBe("ok");
    expect(out.status.prUrl).toBe("https://github.com/robin/shop/pull/1");
    expect(out.status.syncedSha).toBe(c2.sha);
    // The import commit keeps its id; the two merges are new GitHub commits.
    expect(out.known[c0.sha]).toBe(c0.sha);
    expect(out.known[c1.sha]).toBeTruthy();
    const tip = gh.refs.get("heads/gitring")!;
    expect(tip).toBe(out.known[c2.sha]);
    expect(gh.filesAt(tip)).toEqual(await filesOf(b, "shop", c2.sha));
    expect(gh.commits.get(out.known[c1.sha])!.message).toBe("Show prices in euro\n\nGitring-Intent: i_1");
    expect(gh.commits.get(tip)!.parents).toEqual([out.known[c1.sha]]);
    // GitHub main did not move.
    expect(gh.refs.get("heads/main")).toBe(c0.sha);

    // A new merge: only one new commit, the same pull request.
    const c3 = await b.commit({ repo: "shop", branch: "main", parent: c2.sha, message: "Dark mode", author, changes: [{ path: "src/theme.js", content: "dark\n" }] });
    const before = gh.commits.size;
    const again = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, input(b, c3.sha, { known: out.known }));
    expect(again.status.state).toBe("ok");
    expect(again.status.prNumber).toBe(1);
    expect(gh.pulls).toHaveLength(1);
    expect(gh.commits.size).toBe(before + 1);
    expect(gh.filesAt(gh.refs.get("heads/gitring")!)).toEqual(await filesOf(b, "shop", c3.sha));
  });

  it("main mode: fast-forwards main, and stops when a person pushed to GitHub main", async () => {
    const { b, gh, c2 } = await project();
    const out = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, input(b, c2.sha, { mode: "main" }));
    expect(out.status.state).toBe("ok");
    expect(gh.refs.get("heads/main")).toBe(out.known[c2.sha]);
    expect(gh.filesAt(gh.refs.get("heads/main")!)).toEqual(await filesOf(b, "shop", c2.sha));

    // A person pushes to GitHub main; gitring merges more work.
    gh.commits.set("f".repeat(40), { tree: gh.commits.get(gh.refs.get("heads/main")!)!.tree, parents: [gh.refs.get("heads/main")!], message: "hotfix", author: { name: "p", email: "p@x", date: "" } });
    gh.refs.set("heads/main", "f".repeat(40));
    const c3 = await b.commit({ repo: "shop", branch: "main", parent: c2.sha, message: "More", author, changes: [{ path: "more.txt", content: "m" }] });
    const blocked = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, input(b, c3.sha, { mode: "main", known: out.known }));
    expect(blocked.status.state).toBe("blocked");
    expect(gh.refs.get("heads/main")).toBe("f".repeat(40));
  });

  it("gives a link when the app cannot open pull requests", async () => {
    const { b, gh, c2 } = await project();
    gh.canOpenPulls = false;
    const out = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, input(b, c2.sha));
    expect(out.status.state).toBe("ok");
    expect(out.status.prUrl).toBeUndefined();
    expect(out.status.compareUrl).toBe("https://github.com/robin/shop/compare/main...gitring?expand=1");
    expect(gh.refs.get("heads/gitring")).toBe(out.known[c2.sha]);
  });

  it("says when GitHub has no commit of the project's history", async () => {
    const b = backendOf();
    await b.ensureRepo("shop");
    const c0 = await b.commit({ repo: "shop", branch: "main", parent: "", message: "Upload", author, changes: [{ path: "a.txt", content: "a" }] });
    const gh = new FakeGithub();
    const out = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, input(b, c0.sha));
    expect(out.status.state).toBe("error");
    expect(out.status.message).toMatch(/imported from this GitHub repository/);
    expect(gh.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("does nothing new when GitHub already has main", async () => {
    const { b, gh, c2 } = await project();
    const first = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, input(b, c2.sha));
    gh.calls = [];
    const again = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, input(b, c2.sha, { known: first.known }));
    expect(again.status.state).toBe("ok");
    expect(gh.calls.filter((c) => c.startsWith("POST /git"))).toEqual([]);
  });
});
