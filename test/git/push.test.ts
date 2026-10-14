/**
 * The receive-pack client against real git (`git http-backend`), and what a changeset commit costs:
 * the bytes of a commit do not grow with the size of the repository.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpClient } from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareChangeset } from "../../src/core/git/changeset";
import { utf8 } from "../../src/core/git/objects";
import { ArtifactsBackend, fannedNotePath, tokenSecret } from "../../src/platform/repo/artifacts";
import type { CommitInput } from "../../src/platform/repo/backend";
import { concat, packObjectCount, writePack } from "../../src/platform/repo/pack";
import {
  FLUSH_PKT,
  GitHttpError,
  GitProtocolError,
  PushRejectedError,
  advertisedRefs,
  fetchHttp,
  parseAdvertisement,
  parseReport,
  pktLine,
  pushPack,
  readPktLines,
} from "../../src/platform/repo/push";
import { FakeArtifacts, type GitHttpServer, gitIn, startGitHttpServer } from "./fake-artifacts";
import { git, hasGitHttpBackend, tempDir } from "./helpers";

const author = { name: "Robin", email: "robin@gitring.dev" };
const NOW = 1_760_000_000_000;

let tmp: ReturnType<typeof tempDir>;
let server: GitHttpServer;
let binding: FakeArtifacts;

/** A git HTTP client that counts the bytes it sends and receives, and keeps every push body. */
function counting(base: HttpClient = webHttp as HttpClient) {
  const stats = { sent: 0, received: 0, requests: [] as string[], pushes: [] as Uint8Array[] };
  const client: HttpClient = {
    request: async (req) => {
      const chunks: Uint8Array[] = [];
      if (req.body) for await (const c of req.body) chunks.push(c);
      const body = concat(chunks);
      stats.sent += body.byteLength;
      stats.requests.push(`${req.method ?? "GET"} ${new URL(req.url).pathname.split("/").pop()}`);
      if (req.method === "POST" && req.url.endsWith("git-receive-pack")) stats.pushes.push(body);
      const res = await base.request({ ...req, ...(req.body ? { body: (async function* () { yield body; })() } : {}) });
      const got: Uint8Array[] = [];
      if (res.body) for await (const c of res.body) got.push(c);
      const answer = concat(got);
      stats.received += answer.byteLength;
      return { ...res, body: (async function* () { yield answer; })() };
    },
  };
  return { client, stats };
}

/** The pack inside a push body (after the commands and the flush). */
function packOf(body: Uint8Array): Uint8Array {
  const marker = utf8.encode("0000PACK");
  outer: for (let i = 0; i + marker.length <= body.length; i++) {
    for (let j = 0; j < marker.length; j++) if (body[i + j] !== marker[j]) continue outer;
    return body.subarray(i + 4);
  }
  throw new Error("no pack in the push body");
}

/** What real git says about every object of a pack: type, size and size in the pack. */
function verifyPack(name: string, pack: Uint8Array): { type: string; size: number; packed: number }[] {
  const file = join(tmp.path, `${name}.pack`);
  writeFileSync(file, pack);
  git(["index-pack", file]);
  return git(["verify-pack", "-v", file])
    .split("\n")
    .map((line) => /^([0-9a-f]{40}) (commit|tree|blob)\s+(\d+)\s+(\d+)\s+\d+$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ type: m[2], size: Number(m[3]), packed: Number(m[4]) }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.size - b.size);
}

function backend(over: Partial<ConstructorParameters<typeof ArtifactsBackend>[1]> = {}): ArtifactsBackend {
  return new ArtifactsBackend(binding, { now: () => NOW, sleep: async () => undefined, blobCache: null, ...over });
}

/** A repository with one root commit of `files`; returns the commit. */
async function seeded(be: ArtifactsBackend, repo: string, files: Record<string, string>): Promise<string> {
  await be.ensureRepo(repo);
  return (await be.commit({ repo, branch: "main", parent: "", message: "seed", author, changes: Object.entries(files).map(([path, content]) => ({ path, content })) })).sha;
}

