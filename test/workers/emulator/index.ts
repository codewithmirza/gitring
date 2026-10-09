/**
 * Probe worker for the emulator under real workerd (see wrangler.jsonc next to this file).
 *   GET /scenario?ns=…  end-to-end checks through EmulatorBackend → LocalArtifacts (real DO RPC + SQLite)
 *   GET /state?ns=…     repos and main history (to check persistence across restarts)
 *   GET /isogit         isomorphic-git + MemoryFS smoke test inside workerd (Buffer, CompressionStream)
 *   GET /artifacts?rpc= ArtifactsBackend (isomorphic-git clone/push) inside workerd against
 *                       fake-artifacts-server.ts (Node: fake binding over JSON + git http-backend)
 */
import git from "isomorphic-git";
import { EMPTY_TREE_SHA, encodeTree, hashObject, utf8 } from "../../../src/core/git/objects";
import { ArtifactsBackend } from "../../../src/platform/repo/artifacts";
import { RepoConflictError } from "../../../src/platform/repo/backend";
import { EmulatorBackend, GitStore, LocalArtifacts, MemoryObjectStore } from "../../support/git-emulator/local-artifacts";
import { MemoryFS } from "../../../src/platform/repo/memory-fs";

export { LocalArtifacts };

interface Env {
  EMULATOR: DurableObjectNamespace<LocalArtifacts>;
}

type Check = { name: string; ok: boolean; detail?: unknown };

const author = { name: "Probe", email: "probe@gitring.dev" };

async function scenario(backend: EmulatorBackend): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail });
  const run = `r${Date.now().toString(36)}`;
  const canon = `canon-${run}`;

  check("ensureRepo", (await backend.ensureRepo(canon)).defaultBranch === "main");
  const c1 = await backend.commit({
    repo: canon,
    branch: "main",
    parent: "",
    message: "Seed",
    author,
    changes: [
      { path: "src/index.js", content: "export default {};\n" },
      { path: "bin/run", content: "#!/bin/sh\n", mode: "100755" },
      { path: "data.bin", content: new Uint8Array([0, 1, 2, 255]) },
    ],
  });
  const c2 = await backend.commit({
    repo: canon,
    branch: "main",
    parent: c1.sha,
    message: "Second",
    author,
    changes: [{ path: "src/index.js", content: "export default { ok: true };\n" }, { path: "data.bin", content: null }],
    note: '{"schema":"gitring.logbook/v1"}',
  });
  check("resolve main", (await backend.resolve(canon, "main")) === c2.sha);
  check("resolve HEAD", (await backend.resolve(canon, "HEAD")) === c2.sha);
  const log = await backend.log(canon, "main");
  check("log first-parent newest first", log.map((c) => c.hash).join() === [c2.sha, c1.sha].join(), log.map((c) => c.message));
  check("readNote", (await backend.readNote(canon, c2.sha)) === '{"schema":"gitring.logbook/v1"}');
  check("readNote absent", (await backend.readNote(canon, c1.sha)) === null);

  const root = (await backend.readTree(canon, c2.tree)) ?? [];
  check("tree after delete", root.map((e) => `${e.type}:${e.name}`).join() === "tree:bin,tree:src", root);
  const bin = (await backend.readTree(canon, root[0].hash)) ?? [];
  check("exec mode kept", bin[0]?.type === "exec" && bin[0]?.mode === "100755", bin);
  const src = (await backend.readTree(canon, root[1].hash)) ?? [];
  const blob = await backend.readBlob(canon, src[0].hash);
  check("readBlob returns Uint8Array over RPC", blob instanceof Uint8Array && utf8.decode(blob) === "export default { ok: true };\n");

  // Compare-and-swap through real RPC: the conflict comes back as a RepoConflictError.
  const stale = await backend.commit({ repo: canon, branch: "main", parent: c1.sha, message: "late", author, changes: [] }).catch((e: unknown) => e);
  check(
    "stale parent → RepoConflictError",
    stale instanceof RepoConflictError && stale.expected === c1.sha && stale.actual === c2.sha,
    stale instanceof Error ? { name: stale.name, message: stale.message } : stale,
  );

  // Concurrent commits on one parent: exactly one wins.
  const racers = await Promise.allSettled(
    [1, 2, 3].map((i) => backend.commit({ repo: canon, branch: "main", parent: c2.sha, message: `racer ${i}`, author, changes: [{ path: `r${i}.txt`, content: String(i) }] })),
  );
  const winners = racers.filter((r) => r.status === "fulfilled");
  const losers = racers.filter((r) => r.status === "rejected" && r.reason instanceof RepoConflictError);
  check("concurrent commits: one winner", winners.length === 1 && losers.length === 2, racers.map((r) => r.status));
  const tip = (await backend.resolve(canon, "main"))!;

  // Fork: default branch only, independent afterwards.
  const forkName = `att-${run}`;
  const fork = await backend.fork(canon, forkName, { description: "probe attempt" });
  check("fork", fork.name === forkName && (await backend.resolve(forkName, "main")) === tip);
  const f1 = await backend.commit({ repo: forkName, branch: "main", parent: tip, message: "fork work", author, changes: [{ path: "f.txt", content: "f" }] });
  check("fork diverges", (await backend.resolve(forkName, "main")) === f1.sha && (await backend.resolve(canon, "main")) === tip);
  check("notes not copied to fork", (await backend.readNote(forkName, c2.sha)) === null);

  // Object larger than one SQLite row (2 MB cap) is chunked.
  const big = new Uint8Array(2_500_000).map((_, i) => (i * 7) & 0xff);
  const bigCommit = await backend.commit({ repo: forkName, branch: "main", parent: f1.sha, message: "big", author, changes: [{ path: "big.bin", content: big }] });
  const bigEntry = ((await backend.readTree(forkName, bigCommit.tree)) ?? []).find((e) => e.name === "big.bin");
  const bigBack = bigEntry ? await backend.readBlob(forkName, bigEntry.hash) : null;
  check("2.5 MB blob round trip", !!bigBack && bigBack.length === big.length && bigBack.every((b, i) => b === big[i]) && bigEntry?.hash === (await hashObject("blob", big)));

  // Errors keep their message across RPC.
  const missing = await backend.log(`missing-${run}`, "main").catch((e: unknown) => e);
  check("missing repo → NOT_FOUND", missing instanceof Error && /NOT_FOUND/.test(missing.message), String(missing));
  const repos = await backend.listRepos();
  check("listRepos", repos.some((r) => r.name === forkName && r.source === canon));

  await backend.deleteRepo(forkName);
  const gone = await backend.resolve(forkName, "main").catch((e: unknown) => e);
  check("deleteRepo", gone instanceof Error && /NOT_FOUND/.test(gone.message));
  return { ok: checks.every((c) => c.ok), checks };
}

