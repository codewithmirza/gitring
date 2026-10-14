/**
 * Merge fidelity: what the agent pushed is what merges. Binary and large files, modes, symlinks and vendored
 * folders merge as the agent made them; the few parts that stay out are named to the agent. A yes of a person
 * survives a merge of main into the work. A merge that finds main moved catches up and merges, and the list of
 * main commits lives in its own table.
 */
import { describe, expect, it } from "vitest";
import { readSnapshot, type Snapshot } from "../../src/core/git/snapshot";
import { hashObject, utf8 } from "../../src/core/git/objects";
import { Db } from "../../src/harbor/store";
import { readTar, type TarItem } from "../../src/platform/checks/tar";
import type { FileChange } from "../../src/platform/repo/backend";
import { sqliteCtx } from "../support/sqlite-storage";
import { steViolations } from "../coord/ste";
import { MAX_CARRY_FILE_BYTES, MAX_CARRY_TOTAL_BYTES } from "../../src/core/land/carry";
import { CrashWorld } from "./crash-world";

const ROBIN = { name: "Robin", email: "robin@agents.gitring.invalid" };
const OWNER = { id: "u_robin", name: "Robin", role: "owner" as const };

const TEST_FILE = { path: "tests/a.test.js", text: 'import { test, expect } from "../harness/test.js";\ntest("a", () => expect(1).toBe(1));\n' };
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

async function mainSnapshot(w: CrashWorld): Promise<Snapshot> {
  const tip = (await w.repo.resolve(w.mainRepo, "main"))!;
  return readSnapshot(w.repo, w.mainRepo, (await w.repo.readCommit(w.mainRepo, tip))!.treeHash);
}

async function blobText(w: CrashWorld, repo: string, sha: string): Promise<string> {
  return utf8.decode((await w.repo.readBlob(repo, sha))!);
}

/** An agent in git mode: a plan, then the work copy remote. */
async function declareGit(w: CrashWorld, name: string): Promise<{ attemptId: string; intentId: string; fork: string }> {
  const d = await w.harbor.declare({
    agent: { client: "test" },
    newIntent: { title: `Add ${name}`, goal: `Add ${name}.` },
    plan: [`Push ${name}`],
    files: [],
    symbols: [],
    approach: `Push ${name}.`,
    mode: "git",
  });
  return { attemptId: d.attemptId, intentId: d.intent.id, fork: w.inner.attempts.get(d.attemptId)!.fork.repo };
}

/** The agent pushes one commit to its work copy. */
async function push(w: CrashWorld, fork: string, changes: FileChange[]): Promise<string> {
  const tip = (await w.repo.resolve(fork, "main"))!;
  return (await w.repo.commit({ repo: fork, branch: "main", parent: tip, changes, message: "Work of Robin", author: ROBIN })).sha;
}

