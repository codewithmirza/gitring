/**
 * Test doubles for Cloudflare Artifacts:
 *   - startGitHttpServer: real git smart HTTP (`git http-backend` as CGI) over bare repos, with
 *     Basic-auth token checks and a hook to inject a concurrent push;
 *   - FakeArtifacts: the Workers binding surface ArtifactsBackend uses, backed by the same bare
 *     repos through the git CLI (reads decode real git objects).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { decodeCommit, decodeTree } from "../../src/core/git/objects";
import { gitEnv, gitRaw } from "./helpers";

export interface GitHttpServer {
  url: string;
  requests: { method: string; path: string; service: string | null; status: number }[];
  /** Return false to answer 401. Default: allow. */
  authorize: (repo: string, password: string | null, service: string) => boolean;
  /** Runs before a receive-pack POST reaches git (simulate a concurrent writer). */
  beforeReceivePack?: (repoName: string) => void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function runCgi(env: NodeJS.ProcessEnv, body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && out.length === 0) reject(new Error(`git http-backend exited ${code}: ${Buffer.concat(err).toString()}`));
      else resolve(Buffer.concat(out));
    });
    // git can exit before it reads the whole body (EPIPE). Without this handler the error stops the process.
    // The "close" event above reports what happened.
    child.stdin.on("error", () => undefined);
    child.stdin.end(body);
  });
}

function indexOfBytes(haystack: Uint8Array, needle: string): number {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

export async function startGitHttpServer(root: string): Promise<GitHttpServer> {
  const state: Omit<GitHttpServer, "url" | "close"> = { requests: [], authorize: () => true };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const repoName = url.pathname.split("/")[1]?.replace(/\.git$/, "") ?? "";
      const service = url.searchParams.get("service") ?? (url.pathname.endsWith("/git-receive-pack") ? "git-receive-pack" : url.pathname.endsWith("/git-upload-pack") ? "git-upload-pack" : null);
      const log = { method: req.method ?? "GET", path: url.pathname, service, status: 0 };
      state.requests.push(log);
      const auth = req.headers.authorization ?? "";
      const password = auth.startsWith("Basic ") ? (Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":") ?? null) : null;
      if (!state.authorize(repoName, password, service ?? "")) {
        log.status = 401;
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="artifacts"' });
        res.end("unauthorized");
        return;
      }
      const body = await readBody(req);
      if (req.method === "POST" && service === "git-receive-pack") state.beforeReceivePack?.(repoName);
      const out = await runCgi(
        gitEnv({
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method ?? "GET",
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
          REMOTE_USER: "x",
          REMOTE_ADDR: "127.0.0.1",
          ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
        }),
        body,
      );
      let split = indexOfBytes(out, "\r\n\r\n");
      let sepLen = 4;
      if (split < 0) {
        split = indexOfBytes(out, "\n\n");
        sepLen = 2;
      }
      const head = out.subarray(0, split).toString();
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
        else headers[k] = v;
      }
      log.status = status;
      res.writeHead(status, headers);
      res.end(out.subarray(split + sepLen));
    })().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // keep-alive sockets from fetch would hold close() open
      }),
  });
}

type Code = ArtifactsErrorCode;

export function artifactsError(code: Code, message: string = code): Error {
  return Object.assign(new Error(`${code}: ${message}`), { name: "ArtifactsError" as const, code, numericCode: 10000 });
}

interface Meta {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  source: string | null;
  readOnly: boolean;
}

export interface FakeArtifactsOptions {
  root: string;
  baseUrl: string;
  namespace?: string;
  /** false: `log({ ref: "refs/…" })` returns [] (exercises readNote's git fallback). */
  fullRefsInLog?: boolean;
}

/** The subset of the Artifacts binding ArtifactsBackend uses, over bare repos via the git CLI. */
export class FakeArtifacts implements Artifacts {
  readonly repos = new Map<string, Meta>();
  readonly tokens = new Map<string, { repo: string; scope: "read" | "write"; expiresAt: number }>();
  /** "get:<repo>" / "fork:<source>" → error codes thrown by the next calls, in order. */
  readonly failures = new Map<string, Code[]>();
  readonly calls: string[] = [];
  opened = 0;
  disposed = 0;
  private seq = 0;

  constructor(readonly opts: FakeArtifactsOptions) {}

  private path(name: string): string {
    return join(this.opts.root, `${name}.git`);
  }

  remote(name: string): string {
    return `${this.opts.baseUrl}/${name}.git`;
  }

  private maybeFail(key: string): void {
    const queue = this.failures.get(key);
    const code = queue?.shift();
    if (code) throw artifactsError(code);
  }

