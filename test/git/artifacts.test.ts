/**
 * ArtifactsBackend end to end, without the real service:
 *   binding (control plane + reads) → FakeArtifacts over bare repos (git CLI);
 *   git data plane (clone / fetch / push from isomorphic-git) → real `git http-backend`.
 * The same input on GitStore (emulator) must give the same commit ids.
 */
import { join } from "node:path";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_TREE_SHA, utf8 } from "../../src/core/git/objects";
import { ArtifactsBackend, artifactsErrorCode, tokenSecret } from "../../src/platform/repo/artifacts";
import { type CommitInput, RepoConflictError } from "../../src/platform/repo/backend";
import { GitStore, MemoryObjectStore } from "../support/git-emulator/store";
import { FakeArtifacts, type GitHttpServer, gitIn, startGitHttpServer } from "./fake-artifacts";
import { git, gitAsync, hasGitHttpBackend, tempDir } from "./helpers";

const FIXED_NOW = 1_760_000_000_000;
const author = { name: "Kestrel-7", email: "kestrel@gitring.dev" };

let tmp: ReturnType<typeof tempDir>;
let server: GitHttpServer;
let binding: FakeArtifacts;
let sleeps: number[];

function backend(over: Partial<ConstructorParameters<typeof ArtifactsBackend>[1]> = {}, b: Artifacts = binding): ArtifactsBackend {
  return new ArtifactsBackend(b, {
    now: () => FIXED_NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
  });
}

function bare(repo: string): string {
  return join(tmp.path, "repos", `${repo}.git`);
}

