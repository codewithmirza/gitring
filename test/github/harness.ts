/**
 * A whole gitring for GitHub tests: the real Worker routes, the real Directory and the real HarborMaster
 * (on the git emulator), with an in-memory GitHub (fake.ts) behind a global fetch router. People sign in
 * through the Directory's GitHub flow and act with API keys.
 *
 *   const world = new World();
 *   vi.stubGlobal("fetch", world.fetch);
 *   await world.init();
 *   const alice = world.person("alice", 1);         // a GitHub account
 *   alice.access.set("robin/shop", { read: true, push: true });
 *   const { key } = await world.signIn("alice");
 *   await world.call("POST", "/api/projects", { key, body: { ... } });
 */
import { generateKeyPairSync } from "node:crypto";
import { Directory } from "../../src/directory/directory";
import { HarborMaster } from "../../src/harbor/harbor";
import worker from "../../src/worker/index";
import { gzip, tar } from "../../src/platform/checks/tar";
import { backendOf, FakeGithub } from "./fake";
import { sqliteCtx } from "../support/sqlite-storage";

export const ORIGIN = "https://gitring.test";
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/** The fake GitHub with what the review tests need: privacy, `git archive` quirks, failures and byte counts. */
export class FakeGithubSite extends FakeGithub {
  private_ = false;
  /** Paths left out of tarballs (export-ignore). */
  exportIgnore = new Set<string>();
  /** What `git archive` writes instead of the blob (eol=crlf, export-subst). */
  tarballText = new Map<string, string>();
  /** Fail GET /git/trees with this status, this many times (transient GitHub errors). */
  failTrees: { status: number; times: number } = { status: 0, times: 0 };
  /** Fail GET /repos/{repo} (the repository info) with this status. */
  failInfo = 0;
  blobBytesServed = 0;

  constructor() {
    super();
    // FakeGithub's own handler answers what is not special here.
    const base = this.fetch;
    this.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(url));
      const path = u.pathname.replace(`/repos/${this.repo}`, "");
      const method = init?.method ?? "GET";
      if (method === "GET" && path === "") {
        if (this.failInfo) return Response.json({ message: "Server Error" }, { status: this.failInfo });
        return Response.json({ full_name: this.repo, private: this.private_, default_branch: this.defaultBranch, html_url: `https://github.com/${this.repo}` });
      }
      if (method === "GET" && /^\/git\/trees\//.test(path) && this.failTrees.times > 0) {
        this.failTrees.times -= 1;
        this.calls.push(`${method} ${path} (failed)`);
        return Response.json({ message: "Server Error" }, { status: this.failTrees.status });
      }
      const m = /^\/tarball\/([0-9a-f]{40})$/.exec(path);
      if (method === "GET" && m && (this.exportIgnore.size || this.tarballText.size)) {
        const files = this.filesAt(m[1]);
        const top = `${this.repo.replace("/", "-")}-${m[1].slice(0, 7)}`;
        const entries = Object.entries(files)
          .filter(([p]) => !this.exportIgnore.has(p))
          .map(([p, text]) => ({ path: `${top}/${p}`, content: this.tarballText.get(p) ?? text }));
        return new Response((await gzip(tar(entries))) as unknown as BodyInit, { status: 200 });
      }
      // GitHub reads a commit id as its tree (tree-ish) in GET /git/trees/{sha}.
      const tm = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path);
      if (method === "GET" && tm && this.commits.has(tm[1])) {
        const t = new URL(String(url));
        t.pathname = t.pathname.replace(tm[1], this.commits.get(tm[1])!.tree);
        return base(t.toString(), init);
      }
      const res = await base(url, init);
      if (/^\/git\/blobs\//.test(path) && res.ok) this.blobBytesServed += new Uint8Array(await res.clone().arrayBuffer()).length;
      return res;
    };
  }
}

export type Access = { read: boolean; push: boolean };

export interface Person {
  id: number;
  login: string;
  /** Per repository: what GitHub shows this person (absent: a public repository is readable; null: nothing). */
  access: Map<string, Access | null>;
  /** The person's GitHub user token works (false: GitHub answers 401). */
  tokenWorks: boolean;
}

/** The whole deployment: Worker, Directory, project objects and the fake GitHub. */
export class World {
  gh = new FakeGithubSite();
  backend = backendOf();
  dir!: Directory;
  harbors = new Map<string, HarborMaster>();
  pending: Promise<unknown>[] = [];
  /** login → GitHub account */
  people = new Map<string, Person>();
  signingIn = "";
  /** Repositories with the gitring GitHub App (lowercase). */
  installed = new Set<string>(["robin/shop"]);
  /** GitHub answers 403 (rate limit) to these reads of a repository: "user" (a person's token), "anon". */
  rateLimited = new Set<"user" | "anon">();
  env: Record<string, unknown> = {};
  fetchLog: string[] = [];
  /** Runs when GitHub refreshes a user token (the refresh waits for it). */
  onRefresh?: () => Promise<void>;
  private manifestApp: Record<string, unknown> = {};

