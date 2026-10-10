/**
 * GitHub sync over the Git Data API, against the git test double (gitring side) and an in-memory
 * GitHub (blobs, trees, commits, refs, pull requests).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { syncToGithub, treeChanges } from "../../src/platform/github/sync";
import type { RepoBackend } from "../../src/platform/repo/backend";
import { EmulatorBackend, EmulatorService } from "../support/git-emulator/service";
import { GitStore, MemoryObjectStore } from "../support/git-emulator/store";

const author = { name: "gitring", email: "merge@gitring.test" };

function backendOf(): RepoBackend {
  let svc: EmulatorService | undefined;
  const ns = {
    idFromName: (name: string) => ({ name, toString: () => name, equals: () => false }),
    get: () => {
      svc ??= new EmulatorService(new GitStore(new MemoryObjectStore()));
      const target = svc;
      return new Proxy(
        {},
        {
          get:
            (_t, method: string) =>
            async (...args: unknown[]) =>
              structuredClone(await (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method].apply(target, structuredClone(args))),
        },
      );
    },
  };
  return new EmulatorBackend(ns as never, "test");
}

/** Files of a commit in the git double, as path → text. */
async function filesOf(b: RepoBackend, repo: string, sha: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (tree: string, prefix: string) => {
    for (const e of (await b.readTree(repo, tree)) ?? []) {
      if (e.type === "tree") await walk(e.hash, `${prefix}${e.name}/`);
      else out[`${prefix}${e.name}`] = new TextDecoder().decode((await b.readBlob(repo, e.hash))!);
    }
  };
  await walk((await b.readCommit(repo, sha))!.treeHash, "");
  return out;
}

type Entry = { mode: string; sha: string };

/** A small GitHub: enough of the REST API for the sync. */
class FakeGithub {
  blobs = new Map<string, string>(); // sha → text
  trees = new Map<string, Map<string, Entry>>(); // sha → path → entry (flat)
  commits = new Map<string, { tree: string; parents: string[]; message: string; author: { name: string; email: string; date: string } }>();
  refs = new Map<string, string>(); // "heads/main" → sha
  pulls: { number: number; head: string; base: string; title: string; html_url: string }[] = [];
  calls: string[] = [];
  canOpenPulls = true;
  private n = 0;

  constructor(
    readonly repo = "robin/shop",
    readonly defaultBranch = "main",
  ) {}

  private id(): string {
    this.n += 1;
    return createHash("sha1").update(`fake-${this.n}`).digest("hex");
  }

  /** A commit that GitHub has with this exact id (an import keeps ids). */
  async adopt(b: RepoBackend, repo: string, sha: string, parents: string[] = []) {
    const files = new Map<string, Entry>();
    const walk = async (tree: string, prefix: string) => {
      for (const e of (await b.readTree(repo, tree)) ?? []) {
        if (e.type === "tree") await walk(e.hash, `${prefix}${e.name}/`);
        else {
          files.set(`${prefix}${e.name}`, { mode: e.mode, sha: e.hash });
          this.blobs.set(e.hash, new TextDecoder().decode((await b.readBlob(repo, e.hash))!));
        }
      }
    };
    const meta = (await b.readCommit(repo, sha))!;
    await walk(meta.treeHash, "");
    this.trees.set(meta.treeHash, files);
    this.commits.set(sha, { tree: meta.treeHash, parents, message: meta.message, author: { ...meta.author, date: "" } });
  }

  filesAt(commit: string): Record<string, string> {
    const tree = this.trees.get(this.commits.get(commit)!.tree)!;
    return Object.fromEntries([...tree].map(([p, e]) => [p, this.blobs.get(e.sha)!]));
  }

  isAncestor(a: string, b: string): boolean {
    for (let cur: string | undefined = b; cur; cur = this.commits.get(cur)?.parents[0]) if (cur === a) return true;
    return false;
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = u.pathname.replace(`/repos/${this.repo}`, "");
    this.calls.push(`${method} ${path}`);
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && path === "") return json(200, { default_branch: this.defaultBranch, html_url: `https://github.com/${this.repo}` });
    let m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path);
    if (method === "GET" && m) {
      const c = this.commits.get(m[1]);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree } }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && path === "/git/blobs") {
      const text = Buffer.from(body.content, "base64").toString("utf8");
      const sha = createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
      this.blobs.set(sha, text);
      return json(201, { sha });
    }
    if (method === "POST" && path === "/git/trees") {
      const base = new Map(this.trees.get(body.base_tree) ?? []);
      for (const e of body.tree as { path: string; mode: string; sha: string | null }[]) {
        if (e.sha === null) {
          base.delete(e.path);
          for (const k of [...base.keys()]) if (k.startsWith(`${e.path}/`)) base.delete(k);
        } else {
          if (!this.blobs.has(e.sha)) return json(422, { message: `tree.sha ${e.sha} is not a valid blob` });
          base.set(e.path, { mode: e.mode, sha: e.sha });
        }
      }
      const sha = this.id();
      this.trees.set(sha, base);
      return json(201, { sha });
    }
    if (method === "POST" && path === "/git/commits") {
      if (!this.trees.has(body.tree)) return json(422, { message: "tree not found" });
      for (const p of body.parents) if (!this.commits.has(p)) return json(422, { message: "parent not found" });
      const sha = this.id();
      this.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message, author: body.author });
      return json(201, { sha });
    }
    m = /^\/git\/refs\/(heads\/.+)$/.exec(path);
    if (method === "PATCH" && m) {
      const name = decodeURIComponent(m[1]);
      const cur = this.refs.get(name);
      if (!cur) return json(422, { message: "Reference does not exist" });
      if (!body.force && !this.isAncestor(cur, body.sha)) return json(422, { message: "Update is not a fast forward" });
      this.refs.set(name, body.sha);
      return json(200, { ref: `refs/${name}` });
    }
    if (method === "POST" && path === "/git/refs") {
      const name = String(body.ref).replace(/^refs\//, "");
      if (this.refs.has(name)) return json(422, { message: "Reference already exists" });
      this.refs.set(name, body.sha);
      return json(201, { ref: body.ref });
    }
    if (method === "GET" && path === "/pulls") {
      const head = u.searchParams.get("head")!.split(":")[1];
      return json(200, this.pulls.filter((p) => p.head === head));
    }
    if (method === "POST" && path === "/pulls") {
      if (!this.canOpenPulls) return json(403, { message: "Resource not accessible by integration" });
      const tip = this.refs.get(`heads/${body.head}`)!;
      const baseTip = this.refs.get(`heads/${body.base}`)!;
      if (tip === baseTip || this.isAncestor(tip, baseTip)) return json(422, { message: "Validation Failed", errors: [{ message: `No commits between ${body.base} and ${body.head}` }] });
      const pr = { number: this.pulls.length + 1, head: body.head, base: body.base, title: body.title, html_url: `https://github.com/${this.repo}/pull/${this.pulls.length + 1}` };
      this.pulls.push(pr);
      return json(201, pr);
    }
    return json(404, { message: `no route ${method} ${path}` });
  };
}

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
