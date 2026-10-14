/**
 * The pack writer: real git reads what it writes (`git unpack-objects`), and the object headers
 * follow the pack format.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_TREE_SHA, encodeCommit, encodeTree, hashObject, utf8 } from "../../src/core/git/objects";
import { deflate, objectHeader, packObjectCount, writePack } from "../../src/platform/repo/pack";
import { git, gitRaw, tempDir } from "./helpers";

let tmp: ReturnType<typeof tempDir>;
let bare: string;

beforeAll(() => {
  tmp = tempDir("gitring-pack-");
  bare = join(tmp.path, "repo.git");
  git(["init", "-q", "--bare", bare]);
});
afterAll(() => tmp.cleanup());

describe("pack writer", () => {
  it("writes object headers as the pack format says", () => {
    // Type in bits 4 to 6 of the first byte; the size in base-128, low bits first, with a continuation bit.
    expect([...objectHeader("commit", 0)]).toEqual([0x10]);
    expect([...objectHeader("tree", 15)]).toEqual([0x2f]);
    expect([...objectHeader("blob", 16)]).toEqual([0x30 | 0x80, 0x01]);
    expect([...objectHeader("blob", 2048)]).toEqual([0x30 | 0x80, 0x80, 0x01]);
    // 100 000 = 0x186a0: low 4 bits 0, then 0x6a and 0x30 in 7-bit groups.
    expect([...objectHeader("blob", 100_000)]).toEqual([0x80 | 0x30, 0x80 | 0x6a, 0x30]);
    expect(() => objectHeader("blob", -1)).toThrow(/invalid object size/);
  });

  it("deflates in zlib format (what git stores)", async () => {
    const out = await deflate(utf8.encode("hello hello hello hello"));
    expect(out[0]).toBe(0x78); // zlib header: deflate, 32 KB window
    const back = new Uint8Array(await new Response(new Blob([out as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
    expect(utf8.decode(back)).toBe("hello hello hello hello");
  });

  it("real git unpacks a pack of a blob, a tree and a commit, with the same ids", async () => {
    const blob = utf8.encode("# Pack\n");
    const blobSha = await hashObject("blob", blob);
    const tree = encodeTree([{ name: "README.md", mode: "100644", hash: blobSha, type: "blob" }]);
    const treeSha = await hashObject("tree", tree);
    const ident = { name: "Robin", email: "robin@gitring.dev", timestamp: 1_760_000_000, tzOffset: "+0000" };
    const commit = encodeCommit({ tree: treeSha, parents: [], author: ident, committer: ident, message: "Packed\n" });
    const commitSha = await hashObject("commit", commit);
    const pack = await writePack([
      { type: "blob", body: blob },
      { type: "tree", body: tree },
      { type: "commit", body: commit },
    ]);
    expect(utf8.decode(pack.subarray(0, 4))).toBe("PACK");
    expect(packObjectCount(pack)).toBe(3);
    gitRaw(["unpack-objects", "-q"], { cwd: bare, input: pack });
    expect(git(["cat-file", "-t", commitSha], { cwd: bare })).toBe("commit");
    expect(git(["cat-file", "-p", `${commitSha}^{tree}`], { cwd: bare })).toBe(`100644 blob ${blobSha}\tREADME.md`);
    expect(git(["cat-file", "blob", blobSha], { cwd: bare })).toBe("# Pack");
    git(["update-ref", "refs/heads/main", commitSha], { cwd: bare });
    git(["fsck", "--strict"], { cwd: bare });
  });

  it("an empty tree and a large blob travel in a pack too", async () => {
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
    const bigSha = await hashObject("blob", big);
    const pack = await writePack([
      { type: "tree", body: new Uint8Array(0) },
      { type: "blob", body: big },
    ]);
    gitRaw(["unpack-objects", "-q"], { cwd: bare, input: pack });
    expect(git(["cat-file", "-t", EMPTY_TREE_SHA], { cwd: bare })).toBe("tree");
    expect(gitRaw(["cat-file", "blob", bigSha], { cwd: bare })).toEqual(Buffer.from(big));
    // The trailer is the SHA-1 of everything before it: a changed byte breaks the pack.
    const broken = pack.slice();
    broken[20] ^= 0xff;
    expect(() => gitRaw(["unpack-objects", "-q"], { cwd: bare, input: broken })).toThrow();
  });

  it("packObjectCount refuses a buffer that is not a pack", () => {
    expect(() => packObjectCount(new Uint8Array(4))).toThrow(/not a pack/);
  });
});
