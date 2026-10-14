/**
 * Api-mode work copies are changesets in gitring's own storage: no Artifacts fork at the plan, none at submit.
 * A fork is made only when a person or a tool asks for real git (`workCopyRemote`).
 */
import { describe, expect, it } from "vitest";
import { CrashWorld } from "./crash-world";

const TEST_FILE = { path: "tests/a.test.js", text: 'import { test, expect } from "../harness/test.js";\ntest("a", () => expect(1).toBe(1));\n' };

async function declareApi(w: CrashWorld) {
  return w.harbor.declare({
    agent: { client: "test" },
    newIntent: { title: "Add b", goal: "Add b." },
    plan: ["Write b"],
    files: ["src/b.js"],
    symbols: [],
    approach: "Write b.",
    mode: "api",
  });
}

describe("lazy work copy forks", () => {
  it("makes no fork at the plan or at submit, and makes one on demand with the work in it", async () => {
    const w = new CrashWorld();
    await w.start({ files: [{ path: "src/a.js", text: "export const a = 1;\n" }, TEST_FILE], settings: { landing: "manual" } });
    const forks: string[] = [];
    const real = w.repo.fork.bind(w.repo);
    w.repo.fork = async (...args: Parameters<typeof real>) => {
      forks.push(args[1]);
      return real(...args);
    };
    const d = await declareApi(w);
    const fork = w.inner.attempts.get(d.attemptId)!.fork.repo;
    expect(d.workspace.mode).toBe("api");
    await w.harbor.write({ attemptId: d.attemptId, files: [{ path: "src/b.js", content: "export const b = 2;\n" }] });
    await w.harbor.submit(d.attemptId, "Add b");
    expect(forks).toEqual([]);
    await expect(w.repo.resolve(fork, "main")).rejects.toThrow(/does not exist/);

    const copy = await w.harbor.workCopyRemote(d.attemptId);
    expect(forks).toEqual([fork]);
    expect(copy.repo).toBe(fork);
    expect(copy.headSha).toBeTruthy();
    expect(await w.repo.resolve(fork, "main")).toBe(copy.headSha);
  });

  it("keeps a merge that main got after the base: the fork commit carries only the work of the agent", async () => {
    const w = new CrashWorld();
    await w.start({ files: [{ path: "src/a.js", text: "export const a = 1;\n" }, TEST_FILE], settings: { landing: "manual" } });
    const d = await declareApi(w);
    await w.harbor.write({ attemptId: d.attemptId, files: [{ path: "src/b.js", content: "export const b = 2;\n" }] });
    // Main moves after the base of the work (an outside commit), before the fork exists.
    const repo = (w.inner as unknown as { requireProject(): { repo: { name: string } } }).requireProject().repo.name;
    const tip = (await w.repo.resolve(repo, "main"))!;
    const other = await w.repo.commit({ repo, branch: "main", parent: tip, changes: [{ path: "src/c.js", content: "export const c = 3;\n" }], message: "Add c", author: { name: "Robin", email: "robin@example.invalid" } });
    const copy = await w.harbor.workCopyRemote(d.attemptId);
    const head = (await w.repo.readCommit(copy.repo, copy.headSha!))!;
    const files = async (tree: string) => (await w.repo.readTree(copy.repo, tree))!;
    const src = (await files(head.treeHash)).find((e) => e.name === "src")!;
    const names = (await files(src.hash)).map((e) => e.name).sort();
    expect(head.parents[0]).toBe(other.sha);
    expect(names).toEqual(["a.js", "b.js", "c.js"]);
  });
});