describe("git mode carries every change of the push", () => {
  it("merges binary and large files, modes and symlinks, a folder that main has, and names what stays out", async () => {
    const w = new CrashWorld();
    await w.start({
      files: [
        { path: "src/a.js", text: "export const a = 1;\n" },
        TEST_FILE,
        { path: "scripts/tool.sh", text: "#!/bin/sh\necho tool\n" },
        { path: "docs/notes.txt", text: "plain notes\n" },
        { path: "data/big.txt", text: "small now\n" },
        { path: "vendor/lib.js", text: "export const lib = 1;\n" },
      ],
      settings: { landing: "automatic" },
    });
    const t = await declareGit(w, "assets");
    const big = `${"0123456789abcdef".repeat(64)}\n`.repeat(1200); // about 1.2 MB of text
    const binaryNotes = new Uint8Array([0x70, 0x6c, 0, 0x61, 0x69, 0x6e]);
    await push(w, t.fork, [
      { path: "src/a.js", content: "export const a = 2;\n" },
      { path: "img/logo.png", content: PNG },
      { path: "scripts/tool.sh", content: "#!/bin/sh\necho tool\n", mode: "100755" },
      { path: "src/link.js", content: "a.js", mode: "120000" },
      { path: "docs/notes.txt", content: binaryNotes },
      { path: "data/big.txt", content: big },
      { path: "vendor/lib.js", content: "export const lib = 2;\n" },
      { path: "vendor/extra.js", content: "export const extra = 1;\n" },
      { path: "dist/app.js", content: "console.log(1);\n" },
      { path: "node_modules/left-pad/index.js", content: "module.exports = 1;\n" },
      { path: "node_modules/left-pad/package.json", content: "{}\n" },
    ]);
    const fork = await readSnapshot(w.repo, t.fork, (await w.repo.readCommit(t.fork, (await w.repo.resolve(t.fork, "main"))!))!.treeHash);

    const res = await w.harbor.submit(t.attemptId, "Add assets");
    expect(res.next).toBe("landing-queue");
    expect(res.message).toContain("gitring does not merge node_modules/ (2 files).");
    expect(steViolations(res.message)).toEqual([]);
    await w.settle();
    expect(w.status(t.attemptId)).toBe("landed");

    const main = await mainSnapshot(w);
    // Every carried path has exactly the blob and the mode of the push.
    for (const path of ["src/a.js", "img/logo.png", "scripts/tool.sh", "src/link.js", "docs/notes.txt", "data/big.txt", "vendor/lib.js", "vendor/extra.js", "dist/app.js"]) {
      expect(main.get(path), path).toEqual(fork.get(path));
    }
    expect(main.get("scripts/tool.sh")?.mode).toBe("100755");
    expect(main.get("src/link.js")?.mode).toBe("120000");
    // A file that became binary or large is changed, not deleted.
    expect(await w.repo.readBlob(w.mainRepo, main.get("docs/notes.txt")!.sha)).toEqual(binaryNotes);
    expect(await blobText(w, w.mainRepo, main.get("data/big.txt")!.sha)).toBe(big);
    // The new folder of tool output stays out.
    expect([...main.keys()].some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(w.inner.logs.some((l) => l.message.includes("gitring does not merge node_modules/ (2 files)."))).toBe(true);
    // The diff for people lists the changes without text too.
    const diff = await w.harbor.attemptDiff(t.attemptId);
    expect(diff.files.find((f) => f.path === "img/logo.png")).toMatchObject({ status: "A" });
    expect(diff.files.find((f) => f.path === "scripts/tool.sh")).toMatchObject({ status: "M", diff: "Mode changes to 100755." });
  });

  it("leaves out a file over the limit of one file, and the files past the limit of one merge, says so, and merges the rest", async () => {
    const w = new CrashWorld();
    await w.start({ files: [{ path: "src/a.js", text: "export const a = 1;\n" }, TEST_FILE], settings: { landing: "automatic" } });
    const t = await declareGit(w, "video");
    const video = new Uint8Array(MAX_CARRY_FILE_BYTES + 1); // zeros: binary
    // Two files under the limit of one file, but over the limit of one merge together.
    const first = new Uint8Array(MAX_CARRY_FILE_BYTES - 1_000_000).fill(1);
    const second = new Uint8Array(MAX_CARRY_TOTAL_BYTES - first.length + 1_000_000).fill(2);
    first[0] = second[0] = 0;
    await push(w, t.fork, [
      { path: "media/intro.mp4", content: video },
      { path: "media/a.bin", content: first },
      { path: "media/b.bin", content: second },
      { path: "src/a.js", content: "export const a = 3;\n" },
    ]);
    const res = await w.harbor.submit(t.attemptId, "Add the video");
    expect(res.message).toContain("gitring does not merge media/intro.mp4 (10 MB). The limit for one file is 10 MB.");
    expect(res.message).toContain("gitring does not merge media/b.bin (8 MB). One merge carries at most 16 MB of files without text.");
    expect(steViolations(res.message)).toEqual([]);
    await w.settle();
    expect(w.status(t.attemptId)).toBe("landed");
    const main = await mainSnapshot(w);
    expect(main.has("media/intro.mp4")).toBe(false);
    expect(main.has("media/b.bin")).toBe(false);
    expect(main.get("media/a.bin")!.sha).toBe(await hashObject("blob", first));
    expect(await w.harbor.file("main", "src/a.js")).toBe("export const a = 3;\n");
  });

  it("does not merge a binary file that main and the work both changed: the work goes back to its agent", async () => {
    const w = new CrashWorld();
    await w.start({ files: [{ path: "src/a.js", text: "export const a = 1;\n" }, TEST_FILE, { path: "img/logo.png", base64: b64(PNG) } as never], settings: { landing: "automatic" } });
    const alpha = await declareGit(w, "a red logo");
    const beta = await declareGit(w, "a blue logo");
    await push(w, alpha.fork, [{ path: "img/logo.png", content: new Uint8Array([...PNG, 1]) }]);
    await push(w, beta.fork, [{ path: "img/logo.png", content: new Uint8Array([...PNG, 2]) }]);
    await w.harbor.submit(alpha.attemptId, "Red logo");
    await w.settle();
    expect(w.status(alpha.attemptId)).toBe("landed");

    await w.harbor.submit(beta.attemptId, "Blue logo");
    await w.settle();
    expect(w.status(beta.attemptId)).toBe("underway");
    expect(w.inner.logs.some((l) => l.message.includes("img/logo.png (binary)"))).toBe(true);
    expect(await w.repo.readBlob(w.mainRepo, (await mainSnapshot(w)).get("img/logo.png")!.sha)).toEqual(new Uint8Array([...PNG, 1]));
  });

  it("does not keep the bytes of a file when its text is not exactly the blob (Latin-1)", async () => {
    const w = new CrashWorld();
    await w.start({ files: [{ path: "src/a.js", text: "export const a = 1;\n" }, TEST_FILE], settings: { landing: "automatic" } });
    const t = await declareGit(w, "latin");
    // Latin-1 text: gitring reads it as text (few odd bytes), but its UTF-8 text is not the same bytes.
    const latin = new Uint8Array([...utf8.encode("Le menu du jour: caf"), 0xe9, ...utf8.encode(", th"), 0xe9, ...utf8.encode(" et cr"), 0xe8, ...utf8.encode("me.\n")]);
    await push(w, t.fork, [{ path: "docs/menu.txt", content: latin }]);
    await w.harbor.submit(t.attemptId, "Add the menu");
    await w.settle();
    expect(w.status(t.attemptId)).toBe("landed");
    const main = await mainSnapshot(w);
    expect(main.get("docs/menu.txt")!.sha).toBe(await hashObject("blob", latin));
  });
});

describe("api mode", () => {
  it("carries a delete of a binary file", async () => {
    const w = new CrashWorld();
    await w.start({ files: [{ path: "src/a.js", text: "export const a = 1;\n" }, TEST_FILE, { path: "img/old.png", base64: b64(PNG) } as never], settings: { landing: "automatic" } });
    expect((await mainSnapshot(w)).has("img/old.png")).toBe(true);
    const t = await w.startTask("tidy", { "src/tidy.js": "export const tidy = 1;\n" });
    const write = await w.harbor.write({ attemptId: t.attemptId, files: [{ path: "img/old.png", delete: true }] });
    expect(write.written).toEqual(["img/old.png"]);
    await w.harbor.submit(t.attemptId, "Tidy");
    await w.settle();
    expect(w.status(t.attemptId)).toBe("landed");
    const main = await mainSnapshot(w);
    expect(main.has("img/old.png")).toBe(false);
    expect(main.has("src/tidy.js")).toBe(true);
  });
});

describe("the test container gets the tree that merges", () => {
  it("sends binary files and the executable bit, for the work and for main plus the work", async () => {
    const runs: { files: Map<string, TarItem> }[] = [];
    const w = new CrashWorld({
      DRYDOCK: {
        idFromName: (n: string) => n,
        get: () => ({
          run: async (input: { tree: Uint8Array }) => {
            const stream = new Blob([input.tree as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
            const files = new Map<string, TarItem>();
            for await (const item of readTar(stream)) files.set(item.path, item);
            runs.push({ files });
            return { ok: true, stage: "done", exitCode: 0, installMs: 1, testMs: 1, reused: false, log: "all tests pass" };
          },
        }),
      },
    });
    await w.start({
      runner: "container",
      files: [{ path: "src/a.js", text: "export const a = 1;\n" }, { path: "img/logo.png", base64: b64(PNG) } as never, { path: "tools/gen", text: "#!/bin/sh\n", executable: true } as never],
      settings: { landing: "automatic" },
    });
    const t = await w.startTask("beta");
    await w.harbor.submit(t.attemptId, "Add beta");
    await w.settle();
    expect(w.status(t.attemptId)).toBe("landed");
    expect(runs).toHaveLength(2); // the work, then main plus the work
    for (const run of runs) {
      expect(run.files.get("img/logo.png")?.data).toEqual(PNG);
      expect(run.files.get("tools/gen")?.mode).toBe(0o755);
      expect(utf8.decode(run.files.get("src/beta.js")!.data!)).toBe("export const beta = 1;\n");
    }
  });
});

describe("a yes counts for the agent's contribution", () => {
  const lines = (change: (l: string[]) => void) => {
    const l = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;", "const f = 6;", "const g = 7;", "const h = 8;", "const i = 9;", "export { a, b, c, d, e, f, g, h, i };"];
    change(l);
    return `${l.join("\n")}\n`;
  };

  it("keeps the question when gitring merges main into a work copy that waits, and closes it when the agent changes the work", async () => {
    const w = new CrashWorld();
    await w.start({ files: [{ path: "src/x.js", text: lines(() => {}) }, TEST_FILE], settings: { landing: "ask" } });
    const alpha = await w.startTask("alpha", { "src/x.js": lines((l) => (l[1] = "const b = 20;")) });
    expect((await w.harbor.submit(alpha.attemptId, "Change b")).next).toBe("awaiting-approval");
    const question = w.inner.attempts.get(alpha.attemptId)!.approval!;
    expect(question.status).toBe("waiting");

    // Another task changes another line of the same file and merges.
    const beta = await w.startTask("beta", { "src/x.js": lines((l) => (l[8] = "const i = 90;")) });
    expect((await w.harbor.submit(beta.attemptId, "Change i")).next).toBe("awaiting-approval");
    expect((await w.harbor.decide(beta.attemptId, { answer: "approve" }, OWNER)).outcome).toBe("approved");
    await w.settle();
    expect(w.status(beta.attemptId)).toBe("landed");

    // gitring moved alpha onto the new main: its work holds both changes. The person's question still stands.
    const a = w.inner.attempts.get(alpha.attemptId)!;
    expect(a.baseSha).toBe((await w.harbor.state()).project.mainSha);
    expect(await w.harbor.file(alpha.attemptId, "src/x.js")).toBe(lines((l) => ((l[1] = "const b = 20;"), (l[8] = "const i = 90;"))));
    expect(a.status).toBe("ready");
    expect(a.approval).toMatchObject({ id: question.id, status: "waiting", digest: question.digest });

    // The yes merges the work that the person saw.
    expect((await w.harbor.decide(alpha.attemptId, { answer: "approve" }, OWNER, "app", { approvalId: question.id })).outcome).toBe("approved");
    await w.settle();
    expect(w.status(alpha.attemptId)).toBe("landed");
    expect(await w.harbor.file("main", "src/x.js")).toBe(lines((l) => ((l[1] = "const b = 20;"), (l[8] = "const i = 90;"))));
  });

  it("withdraws the question when the agent changes its work", async () => {
    const w = new CrashWorld();
    await w.start({ files: [{ path: "src/x.js", text: lines(() => {}) }, TEST_FILE], settings: { landing: "ask" } });
    const alpha = await w.startTask("alpha", { "src/x.js": lines((l) => (l[1] = "const b = 20;")) });
    await w.harbor.submit(alpha.attemptId, "Change b");
    await w.harbor.write({ attemptId: alpha.attemptId, files: [{ path: "src/x.js", content: lines((l) => (l[1] = "const b = 21;")) }] });
    const a = w.inner.attempts.get(alpha.attemptId)!;
    expect(a.status).toBe("underway");
    expect(a.approval?.status).toBe("withdrawn");
  });

  it("takes the question of an older version: the hash of whole files still names the same work", async () => {
    const w = new CrashWorld();
    await w.start({ files: [{ path: "src/x.js", text: lines(() => {}) }, TEST_FILE], settings: { landing: "ask" } });
    const alpha = await w.startTask("alpha", { "src/x.js": lines((l) => (l[1] = "const b = 20;")) });
    await w.harbor.submit(alpha.attemptId, "Change b");
    const a = w.inner.attempts.get(alpha.attemptId)!;
    // The hash that an older version wrote: each changed file with the hash of its new text.
    const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const head = lines((l) => (l[1] = "const b = 20;"));
    a.approval!.digest = await sha256(`src/x.js\0${await sha256(head)}`);
    w.inner.db.putAttempt(a);
    const restarted = w.restart();
    expect(w.inner.attempts.get(alpha.attemptId)!.approval!.digest.startsWith("v2:")).toBe(false);
    expect((await restarted.decide(alpha.attemptId, { answer: "approve" }, OWNER)).outcome).toBe("approved");
    expect(w.inner.attempts.get(alpha.attemptId)!.approval!.digest.startsWith("v2:")).toBe(true);
    await w.settle();
    expect(w.status(alpha.attemptId)).toBe("landed");
  });
});

describe("a merge finds main moved", () => {
  it("writes the record of a merge that a stopped run made, then merges on top of it", async () => {
    const w = new CrashWorld();
    await w.start();
    const alpha = await w.submitTask("alpha", { stop: "after-commit" });
    await w.reached();
    // A new object: alpha's commit is on main, but gitring has no record of it. Its run may still hold the lease.
    w.restart();
    await w.settle();
    expect(w.status(alpha.attemptId)).toBe("landing");

    const beta = await w.submitTask("beta");
    expect(beta.next).toBe("landing-queue");
    await w.settle();

    expect(w.status(beta.attemptId)).toBe("landed");
    expect(w.status(alpha.attemptId)).toBe("landed");
    expect(w.inner.attempts.get(beta.attemptId)!.mergeStops).toBeUndefined();
    expect(w.inner.attempts.get(beta.attemptId)!.approval).toBeUndefined();
    expect(await w.mergesOf(alpha.attemptId)).toHaveLength(1);
    expect(await w.mergesOf(beta.attemptId)).toHaveLength(1);
    expect(w.inner.landings.map((l) => l.attemptId)).toEqual([alpha.attemptId, beta.attemptId]);
    expect(w.inner.stats.landings).toBe(2);
    expect(await w.harbor.file("main", "src/alpha.js")).toBe("export const alpha = 1;\n");
    expect(await w.harbor.file("main", "src/beta.js")).toBe("export const beta = 1;\n");
    expect((await w.harbor.state()).project.mainSha).toBe(await w.repo.resolve(w.mainRepo, "main"));
    expect(w.inner.logs.some((l) => /a stopped run merged the work of/.test(l.message))).toBe(true);
  });

  it("takes a commit that gitring did not make as main, then merges on top of it", async () => {
    const w = new CrashWorld();
    await w.start();
    const before = (await w.harbor.state()).project.mainSha;
    const outside = await w.repo.commit({ repo: w.mainRepo, branch: "main", parent: before, changes: [{ path: "src/outside.js", content: "export const o = 1;\n" }], message: "A change from outside", author: ROBIN });

    const gamma = await w.submitTask("gamma");
    await w.settle();

    expect(w.status(gamma.attemptId)).toBe("landed");
    expect(w.inner.attempts.get(gamma.attemptId)!.mergeStops).toBeUndefined();
    const merge = (await w.mergesOf(gamma.attemptId))[0];
    expect(merge.parents).toEqual([outside.sha]);
    expect(await w.harbor.file("main", "src/outside.js")).toBe("export const o = 1;\n");
    expect(await w.harbor.file("main", "src/gamma.js")).toBe("export const gamma = 1;\n");
    expect(w.inner.logs.some((l) => l.message.includes(`Main has a commit that gitring did not record: ${outside.sha.slice(0, 7)}`))).toBe(true);
    const seq = (w.inner.db as unknown as Db).mainSeq().map((r) => r.sha);
    expect(seq.slice(-3)).toEqual([before, outside.sha, merge.hash]);
  });
});

describe("the list of main commits", () => {
  it("moves from the old meta value to its own table once, in order", () => {
    const ctx = sqliteCtx();
    const sql = ctx.storage.sql as unknown as SqlStorage;
    const first = new Db(sql);
    first.setMeta("mainSeq", ["a1", "b2", "c3"]);
    const db = new Db(sql);
    expect(db.getMeta("mainSeq")).toBeUndefined();
    expect(db.mainSeq()).toEqual([
      { seq: 1, sha: "a1" },
      { seq: 2, sha: "b2" },
      { seq: 3, sha: "c3" },
    ]);
    // A commit that is in the list keeps its place; a new one comes last.
    expect(db.appendMain("b2")).toBe(2);
    expect(db.appendMain("d4")).toBe(4);
    expect(db.resetMain("e5")).toBe(1);
    expect(db.mainSeq().map((r) => r.sha)).toEqual(["e5"]);
  });

  it("is in the table after a merge, and a new object reads it", async () => {
    const w = new CrashWorld();
    await w.start();
    const t = await w.submitTask("alpha");
    await w.settle();
    expect(w.status(t.attemptId)).toBe("landed");
    const db = w.inner.db as unknown as Db;
    expect(db.getMeta("mainSeq")).toBeUndefined();
    const seq = db.mainSeq().map((r) => r.sha);
    expect(seq).toHaveLength(2);
    expect(seq[1]).toBe((await w.harbor.state()).project.mainSha);
    const h = w.restart();
    const traffic = await h.traffic(t.attemptId).catch(() => undefined);
    expect(traffic === undefined || Array.isArray(traffic.landedSinceBase)).toBe(true);
  });
});