  async init(extraEnv: Record<string, unknown> = {}) {
    const dctx = sqliteCtx();
    const dirNs = { idFromName: (n: string) => n, get: () => this.dir };
    const harborNs = {
      idFromName: (n: string) => n,
      get: (id: string) => {
        let h = this.harbors.get(id);
        if (!h) {
          h = new HarborMaster(this.harborCtx() as never, this.env as never);
          Object.defineProperty(h, "backend", { get: () => this.backend, configurable: true });
          this.harbors.set(id, h);
        }
        return h;
      },
    };
    // Artifacts imports of public URLs never finish here: tests of that path look at the facts recorded.
    const artifacts = {
      import: async (o: { source: { url: string }; target: { name: string } }) => ({ remote: `${o.source.url}.git`, defaultBranch: "main" }),
      get: async () => ({ info: async () => ({ status: "importing", defaultBranch: "main" }), [Symbol.dispose]: () => undefined }),
    };
    this.env = { DIRECTORY: dirNs, HARBOR: harborNs, ARTIFACTS: artifacts, GITRING_SECRET: "review-secret-0123456789abcdef", ARTIFACTS_NAMESPACE: "gitring", ...extraEnv };
    this.dir = new Directory(dctx as never, this.env as never);
    // The GitHub App, through the manifest flow.
    const m = await this.dir.githubManifest(ORIGIN);
    this.manifestApp = { id: 42, slug: "git-ring", client_id: "Iv1.x", client_secret: "cs", webhook_secret: "whsec", pem: PEM, html_url: "https://github.com/apps/git-ring" };
    await this.dir.githubManifestDone("code", new URL(m.postUrl).searchParams.get("state")!);
  }

  harborCtx() {
    const base = sqliteCtx();
    let alarm: number | null = null;
    return {
      storage: { sql: base.storage.sql, setAlarm: async (t: number) => void (alarm = t), getAlarm: async () => alarm, deleteAlarm: async () => void (alarm = null) },
      blockConcurrencyWhile: async (fn: () => unknown) => fn(),
      waitUntil: (p: Promise<unknown>) => void this.pending.push(p.catch((e) => console.warn("waitUntil", e))),
      getWebSockets: () => [],
      getTags: () => [],
      acceptWebSocket: () => undefined,
    };
  }

  /** Wait until background work (waitUntil) settles. */
  async settle() {
    for (let i = 0; i < 20; i++) {
      const p = this.pending.splice(0);
      if (!p.length) {
        await new Promise((r) => setTimeout(r, 5));
        if (!this.pending.length) return;
        continue;
      }
      await Promise.all(p);
    }
  }

  person(login: string, id: number): Person {
    const p: Person = { id, login, access: new Map(), tokenWorks: true };
    this.people.set(login, p);
    return p;
  }