async function isogit(): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const fs = new MemoryFS();
  const dir = "/repo";
  await git.init({ fs, dir, defaultBranch: "main" });
  const body = utf8.encode("hello from workerd\n");
  const oid = await git.writeObject({ fs, dir, type: "blob", object: body, format: "content" });
  checks.push({ name: "writeObject blob id = hashObject", ok: oid === (await hashObject("blob", body)), detail: oid });
  const tree = encodeTree([{ name: "hello.txt", mode: "100644", hash: oid, type: "blob" }]);
  const treeOid = await git.writeObject({ fs, dir, type: "tree", object: tree, format: "content" });
  checks.push({ name: "writeObject tree id = hashObject", ok: treeOid === (await hashObject("tree", tree)) });
  const back = await git.readObject({ fs, dir, oid, format: "content" });
  checks.push({ name: "readObject round trip", ok: utf8.decode(back.object as Uint8Array) === "hello from workerd\n" });
  const commitOid = await git.commit({ fs, dir, message: "probe", tree: treeOid, parent: [], author: { name: "P", email: "p@x", timestamp: 1_760_000_000, timezoneOffset: 0 } });
  checks.push({ name: "commit + resolveRef", ok: (await git.resolveRef({ fs, dir, ref: "main" })) === commitOid });
  checks.push({ name: "empty tree constant", ok: (await hashObject("tree", encodeTree([]))) === EMPTY_TREE_SHA });
  checks.push({ name: "Buffer global (nodejs_compat)", ok: typeof (globalThis as { Buffer?: unknown }).Buffer === "function" });
  return { ok: checks.every((c) => c.ok), checks };
}

/** The Artifacts binding surface, proxied to fake-artifacts-server.ts (Node) over JSON. */
class RemoteArtifacts {
  constructor(private readonly base: string) {}

  async call(repo: string | undefined, method: string, args: unknown[]): Promise<unknown> {
    const res = await fetch(`${this.base}/rpc`, { method: "POST", body: JSON.stringify({ repo, method, args }) });
    const body = (await res.json()) as { result?: unknown; error?: { code: string; message: string } };
    if (body.error) throw Object.assign(new Error(body.error.message), { name: "ArtifactsError", code: body.error.code });
    return body.result;
  }

