/**
 * Bring GitHub changes into gitring: compare since…head on GitHub, merge per file with main, and send the
 * merge back to GitHub as a merge commit (so the default branch can fast-forward).
 */
import { describe, expect, it } from "vitest";
import { upstreamChanges } from "../../src/platform/github/upstream";
import { syncToGithub } from "../../src/platform/github/sync";
import { readSnapshot } from "../../src/core/git/snapshot";
import type { RepoBackend } from "../../src/platform/repo/backend";
import { author, backendOf, FakeGithub, filesOf } from "./fake";

const PRICE = "export function price(cents) {\n  return cents / 100;\n}\n\nexport const currency = 'EUR';\n";

/** A project imported from GitHub (same commit ids), then one merge in gitring. */
async function setup() {
  const b = backendOf();
  await b.ensureRepo("shop");
  const c0 = await b.commit({
    repo: "shop",
    branch: "main",
    parent: "",
    message: "Import",
    author,
    changes: [
      { path: "README.md", content: "# Shop\n" },
      { path: "src/price.js", content: PRICE },
      { path: "src/cart.js", content: "export const cart = [];\n" },
    ],
  });
  const gh = new FakeGithub();
  await gh.adopt(b, "shop", c0.sha);
  gh.refs.set("heads/main", c0.sha);
  const c1 = await b.commit({ repo: "shop", branch: "main", parent: c0.sha, message: "Add search", author, changes: [{ path: "src/search.js", content: "export const search = () => [];\n" }] });
  return { b, gh, c0, c1 };
}

async function run(b: RepoBackend, gh: FakeGithub, mainSha: string, since: string, resolved?: Record<string, string | null>) {
  const tree = (await b.readCommit("shop", mainSha))!.treeHash;
  return upstreamChanges({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch, backend: b, source: "shop", main: await readSnapshot(b, "shop", tree), since, resolved });
}

describe("upstreamChanges", () => {
  it("says up to date when GitHub has nothing new", async () => {
    const { b, gh, c0, c1 } = await setup();
    const res = await run(b, gh, c1.sha, c0.sha);
    expect(res.state).toBe("up-to-date");
  });

  it("takes GitHub's version of files that only GitHub changed, and keeps gitring's work", async () => {
    const { b, gh, c0, c1 } = await setup();
    const head = gh.push({ "README.md": "# Shop\n\nNow with docs.\n", "src/cart.js": null }, "Docs and cleanup");
    const res = await run(b, gh, c1.sha, c0.sha);
    expect(res.state).toBe("changes");
    if (res.state !== "changes") return;
    expect(res.head).toBe(head);
    expect(res.base).toBe(c0.sha);
    expect(res.commits).toBe(1);
    expect(res.authors).toEqual(["Pat"]);
    const byPath = Object.fromEntries(res.changes.map((c) => [c.path, c.content === null ? null : new TextDecoder().decode(c.content as Uint8Array)]));
    expect(byPath).toEqual({ "README.md": "# Shop\n\nNow with docs.\n", "src/cart.js": null });
  });

  it("merges changes to different lines of the same file", async () => {
    const { b, gh, c0, c1 } = await setup();
    const ours = await b.commit({ repo: "shop", branch: "main", parent: c1.sha, message: "Round prices", author, changes: [{ path: "src/price.js", content: PRICE.replace("return cents / 100;", "return Math.round(cents) / 100;") }] });
    gh.push({ "src/price.js": PRICE.replace("'EUR'", "'USD'") });
    const res = await run(b, gh, ours.sha, c0.sha);
    expect(res.state).toBe("changes");
    if (res.state !== "changes") return;
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0].content).toBe("export function price(cents) {\n  return Math.round(cents) / 100;\n}\n\nexport const currency = 'USD';\n");
  });

  it("reports a conflict with GitHub's diff when both changed the same lines; a resolved file passes later", async () => {
    const { b, gh, c0, c1 } = await setup();
    const ours = await b.commit({ repo: "shop", branch: "main", parent: c1.sha, message: "Pounds", author, changes: [{ path: "src/price.js", content: PRICE.replace("'EUR'", "'GBP'") }] });
    gh.push({ "src/price.js": PRICE.replace("'EUR'", "'USD'"), "README.md": "# Shop!\n" });
    const res = await run(b, gh, ours.sha, c0.sha);
    expect(res.state).toBe("conflict");
    if (res.state !== "conflict") return;
    expect(res.conflicts.map((c) => c.path)).toEqual(["src/price.js"]);
    expect(res.conflicts[0].diff).toContain("-export const currency = 'EUR';");
    expect(res.conflicts[0].diff).toContain("+export const currency = 'USD';");
    expect(res.message).toMatch(/same lines/);

    // An agent merged it by hand on main (both currencies); the next pull takes the rest.
    const fixed = await b.commit({ repo: "shop", branch: "main", parent: ours.sha, message: "Merge GitHub change", author, changes: [{ path: "src/price.js", content: PRICE.replace("'EUR'", "'GBP' /* GitHub: USD */") }] });
    const again = await run(b, gh, fixed.sha, c0.sha, { "src/price.js": res.conflicts[0].theirs });
    expect(again.state).toBe("changes");
    if (again.state !== "changes") return;
    expect(again.changes.map((c) => c.path)).toEqual(["README.md"]);
  });

  it("skips files that main already has in GitHub's version", async () => {
    const { b, gh, c0, c1 } = await setup();
    gh.push({ "src/search.js": "export const search = () => [];\n" });
    const res = await run(b, gh, c1.sha, c0.sha);
    expect(res.state).toBe("changes");
    if (res.state === "changes") expect(res.changes).toEqual([]);
  });

  it("explains a force push that removed the known commit", async () => {
    const { b, gh, c1 } = await setup();
    gh.push({ "README.md": "x\n" });
    const res = await run(b, gh, c1.sha, "e".repeat(40));
    expect(res.state).toBe("error");
    if (res.state === "error") expect(res.message).toMatch(/force push/);
  });
});