  /** `session`: the token of the browser session of this person (send it as the cookie `__Host-gitring`). `key`: a personal API key. */
  async signIn(login: string): Promise<{ userId: string; key: string; session: string }> {
    this.signingIn = login;
    const url = await this.dir.signInUrl("github", ORIGIN, "/");
    const res = await this.dir.finishSignIn("github", "code", new URL(url).searchParams.get("state")!);
    const { key } = await this.dir.createKey(res.user.id, "k");
    return { userId: res.user.id, key, session: res.token ?? "" };
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? "";
    this.fetchLog.push(`${method} ${url.pathname} ${auth.slice(0, 24)}`);
    const limited = () => Response.json({ message: "API rate limit exceeded for 203.0.113.9." }, { status: 403 });
    if (url.href.startsWith("https://api.github.com/app-manifests/")) return Response.json(this.manifestApp);
    if (url.href === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.refresh_token && this.onRefresh) await this.onRefresh();
      const login = body.refresh_token ? String(body.refresh_token).replace(/^ghr_/, "") : this.signingIn;
      return Response.json({ access_token: `gho_${login}`, expires_in: 28800, refresh_token: `ghr_${login}`, refresh_token_expires_in: 15552000 });
    }
    if (url.href === "https://api.github.com/user") {
      const p = this.people.get(this.signingIn)!;
      return Response.json({ id: p.id, login: p.login, name: p.login, email: null, avatar_url: "" });
    }
    if (method === "DELETE" && /^\/applications\/[^/]+\/token$/.test(url.pathname)) return new Response(null, { status: 204 });
    let m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url.pathname);
    if (m) return this.installed.has(m[1].toLowerCase()) ? Response.json({ id: 1 }) : Response.json({ message: "Not Found" }, { status: 404 });
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return Response.json({ token: "ghs_inst", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: "write" } }, { status: 201 });
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/.exec(url.pathname);
    if (m) {
      const p = this.people.get(decodeURIComponent(m[2]));
      const a = p?.access.get(m[1]);
      const permission = !a ? "none" : a.push ? "write" : a.read ? "read" : "none";
      return Response.json({ permission, role_name: permission, user: { id: p?.id, login: p?.login } });
    }
    // The person's own token reads the repository as GitHub shows it to them.
    if (auth.startsWith("Bearer gho_")) {
      const p = this.people.get(auth.slice("Bearer gho_".length));
      if (!p || !p.tokenWorks) return Response.json({ message: "Bad credentials" }, { status: 401 });
      m = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname);
      if (m && method === "GET") {
        if (this.rateLimited.has("user")) return limited();
        const a = p.access.get(m[1]);
        const isPrivate = m[1] === this.gh.repo ? this.gh.private_ : false;
        if (!a?.read && (isPrivate || a === null)) return Response.json({ message: "Not Found" }, { status: 404 });
        return Response.json({ full_name: m[1], private: isPrivate, default_branch: "main", html_url: `https://github.com/${m[1]}`, permissions: { pull: true, push: Boolean(a?.push) } });
      }
      return Response.json({ message: "not stubbed (user)" }, { status: 404 });
    }
    if (url.pathname.startsWith(`/repos/${this.gh.repo}`)) {
      if (!auth && this.rateLimited.has("anon")) return limited();
      if (!auth && this.gh.private_) return Response.json({ message: "Not Found" }, { status: 404 });
      return this.gh.fetch(input as string, init);
    }
    return Response.json({ message: `not stubbed ${method} ${url.href}` }, { status: 599 });
  };

  /** A request to the real Worker. */
  async call(method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}): Promise<{ status: number; json: any; text: string }> {
    const headers: Record<string, string> = { ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) };
    const req = new Request(`${ORIGIN}${path}`, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
    const ctx = { waitUntil: (p: Promise<unknown>) => void this.pending.push(p.catch((e) => console.warn("ctx.waitUntil", e))), passThroughOnException() {}, props: {} };
    const res = await worker.fetch(req, this.env as never, ctx as never);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: res.status, json, text };
  }

  /** A signed GitHub App webhook delivery. */
  async hook(event: string, delivery: string, payload: unknown) {
    const { createHmac } = await import("node:crypto");
    const raw = JSON.stringify(payload);
    const sig = createHmac("sha256", "whsec").update(raw).digest("hex");
    return this.call("POST", "/hooks/github-app", { raw, headers: { "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${sig}`, "content-type": "application/json" } });
  }

  harbor(id: string): HarborMaster {
    return (this.env.HARBOR as { get: (id: string) => HarborMaster }).get(id);
  }

  /** The project object's private GitHub state (what the tests look at). */
  ghState(id: string, repo = "robin/shop"): GithubState {
    return (this.harbor(id) as unknown as { gh(r: string): GithubState }).gh(repo);
  }

  setGhState(id: string, patch: Partial<GithubState>, repo = "robin/shop"): void {
    (this.harbor(id) as unknown as { setGh(r: string, p: Partial<GithubState>): void }).setGh(repo, patch);
  }

  /** A merged task: one commit on main in the project's repository (what a landing does). */
  async land(id: string, path: string, content: string): Promise<string> {
    const h = this.harbor(id) as unknown as { project: { mainSha: string; mainTree: string; repo: { name: string } }; db: { setMeta(k: string, v: unknown): void } };
    const c = await this.backend.commit({ repo: h.project.repo.name, branch: "main", parent: h.project.mainSha, message: `Task ${path}`, author: { name: "gitring", email: "merge@gitring.test" }, changes: [{ path, content }] });
    h.project.mainSha = c.sha;
    h.project.mainTree = c.tree;
    h.db.setMeta("project", h.project);
    return c.sha;
  }

  /**
   * A private project of `login` whose main is a commit that GitHub has (as after an import that keeps
   * GitHub's commit ids), linked to robin/shop with the given GitHub settings.
   */
  async linkedProject(login: string, github: Record<string, unknown> = { repo: "robin/shop", mode: "pull-request" }, visibility: "private" | "public" = "private") {
    const { key, userId } = await this.signIn(login);
    const made = await this.call("POST", "/api/projects", { key, body: { name: "shop", visibility, source: { kind: "empty" } } });
    if (made.status !== 201) throw new Error(`project: ${made.text}`);
    const id = made.json.project.id as string;
    const h = this.harbor(id);
    const st = await h.state();
    await this.gh.adopt(this.backend, st.project.repo.name, st.project.mainSha);
    this.gh.refs.set("heads/main", st.project.mainSha);
    const link = await this.call("PUT", `/api/projects/${id}/settings`, { key, body: { github } });
    if (link.status !== 200) throw new Error(`link: ${link.text}`);
    await this.settle();
    return { id, key, userId, h, mainSha: st.project.mainSha as string };
  }
}

export interface GithubState {
  known: Record<string, string>;
  last?: string;
  upstreamOf: Record<string, unknown>;
  conflict?: { head: string; files: Record<string, string | null>; intentId: string };
  pull?: { state: string; message: string };
  actor?: { userId: string; checkedAt: number; read: boolean; push: boolean; gone?: string };
  private?: boolean;
}