  create(name: string, opts?: unknown) {
    return this.call(undefined, "create", [name, opts]) as Promise<ArtifactsCreateRepoResult>;
  }
  delete(name: string) {
    return this.call(undefined, "delete", [name]) as Promise<boolean>;
  }
  list() {
    return this.call(undefined, "list", []) as Promise<ArtifactsRepoListResult>;
  }
  async import(): Promise<ArtifactsCreateRepoResult> {
    throw new Error("not faked");
  }
  async get(name: string): Promise<ArtifactsRepo> {
    await this.call(undefined, "get", [name]);
    const c = (method: string, ...args: unknown[]) => this.call(name, method, args);
    return {
      info: () => c("info"),
      createToken: (scope?: string, ttl?: number) => c("createToken", scope, ttl),
      listTokens: () => c("listTokens"),
      revokeToken: (t: string) => c("revokeToken", t),
      log: (opts?: unknown) => c("log", opts),
      readCommit: (h: string) => c("readCommit", h),
      readTree: (h: string) => c("readTree", h),
      readFile: async () => null,
      readBlob: async (h: string) => {
        const out = (await c("readBlob", h)) as { base64: string } | null;
        return out ? new Blob([Uint8Array.from(atob(out.base64), (ch) => ch.charCodeAt(0))]) : null;
      },
      fork: (target: string, opts?: unknown) => c("fork", target, opts),
      [Symbol.dispose]() {},
    } as unknown as ArtifactsRepo;
  }
}

/** ArtifactsBackend inside workerd: isomorphic-git clone/push against real git http-backend. */
async function artifactsScenario(rpc: string): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail });
  const NOW = 1_760_000_000_000;
  const backend = new ArtifactsBackend(new RemoteArtifacts(rpc) as unknown as Artifacts, { now: () => NOW });
  const emu = new GitStore(new MemoryObjectStore(), { now: () => NOW });
  const repo = `wd-${Date.now().toString(36)}`;
  const h = await backend.ensureRepo(repo);
  await emu.ensureRepo(repo);
  check("ensureRepo", h.defaultBranch === "main" && !!h.remote, h);

  const first = {
    repo,
    branch: "main",
    parent: "",
    message: "Seed from workerd",
    author,
    changes: [
      { path: "src/index.js", content: "export default {};\n" },
      { path: "bin/run", content: "#!/bin/sh\n", mode: "100755" },
      { path: "img.bin", content: new Uint8Array([137, 80, 78, 71, 0, 1]) },
    ],
  };
  const t0 = Date.now();
  const c1 = await backend.commit(first);
  const e1 = await emu.commit(first);
  check("root commit pushed (init + push)", c1.sha === e1.sha, { artifacts: c1.sha, emulator: e1.sha });
  const second = {
    repo,
    branch: "main",
    parent: c1.sha,
    message: "Second from workerd",
    author,
    changes: [{ path: "src/index.js", content: "export default { ok: true };\n" }, { path: "img.bin", content: null }],
    note: '{"schema":"gitring.logbook/v1","from":"workerd"}',
  };
  const c2 = await backend.commit(second);
  const e2 = await emu.commit({ ...second, parent: e1.sha });
  check("second commit (shallow clone + push + note) = emulator", c2.sha === e2.sha && c2.tree === e2.tree, { c2, e2, ms: Date.now() - t0 });
  check("resolve main", (await backend.resolve(repo, "main")) === c2.sha);
  check("readNote", (await backend.readNote(repo, c2.sha)) === second.note);
  const tree = (await backend.readTree(repo, c2.tree)) ?? [];
  check("tree", tree.map((e) => `${e.type}:${e.name}`).join() === "tree:bin,tree:src", tree);
  const stale = await backend.commit({ ...second, parent: c1.sha, note: undefined }).catch((e: unknown) => e);
  check("stale parent → RepoConflictError", stale instanceof RepoConflictError && stale.actual === c2.sha, String(stale));
  const fork = await backend.fork(repo, `${repo}-att`);
  const f1 = await backend.commit({ repo: fork.name, branch: "main", parent: c2.sha, message: "fork work", author, changes: [{ path: "f.txt", content: "f" }] });
  check("fork + commit", (await backend.resolve(fork.name, "main")) === f1.sha && (await backend.resolve(repo, "main")) === c2.sha);
  return { ok: checks.every((c) => c.ok), checks };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const backend = new EmulatorBackend(env.EMULATOR, url.searchParams.get("ns") ?? "probe");
    try {
      if (url.pathname === "/scenario") return Response.json(await scenario(backend));
      if (url.pathname === "/isogit") return Response.json(await isogit());
      if (url.pathname === "/artifacts") return Response.json(await artifactsScenario(url.searchParams.get("rpc") ?? "http://127.0.0.1:8792"));
      if (url.pathname === "/state") {
        const repos = await backend.listRepos();
        const history: Record<string, string[]> = {};
        for (const r of repos) history[r.name] = (await backend.log(r.name, "main", 5)).map((c) => `${c.hash.slice(0, 8)} ${c.message}`);
        return Response.json({ repos: repos.map((r) => r.name), history });
      }
      return new Response("routes: /scenario /state /isogit", { status: 404 });
    } catch (err) {
      return Response.json({ error: String(err), stack: (err as Error).stack }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
