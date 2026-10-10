/**
 * Memory of the project's object (security review, findings 4 and 6):
 *   - a private import has one byte budget: the tarball's files and the files read one by one through the
 *     Git Data API together (the tree's sizes decide before any file is read);
 *   - a pull reads at most MAX_PULL_BYTES of files, and holds no blob longer than its merge step;
 *   - the import checks the tarball against GitHub's tree, with two more tries; without the tree the
 *     attempt fails and the snapshot is never recorded as GitHub's commit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PULL_BYTES, upstreamChanges } from "../../src/platform/github/upstream";
import { readSnapshot } from "../../src/core/git/snapshot";
import { author, backendOf, FakeGithub } from "./fake";
import { World } from "./harness";

describe("a private import", () => {
  let world: World;
  beforeEach(async () => {
    world = new World();
    vi.stubGlobal("fetch", world.fetch);
    await world.init();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function githubCommit(files: Record<string, string>) {
    await world.backend.ensureRepo("gh-src");
    const c = await world.backend.commit({ repo: "gh-src", branch: "main", parent: "", message: "init", author, changes: Object.entries(files).map(([path, content]) => ({ path, content })) });
    await world.gh.adopt(world.backend, "gh-src", c.sha);
    world.gh.refs.set("heads/main", c.sha);
    world.gh.private_ = true;
    return c.sha;
  }

  async function importPrivate() {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const a = await world.signIn("alice");
    const made = await world.call("POST", "/api/projects", { key: a.key, body: { name: "shop", source: { kind: "github", repo: "robin/shop" } } });
    expect(made.status).toBe(201);
    expect(made.json.project.visibility).toBe("private");
    const id = made.json.project.id as string;
    await world.settle();
    const done = await world.call("POST", `/api/projects/${id}/import/check`, { key: a.key });
    await world.settle();
    return { id, key: a.key, done, h: world.harbor(id) };
  }

  it("refuses when the files that the tarball leaves out move the import past the byte budget, before reading them", async () => {
    const files: Record<string, string> = { "README.md": "# shop\n" };
    for (let i = 0; i < 8; i++) files[`assets/big${i}.bin`] = String.fromCharCode(97 + i).repeat(5_000_000);
    await githubCommit(files);
    for (let i = 0; i < 8; i++) world.gh.exportIgnore.add(`assets/big${i}.bin`);
    const { done, h } = await importPrivate();
    expect(done.json.importing.error).toMatch(/robin\/shop is larger than 25 MB/);
    expect(done.json.mainSha).toBe("");
    expect(world.gh.blobBytesServed).toBe(0);
    expect((await h.state()).files).toEqual([]);
    // The project stays private either way.
    expect((await h.githubFacts()).privateCode).toBe(true);
  });

  it("takes the files that the tarball leaves out when they fit", async () => {
    await githubCommit({ "README.md": "# shop\n", "assets/big.bin": "b".repeat(3_000_000), "src/a.js": "a\n" });
    world.gh.exportIgnore.add("assets/big.bin");
    const { done, h } = await importPrivate();
    expect(done.json.importing).toBeNull();
    expect((await h.state()).files.map((f: { path: string }) => f.path).sort()).toEqual(["README.md", "assets/big.bin", "src/a.js"]);
    expect(world.gh.blobBytesServed).toBe(3_000_000);
  });

  it("reads the tree again after a transient GitHub error, and the import is exact", async () => {
    const lf = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const sha = await githubCommit({ "README.md": "# shop\n", "win/build.bat": lf });
    world.gh.tarballText.set("win/build.bat", lf.replace(/\n/g, "\r\n")); // .gitattributes: *.bat eol=crlf
    world.gh.failTrees = { status: 502, times: 1 };
    const { id, key, done, h } = await importPrivate();
    expect(done.json.importing).toBeNull();
    expect(await h.file("main", "win/build.bat")).toBe(lf);
    expect(world.gh.calls.filter((c) => c.startsWith("GET /git/trees/"))).toHaveLength(2);
    expect(world.ghState(id).known[done.json.mainSha]).toBe(sha);
    // A later one-line edit on GitHub merges cleanly: main really is GitHub's commit.
    world.gh.push({ "win/build.bat": lf.replace("line 3", "line three") }, "Edit");
    const pulled = await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    expect(pulled.json.pull.state).toBe("merged");
  }, 30_000);

  it("fails the attempt when GitHub does not give the tree three times, and never records the snapshot as GitHub's commit", async () => {
    const sha = await githubCommit({ "README.md": "# shop\n" });
    world.gh.failTrees = { status: 502, times: 3 };
    const { id, done, h } = await importPrivate();
    // The attempt failed; the alarm tries again later (no error yet, no main).
    expect(done.json.importing.error).toBeUndefined();
    expect(done.json.importing.github.tries).toBe(1);
    expect(done.json.mainSha).toBe("");
    expect(Object.values(world.ghState(id).known)).not.toContain(sha);
    expect(world.ghState(id).last).toBeUndefined();
    const log = (await h.state()).logs.map((l: { message: string }) => l.message).join("\n");
    expect(log).toMatch(/could not read the file list of robin\/shop \(GitHub answered 502\)\. gitring tries again soon/);
  }, 30_000);

  it("fails the import for a tree that GitHub does not list whole", async () => {
    await githubCommit({ "README.md": "# shop\n" });
    const base = world.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/\/git\/trees\//.test(url)) return Response.json({ sha: "x", truncated: true, tree: [] });
      return base(input, init);
    });
    const { done } = await importPrivate();
    expect(done.json.importing.error).toMatch(/does not list all files of robin\/shop/);
  });
});

describe("a pull", () => {
  let world: World;
  beforeEach(async () => {
    world = new World();
    vi.stubGlobal("fetch", world.fetch);
    await world.init();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stops before reading the files when GitHub changed more than the budget, and opens no task", async () => {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const { id, key, h } = await world.linkedProject("alice");
    const big: Record<string, string> = {};
    for (let i = 0; i < 4; i++) big[`assets/big${i}.bin`] = String.fromCharCode(97 + i).repeat(9_000_000);
    world.gh.push(big, "Add assets");
    const pulled = await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    expect(pulled.json.pull.state).toBe("error");
    expect(pulled.json.pull.message).toMatch(/GitHub changed 36 MB of files\. gitring merges at most 25 MB through the API in one pull/);
    expect(world.gh.blobBytesServed).toBe(0);
    expect((await h.state()).intents).toEqual([]);
    expect(await h.file("main", "assets/big0.bin")).toBeNull();
  });
});

describe("upstreamChanges", () => {
  async function repoWith(files: Record<string, string>) {
    const b = backendOf();
    await b.ensureRepo("shop");
    const c0 = await b.commit({ repo: "shop", branch: "main", parent: "", message: "Import", author, changes: Object.entries(files).map(([path, content]) => ({ path, content })) });
    const gh = new FakeGithub();
    await gh.adopt(b, "shop", c0.sha);
    gh.refs.set("heads/main", c0.sha);
    const main = await readSnapshot(b, "shop", (await b.readCommit("shop", c0.sha))!.treeHash);
    return { b, gh, c0, main };
  }

  it("keeps the default budget at 25 MB and counts base and head blobs of a three-way merge", async () => {
    expect(MAX_PULL_BYTES).toBe(25_000_000);
    const { b, gh, c0, main } = await repoWith({ "a.txt": "a\n", "b.txt": "b\n" });
    gh.push({ "a.txt": "A".repeat(600), "b.txt": "B".repeat(600) }, "Edit");
    const blobReads = () => gh.calls.filter((c) => c.startsWith("GET /git/blobs/")).length;
    const over = await upstreamChanges({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch, backend: b, source: "shop", main, since: c0.sha, maxBytes: 1000 });
    expect(over.state).toBe("error");
    expect(over).toMatchObject({ message: expect.stringMatching(/GitHub changed 0\.1 MB of files\. gitring merges at most 0\.1 MB through the API in one pull/) });
    expect(blobReads()).toBe(0);
    const ok = await upstreamChanges({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch, backend: b, source: "shop", main, since: c0.sha, maxBytes: 1200 });
    expect(ok.state).toBe("changes");
    expect(blobReads()).toBe(2);
  });

  it("stops when the bytes read pass the budget although the tree gave no sizes", async () => {
    const { b, gh, c0, main } = await repoWith({ "a.txt": "a\n" });
    gh.push({ "a.txt": "A".repeat(600), "c.txt": "C".repeat(600) }, "Edit");
    const noSizes = (async (url: string, init?: RequestInit) => {
      const res = await gh.fetch(url, init);
      if (!/\/git\/trees\//.test(url)) return res;
      const j = (await res.json()) as { tree: { size?: number }[] };
      for (const e of j.tree) delete e.size;
      return Response.json(j);
    }) as typeof fetch;
    const res = await upstreamChanges({ repo: gh.repo, token: "t", fetch: noSizes, backend: b, source: "shop", main, since: c0.sha, maxBytes: 1000 });
    expect(res.state).toBe("error");
    expect(res).toMatchObject({ message: expect.stringMatching(/gitring merges at most 0\.1 MB/) });
  });
});
