/**
 * Pull-request mode (security review, findings 5 and 9):
 *   - a merged gitring pull request does not come back as a new, empty pull request;
 *   - a commit that a person pushes to the pull request branch between gitring's read and its move of
 *     the branch is not lost: the move is a fast-forward, or the sync stops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeBranch, syncToGithub } from "../../src/platform/github/sync";
import { author, backendOf, FakeGithub } from "./fake";
import { World } from "./harness";

describe("a merged pull request", () => {
  let world: World;
  beforeEach(async () => {
    world = new World();
    vi.stubGlobal("fetch", world.fetch);
    await world.init();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** What GitHub does for "Merge pull request" (create a merge commit): the base's files plus the head's. */
  function mergePr(n: number) {
    const pr = world.gh.pulls[0]!;
    const head = world.gh.refs.get(`heads/${pr.head}`)!;
    const base = world.gh.refs.get(`heads/${pr.base}`)!;
    const headTree = world.gh.commits.get(head)!.tree;
    const baseTree = world.gh.commits.get(base)!.tree;
    const tree = world.gh.isAncestor(base, head) ? headTree : world.gh.putTree(new Map([...world.gh.trees.get(baseTree)!, ...world.gh.trees.get(headTree)!]));
    const sha = (n + 10).toString(16).repeat(40).slice(0, 40);
    world.gh.commits.set(sha, { tree, parents: [base, head], message: `Merge pull request #${n}`, author: { name: "Pat", email: "p@x", date: "" } });
    world.gh.refs.set(`heads/${pr.base}`, sha);
    world.gh.pulls = world.gh.pulls.filter((x) => x !== pr); // merged: no longer open
    return sha;
  }

  const pushEvent = (n: number) => world.hook("push", `d-${n}`, { ref: "refs/heads/main", repository: { full_name: "robin/shop", default_branch: "main" } });

  it("opens no empty pull request after the merge; the next merged task opens the next one", async () => {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const { id, key, h } = await world.linkedProject("alice");
    // Real work, pull request #1.
    const work = await world.land(id, "feature.js", "export const f = 1;\n");
    expect((await world.call("POST", `/api/projects/${id}/github/sync`, { key })).json.prNumber).toBe(1);
    const prPosts = () => world.gh.calls.filter((c) => c === "POST /pulls").length;
    const posts = prPosts();

    const merge = mergePr(1);
    expect((await pushEvent(1)).status).toBe(202);
    await world.settle();
    // Nothing to merge: main is the files of GitHub main now; no commit, no new pull request.
    expect((await h.state()).project.mainSha).toBe(work);
    expect(world.gh.pulls).toHaveLength(0);
    expect(prPosts()).toBe(posts);
    const st = world.ghState(id);
    expect(st.known[work]).toBe(merge);
    expect(st.last).toBe(merge);
    expect(st.pull?.state).toBe("up-to-date");
    const status = await h.githubStatus();
    expect(status.state).toBe("ok");
    expect(status.message).toMatch(/No pull request is necessary/);

    // A second push webhook for the same state changes nothing either.
    await pushEvent(2);
    await world.settle();
    expect(world.gh.pulls).toHaveLength(0);
    expect(prPosts()).toBe(posts);

    // The next merged task: a new pull request with that work only.
    await world.land(id, "more.js", "export const g = 2;\n");
    const sync = await world.call("POST", `/api/projects/${id}/github/sync`, { key });
    expect(sync.json.state).toBe("ok");
    expect(sync.json.prUrl).toBeDefined();
    expect(prPosts()).toBe(posts + 1);
    expect(world.gh.pulls).toHaveLength(1);
    const tip = world.gh.refs.get("heads/gitring")!;
    expect(world.gh.commits.get(tip)!.parents).toEqual([merge]);
    expect(world.gh.filesAt(tip)["more.js"]).toBe("export const g = 2;\n");
  });

  it("merges GitHub changes that came with the merge commit (main did not have everything)", async () => {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const { id, key, h } = await world.linkedProject("alice");
    await world.land(id, "feature.js", "export const f = 1;\n");
    await world.call("POST", `/api/projects/${id}/github/sync`, { key });
    // A person pushes to GitHub main, then merges the pull request.
    world.gh.push({ "docs.md": "# docs\n" }, "Docs");
    const merge = mergePr(1);
    expect(world.gh.filesAt(merge)).toMatchObject({ "docs.md": "# docs\n", "feature.js": "export const f = 1;\n" });
    await pushEvent(1);
    await world.settle();
    expect(await h.file("main", "docs.md")).toBe("# docs\n");
    expect(world.ghState(id).pull?.state).toBe("merged");
    // The merge went back to GitHub as a merge commit on the branch; no pull request for it: its files
    // are the files of GitHub main.
    expect(world.gh.pulls).toHaveLength(0);
    expect((await h.githubStatus()).message).toMatch(/No pull request is necessary/);
  });
});