describe.skipIf(!hasGitHttpBackend())("ArtifactsBackend (fake binding + git http-backend)", () => {
  beforeAll(async () => {
    tmp = tempDir("gitring-artifacts-");
    server = await startGitHttpServer(join(tmp.path, "repos"));
    binding = new FakeArtifacts({ root: join(tmp.path, "repos"), baseUrl: server.url });
    server.authorize = (repo, password, service) => binding.checkToken(repo, password, service);
  });
  afterAll(async () => {
    await server.close();
    tmp.cleanup();
  });
  beforeEach(() => {
    sleeps = [];
    server.beforeReceivePack = undefined;
  });

  it("ensureRepo creates once (default branch main), then returns the existing repo", async () => {
    const be = backend();
    const h = await be.ensureRepo("canon", { description: "canonical" });
    expect(h).toEqual({ name: "canon", remote: `${server.url}/canon.git`, defaultBranch: "main" });
    expect(await be.ensureRepo("canon")).toEqual(h);
    expect(binding.calls.filter((c) => c === "create:canon")).toHaveLength(1);
    expect(binding.repos.get("canon")?.description).toBe("canonical");
    expect(await be.remoteUrl("canon")).toBe(h.remote);
    expect(be.kind).toBe("artifacts");
  });

  it("root commit on an empty repo, then a second commit; same ids as the emulator", async () => {
    const be = backend();
    await be.ensureRepo("demo");
    expect(await be.resolve("demo", "main")).toBeNull();

    const first: CommitInput = {
      repo: "demo",
      branch: "main",
      parent: "",
      message: "Seed demo app",
      author,
      changes: [
        { path: "README.md", content: "# Demo\n" },
        { path: "src/index.js", content: "export default { fetch() { return new Response('ok'); } };\n" },
        { path: "src/products.js", content: "export const formatPrice = (cents) => `$${(cents / 100).toFixed(2)}`;\n" },
        { path: "scripts/build.sh", content: "#!/bin/sh\necho build\n", mode: "100755" },
        { path: "docs/link.md", content: "../README.md", mode: "120000" },
        { path: "assets/pixel.bin", content: new Uint8Array([0, 255, 0, 1]) },
      ],
    };
    const c1 = await be.commit(first);
    expect(gitIn(binding, "demo", ["rev-parse", "refs/heads/main"])).toBe(c1.sha);
    expect(gitIn(binding, "demo", ["rev-parse", "main^{tree}"])).toBe(c1.tree);

    const second: CommitInput = {
      repo: "demo",
      branch: "main",
      parent: c1.sha,
      message: "Add currency to formatPrice\n\nGitring-Intent: int_42\n",
      author,
      changes: [
        { path: "src/products.js", content: "export const formatPrice = (cents, currency = 'USD') => `${currency} ${(cents / 100).toFixed(2)}`;\n" },
        { path: "assets/pixel.bin", content: null }, // empties assets/
        { path: "tests/products.test.js", content: "// test\n" },
        { path: "scripts/build.sh", content: "#!/bin/sh\necho build v2\n" }, // keeps 100755
      ],
    };
    const c2 = await be.commit(second);
    git(["fsck", "--strict", "--no-dangling"], { cwd: bare("demo") });
    expect(gitIn(binding, "demo", ["ls-tree", "-r", "--format=%(objectmode) %(path)", "main"]).split("\n")).toEqual([
      "100644 README.md",
      "120000 docs/link.md",
      "100755 scripts/build.sh",
      "100644 src/index.js",
      "100644 src/products.js",
      "100644 tests/products.test.js",
    ]);

    // Reads through the binding.
    const log = await be.log("demo", "main");
    expect(log.map((c) => c.hash)).toEqual([c2.sha, c1.sha]);
    expect(log[0]).toMatchObject({ treeHash: c2.tree, parents: [c1.sha], message: "Add currency to formatPrice\n\nGitring-Intent: int_42", author, committer: author, authoredAt: FIXED_NOW / 1000 });
    for (const ref of ["main", "refs/heads/main", "HEAD", c2.sha]) expect(await be.resolve("demo", ref)).toBe(c2.sha);
    expect(await be.resolve("demo", "nope")).toBeNull();
    expect(await be.resolve("demo", "0".repeat(40))).toBeNull();
    const root = (await be.readTree("demo", c2.tree))!;
    expect(root.map((e) => `${e.type} ${e.name}`)).toEqual(["blob README.md", "tree docs", "tree scripts", "tree src", "tree tests"]);
    const scripts = (await be.readTree("demo", root.find((e) => e.name === "scripts")!.hash))!;
    expect(scripts[0]).toMatchObject({ name: "build.sh", mode: "100755", type: "exec" });
    const docs = (await be.readTree("demo", root.find((e) => e.name === "docs")!.hash))!;
    expect(docs[0]).toMatchObject({ mode: "120000", type: "symlink" });
    const readme = await be.readBlob("demo", root[0].hash);
    expect(readme).toBeInstanceOf(Uint8Array);
    expect(utf8.decode(readme!)).toBe("# Demo\n");
    expect((await be.readCommit("demo", c1.sha))?.message).toBe("Seed demo app");
    expect(await be.readTree("demo", EMPTY_TREE_SHA)).toEqual([]);
    expect(await be.readBlob("demo", "zz")).toBeNull();

    // The emulator builds byte-identical commits from the same input and clock.
    const emu = new GitStore(new MemoryObjectStore(), { now: () => FIXED_NOW });
    await emu.ensureRepo("demo");
    const e1 = await emu.commit(first);
    const e2 = await emu.commit({ ...second, parent: e1.sha });
    expect([e1.sha, e2.sha, e2.tree]).toEqual([c1.sha, c2.sha, c2.tree]);
  });

  it("stale parent: RepoConflictError before any git traffic", async () => {
    const be = backend();
    const tip = (await be.resolve("demo", "main"))!;
    const parent = (await be.readCommit("demo", tip))!.parents[0];
    const before = server.requests.length;
    const err = await be.commit({ repo: "demo", branch: "main", parent, message: "late", author, changes: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoConflictError);
    expect(err).toMatchObject({ expected: parent, actual: tip });
    expect(server.requests.length).toBe(before);
    await expect(be.commit({ repo: "demo", branch: "main", parent: "", message: "root?", author, changes: [] })).rejects.toMatchObject({ expected: "", actual: tip });
    await expect(be.commit({ repo: "demo", branch: "nope", parent: tip, message: "x", author, changes: [] })).rejects.toMatchObject({ expected: tip, actual: null });
  });

  it("lost race at push time: the server's compare-and-swap rejects, RepoConflictError", async () => {
    const be = backend();
    const tip = (await be.resolve("demo", "main"))!;
    let racer = "";
    server.beforeReceivePack = (repo) => {
      if (repo !== "demo" || racer) return;
      // Another writer lands first (directly in the bare repo).
      const env = { GIT_AUTHOR_NAME: "Other", GIT_AUTHOR_EMAIL: "o@x", GIT_COMMITTER_NAME: "Other", GIT_COMMITTER_EMAIL: "o@x" };
      racer = gitIn(binding, "demo", ["commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "racer"], env);
      gitIn(binding, "demo", ["update-ref", "refs/heads/main", racer, tip]);
    };
    const err = await be.commit({ repo: "demo", branch: "main", parent: tip, message: "mine", author, changes: [{ path: "mine.txt", content: "m" }] }).catch((e: unknown) => e);
    expect(racer).toMatch(/^[0-9a-f]{40}$/);
    expect(err).toBeInstanceOf(RepoConflictError);
    expect(err).toMatchObject({ expected: tip, actual: racer });
    expect(gitIn(binding, "demo", ["rev-parse", "main"])).toBe(racer);
  });

  describe("a service with a short problem (the first real run saw one 500 in about 300 requests)", () => {
    const answer = (statusCode: number): GitHttpResponse => ({ url: "", statusCode, statusMessage: "Problem", headers: {}, body: undefined });

    /** A git client that goes to the real server, except where `fault` gives an answer or an error. */
    function flaky(fault: (req: GitHttpRequest, n: number, real: HttpClient["request"]) => Promise<GitHttpResponse | undefined>): { client: HttpClient; seen: string[] } {
      const seen: string[] = [];
      let n = 0;
      const real = (webHttp as HttpClient).request.bind(webHttp);
      const client: HttpClient = {
        request: async (req) => {
          n += 1;
          seen.push(`${req.method ?? "GET"} ${new URL(req.url).pathname.split("/").pop()}`);
          return (await fault(req, n, real)) ?? real(req);
        },
      };
      return { client, seen };
    }

    async function repoWithRoot(name: string): Promise<string> {
      const be = backend();
      await be.ensureRepo(name);
      return (await be.commit({ repo: name, branch: "main", parent: "", message: "root", author, changes: [{ path: "a.txt", content: "a" }] })).sha;
    }

    const second = (repo: string, parent: string): CommitInput => ({ repo, branch: "main", parent, message: "second", author, changes: [{ path: "b.txt", content: "b" }] });

    it("sends a request again after a 500, and the commit works", async () => {
      const root = await repoWithRoot("flaky-500");
      const f = flaky(async (_req, n) => (n === 1 ? answer(500) : undefined));
      const res = await backend({ http: f.client }).commit(second("flaky-500", root));
      expect(await backend().resolve("flaky-500", "main")).toBe(res.sha);
      expect(sleeps).toEqual([200]);
      expect(f.seen[0]).toBe(f.seen[1]);
    });

    it("sends a request again after a broken connection", async () => {
      const root = await repoWithRoot("flaky-net");
      const f = flaky(async (_req, n) => {
        if (n === 1) throw new TypeError("fetch failed");
        return undefined;
      });
      const res = await backend({ http: f.client }).commit(second("flaky-net", root));
      expect(await backend().resolve("flaky-net", "main")).toBe(res.sha);
      expect(sleeps).toEqual([200]);
    });

    it("gives up after three tries with the error of the service", async () => {
      const root = await repoWithRoot("flaky-down");
      const f = flaky(async () => answer(503));
      const err = await backend({ http: f.client }).commit(second("flaky-down", root)).catch((e: unknown) => e);
      expect(String(err)).toMatch(/503/);
      expect(f.seen).toHaveLength(3);
      expect(sleeps).toEqual([200, 400]);
      expect(await backend().resolve("flaky-down", "main")).toBe(root);
    });

    it("does not send again after an answer that a second try cannot change", async () => {
      const root = await repoWithRoot("flaky-401");
      const f = flaky(async () => answer(401));
      const err = await backend({ http: f.client }).commit(second("flaky-401", root)).catch((e: unknown) => e);
      expect(String(err)).toMatch(/401/);
      // isomorphic-git asks once more with its credentials after a 401. gitring waits for nothing and sends nothing more.
      expect(f.seen.length).toBeLessThanOrEqual(2);
      expect(sleeps).toEqual([]);
    });

    it("takes a push as done when the service applied it and then lost the answer", async () => {
      const root = await repoWithRoot("flaky-lost");
      let lost = 0;
      const f = flaky(async (req, _n, real) => {
        if (req.method === "POST" && req.url.endsWith("git-receive-pack") && lost === 0) {
          lost += 1;
          // The service applies the push. The answer is lost: the client sees a 500.
          const res = await real(req);
          for await (const chunk of res.body ?? []) void chunk;
          return answer(500);
        }
        return undefined;
      });
      const res = await backend({ http: f.client }).commit(second("flaky-lost", root));
      expect(lost).toBe(1);
      expect(await backend().resolve("flaky-lost", "main")).toBe(res.sha);
      // One commit on main for this change, not two.
      expect(gitIn(binding, "flaky-lost", ["rev-list", "--count", "main"])).toBe("2");
    });

    it("keeps the note when the push landed and the answer got lost, also when a newer commit is on top", async () => {
      const root = await repoWithRoot("flaky-note");
      let pushes = 0;
      let racer = "";
      const f = flaky(async (req, _n, real) => {
        if (req.method !== "POST" || !req.url.endsWith("git-receive-pack")) return undefined;
        pushes += 1;
        if (pushes !== 2) return undefined; // 1: the note, 2: the branch
        const res = await real(req);
        for await (const chunk of res.body ?? []) void chunk;
        // The push landed. Before the answer comes back, another writer adds a commit on top.
        const env = { GIT_AUTHOR_NAME: "Other", GIT_AUTHOR_EMAIL: "o@x", GIT_COMMITTER_NAME: "Other", GIT_COMMITTER_EMAIL: "o@x" };
        const tip = gitIn(binding, "flaky-note", ["rev-parse", "main"]);
        racer = gitIn(binding, "flaky-note", ["commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "racer"], env);
        gitIn(binding, "flaky-note", ["update-ref", "refs/heads/main", racer, tip]);
        return answer(500);
      });
      const res = await backend({ http: f.client }).commit({ ...second("flaky-note", root), note: "note of second\n" });
      expect(racer).toMatch(/^[0-9a-f]{40}$/);
      expect(gitIn(binding, "flaky-note", ["rev-parse", "main^"])).toBe(res.sha);
      // The commit is on main, so its note stays.
      expect(await backend().readNote("flaky-note", res.sha)).toBe("note of second\n");
    });

    it("sends the body of a push again unchanged", async () => {
      const root = await repoWithRoot("flaky-body");
      const bodies: string[] = [];
      const f = flaky(async (req, _n, real) => {
        if (req.method === "POST" && req.url.endsWith("git-receive-pack")) {
          const chunks: Uint8Array[] = [];
          for await (const c of req.body ?? []) chunks.push(c);
          bodies.push(Buffer.concat(chunks).toString("hex"));
          if (bodies.length === 1) return answer(502);
          return real({ ...req, body: (async function* () { yield* chunks; })() });
        }
        return undefined;
      });
      const res = await backend({ http: f.client }).commit(second("flaky-body", root));
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(await backend().resolve("flaky-body", "main")).toBe(res.sha);
    });
  });

  it("notes: pushed with the commit, appended by later commits, readable via the binding and via git", async () => {
    const be = backend();
    const tip = (await be.resolve("demo", "main"))!;
    const n1 = JSON.stringify({ schema: "gitring.logbook/v1", intent: "int_1" }, null, 2);
    const c3 = await be.commit({ repo: "demo", branch: "main", parent: tip, message: "Land 1", author, changes: [{ path: "a.txt", content: "a" }], note: n1 });
    const c4 = await be.commit({ repo: "demo", branch: "main", parent: c3.sha, message: "Land 2", author, changes: [{ path: "b.txt", content: "b" }], note: "second note\n" });
    expect(await be.readNote("demo", c3.sha)).toBe(n1);
    expect(await be.readNote("demo", c4.sha)).toBe("second note\n");
    expect(await be.readNote("demo", tip)).toBeNull();
    // Real git reads our notes ref.
    expect(gitIn(binding, "demo", ["notes", "--ref=gitring", "show", c3.sha])).toBe(n1);
    expect(gitIn(binding, "demo", ["rev-list", "--count", "refs/notes/gitring"])).toBe("2");
    git(["fsck", "--strict", "--no-dangling"], { cwd: bare("demo") });

    // Fallback path: a binding whose log() cannot resolve full refs → fetch the notes ref over git.
    const noFullRefs = new FakeArtifacts({ ...binding.opts, fullRefsInLog: false });
    for (const [k, v] of binding.repos) noFullRefs.repos.set(k, v);
    const prevAuth = server.authorize;
    server.authorize = (repo, password, service) => noFullRefs.checkToken(repo, password, service) || prevAuth(repo, password, service);
    try {
      const fb = backend({}, noFullRefs);
      expect(await fb.readNote("demo", c3.sha)).toBe(n1);
      expect(await fb.readNote("demo", tip)).toBeNull();
      await fb.ensureRepo("no-notes");
      expect(await fb.readNote("no-notes", c3.sha)).toBeNull();
    } finally {
      server.authorize = prevAuth;
    }
  });

  it("notes in a fanned-out notes tree (ab/cdef…) are read and extended in place", async () => {
    const be = backend();
    await be.ensureRepo("fan");
    const c1 = await be.commit({ repo: "fan", branch: "main", parent: "", message: "1", author, changes: [{ path: "a", content: "1" }] });
    // Another tool wrote refs/notes/gitring with a fanout layout.
    const noteBlob = git(["hash-object", "-w", "--stdin"], { cwd: bare("fan"), input: "fanned note\n" });
    const sub = git(["mktree"], { cwd: bare("fan"), input: `100644 blob ${noteBlob}\t${c1.sha.slice(2)}\n` });
    const root = git(["mktree"], { cwd: bare("fan"), input: `040000 tree ${sub}\t${c1.sha.slice(0, 2)}\n` });
    const env = { GIT_AUTHOR_NAME: "Tool", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "Tool", GIT_COMMITTER_EMAIL: "t@x" };
    const notesCommit = git(["commit-tree", root, "-m", "notes"], { cwd: bare("fan"), env });
    git(["update-ref", "refs/notes/gitring", notesCommit], { cwd: bare("fan") });
    expect(gitIn(binding, "fan", ["notes", "--ref=gitring", "show", c1.sha])).toBe("fanned note");

    expect(await be.readNote("fan", c1.sha)).toBe("fanned note\n");
    const c2 = await be.commit({ repo: "fan", branch: "main", parent: c1.sha, message: "2", author, changes: [{ path: "b", content: "2" }], note: "new note" });
    expect(await be.readNote("fan", c2.sha)).toBe("new note");
    expect(gitIn(binding, "fan", ["notes", "--ref=gitring", "show", c2.sha])).toBe("new note");
    // The new note went into the fanout layout, and the old one is still there.
    const layout = gitIn(binding, "fan", ["ls-tree", "-r", "--name-only", "refs/notes/gitring"]).split("\n");
    expect(layout).toContain(`${c2.sha.slice(0, 2)}/${c2.sha.slice(2)}`);
    expect(layout).toContain(`${c1.sha.slice(0, 2)}/${c1.sha.slice(2)}`);
    expect(gitIn(binding, "fan", ["rev-parse", "refs/notes/gitring^"])).toBe(notesCommit);
  });

  it("a lost race at push time removes the note again: no note names a commit that never landed", async () => {
    const be = backend();
    await be.ensureRepo("orphan");
    const c1 = await be.commit({ repo: "orphan", branch: "main", parent: "", message: "1", author, changes: [{ path: "a.txt", content: "a" }], note: "note of 1\n" });
    let racer = "";
    server.beforeReceivePack = (repo) => {
      // Let the notes push pass. Before the push of the branch, another writer moves main.
      if (repo !== "orphan" || racer || !gitIn(binding, "orphan", ["ls-tree", "-r", "--name-only", "refs/notes/gitring"]).includes("\n")) return;
      const env = { GIT_AUTHOR_NAME: "Other", GIT_AUTHOR_EMAIL: "o@x", GIT_COMMITTER_NAME: "Other", GIT_COMMITTER_EMAIL: "o@x" };
      racer = gitIn(binding, "orphan", ["commit-tree", `${c1.sha}^{tree}`, "-p", c1.sha, "-m", "racer"], env);
      gitIn(binding, "orphan", ["update-ref", "refs/heads/main", racer, c1.sha]);
    };
    const err = await be.commit({ repo: "orphan", branch: "main", parent: c1.sha, message: "mine", author, changes: [{ path: "b.txt", content: "b" }], note: "note of mine\n" }).catch((e: unknown) => e);
    expect(racer).toMatch(/^[0-9a-f]{40}$/);
    expect(err).toBeInstanceOf(RepoConflictError);
    // The notes ref had the note of the lost commit for a moment. Now only the note of c1 is left.
    expect(gitIn(binding, "orphan", ["ls-tree", "-r", "--name-only", "refs/notes/gitring"])).toBe(c1.sha);
    expect(gitIn(binding, "orphan", ["rev-list", "--count", "refs/notes/gitring"])).toBe("3");
    expect(await be.readNote("orphan", c1.sha)).toBe("note of 1\n");
    git(["fsck", "--strict", "--no-dangling"], { cwd: bare("orphan") });
  });

  it("a root commit can start a new branch in a non-empty repo", async () => {
    const be = backend();
    const main = (await be.resolve("demo", "main"))!;
    const side = await be.commit({ repo: "demo", branch: "gitring/scratch", parent: "", message: "scratch", author, changes: [{ path: "notes.md", content: "x\n" }] });
    expect(await be.resolve("demo", "gitring/scratch")).toBe(side.sha);
    expect(await be.resolve("demo", "refs/heads/gitring/scratch")).toBe(side.sha);
    expect(await be.resolve("demo", "main")).toBe(main);
    expect((await be.readCommit("demo", side.sha))?.parents).toEqual([]);
  });

  it("fork: default branch only, independent history, no notes; retried and adopted", async () => {
    const be = backend();
    const tip = (await be.resolve("demo", "main"))!;
    binding.failures.set("fork:demo", ["FORK_IN_PROGRESS", "FORK_IN_PROGRESS"]);
    const fork = await be.fork("demo", "att-1", { description: "attempt 1" });
    expect(sleeps).toEqual([250, 500]);
    expect(fork).toMatchObject({ name: "att-1", remote: `${server.url}/att-1.git`, defaultBranch: "main" });
    expect(fork.token).toMatch(/^art_v1_[0-9a-f]+\?expires=\d+$/);
    expect(binding.repos.get("att-1")?.source).toBe("artifacts:test/demo");
    expect(gitIn(binding, "att-1", ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");

    // The fork's own token works with plain git (Basic auth with the secret).
    const authed = fork.remote!.replace("http://", `http://x:${tokenSecret(fork.token!)}@`);
    expect((await gitAsync(["ls-remote", authed, "refs/heads/main"])).split("\t")[0]).toBe(tip);

    const f1 = await be.commit({ repo: "att-1", branch: "main", parent: tip, message: "attempt work", author, changes: [{ path: "src/new.js", content: "new\n" }] });
    expect(await be.resolve("att-1", "main")).toBe(f1.sha);
    expect(await be.resolve("demo", "main")).toBe(tip);
    expect(await be.readNote("att-1", tip)).toBeNull();

    // A retried fork call adopts the existing fork of the same source.
    const again = await be.fork("demo", "att-1");
    expect(again.name).toBe("att-1");
    expect(again.token).toMatch(/^art_v1_/);
    await be.ensureRepo("unrelated");
    await expect(be.fork("demo", "unrelated")).rejects.toThrow(/ALREADY_EXISTS/);
  });

  it("retries *_IN_PROGRESS on get() within the budget, then gives up", async () => {
    const be = backend();
    binding.failures.set("get:att-1", ["FORK_IN_PROGRESS", "CREATE_IN_PROGRESS"]);
    expect(await be.resolve("att-1", "main")).toMatch(/^[0-9a-f]{40}$/);
    expect(sleeps).toEqual([250, 500]);

    sleeps = [];
    binding.failures.set("get:att-1", Array(50).fill("FORK_IN_PROGRESS"));
    const err = await be.resolve("att-1", "main").catch((e: unknown) => e);
    expect(artifactsErrorCode(err)).toBe("FORK_IN_PROGRESS");
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20_000);
    binding.failures.delete("get:att-1");

    await expect(be.resolve("missing-repo", "main")).rejects.toThrow(/NOT_FOUND/);
  });

  it("a short problem of the service (INTERNAL_ERROR) is sent again twice, then it reaches the caller", async () => {
    const be = backend();
    binding.failures.set("get:att-1", ["INTERNAL_ERROR"]);
    expect(await be.resolve("att-1", "main")).toMatch(/^[0-9a-f]{40}$/);
    expect(sleeps).toEqual([250]);

    sleeps = [];
    binding.failures.set("get:att-1", ["INTERNAL_ERROR", "INTERNAL_ERROR"]);
    expect(await be.resolve("att-1", "main")).toMatch(/^[0-9a-f]{40}$/);
    expect(sleeps).toEqual([250, 500]);

    sleeps = [];
    binding.failures.set("get:att-1", ["INTERNAL_ERROR", "INTERNAL_ERROR", "INTERNAL_ERROR"]);
    const err = await be.resolve("att-1", "main").catch((e: unknown) => e);
    expect(artifactsErrorCode(err)).toBe("INTERNAL_ERROR");
    expect(sleeps).toEqual([250, 500]);
    binding.failures.delete("get:att-1");

    // A fork that fails once is made on the second call, and exists once.
    sleeps = [];
    binding.failures.set("fork:demo", ["INTERNAL_ERROR"]);
    const fork = await be.fork("demo", "att-internal");
    expect(fork.name).toBe("att-internal");
    expect(sleeps).toEqual([250]);
    expect(binding.calls.filter((c) => c === "fork:demo->att-internal")).toHaveLength(2);
    await be.deleteRepo("att-internal");

    // Other errors are not sent again.
    sleeps = [];
    await expect(be.resolve("missing-repo", "main")).rejects.toThrow(/NOT_FOUND/);
    expect(sleeps).toEqual([]);
  });

  it("createToken, deleteRepo, and every get() handle is disposed", async () => {
    const be = backend();
    const t = await be.createToken("att-1", "read", 5);
    expect(t.token).toMatch(/\?expires=\d+$/);
    expect(binding.calls).toContain("createToken:att-1:read:60"); // TTL clamped to the 60 s minimum
    expect(Date.parse(t.expiresAt)).toBeGreaterThan(Date.now());

    await be.deleteRepo("att-1");
    await be.deleteRepo("att-1"); // idempotent
    expect(binding.repos.has("att-1")).toBe(false);
    await expect(be.log("att-1", "main")).rejects.toThrow(/NOT_FOUND/);

    expect(binding.opened).toBeGreaterThan(10);
    expect(binding.disposed).toBe(binding.opened);
  });

  it("log pages through the binding's 1000-commit cap", async () => {
    const total = 2500;
    const sha = (i: number) => i.toString(16).padStart(40, "0");
    const requests: [number, number][] = [];
    const stub = {
      async get() {
        return {
          async log(o: { ref?: string; limit?: number; offset?: number }) {
            const limit = Math.min(o.limit ?? 50, 1000);
            const offset = o.offset ?? 0;
            requests.push([limit, offset]);
            return Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, k) => {
              const i = total - offset - k; // newest first
              return {
                hash: sha(i),
                treeHash: EMPTY_TREE_SHA,
                message: `c${i}`,
                author,
                committer: author,
                parents: i > 1 ? [sha(i - 1)] : [],
                authoredAt: i,
                committedAt: i,
              };
            });
          },
          [Symbol.dispose]() {},
        };
      },
    } as unknown as Artifacts;
    const be = backend({}, stub);
    const all = await be.log("big", "main", 5000);
    expect(all).toHaveLength(total);
    expect(all[0].message).toBe("c2500");
    expect(all[total - 1].parents).toEqual([]);
    expect(requests).toEqual([
      [1000, 0],
      [1000, 1000],
      [1000, 2000],
    ]);
    requests.length = 0;
    expect(await be.log("big", "main", 1200)).toHaveLength(1200);
    expect(requests).toEqual([
      [1000, 0],
      [200, 1000],
    ]);
    expect(await be.log("big", "main", 0)).toEqual([]);
  });

  it("artifactsErrorCode reads .code, else the message", () => {
    expect(artifactsErrorCode({ code: "NOT_FOUND" })).toBe("NOT_FOUND");
    expect(artifactsErrorCode(new Error("repo is still forking"))).toBe("FORK_IN_PROGRESS");
    expect(artifactsErrorCode(new Error("Repository does not exist"))).toBe("NOT_FOUND");
    expect(artifactsErrorCode(new Error("An internal error occurred."))).toBe("INTERNAL_ERROR");
    expect(artifactsErrorCode(new Error("boom"))).toBeUndefined();
    expect(tokenSecret("art_v1_abc?expires=123")).toBe("art_v1_abc");
  });
});