  private mint(repo: string, scope: "read" | "write", ttl: number): { id: string; plaintext: string; scope: "read" | "write"; expiresAt: string } {
    const secret = `art_v1_${(++this.seq).toString(16).padStart(8, "0")}${"a".repeat(32)}`;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    this.tokens.set(secret, { repo, scope, expiresAt });
    return { id: secret.slice(7, 23), plaintext: `${secret}?expires=${expiresAt}`, scope, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }

  /** Git smart-HTTP auth check (wire to GitHttpServer.authorize). */
  checkToken(repo: string, password: string | null, service: string): boolean {
    const t = password ? this.tokens.get(password) : undefined;
    if (!t || t.repo !== repo) return false;
    return service !== "git-receive-pack" || t.scope === "write";
  }

  private git(name: string, args: string[]): Buffer {
    return gitRaw(["--git-dir", this.path(name), ...args]);
  }

  private result(meta: Meta) {
    return { id: meta.id, name: meta.name, description: meta.description, defaultBranch: meta.defaultBranch, remote: this.remote(meta.name), token: this.mint(meta.name, "write", 86_400).plaintext };
  }

  private register(name: string, defaultBranch: string, description: string | null, source: string | null): Meta {
    const now = new Date().toISOString();
    const meta: Meta = { id: `repo_${++this.seq}`, name, description, defaultBranch, createdAt: now, updatedAt: now, lastPushAt: null, source, readOnly: false };
    this.repos.set(name, meta);
    gitRaw(["--git-dir", this.path(name), "config", "http.receivepack", "true"]);
    return meta;
  }

  async create(name: string, opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string }): Promise<ArtifactsCreateRepoResult> {
    this.calls.push(`create:${name}`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw artifactsError("INVALID_REPO_NAME");
    if (this.repos.has(name)) throw artifactsError("ALREADY_EXISTS");
    const branch = opts?.setDefaultBranch ?? "main";
    gitRaw(["init", "-q", "--bare", "-b", branch, this.path(name)]);
    return this.result(this.register(name, branch, opts?.description ?? null, null));
  }

  async get(name: string): Promise<ArtifactsRepo> {
    this.calls.push(`get:${name}`);
    this.maybeFail(`get:${name}`);
    if (!this.repos.has(name)) throw artifactsError("NOT_FOUND", `repo ${name} not found`);
    this.opened++;
    return this.handle(name);
  }

  async import(): Promise<ArtifactsCreateRepoResult> {
    throw artifactsError("INVALID_INPUT", "import is not faked");
  }

  async list(): Promise<ArtifactsRepoListResult> {
    const repos = [...this.repos.values()];
    return { repos, total: repos.length };
  }

  async delete(name: string): Promise<boolean> {
    this.calls.push(`delete:${name}`);
    if (!this.repos.delete(name)) return false;
    rmSync(this.path(name), { recursive: true, force: true });
    return true;
  }

  private handle(name: string): ArtifactsRepo {
    const self = this;
    const meta = () => {
      const m = self.repos.get(name);
      if (!m) throw artifactsError("NOT_FOUND");
      return m;
    };
    const objectType = (hash: string): string | null => {
      if (!/^[0-9a-f]{40}$/.test(hash)) throw artifactsError("INVALID_INPUT", "malformed hash");
      try {
        return self.git(name, ["cat-file", "-t", hash]).toString().trim();
      } catch {
        return null;
      }
    };
    const readCommit = (hash: string) => (objectType(hash) === "commit" ? decodeCommit(hash, self.git(name, ["cat-file", "commit", hash])) : null);
    return {
      async info() {
        self.calls.push(`info:${name}`);
        return { ...meta(), remote: self.remote(name) };
      },
      async createToken(scope = "write", ttl = 86_400) {
        self.calls.push(`createToken:${name}:${scope}:${ttl}`);
        meta();
        return self.mint(name, scope, ttl);
      },
      async listTokens() {
        return { tokens: [], total: 0 };
      },
      async revokeToken() {
        return false;
      },
      async readBlob(hash: string) {
        self.calls.push(`readBlob:${name}`);
        return objectType(hash) === "blob" ? new Blob([new Uint8Array(self.git(name, ["cat-file", "blob", hash]))]) : null;
      },
      async readTree(hash: string) {
        self.calls.push(`readTree:${name}`);
        return objectType(hash) === "tree" ? decodeTree(self.git(name, ["cat-file", "tree", hash])) : null;
      },
      async readCommit(hash: string) {
        self.calls.push(`readCommit:${name}`);
        return readCommit(hash);
      },
      async readFile() {
        return null;
      },
      async log(opts?: { ref?: string; limit?: number; offset?: number }) {
        self.calls.push(`log:${name}:${opts?.ref ?? "HEAD"}`);
        const ref = opts?.ref ?? "HEAD";
        if (ref.startsWith("refs/") && self.opts.fullRefsInLog === false) return [];
        const limit = Math.min(opts?.limit ?? 50, 1000);
        let shas: string[];
        try {
          shas = self.git(name, ["rev-list", "--first-parent", `--max-count=${limit}`, `--skip=${opts?.offset ?? 0}`, ref, "--"]).toString().split("\n").filter(Boolean);
        } catch {
          return [];
        }
        return shas.map((sha) => readCommit(sha)!);
      },
      async fork(target: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }) {
        self.calls.push(`fork:${name}->${target}`);
        self.maybeFail(`fork:${name}`);
        if (self.repos.has(target)) throw artifactsError("ALREADY_EXISTS");
        const src = meta();
        const hasBranch = existsSync(self.path(name)) && (() => {
          try {
            self.git(name, ["rev-parse", "--verify", `refs/heads/${src.defaultBranch}`]);
            return true;
          } catch {
            return false;
          }
        })();
        if (hasBranch && opts?.defaultBranchOnly !== false) {
          gitRaw(["clone", "-q", "--bare", "--single-branch", "--no-tags", "--branch", src.defaultBranch, self.path(name), self.path(target)]);
        } else if (hasBranch) {
          gitRaw(["clone", "-q", "--bare", "--no-tags", self.path(name), self.path(target)]);
        } else {
          gitRaw(["init", "-q", "--bare", "-b", src.defaultBranch, self.path(target)]);
        }
        const ns = self.opts.namespace ?? "test";
        return self.result(self.register(target, src.defaultBranch, opts?.description ?? null, `artifacts:${ns}/${name}`));
      },
      [Symbol.dispose]() {
        self.disposed++;
      },
    } as ArtifactsRepo;
  }
}

/** Run git directly in a fake repo (to play a concurrent writer). */
export function gitIn(binding: FakeArtifacts, repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["--git-dir", join(binding.opts.root, `${repo}.git`), ...args], { env: gitEnv(env) }).toString().trim();
}