const SMALL: Record<string, string> = {
  "README.md": "# Demo\n",
  "src/app/index.ts": "export const a = 1;\n",
  "src/app/util.ts": "export const u = 2;\n",
  "src/other/x.ts": "export const x = 3;\n",
  "vendor/a.js": "1\n",
};
/** The same tree with 600 more files (about 60 KB) under vendor/. */
const BIG: Record<string, string> = {
  ...SMALL,
  ...Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`vendor/lib${i % 12}/pkg${i % 25}/file${i}.js`, `module.exports = { n: ${i}, text: "${"x".repeat(60)}" };\n`])),
};
const CHANGE: CommitInput["changes"] = [{ path: "src/app/index.ts", content: "export const a = 2;\n" }];

describe("pkt-line and the answers of git", () => {
  it("writes and reads pkt-lines", () => {
    expect(utf8.decode(pktLine("abc"))).toBe("0007abc");
    expect(utf8.decode(FLUSH_PKT)).toBe("0000");
    expect(readPktLines(concat([pktLine("abc"), FLUSH_PKT, pktLine("d\n")])).map((p) => (p ? utf8.decode(p) : p))).toEqual(["abc", null, "d\n"]);
    expect(() => readPktLines(utf8.encode("00zz"))).toThrow(GitProtocolError);
    expect(() => readPktLines(utf8.encode("0009ab"))).toThrow(/does not fit/);
    expect(() => pktLine("x".repeat(70_000))).toThrow(/too long/);
  });

  it("reads a ref advertisement: an empty repository, refs with capabilities, peeled tags", () => {
    const zero = "0".repeat(40);
    const empty = concat([pktLine("# service=git-receive-pack\n"), FLUSH_PKT, pktLine(`${zero} capabilities^{}\0report-status delete-refs agent=git/2.51\n`), FLUSH_PKT]);
    const a = parseAdvertisement(empty);
    expect(a.refs.size).toBe(0);
    expect([...a.capabilities]).toEqual(["report-status", "delete-refs", "agent=git/2.51"]);
    const one = "1".repeat(40);
    const two = "2".repeat(40);
    const full = concat([
      pktLine("# service=git-receive-pack\n"),
      FLUSH_PKT,
      pktLine(`${one} refs/heads/main\0report-status atomic\n`),
      pktLine(`${two} refs/tags/v1\n`),
      pktLine(`${one} refs/tags/v1^{}\n`),
      pktLine(`${two} refs/notes/gitring\n`),
      FLUSH_PKT,
    ]);
    const b = parseAdvertisement(full);
    expect([...b.refs]).toEqual([
      ["refs/heads/main", one],
      ["refs/tags/v1", two],
      ["refs/notes/gitring", two],
    ]);
    expect(b.capabilities.has("atomic")).toBe(true);
    expect(() => parseAdvertisement(concat([pktLine("# service=git-upload-pack\n"), FLUSH_PKT]))).toThrow(GitProtocolError);
    expect(() => parseAdvertisement(concat([pktLine("# service=git-receive-pack\n"), FLUSH_PKT, FLUSH_PKT]))).toThrow(/no refs line/);
    expect(() => parseAdvertisement(concat([pktLine("# service=git-receive-pack\n"), FLUSH_PKT, pktLine("nonsense\n"), FLUSH_PKT]))).toThrow(/bad ref line/);
  });

  it("reads a report-status answer, plain or in a side band", () => {
    const plain = concat([pktLine("unpack ok\n"), pktLine("ok refs/heads/main\n"), pktLine("ng refs/notes/gitring failed to update ref\n"), FLUSH_PKT]);
    const r = parseReport(plain);
    expect(r.unpack).toBe("ok");
    expect([...r.refs]).toEqual([
      ["refs/heads/main", { ok: true, reason: "" }],
      ["refs/notes/gitring", { ok: false, reason: "failed to update ref" }],
    ]);
    const band1 = concat([new Uint8Array([1]), pktLine("unpack ok\n"), pktLine("ok refs/heads/main\n"), FLUSH_PKT]);
    const band2 = concat([new Uint8Array([2]), utf8.encode("a message\n")]);
    const banded = concat([pktLine(band2), pktLine(band1), FLUSH_PKT]);
    expect(parseReport(banded).refs.get("refs/heads/main")).toEqual({ ok: true, reason: "" });
    expect(() => parseReport(concat([pktLine("ok refs/heads/main\n"), FLUSH_PKT]))).toThrow(/no unpack status/);
  });
});