describe("the pull request branch", () => {
  it("keeps a commit that a person pushed between gitring's read and its move", async () => {
    const b = backendOf();
    await b.ensureRepo("shop");
    const c0 = await b.commit({ repo: "shop", branch: "main", parent: "", message: "Import", author, changes: [{ path: "README.md", content: "# Shop\n" }] });
    const gh = new FakeGithub();
    await gh.adopt(b, "shop", c0.sha);
    gh.refs.set("heads/main", c0.sha);
    const c1 = await b.commit({ repo: "shop", branch: "main", parent: c0.sha, message: "One", author, changes: [{ path: "a.txt", content: "a" }] });
    const input = { backend: b, source: "shop", mode: "pull-request" as const, branch: "gitring", pr: { title: "t", body: "b" } };
    const first = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, { ...input, mainSha: c1.sha, known: {} });
    expect(first.status.state).toBe("ok");

    const c2 = await b.commit({ repo: "shop", branch: "main", parent: c1.sha, message: "Two", author, changes: [{ path: "b.txt", content: "b" }] });
    const pushed: string[] = [];
    const racing = (async (url: string, init?: RequestInit) => {
      const res = await gh.fetch(url, init);
      // A reviewer's commit lands right after gitring read the tip.
      if ((init?.method ?? "GET") === "GET" && new URL(url).pathname.endsWith("/git/refs/heads/gitring")) pushed.push(gh.push({ [`review-${pushed.length}.md`]: "a reviewer's fix\n" }, "Review fix", "gitring"));
      return res;
    }) as typeof fetch;
    const second = await syncToGithub({ repo: gh.repo, token: "t", fetch: racing }, { ...input, mainSha: c2.sha, known: first.known });
    expect(second.status.state).toBe("blocked");
    expect(second.status.message).toMatch(/Someone pushed commits to gitring/);
    expect(gh.refs.get("heads/gitring")).toBe(pushed[pushed.length - 1]);
    for (const sha of pushed) expect(gh.isAncestor(sha, gh.refs.get("heads/gitring")!)).toBe(true);
    expect(gh.calls.filter((c) => c === "PATCH /git/refs/heads/gitring")).not.toHaveLength(0);
  });

  it("moves without force in the normal case, and with force only when the tip is gitring's own and unchanged", async () => {
    const b = backendOf();
    await b.ensureRepo("shop");
    const c0 = await b.commit({ repo: "shop", branch: "main", parent: "", message: "Import", author, changes: [{ path: "README.md", content: "# Shop\n" }] });
    const gh = new FakeGithub();
    await gh.adopt(b, "shop", c0.sha);
    gh.refs.set("heads/main", c0.sha);
    const c1 = await b.commit({ repo: "shop", branch: "main", parent: c0.sha, message: "One", author, changes: [{ path: "a.txt", content: "a" }] });
    const input = { backend: b, source: "shop", mode: "pull-request" as const, branch: "gitring", pr: { title: "t", body: "b" } };
    const bodies: { force?: boolean }[] = [];
    const watch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && new URL(url).pathname.endsWith("/git/refs/heads/gitring")) bodies.push(JSON.parse(String(init.body)));
      return gh.fetch(url, init);
    }) as typeof fetch;
    const first = await syncToGithub({ repo: gh.repo, token: "t", fetch: watch }, { ...input, mainSha: c1.sha, known: {} });
    expect(first.status.state).toBe("ok");
    // The branch did not exist: the move without force said so, then the branch was made.
    expect(bodies).toEqual([{ sha: expect.any(String), force: false }]);
    bodies.length = 0;
    // Another history from c1 (a project reset to that commit), for the third sync.
    await b.fork("shop", "shop-reset");
    const c2 = await b.commit({ repo: "shop", branch: "main", parent: c1.sha, message: "Two", author, changes: [{ path: "b.txt", content: "b" }] });
    const second = await syncToGithub({ repo: gh.repo, token: "t", fetch: watch }, { ...input, mainSha: c2.sha, known: first.known });
    expect(second.status.state).toBe("ok");
    expect(bodies).toEqual([{ sha: expect.any(String), force: false }]);
    bodies.length = 0;
    // gitring's own tip, not an ancestor of the new tip (another history): force, after a second read.
    const c3 = await b.commit({ repo: "shop-reset", branch: "main", parent: c1.sha, message: "Other history", author, changes: [{ path: "c.txt", content: "c" }] });
    const third = await syncToGithub({ repo: gh.repo, token: "t", fetch: watch }, { ...input, source: "shop-reset", mainSha: c3.sha, known: second.known });
    expect(third.status.state).toBe("ok");
    expect(bodies.map((x) => x.force)).toEqual([false, true]);
    expect(gh.refs.get("heads/gitring")).toBe(third.known[c3.sha]);
  });

  it("compares branch names as git resolves them", () => {
    expect(normalizeBranch("./main")).toBe("main");
    expect(normalizeBranch("refs/heads/main")).toBe("main");
    expect(normalizeBranch("a//b/./c/")).toBe("a/b/c");
    expect(normalizeBranch(" gitring ")).toBe("gitring");
  });
});
