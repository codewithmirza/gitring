/**
 * Test doubles for GitHub work: the git test double (gitring side) and an in-memory GitHub (blobs, trees,
 * commits, refs, pull requests, compare, tarballs) with enough of the REST API for sync and pulls.
 */
import { createHash } from "node:crypto";
import type { RepoBackend } from "../../src/platform/repo/backend";
import { gzip, tar } from "../../src/platform/checks/tar";
import { EmulatorBackend, EmulatorService } from "../support/git-emulator/service";
import { GitStore, MemoryObjectStore } from "../support/git-emulator/store";

export const author = { name: "gitring", email: "merge@gitring.test" };

export function backendOf(): RepoBackend {
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
export async function filesOf(b: RepoBackend, repo: string, sha: string): Promise<Record<string, string>> {
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
export class FakeGithub {
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
    return this.ancestors(b).has(a);
  }

  ancestors(sha: string): Set<string> {
    const out = new Set<string>();
    const todo = [sha];
    while (todo.length) {
      const c = todo.pop()!;
      if (out.has(c) || !this.commits.has(c)) continue;
      out.add(c);
      todo.push(...this.commits.get(c)!.parents);
    }
    return out;
  }

  mergeBase(a: string, b: string): string | null {
    const fromA = this.ancestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const c = queue.shift()!;
      if (seen.has(c)) continue;
      seen.add(c);
      if (fromA.has(c)) return c;
      queue.push(...(this.commits.get(c)?.parents ?? []));
    }
    return null;
  }

  modeAt(commit: string, path: string): string | undefined {
    return this.trees.get(this.commits.get(commit)!.tree)!.get(path)?.mode;
  }

  /** A person pushes a commit to a GitHub branch (null deletes a file). */
  push(files: Record<string, string | null>, message = "A change on GitHub", branch = this.defaultBranch, authorName = "Pat"): string {
    const parent = this.refs.get(`heads/${branch}`)!;
    const tree = new Map(this.trees.get(this.commits.get(parent)!.tree)!);
    for (const [p, text] of Object.entries(files)) {
      if (text === null) tree.delete(p);
      else {
        const sha = createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
        this.blobs.set(sha, text);
        tree.set(p, { mode: tree.get(p)?.mode ?? "100644", sha });
      }
    }
    const treeSha = this.id();
    this.trees.set(treeSha, tree);
    const sha = this.id();
    this.commits.set(sha, { tree: treeSha, parents: [parent], message, author: { name: authorName, email: "pat@example.com", date: "" } });
    this.refs.set(`heads/${branch}`, sha);
    return sha;
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
      for (const e of body.tree as { path: string; mode: string; type?: string; sha: string | null }[]) {
        if (e.sha === null) {
          base.delete(e.path);
          for (const k of [...base.keys()]) if (k.startsWith(`${e.path}/`)) base.delete(k);
        } else {
          // Submodules point at commits of other repositories: GitHub does not check them.
          if (e.type !== "commit" && !this.blobs.has(e.sha)) return json(422, { message: `tree.sha ${e.sha} is not a valid blob` });
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
    if (method === "GET" && path.startsWith("/commits/") && String((init?.headers as Record<string, string>)?.Accept ?? "").includes("sha")) {
      const branch = decodeURIComponent(path.slice("/commits/".length));
      const sha = this.refs.get(`heads/${branch}`);
      return sha ? new Response(sha, { status: 200 }) : json(404, { message: "No commit found" });
    }
    m = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
    if (method === "GET" && m) {
      const [a, b] = [m[1], m[2]];
      if (!this.commits.has(a) || !this.commits.has(b)) return json(404, { message: "Not Found" });
      const base = this.mergeBase(a, b);
      const status = a === b ? "identical" : base === b ? "behind" : base === a ? "ahead" : "diverged";
      const fromA = this.ancestors(a);
      const commits = [...this.ancestors(b)].filter((c) => !fromA.has(c));
      return json(200, {
        status,
        total_commits: commits.length,
        merge_base_commit: { sha: base, commit: { tree: { sha: this.commits.get(base!)!.tree } } },
        commits: commits.map((c) => ({ sha: c, commit: { author: { name: this.commits.get(c)!.author.name } } })),
      });
    }
    m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path);
    if (method === "GET" && m) {
      const t = this.trees.get(m[1]);
      if (!t) return json(404, { message: "Not Found" });
      return json(200, { sha: m[1], truncated: false, tree: [...t].map(([p, e]) => ({ path: p, mode: e.mode, type: e.mode === "160000" ? "commit" : "blob", sha: e.sha })) });
    }
    m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path);
    if (method === "GET" && m) {
      const text = this.blobs.get(m[1]);
      if (text === undefined) return json(404, { message: "Not Found" });
      if (String((init?.headers as Record<string, string>)?.Accept ?? "").includes("raw")) return new Response(text, { status: 200 });
      return json(200, { sha: m[1], content: Buffer.from(text).toString("base64"), encoding: "base64" });
    }
    m = /^\/git\/refs\/(heads\/.+)$/.exec(path);
    if (method === "GET" && m) {
      const sha = this.refs.get(decodeURIComponent(m[1]));
      return sha ? json(200, { ref: `refs/${m[1]}`, object: { sha, type: "commit" } }) : json(404, { message: "Not Found" });
    }
    m = /^\/tarball\/([0-9a-f]{40})$/.exec(path);
    if (method === "GET" && m) {
      const files = this.filesAt(m[1]);
      const top = `${this.repo.replace("/", "-")}-${m[1].slice(0, 7)}`;
      const bytes = await gzip(tar(Object.entries(files).map(([p, text]) => ({ path: `${top}/${p}`, content: text, mode: this.modeAt(m![1], p) === "100755" ? 0o755 : 0o644 }))));
      return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "content-type": "application/x-gzip" } });
    }
    return json(404, { message: `no route ${method} ${path}` });
  };
}