describe.skipIf(!hasGitHttpBackend())("receive-pack client (git http-backend)", () => {
  beforeAll(async () => {
    tmp = tempDir("gitring-push-");
    server = await startGitHttpServer(join(tmp.path, "repos"));
    binding = new FakeArtifacts({ root: join(tmp.path, "repos"), baseUrl: server.url });
    server.authorize = (repo, password, service) => binding.checkToken(repo, password, service);
  });
  afterAll(async () => {
    await server.close();
    tmp.cleanup();
  });

  it("pushes a pack with fetch: a new branch, then a commit on it; a stale old id is refused", async () => {
    const created = await binding.create("direct");
    const remote = created.remote;
    const secret = tokenSecret(created.token);
    const http = fetchHttp();
    const empty = await advertisedRefs(http, remote, secret);
    expect(empty.refs.size).toBe(0);
    expect(empty.capabilities.has("report-status")).toBe(true);

    const root = await prepareChangeset({ reader: { readTree: async () => null }, baseTree: null, changes: [{ path: "a.txt", content: "a\n" }], parents: [], author, message: "root", timestamp: NOW / 1000 });
    const pack1 = await writePack([...[...root.blobs.values()].map((body) => ({ type: "blob" as const, body })), ...[...root.trees.values()].map((body) => ({ type: "tree" as const, body })), { type: "commit", body: root.commit }]);
    expect(packObjectCount(pack1)).toBe(3);
    const sent = await pushPack(http, remote, secret, [{ ref: "refs/heads/main", old: null, new: root.sha }], pack1);
    expect(sent.sent).toBe(pack1.byteLength + 4 + 4 + `${"0".repeat(40)} ${root.sha} refs/heads/main\0report-status agent=gitring-changeset/1\n`.length);
    expect(gitIn(binding, "direct", ["rev-parse", "refs/heads/main"])).toBe(root.sha);

    const adv = await advertisedRefs(http, remote, secret);
    expect(adv.refs.get("refs/heads/main")).toBe(root.sha);
    const next = await prepareChangeset({
      reader: { readTree: async (sha) => (await backend().readTree("direct", sha)) },
      baseTree: root.tree,
      changes: [{ path: "b/c.txt", content: "c\n" }],
      parents: [root.sha],
      author,
      message: "second",
      timestamp: NOW / 1000,
    });
    const pack2 = await writePack([...[...next.blobs.values()].map((body) => ({ type: "blob" as const, body })), ...[...next.trees.values()].map((body) => ({ type: "tree" as const, body })), { type: "commit", body: next.commit }]);
    await pushPack(http, remote, secret, [{ ref: "refs/heads/main", old: root.sha, new: next.sha }], pack2);
    expect(gitIn(binding, "direct", ["rev-parse", "main"])).toBe(next.sha);
    expect(gitIn(binding, "direct", ["ls-tree", "-r", "--name-only", "main"]).split("\n")).toEqual(["a.txt", "b/c.txt"]);
    git(["fsck", "--strict", "--no-dangling"], { cwd: join(tmp.path, "repos", "direct.git") });

    // The same push again names an old id that main left behind: the server does not move the ref.
    const err = await pushPack(http, remote, secret, [{ ref: "refs/heads/main", old: root.sha, new: next.sha }], pack2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushRejectedError);
    expect(err).toMatchObject({ ref: "refs/heads/main" });
    expect((err as PushRejectedError).reason).toMatch(/failed to update ref|stale|lock|incorrect old value/);
    expect(gitIn(binding, "direct", ["rev-parse", "main"])).toBe(next.sha);

    // A commit whose tree the server does not have: the server reports missing objects, nothing moves.
    const orphan = await prepareChangeset({ reader: { readTree: async () => null }, baseTree: null, changes: [{ path: "z.txt", content: "z\n" }], parents: [next.sha], author, message: "orphan", timestamp: NOW / 1000 });
    const onlyCommit = await writePack([{ type: "commit", body: orphan.commit }]);
    const missing = await pushPack(http, remote, secret, [{ ref: "refs/heads/main", old: next.sha, new: orphan.sha }], onlyCommit).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PushRejectedError);
    expect((missing as PushRejectedError).reason).toMatch(/missing necessary objects|unpack/);
    expect(gitIn(binding, "direct", ["rev-parse", "main"])).toBe(next.sha);

    // A wrong token: the status of the server, as an error.
    const denied = await advertisedRefs(http, remote, "art_v1_wrong").catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(GitHttpError);
    expect((denied as GitHttpError).status).toBe(401);
  });

  it("a commit costs the size of the change: the same bytes on a small and on a large tree, with nothing cloned", async () => {
    const small = counting();
    const smallBe = backend({ http: small.client });
    const s0 = await seeded(smallBe, "small", SMALL);
    small.stats.pushes.length = 0;
    small.stats.requests.length = 0;
    small.stats.sent = 0;
    small.stats.received = 0;
    const t0 = performance.now();
    const s1 = await smallBe.commit({ repo: "small", branch: "main", parent: s0, message: "One line", author, changes: CHANGE });
    const smallMs = performance.now() - t0;

    const big = counting();
    const bigBe = backend({ http: big.client });
    const b0 = await seeded(bigBe, "big", BIG);
    expect(gitIn(binding, "big", ["ls-tree", "-r", "--name-only", "main"]).split("\n")).toHaveLength(605);
    big.stats.pushes.length = 0;
    big.stats.requests.length = 0;
    big.stats.sent = 0;
    big.stats.received = 0;
    const t1 = performance.now();
    const b1 = await bigBe.commit({ repo: "big", branch: "main", parent: b0, message: "One line", author, changes: CHANGE });
    const bigMs = performance.now() - t1;

    expect(gitIn(binding, "small", ["rev-parse", "main"])).toBe(s1.sha);
    expect(gitIn(binding, "big", ["rev-parse", "main"])).toBe(b1.sha);
    // One advertisement and one push each; no clone (no upload-pack request).
    expect(small.stats.requests).toEqual(["GET refs", "POST git-receive-pack"]);
    expect(big.stats.requests).toEqual(small.stats.requests);
    expect(small.stats.requests.some((r) => r.includes("upload-pack"))).toBe(false);

    // The same objects: one blob, the three trees on the changed path (root, src, src/app), the commit.
    const smallObjects = verifyPack("small", packOf(small.stats.pushes[0]));
    const bigObjects = verifyPack("big", packOf(big.stats.pushes[0]));
    expect(smallObjects.map((o) => o.type)).toEqual(["blob", "commit", "tree", "tree", "tree"]);
    expect(bigObjects.map((o) => `${o.type} ${o.size}`)).toEqual(smallObjects.map((o) => `${o.type} ${o.size}`));
    // The same bytes on the wire, give or take the few bytes zlib spends on different tree ids.
    expect(Math.abs(big.stats.sent - small.stats.sent)).toBeLessThanOrEqual(8);
    expect(big.stats.sent).toBeLessThan(2000);
    expect(big.stats.received).toBeLessThan(2000);

    // The clone path for the same change on the large tree reads the whole tree first.
    const clone = counting();
    const cloneBe = backend({ http: clone.client, writes: "clone" });
    const t2 = performance.now();
    const b2 = await cloneBe.commit({ repo: "big", branch: "main", parent: b1.sha, message: "One more line", author, changes: [{ path: "src/app/index.ts", content: "export const a = 3;\n" }] });
    const cloneMs = performance.now() - t2;
    expect(gitIn(binding, "big", ["rev-parse", "main"])).toBe(b2.sha);
    expect(clone.stats.requests.some((r) => r.includes("upload-pack"))).toBe(true);
    expect(clone.stats.received).toBeGreaterThan(20 * big.stats.received);
    console.info(
      `changeset commit: small tree ${small.stats.sent} B sent / ${small.stats.received} B received in ${smallMs.toFixed(0)} ms; ` +
        `large tree (605 files) ${big.stats.sent} B sent / ${big.stats.received} B received in ${bigMs.toFixed(0)} ms; ` +
        `clone path on the large tree ${clone.stats.sent} B sent / ${clone.stats.received} B received in ${cloneMs.toFixed(0)} ms`,
    );
  }, 60_000);

  it("falls back to the clone path when the server cannot use the pack, and `writes: \"clone\"` selects it", async () => {
    const be = backend();
    const root = await seeded(be, "fallback", SMALL);
    let faked = 0;
    const real = (webHttp as HttpClient).request.bind(webHttp);
    const f = counting({
      request: async (req) => {
        if (req.method === "POST" && req.url.endsWith("git-receive-pack") && faked === 0) {
          faked += 1;
          // The server answers that it cannot use the objects. The push did not happen.
          const body = concat([pktLine("unpack ok\n"), pktLine("ng refs/heads/main missing necessary objects\n"), FLUSH_PKT]);
          return { url: req.url, statusCode: 200, statusMessage: "OK", headers: {}, body: (async function* () { yield body; })() };
        }
        return real(req);
      },
    });
    const res = await backend({ http: f.client }).commit({ repo: "fallback", branch: "main", parent: root, message: "via clone", author, changes: CHANGE });
    expect(faked).toBe(1);
    expect(gitIn(binding, "fallback", ["rev-parse", "main"])).toBe(res.sha);
    expect(f.stats.requests.filter((r) => r.includes("upload-pack")).length).toBeGreaterThan(0);
    expect(f.stats.requests.filter((r) => r === "POST git-receive-pack")).toHaveLength(2);

    const c = counting();
    const viaClone = await backend({ http: c.client, writes: "clone" }).commit({ repo: "fallback", branch: "main", parent: res.sha, message: "clone path", author, changes: [{ path: "README.md", content: "# Demo 2\n" }] });
    expect(gitIn(binding, "fallback", ["rev-parse", "main"])).toBe(viaClone.sha);
    expect(c.stats.requests.some((r) => r.includes("upload-pack"))).toBe(true);
  });

  it("a flat notes tree moves to the fan-out layout on the first note gitring writes", async () => {
    const be = backend();
    const c1 = await seeded(be, "flat", { "a.txt": "a\n" });
    const c2 = (await be.commit({ repo: "flat", branch: "main", parent: c1, message: "2", author, changes: [{ path: "b.txt", content: "b\n" }] })).sha;
    const env = { GIT_AUTHOR_NAME: "Tool", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "Tool", GIT_COMMITTER_EMAIL: "t@x" };
    gitIn(binding, "flat", ["notes", "--ref=gitring", "add", "-m", "note of 1", c1], env);
    gitIn(binding, "flat", ["notes", "--ref=gitring", "add", "-m", "note of 2", c2], env);
    expect(gitIn(binding, "flat", ["ls-tree", "--name-only", "refs/notes/gitring"]).split("\n").sort()).toEqual([c1, c2].sort());
    const before = gitIn(binding, "flat", ["rev-parse", "refs/notes/gitring"]);

    const c3 = await be.commit({ repo: "flat", branch: "main", parent: c2, message: "3", author, changes: [{ path: "c.txt", content: "c\n" }], note: "note of 3\n" });
    const layout = gitIn(binding, "flat", ["ls-tree", "-r", "--name-only", "refs/notes/gitring"]).split("\n").sort();
    expect(layout).toEqual([fannedNotePath(c1), fannedNotePath(c2), fannedNotePath(c3.sha)].sort());
    expect(gitIn(binding, "flat", ["rev-parse", "refs/notes/gitring^"])).toBe(before);
    for (const [sha, text] of [[c1, "note of 1"], [c2, "note of 2"], [c3.sha, "note of 3"]]) {
      expect(gitIn(binding, "flat", ["notes", "--ref=gitring", "show", sha])).toBe(text);
      expect((await be.readNote("flat", sha))?.trim()).toBe(text);
    }
    git(["fsck", "--strict", "--no-dangling"], { cwd: join(tmp.path, "repos", "flat.git") });

    // The next note reads one subtree and writes one blob, one subtree, one root and one commit: four objects, no migration.
    const c = counting();
    const c4 = await backend({ http: c.client }).commit({ repo: "flat", branch: "main", parent: c3.sha, message: "4", author, changes: [{ path: "d.txt", content: "d\n" }], note: "note of 4\n" });
    expect(c.stats.pushes).toHaveLength(2);
    expect(packObjectCount(packOf(c.stats.pushes[0]))).toBe(4);
    expect(gitIn(binding, "flat", ["notes", "--ref=gitring", "show", c4.sha])).toBe("note of 4");
  });
});