describe("sync after a pull", () => {
  it("sends the pull to GitHub as a merge commit, so main mode fast-forwards", async () => {
    const { b, gh, c0, c1 } = await setup();
    // First sync: GitHub main gets gitring's merge.
    const first = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, { backend: b, source: "shop", mainSha: c1.sha, mode: "main", branch: "gitring", known: {}, pr: { title: "t", body: "b" } });
    expect(first.status.state).toBe("ok");
    // A person pushes to GitHub main; gitring merges more work meanwhile.
    const head = gh.push({ "README.md": "# Shop\n\nHotfix.\n" }, "Hotfix");
    const c2 = await b.commit({ repo: "shop", branch: "main", parent: c1.sha, message: "Dark mode", author, changes: [{ path: "src/theme.js", content: "dark\n" }] });
    const blocked = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, { backend: b, source: "shop", mainSha: c2.sha, mode: "main", branch: "gitring", known: first.known, pr: { title: "t", body: "b" } });
    expect(blocked.status.state).toBe("blocked");

    // Pull: since = what GitHub had from gitring (the last sync).
    const res = await run(b, gh, c2.sha, first.status.githubSha!);
    expect(res.state).toBe("changes");
    if (res.state !== "changes") return;
    const merged = await b.commit({ repo: "shop", branch: "main", parent: c2.sha, message: "Bring GitHub changes into main", author, changes: res.changes });
    const out = await syncToGithub(
      { repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch },
      { backend: b, source: "shop", mainSha: merged.sha, mode: "main", branch: "gitring", known: blocked.known, upstreamOf: { [merged.sha]: head }, pr: { title: "t", body: "b" } },
    );
    expect(out.status.state).toBe("ok");
    const tip = gh.refs.get("heads/main")!;
    expect(gh.commits.get(tip)!.parents).toEqual([out.known[c2.sha], head]);
    expect(gh.filesAt(tip)).toEqual(await filesOf(b, "shop", merged.sha));
    expect(gh.filesAt(tip)["README.md"]).toBe("# Shop\n\nHotfix.\n");
    expect(gh.isAncestor(c0.sha, tip)).toBe(true);
  });
});

