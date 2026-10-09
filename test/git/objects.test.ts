/**
 * Cross-check of the git object model against the real git CLI: blob, tree and commit ids
 * must be identical, and decoding git's own objects must give the expected fields.
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMPTY_TREE_SHA,
  decodeCommit,
  decodeTree,
  encodeCommit,
  encodeTree,
  frameObject,
  hashObject,
  isValidBranchName,
  modeToType,
  normalizeCommitMessage,
  sha1Hex,
  utf8,
} from "../../src/core/git/objects";
import { buildTrees, type Snapshot } from "../../src/core/git/snapshot";
import type { TreeEntry } from "../../src/platform/repo/backend";
import { git, gitRaw, tempDir } from "./helpers";

let tmp: ReturnType<typeof tempDir>;
let repo: string;

beforeAll(() => {
  tmp = tempDir();
  repo = join(tmp.path, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main", repo]);
});
afterAll(() => tmp.cleanup());

/** `git hash-object -w --stdin` for raw bytes. */
function gitBlob(content: Uint8Array | string): string {
  return git(["hash-object", "-w", "--stdin"], { cwd: repo, input: content });
}

describe("blobs", () => {
  const samples: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["text", utf8.encode("hello world\n")],
    ["no trailing newline", utf8.encode("export const x = 1;")],
    ["unicode", utf8.encode("Grüße, 世界 — 🚢\n")],
    ["binary with NUL", new Uint8Array([0, 1, 2, 255, 0, 10, 13, 0])],
    ["large", utf8.encode("line\n".repeat(50_000))],
  ];
  for (const [label, bytes] of samples) {
    it(`hashObject matches git hash-object (${label})`, async () => {
      expect(await hashObject("blob", bytes)).toBe(gitBlob(bytes));
    });
  }

  it("frames objects as '<type> <len>\\0<body>'", async () => {
    const framed = frameObject("blob", utf8.encode("abc"));
    expect(utf8.decode(framed)).toBe("blob 3\0abc");
    expect(await sha1Hex(framed)).toBe(await hashObject("blob", utf8.encode("abc")));
  });
});

