/**
 * A fork that was made at the plan (before the lazy fork), at an old base. The work was then planned again onto a
 * newer main. The commit that flushes the work must carry the merges that main got since that old base.
 */
import { describe, expect, it } from "vitest";
import { CrashWorld } from "./crash-world";

const TEST_FILE = { path: "tests/a.test.js", text: 'import { test, expect } from "../harness/test.js";\ntest("a", () => expect(1).toBe(1));\n' };

describe("a fork made before the lazy fork", () => {
  it("gets the merges that main got since its old base, once the work was planned again onto the new main", async () => {
    const w = new CrashWorld();
    await w.start({ files: [{ path: "src/a.js", text: "export const a = 1;\n" }, TEST_FILE], settings: { landing: "manual" } });
    const d = await w.harbor.declare({
      agent: { client: "test" },
      newIntent: { title: "Add b", goal: "Add b." },
      plan: ["Write b"],
      files: ["src/b.js"],
      symbols: [],
      approach: "Write b.",
      mode: "api",
    });
    const attempt = w.inner.attempts.get(d.attemptId)!;
    // The old way: the fork exists at the plan, from the old main, with no work in it.
    const first = await w.harbor.workCopyRemote(d.attemptId);
    expect(first.headSha).toBeUndefined();
    const repo = (w.inner as unknown as { requireProject(): { repo: { name: string } } }).requireProject().repo.name;
    const oldTip = (await w.repo.resolve(repo, "main"))!;
    const other = await w.repo.commit({
      repo,
      branch: "main",
      parent: oldTip,
      changes: [
        { path: "src/c.js", content: "export const c = 3;\n" },
        { path: "src/a.js", content: "export const a = 5;\n" },
      ],
      message: "Add c",
      author: { name: "Robin", email: "robin@example.invalid" },
    });
    // The work is planned again onto the new main.
    attempt.baseSha = other.sha;
    attempt.baseTree = (await w.repo.readCommit(repo, other.sha))!.treeHash;
    await w.harbor.write({ attemptId: d.attemptId, files: [{ path: "src/b.js", content: "export const b = 2;\n" }] });
    const copy = await w.harbor.workCopyRemote(d.attemptId);
    const head = (await w.repo.readCommit(copy.repo, copy.headSha!))!;
    expect(head.parents[0]).toBe(oldTip);
    const src = (await w.repo.readTree(copy.repo, head.treeHash))!.find((e) => e.name === "src")!;
    const entries = (await w.repo.readTree(copy.repo, src.hash))!;
    expect(entries.map((e) => e.name).sort()).toEqual(["a.js", "b.js", "c.js"]);
    const a = entries.find((e) => e.name === "a.js")!;
    expect(new TextDecoder().decode((await w.repo.readBlob(copy.repo, a.hash))!)).toBe("export const a = 5;\n");
  });
});