describe("upstreamChanges: edges", () => {
  it("carries submodule pointers into the merge commit on GitHub", async () => {
    const { b, gh, c0, c1 } = await setup();
    // GitHub bumps a submodule (a gitlink entry) and changes the README.
    const parent = gh.refs.get("heads/main")!;
    const tree = new Map(gh.trees.get(gh.commits.get(parent)!.tree)!);
    tree.set("lib/vendor", { mode: "160000", sha: "5".repeat(40) });
    const treeSha = "7".repeat(40);
    gh.trees.set(treeSha, tree);
    gh.commits.set("8".repeat(40), { tree: treeSha, parents: [parent], message: "Add submodule", author: { name: "Pat", email: "p@x", date: "" } });
    gh.refs.set("heads/main", "8".repeat(40));
    const head = gh.push({ "README.md": "# Shop 2\n" });
    const res = await run(b, gh, c1.sha, c0.sha);
    expect(res.state).toBe("changes");
    if (res.state !== "changes") return;
    expect(res.gitlinks).toEqual({ "lib/vendor": "5".repeat(40) });
    const merged = await b.commit({ repo: "shop", branch: "main", parent: c1.sha, message: "Bring GitHub changes into main", author, changes: res.changes });
    const first = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, { backend: b, source: "shop", mainSha: merged.sha, mode: "main", branch: "gitring", known: {}, upstreamOf: { [merged.sha]: { head, gitlinks: res.gitlinks } }, pr: { title: "t", body: "b" } });
    expect(first.status.state).toBe("ok");
    const tip = gh.refs.get("heads/main")!;
    expect(gh.trees.get(gh.commits.get(tip)!.tree)!.get("lib/vendor")).toEqual({ mode: "160000", sha: "5".repeat(40) });
  });

  it("follows the named branch instead of the default branch", async () => {
    const { b, gh, c0, c1 } = await setup();
    gh.refs.set("heads/develop", c0.sha);
    gh.push({ "README.md": "# Shop (develop)\n" }, "Develop change", "develop");
    gh.push({ "README.md": "# Shop (main)\n" }, "Main change", "main");
    const tree = (await b.readCommit("shop", c1.sha))!.treeHash;
    const res = await upstreamChanges({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch, backend: b, source: "shop", main: await readSnapshot(b, "shop", tree), since: c0.sha, branch: "develop" });
    expect(res.state).toBe("changes");
    if (res.state === "changes") {
      expect(res.branch).toBe("develop");
      expect(new TextDecoder().decode(res.changes[0].content as Uint8Array)).toBe("# Shop (develop)\n");
    }
  });

  it("takes GitHub's mode change when main kept the old mode", async () => {
    const { b, gh, c0, c1 } = await setup();
    const ours = await b.commit({ repo: "shop", branch: "main", parent: c1.sha, message: "Round", author, changes: [{ path: "src/price.js", content: PRICE.replace("cents / 100", "Math.round(cents) / 100") }] });
    const parent = gh.refs.get("heads/main")!;
    const tree = new Map(gh.trees.get(gh.commits.get(parent)!.tree)!);
    const text = PRICE.replace("'EUR'", "'USD'");
    const sha = (await import("node:crypto")).createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
    gh.blobs.set(sha, text);
    tree.set("src/price.js", { mode: "100755", sha });
    gh.trees.set("9".repeat(40), tree);
    gh.commits.set("a".repeat(40), { tree: "9".repeat(40), parents: [parent], message: "Exec", author: { name: "Pat", email: "p@x", date: "" } });
    gh.refs.set("heads/main", "a".repeat(40));
    const res = await run(b, gh, ours.sha, c0.sha);
    expect(res.state).toBe("changes");
    if (res.state === "changes") expect(res.changes[0]).toMatchObject({ path: "src/price.js", mode: "100755" });
  });
});

describe("sync safety", () => {
  it("does not overwrite commits that people pushed to the pull request branch", async () => {
    const { b, gh, c1 } = await setup();
    const first = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, { backend: b, source: "shop", mainSha: c1.sha, mode: "pull-request", branch: "gitring", known: {}, pr: { title: "t", body: "b" } });
    expect(first.status.state).toBe("ok");
    // A reviewer pushes a fix-up to the gitring branch.
    gh.push({ "README.md": "# Fixed by a reviewer\n" }, "Review fix", "gitring");
    const c2 = await b.commit({ repo: "shop", branch: "main", parent: c1.sha, message: "More", author, changes: [{ path: "more.txt", content: "m" }] });
    const again = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, { backend: b, source: "shop", mainSha: c2.sha, mode: "pull-request", branch: "gitring", known: first.known, pr: { title: "t", body: "b" } });
    expect(again.status.state).toBe("blocked");
    expect(again.status.message).toMatch(/does not overwrite/);
  });

  it("refuses a pull request branch that is the base branch", async () => {
    const { b, gh, c1 } = await setup();
    const out = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, { backend: b, source: "shop", mainSha: c1.sha, mode: "pull-request", branch: "main", known: {}, pr: { title: "t", body: "b" } });
    expect(out.status.state).toBe("error");
    expect(gh.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
  });

  it("sends long histories in batches", async () => {
    const { b, gh, c1 } = await setup();
    let tip = c1.sha;
    for (let i = 0; i < 5; i++) tip = (await b.commit({ repo: "shop", branch: "main", parent: tip, message: `w${i}`, author, changes: [{ path: `w${i}.txt`, content: String(i) }] })).sha;
    const one = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, { backend: b, source: "shop", mainSha: tip, mode: "main", branch: "gitring", known: {}, maxCommits: 4, pr: { title: "t", body: "b" } });
    expect(one.more).toBe(true);
    expect(one.status.state).toBe("pending");
    const two = await syncToGithub({ repo: gh.repo, token: "t", fetch: gh.fetch as typeof fetch }, { backend: b, source: "shop", mainSha: tip, mode: "main", branch: "gitring", known: one.known, maxCommits: 4, pr: { title: "t", body: "b" } });
    expect(two.more).toBeFalsy();
    expect(two.status.state).toBe("ok");
    expect(gh.filesAt(gh.refs.get("heads/main")!)).toEqual(await filesOf(b, "shop", tip));
  });
});