describe("trees", () => {
  it("empty tree id", async () => {
    expect(await hashObject("tree", encodeTree([]))).toBe(EMPTY_TREE_SHA);
    expect(git(["mktree"], { cwd: repo, input: "" })).toBe(EMPTY_TREE_SHA);
  });

  it("encodeTree matches git mktree, including git's directory sort order", async () => {
    const blob = gitBlob("x\n");
    const blob2 = gitBlob("y\n");
    const sub = git(["mktree"], { cwd: repo, input: `100644 blob ${blob}\tinner.txt\n` });
    const gitlink = "1234567890abcdef1234567890abcdef12345678";
    // Names chosen so that git's "directories sort as name/" rule matters:
    // "a" (dir) sorts after "a-b", "a.b" and before "a0"; "foo" (file) sorts before "foo.c".
    const entries: TreeEntry[] = [
      { name: "a0", mode: "100644", hash: blob, type: "blob" },
      { name: "a", mode: "40000", hash: sub, type: "tree" },
      { name: "a.b", mode: "100644", hash: blob, type: "blob" },
      { name: "a-b", mode: "100644", hash: blob2, type: "blob" },
      { name: "foo.c", mode: "100644", hash: blob, type: "blob" },
      { name: "foo", mode: "100644", hash: blob2, type: "blob" },
      { name: "run.sh", mode: "100755", hash: blob, type: "exec" },
      { name: "link", mode: "120000", hash: blob2, type: "symlink" },
      { name: "vendor", mode: "160000", hash: gitlink, type: "gitlink" },
      { name: "ä-unicode.txt", mode: "100644", hash: blob, type: "blob" },
      { name: "Z-upper", mode: "100644", hash: blob, type: "blob" },
    ];
    const typeOf = (e: TreeEntry) => (e.type === "tree" ? "tree" : e.type === "gitlink" ? "commit" : "blob");
    const mktreeInput = entries.map((e) => `${e.mode.padStart(6, "0")} ${typeOf(e)} ${e.hash}\t${e.name}\n`).join("");
    const expected = git(["mktree", "--missing"], { cwd: repo, input: mktreeInput });

    const body = encodeTree(entries);
    expect(await hashObject("tree", body)).toBe(expected);
    // Byte-identical to git's own object.
    expect(Buffer.from(body).equals(gitRaw(["cat-file", "tree", expected], { cwd: repo }))).toBe(true);

    // decodeTree on git's bytes: canonical modes, derived types, git order.
    const decoded = decodeTree(gitRaw(["cat-file", "tree", expected], { cwd: repo }));
    expect(decoded.map((e) => e.name)).toEqual(["Z-upper", "a-b", "a.b", "a", "a0", "foo", "foo.c", "link", "run.sh", "vendor", "ä-unicode.txt"]);
    const byName = new Map(decoded.map((e) => [e.name, e]));
    expect(byName.get("a")).toEqual({ name: "a", mode: "40000", hash: sub, type: "tree" });
    expect(byName.get("run.sh")?.type).toBe("exec");
    expect(byName.get("link")?.type).toBe("symlink");
    expect(byName.get("vendor")).toEqual({ name: "vendor", mode: "160000", hash: gitlink, type: "gitlink" });
    // Re-encoding a decoded tree is lossless.
    expect(await hashObject("tree", encodeTree(decoded))).toBe(expected);
  });

  it("accepts '040000' and writes '40000'", async () => {
    const sub = git(["mktree"], { cwd: repo, input: "" });
    const a = encodeTree([{ name: "d", mode: "040000", hash: sub, type: "tree" }]);
    const b = encodeTree([{ name: "d", mode: "40000", hash: sub, type: "tree" }]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(utf8.decode(a.subarray(0, 6))).toBe("40000 ");
  });

  it("rejects duplicate and invalid names", () => {
    const h = EMPTY_TREE_SHA;
    expect(() => encodeTree([{ name: "x", mode: "100644", hash: h, type: "blob" }, { name: "x", mode: "40000", hash: h, type: "tree" }])).toThrow(/duplicate/);
    expect(() => encodeTree([{ name: "a/b", mode: "100644", hash: h, type: "blob" }])).toThrow(/invalid tree entry name/);
    expect(() => encodeTree([{ name: "x", mode: "100644", hash: "nothex", type: "blob" }])).toThrow(/invalid object id/);
  });

  it("buildTrees matches git write-tree on a real working tree (nested dirs, exec bit, symlink)", async () => {
    const work = join(tmp.path, "work");
    mkdirSync(work);
    git(["init", "-q", "-b", "main", work]);
    const files: Record<string, string> = {
      "README.md": "# demo\n",
      "src/index.js": "export default {};\n",
      "src/lib/util.js": "export const add = (a, b) => a + b;\n",
      "src/lib-extra.js": "// sorts before src/lib/ in git order\n",
      "src.txt": "file next to the src/ directory\n",
      "tests/a.test.js": "test\n",
      "bin/run": "#!/bin/sh\necho hi\n",
    };
    const snapshot: Snapshot = new Map();
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(work, path, ".."), { recursive: true });
      writeFileSync(join(work, path), content);
      snapshot.set(path, { sha: await hashObject("blob", utf8.encode(content)), mode: "100644" });
    }
    chmodSync(join(work, "bin/run"), 0o755);
    snapshot.set("bin/run", { ...snapshot.get("bin/run")!, mode: "100755" });
    symlinkSync("../README.md", join(work, "src/readme-link"));
    snapshot.set("src/readme-link", { sha: await hashObject("blob", utf8.encode("../README.md")), mode: "120000" });

    git(["add", "-A"], { cwd: work });
    const expected = git(["write-tree"], { cwd: work });
    const built = await buildTrees(snapshot);
    expect(built.root).toBe(expected);
    // Every subtree id matches too.
    for (const dir of ["src", "src/lib", "tests", "bin"]) {
      const sub = git(["rev-parse", `${expected}:${dir}`], { cwd: work });
      expect(built.trees.has(sub)).toBe(true);
    }
    expect(built.trees.size).toBe(5); // root, src, src/lib, tests, bin
  });
});

describe("commits", () => {
  const author = { name: "Kestrel Agent", email: "kestrel-7@gitring.dev", timestamp: 1_760_000_000, tzOffset: "+0000" };

  function gitCommitTree(tree: string, parents: string[], message: string, env: Record<string, string>): string {
    const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])];
    return git(args, { cwd: repo, input: message, env }); // message from stdin: stored verbatim
  }

  function identEnv(a: { name: string; email: string; timestamp: number; tzOffset: string }, c = a): Record<string, string> {
    return {
      GIT_AUTHOR_NAME: a.name,
      GIT_AUTHOR_EMAIL: a.email,
      GIT_AUTHOR_DATE: `${a.timestamp} ${a.tzOffset}`,
      GIT_COMMITTER_NAME: c.name,
      GIT_COMMITTER_EMAIL: c.email,
      GIT_COMMITTER_DATE: `${c.timestamp} ${c.tzOffset}`,
    };
  }

  it("root commit id matches git commit-tree", async () => {
    const tree = git(["mktree"], { cwd: repo, input: `100644 blob ${gitBlob("root\n")}\tREADME.md\n` });
    const message = "Initial commit\n";
    const expected = gitCommitTree(tree, [], message, identEnv(author));
    const body = encodeCommit({ tree, parents: [], author, committer: author, message });
    expect(await hashObject("commit", body)).toBe(expected);
    expect(Buffer.from(body).equals(gitRaw(["cat-file", "commit", expected], { cwd: repo }))).toBe(true);
  });

  it("commit with parents, different committer and a negative tz matches git", async () => {
    const tree = git(["mktree"], { cwd: repo, input: `100644 blob ${gitBlob("two\n")}\tfile.txt\n` });
    const p1 = gitCommitTree(tree, [], "p1\n", identEnv(author));
    const p2 = gitCommitTree(tree, [], "p2\n", identEnv(author));
    const committer = { name: "gitring", email: "harbor@gitring.dev", timestamp: 1_760_000_123, tzOffset: "-0700" };
    const message = "Land intent: dark mode\n\nBody line 1\nBody line 2\n\nGitring-Intent: int_1\n";
    const expected = gitCommitTree(tree, [p1, p2], message, identEnv(author, committer));
    const body = encodeCommit({ tree, parents: [p1, p2], author, committer, message });
    expect(await hashObject("commit", body)).toBe(expected);

    const meta = decodeCommit(expected, gitRaw(["cat-file", "commit", expected], { cwd: repo }));
    expect(meta).toEqual({
      hash: expected,
      treeHash: tree,
      message: "Land intent: dark mode\n\nBody line 1\nBody line 2\n\nGitring-Intent: int_1",
      author: { name: author.name, email: author.email },
      committer: { name: committer.name, email: committer.email },
      parents: [p1, p2],
      authoredAt: author.timestamp,
      committedAt: committer.timestamp,
    });
  });

  it("sanitizes identities like git does", async () => {
    const tree = EMPTY_TREE_SHA;
    const odd = { name: "  'Odd <Name>'  ", email: " <odd@x.dev> ", timestamp: 1_700_000_000, tzOffset: "+0530" };
    const expected = gitCommitTree(tree, [], "odd\n", identEnv(odd));
    expect(await hashObject("commit", encodeCommit({ tree, parents: [], author: odd, committer: odd, message: "odd\n" }))).toBe(expected);
  });

  it("decodeCommit removes exactly one trailing newline and skips extra headers", () => {
    const raw = utf8.encode(
      `tree ${EMPTY_TREE_SHA}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 2 -0100\nencoding ISO-8859-1\ngpgsig -----BEGIN PGP SIGNATURE-----\n abc\n -----END PGP SIGNATURE-----\n\nmsg\n\n`,
    );
    const meta = decodeCommit("f".repeat(40), raw);
    expect(meta.message).toBe("msg\n");
    expect(meta.parents).toEqual([]);
    expect(meta.authoredAt).toBe(1);
    expect(meta.committedAt).toBe(2);
    expect(meta.committer).toEqual({ name: "C", email: "c@x" });
  });

  it("normalizeCommitMessage adds the newline git -m adds", () => {
    expect(normalizeCommitMessage("x")).toBe("x\n");
    expect(normalizeCommitMessage("x\n")).toBe("x\n");
  });
});

describe("modes and refs", () => {
  it("modeToType", () => {
    expect(modeToType("40000")).toBe("tree");
    expect(modeToType("040000")).toBe("tree");
    expect(modeToType("100644")).toBe("blob");
    expect(modeToType("100755")).toBe("exec");
    expect(modeToType("120000")).toBe("symlink");
    expect(modeToType("160000")).toBe("gitlink");
    expect(() => modeToType("12345")).toThrow();
    expect(() => modeToType("abc")).toThrow();
  });

  it("isValidBranchName follows git check-ref-format", () => {
    for (const ok of ["main", "feature/x", "att-123_x.y", "gitring/attempt-7"]) {
      expect(isValidBranchName(ok)).toBe(true);
      expect(() => git(["check-ref-format", "--branch", ok])).not.toThrow();
    }
    for (const bad of ["", "a..b", "a b", "a~1", "a^", "a:b", "x.lock", "/x", "x/", "a//b", ".hidden", "a@{1}", "HEAD", "-x"]) {
      expect(isValidBranchName(bad)).toBe(false);
    }
  });
});
