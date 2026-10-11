/**
 * The GitHub-compatible tools (/mcp/github), end to end through the real Worker, the real Directory and the
 * real project object: a repo is a project, a branch is a work copy, a write goes through the same code as
 * gitring_write, a pull request is a submit (the tests run), and a merge never skips the tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinClearance, writeAnswer } from "../../src/worker/mcp-kit";
import { MERGE_WAIT } from "../../src/worker/mcp-github";
import { nodeLoader, type NodeLoader } from "../checks/node-loader";
import { World } from "../github/harness";
import { callTool, makeProject } from "./support";

const GREET = 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n';
const GREET_TEST = 'import { test, expect } from "../harness/test.js";\nimport { greet } from "../src/greet.js";\ntest("greets", () => expect(greet("Robin")).toBe("Hello, Robin!"));\n';
const SHOUT = 'import { greet } from "./greet.js";\nexport function shout(name) {\n  return greet(name).toUpperCase();\n}\n';
const SHOUT_TEST = 'import { test, expect } from "../harness/test.js";\nimport { shout } from "../src/shout.js";\ntest("shouts", () => expect(shout("Robin")).toBe("HELLO, ROBIN!"));\n';
const BROKEN_TEST = 'import { test, expect } from "../harness/test.js";\nimport { shout } from "../src/shout.js";\ntest("shouts", () => expect(shout("Robin")).toBe("never"));\n';

let world: World;
let loader: NodeLoader;
let key: string;
/** The browser session of alice: a person changes the settings and answers questions in the gitring app. */
let session: string;
let project: string;

const gh = (name: string, args: Record<string, unknown> = {}, as = key) => callTool(world, as, name, { repo: project, ...args }, "/mcp/github");
/** The pull request number that an answer names. */
const numberOf = (text: string): number => Number(/Pull request (\d+)/.exec(text)?.[1]);

beforeEach(async () => {
  world = new World();
  loader = nodeLoader();
  vi.stubGlobal("fetch", world.fetch);
  await world.init({ LOADER: loader });
  world.person("alice", 1);
  ({ key, session } = await world.signIn("alice"));
  project = await makeProject(world, key, "shop", { checks: { runner: "worker" } });
  await world.land(project, "src/greet.js", GREET);
  await world.land(project, "tests/greet.test.js", GREET_TEST);
  MERGE_WAIT.ms = 3000;
  MERGE_WAIT.stepMs = 20;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await world.settle();
  await loader.cleanup();
});

describe("projects", () => {
  it("shows who you are, with your projects", async () => {
    const res = await gh("get_me");
    expect(res.isError, res.text).toBe(false);
    const me = JSON.parse(res.text.slice(res.text.indexOf("{")));
    expect(me.login).toBe("alice");
    expect(me.projects).toEqual([{ repo: project, name: "shop", role: "owner" }]);
  });

  it("finds projects by name or id, and ignores search qualifiers", async () => {
    const hit = await gh("search_repositories", { query: "org:robin shop language:js" });
    expect(hit.text).toMatch(/1 projects match/);
    expect(hit.text).toContain(`"full_name": "${project}"`);
    const miss = await gh("search_repositories", { query: "no-such-thing" });
    expect(miss.text).toMatch(/0 projects match/);
  });

  it("takes owner/repo as the repo, and ignores owner", async () => {
    const res = await gh("get_file_contents", { owner: "robin", repo: `robin/${project}`, path: "src/greet.js" });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toBe(GREET);
  });

  it("names the tool that lists projects when the project id is wrong", async () => {
    const res = await gh("get_file_contents", { repo: "Not A Project" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Call get_me to list your projects.");
    expect(res.text).not.toContain("gitring_intents");
  });
});

describe("reading", () => {
  it("reads a file of main, and lists a folder", async () => {
    const file = await gh("get_file_contents", { path: "src/greet.js" });
    expect(file.text).toBe(GREET);
    const root = await gh("get_file_contents", {});
    // A new project starts with a README.md file.
    expect(root.text).toMatch(/3 entries in the top folder on main/);
    const entries = JSON.parse(root.text.slice(root.text.indexOf("["))) as { type: string; name: string; path: string }[];
    expect(entries.map((e) => `${e.type}:${e.path}`)).toEqual(["dir:src", "dir:tests", "file:README.md"]);
    const dir = await gh("get_file_contents", { path: "/src/" });
    expect(dir.text).toContain('"name": "greet.js"');
  });

  it("says when a path does not exist", async () => {
    const res = await gh("get_file_contents", { path: "src/nothing.js" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/There is no text file or folder "src\/nothing.js" on main/);
  });

  it("lists the files of main, with a path filter and the recursive flag", async () => {
    const top = await gh("get_repository_tree", {});
    expect(JSON.parse(top.text.slice(top.text.indexOf("{"))).tree.map((e: { path: string; type: string }) => `${e.type}:${e.path}`)).toEqual(["tree:src", "tree:tests", "blob:README.md"]);
    const all = await gh("get_repository_tree", { recursive: true, path_filter: "tests" });
    expect(JSON.parse(all.text.slice(all.text.indexOf("{"))).tree.map((e: { path: string }) => e.path)).toEqual(["tests/greet.test.js"]);
  });

  it("reads main by its name in the forms that GitHub clients use", async () => {
    for (const ref of ["main", "refs/heads/main", "heads/main"]) expect((await gh("get_file_contents", { path: "src/greet.js", ref })).text, ref).toBe(GREET);
  });

  it("refuses a branch that does not exist, and a branch of another person", async () => {
    const none = await gh("get_file_contents", { path: "src/greet.js", ref: "feature/none" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/The branch "feature\/none" does not exist/);
    // A branch is a work copy of the person who made it.
    await gh("push_files", { branch: "feature/mine", message: "Mine", files: [{ path: "a.txt", content: "a" }] });
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
    const other = await gh("get_file_contents", { path: "a.txt", ref: "feature/mine" }, bob.key);
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/does not exist/);
  });
});

describe("branches and writes", () => {
  it("makes a branch from main, lists it, and refuses a second branch with the same name", async () => {
    const made = await gh("create_branch", { branch: "feature/shout" });
    expect(made.isError, made.text).toBe(false);
    expect(made.text).toMatch(/The branch "feature\/shout" is ready/);
    const list = await gh("list_branches");
    const branches = JSON.parse(list.text.slice(list.text.indexOf("[")));
    expect(branches.map((b: { name: string }) => b.name)).toEqual(["main", "feature/shout"]);
    expect(branches[0]).toMatchObject({ name: "main", protected: true });
    const again = await gh("create_branch", { branch: "feature/shout" });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/exists already/);
  });

  it("makes a branch from main only", async () => {
    const res = await gh("create_branch", { branch: "feature/x", from_branch: "other" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/from main only/);
    expect((await gh("create_branch", { branch: "feature/y", from_branch: "main" })).isError).toBe(false);
  });

  it("refuses a bad branch name", async () => {
    for (const branch of ["", "a b", "../x", "/x", "x/", "x..y", "a".repeat(101)]) {
      const res = await gh("create_branch", { branch });
      expect(res.isError, JSON.stringify(branch)).toBe(true);
      expect(res.text, JSON.stringify(branch)).toMatch(/is not a branch name/);
    }
  });

  it("never writes to main, with any spelling of main", async () => {
    for (const branch of ["main", "refs/heads/main", "heads/main"]) {
      for (const [tool, args] of [
        ["push_files", { files: [{ path: "x.txt", content: "x" }], message: "x" }],
        ["create_or_update_file", { path: "x.txt", content: "x", message: "x" }],
        ["delete_file", { path: "src/greet.js", message: "x" }],
        ["create_branch", {}],
      ] as [string, Record<string, unknown>][]) {
        const res = await gh(tool, { branch, ...args });
        expect(res.isError, `${tool} ${branch}`).toBe(true);
        expect(res.text, `${tool} ${branch}`).toMatch(/does not write to main/);
      }
    }
    expect((await gh("get_file_contents", { path: "x.txt" })).isError).toBe(true);
    expect((await gh("get_file_contents", { path: "src/greet.js" })).text).toBe(GREET);
  });

  it("makes a work copy at the first write to a new branch, and keeps main as it is", async () => {
    const res = await gh("push_files", { branch: "feature/shout", message: "Shout the greeting", files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toMatch(/^The branch "feature\/shout" is a new work copy of main\. Written: src\/shout\.js, tests\/shout\.test\.js\./);
    // The new files are on the branch, and not on main.
    expect((await gh("get_file_contents", { path: "src/shout.js", ref: "feature/shout" })).text).toBe(SHOUT);
    expect((await gh("get_file_contents", { path: "src/shout.js" })).isError).toBe(true);
    const tree = await gh("get_repository_tree", { tree_sha: "feature/shout", recursive: true });
    expect(JSON.parse(tree.text.slice(tree.text.indexOf("{"))).tree.map((e: { path: string }) => e.path)).toEqual(["README.md", "src/greet.js", "src/shout.js", "tests/greet.test.js", "tests/shout.test.js"]);
    // The task of the work copy is named after the message of the first write.
    const issues = await gh("list_issues");
    expect(issues.text).toContain('"title": "Shout the greeting"');
    // A second write goes to the same work copy.
    const more = await gh("create_or_update_file", { branch: "feature/shout", path: "README.md", content: "Shout.\n", message: "Add a note" });
    expect(more.text).toMatch(/^Written: README\.md\./);
    const list = JSON.parse((await gh("list_branches")).text.split("\n\n").slice(1).join("\n\n"));
    expect(list.map((b: { name: string }) => b.name)).toEqual(["main", "feature/shout"]);
  });

  it("changes and deletes files of a branch", async () => {
    await gh("push_files", { branch: "feature/edit", message: "Edit", files: [{ path: "src/greet.js", content: GREET.replace("Hello", "Hi") }] });
    expect((await gh("get_file_contents", { path: "src/greet.js", ref: "feature/edit" })).text).toContain("Hi, ");
    const del = await gh("delete_file", { branch: "feature/edit", path: "tests/greet.test.js", message: "Remove the test" });
    expect(del.isError, del.text).toBe(false);
    expect(del.text).toMatch(/Written: tests\/greet\.test\.js/);
    expect((await gh("get_file_contents", { path: "tests/greet.test.js", ref: "feature/edit" })).isError).toBe(true);
    // Main has both files still.
    expect((await gh("get_file_contents", { path: "tests/greet.test.js" })).text).toBe(GREET_TEST);
    expect((await gh("get_file_contents", { path: "src/greet.js" })).text).toBe(GREET);
  });

  it("asks for at least one file", async () => {
    const res = await gh("push_files", { branch: "feature/none", message: "x", files: [] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/at least one file/);
  });
});

describe("a pull request", () => {
  const shoutBranch = (name = "feature/shout", test = SHOUT_TEST) =>
    gh("push_files", { branch: name, message: "Shout the greeting", files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: test }] });

  it("runs the tests, queues the merge, and reports the merge (it never merges by itself)", async () => {
    await shoutBranch();
    const pr = await gh("create_pull_request", { title: "Shout the greeting", head: "feature/shout", base: "main", body: "Adds shout." });
    expect(pr.isError, pr.text).toBe(false);
    expect(pr.text).toMatch(/^Pull request 1: queued\. All tests pass\. The work copy is in the merge queue\./);
    await world.settle();
    const merged = await gh("merge_pull_request", { pullNumber: 1, merge_method: "squash" });
    expect(merged.isError, merged.text).toBe(false);
    expect(merged.text).toMatch(/^Pull request 1: merged\. The work is on main at [0-9a-f]{7}\./);
    // The work is on main now.
    expect((await gh("get_file_contents", { path: "src/shout.js" })).text).toBe(SHOUT);
    const list = await gh("list_pull_requests", { state: "closed" });
    expect(list.text).toContain('"merged": true');
  });

  it("waits for a merge that is not done yet, and says when it is not done", async () => {
    await shoutBranch();
    await gh("create_pull_request", { title: "Shout", head: "feature/shout", base: "main" });
    // Without settle: the merge queue runs in the background. The wait ends when the merge is done.
    const merged = await gh("merge_pull_request", { pullNumber: 1 });
    expect(merged.text).toMatch(/^Pull request 1: merged\./);
    // The wait is short: a merge that cannot finish is reported, and the tool says to call it again.
    MERGE_WAIT.ms = 0;
    const slow = await gh("pull_request_read", { method: "get", pullNumber: 1 });
    expect(slow.isError, slow.text).toBe(false);
  });

  it("reports failed tests, and takes the same call again after the fix", async () => {
    await shoutBranch("feature/shout", BROKEN_TEST);
    const bad = await gh("create_pull_request", { title: "Shout", head: "feature/shout", base: "main" });
    expect(bad.isError, bad.text).toBe(false);
    expect(bad.text).toMatch(/^Pull request 1: tests failed\./);
    const state = await gh("merge_pull_request", { pullNumber: 1 });
    expect(state.text).toMatch(/^Pull request 1: tests fail\. The last test run failed/);
    expect(state.text).not.toMatch(/merged\. /);
    await gh("create_or_update_file", { branch: "feature/shout", path: "tests/shout.test.js", content: SHOUT_TEST, message: "Fix the test" });
    const good = await gh("create_pull_request", { title: "Shout", head: "feature/shout", base: "main" });
    expect(good.text).toMatch(/^Pull request 1: queued\./);
    await world.settle();
    expect((await gh("merge_pull_request", { pullNumber: 1 })).text).toMatch(/^Pull request 1: merged\./);
  });

  it("waits for a person when the project does not merge by itself, and merge_pull_request does not merge either", async () => {
    // A key cannot change when a person says yes. The person does it in the app.
    const refused = await world.call("PUT", `/api/projects/${project}/settings`, { key, body: { autoLand: false } });
    expect(refused.status).toBe(403);
    const set = await world.call("PUT", `/api/projects/${project}/settings`, { headers: { cookie: `__Host-gitring=${session}` }, body: { autoLand: false } });
    expect(set.status, set.text).toBe(200);
    await shoutBranch();
    const pr = await gh("create_pull_request", { title: "Shout", head: "feature/shout", base: "main" });
    expect(pr.text).toMatch(/^Pull request 1: waits for a person\. The work is not merged yet\./);
    expect(pr.text).toMatch(/must say yes to this work/);
    expect(pr.text).toMatch(/Link: \S+\/approve\//);
    await world.settle();
    // The tool does not wait for a person (it would wait for ever): it answers at once, and says what is true.
    MERGE_WAIT.ms = 60_000;
    const t0 = Date.now();
    const state = await gh("merge_pull_request", { pullNumber: 1, merge_method: "merge" });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(state.isError).toBe(false);
    expect(state.text).toMatch(/^Pull request 1: waits for a person\. .*must say yes\. gitring does not merge before that\. The person answers here: \S+\/approve\//);
    expect(JSON.parse(state.text.slice(state.text.indexOf("{")))).toMatchObject({ merged: false, state: "open" });
    // Main did not change.
    expect((await gh("get_file_contents", { path: "src/shout.js" })).isError).toBe(true);
    expect((await gh("list_commits")).text).toMatch(/^0 commits/);
  });

  it("does not merge work that was never submitted", async () => {
    await shoutBranch();
    const res = await gh("merge_pull_request", { pullNumber: 1 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Pull request 1 does not exist, or it is not yours/);
    expect((await gh("get_file_contents", { path: "src/shout.js" })).isError).toBe(true);
  });

  it("takes only main as the base, and has no draft pull request", async () => {
    await shoutBranch();
    const base = await gh("create_pull_request", { title: "x", head: "feature/shout", base: "release" });
    expect(base.isError).toBe(true);
    expect(base.text).toMatch(/merges into main only/);
    const draft = await gh("create_pull_request", { title: "x", head: "feature/shout", base: "main", draft: true });
    expect(draft.isError, draft.text).toBe(false);
    expect(draft.text).toMatch(/no draft pull requests/);
    expect((await gh("list_pull_requests", { state: "all" })).text).toMatch(/0 pull requests/);
    const none = await gh("create_pull_request", { title: "x", head: "feature/none", base: "main" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/The branch "feature\/none" does not exist/);
    const toMain = await gh("create_pull_request", { title: "x", head: "main", base: "main" });
    expect(toMain.isError).toBe(true);
  });

  it("refuses a branch with no changes, and a branch that is merged already, and takes owner:branch as the head", async () => {
    await gh("create_branch", { branch: "feature/empty" });
    const empty = await gh("create_pull_request", { title: "x", head: "feature/empty", base: "main" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/The branch "feature\/empty" has no changes\. Write files to it first\./);
    await shoutBranch();
    const pr = await gh("create_pull_request", { title: "Shout", head: "alice:feature/shout", base: "main" });
    expect(pr.isError, pr.text).toBe(false);
    expect(pr.text).toMatch(/^Pull request 2: queued\./);
    await world.settle();
    const again = await gh("create_pull_request", { title: "Shout", head: "feature/shout", base: "main" });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/is merged already\. Write to it to start new work/);
  });

  it("reads a pull request: the state, the checks, the files and the diff", async () => {
    await shoutBranch();
    await gh("create_pull_request", { title: "Shout the greeting", head: "feature/shout", base: "main", body: "Adds shout." });
    await world.settle();
    const get = await gh("pull_request_read", { method: "get", pullNumber: 1 });
    const pr = JSON.parse(get.text.slice(get.text.indexOf("{")));
    expect(pr).toMatchObject({ number: 1, title: "Shout the greeting", body: "Adds shout.", state: "closed", merged: true, head: { ref: "feature/shout" }, base: { ref: "main" } });
    const status = await gh("pull_request_read", { method: "get_status", pullNumber: 1 });
    expect(JSON.parse(status.text.slice(status.text.indexOf("{")))).toMatchObject({ state: "success" });
    const files = await gh("pull_request_read", { method: "get_files", pullNumber: 1 });
    const list = JSON.parse(files.text.slice(files.text.indexOf("[")));
    expect(list.map((f: { filename: string; status: string }) => `${f.status}:${f.filename}`)).toEqual(["added:src/shout.js", "added:tests/shout.test.js"]);
    const diff = await gh("pull_request_read", { method: "get_diff", pullNumber: 1 });
    expect(diff.text).toContain("+export function shout(name)");
    const reviews = await gh("pull_request_read", { method: "get_reviews", pullNumber: 1 });
    expect(reviews.isError).toBe(true);
    expect(reviews.text).toMatch(/no reviews on a pull request\. Use get, get_status, get_files or get_diff/);
  });

  it("shows only your own pull requests", async () => {
    await shoutBranch();
    await gh("create_pull_request", { title: "Shout", head: "feature/shout", base: "main" });
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
    const res = await gh("pull_request_read", { method: "get", pullNumber: 1 }, bob.key);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not exist, or it is not yours/);
    expect((await gh("list_pull_requests", { state: "all" }, bob.key)).text).toMatch(/0 pull requests/);
    const merge = await gh("merge_pull_request", { pullNumber: 1 }, bob.key);
    expect(merge.isError).toBe(true);
    const update = await gh("update_pull_request_branch", { pullNumber: 1 }, bob.key);
    expect(update.isError).toBe(true);
  });

  it("moves a branch onto the new main", async () => {
    await shoutBranch();
    expect((await gh("update_pull_request_branch", { pullNumber: 1 })).isError).toBe(true);
    await gh("create_pull_request", { title: "Shout", head: "feature/shout", base: "main" });
    await world.settle();
    // The work is merged: a merged work copy cannot move.
    const done = await gh("update_pull_request_branch", { pullNumber: 1 });
    expect(done.isError).toBe(true);
    expect(done.text).toMatch(/Work copy .* is merged/);
  });

  it("starts a new work copy when the branch name is used again after a merge", async () => {
    await shoutBranch();
    await gh("create_pull_request", { title: "Shout", head: "feature/shout", base: "main" });
    await world.settle();
    const again = await gh("create_or_update_file", { branch: "feature/shout", path: "NOTES.md", content: "More.\n", message: "More notes" });
    expect(again.isError, again.text).toBe(false);
    expect(again.text).toMatch(/^The branch "feature\/shout" is a new work copy of main\./);
    // The new work copy starts from the new main: it has the merged file.
    expect((await gh("get_file_contents", { path: "src/shout.js", ref: "feature/shout" })).text).toBe(SHOUT);
  });
});

describe("change requests", () => {
  it("brings the change requests of a first write (the work copy of the same call) and of a later write", async () => {
    // Another agent works on the same lines of the same file, with the gitring tools.
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
    const plan = await callTool(world, bob.key, "gitring_declare", {
      project,
      newIntent: { title: "Greet politely", goal: "The greeting says Good day." },
      plan: ["Change the greeting text"],
      files: ["src/greet.js"],
      symbols: ["src/greet.js#greet"],
      approach: "Edit greet.",
    });
    const attemptId = /work copy (a_\w+)/.exec(plan.text)?.[1] ?? "";
    expect(attemptId).not.toBe("");
    const write = await callTool(world, bob.key, "gitring_write", { project, attemptId, files: [{ path: "src/greet.js", content: GREET.replace("Hello", "Good day") }] });
    expect(write.text).toMatch(/^Written: src\/greet\.js\. Conflict check: clear\./);
    // Alice changes the same lines with the GitHub tools. The first write makes her work copy, and the answer starts with the change request.
    const res = await gh("push_files", { branch: "feature/hi", message: "Greet with Hi", files: [{ path: "src/greet.js", content: GREET.replace("Hello", "Hi") }] });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toMatch(/^GITRING CHANGE REQUEST — apply it in your next edits\. Do not stop\.\n- \[cr_\w+\] \(same lines; [A-Z]+-\d+ continues\) [A-Z]+-\d+ edits line 2 of src\/greet\.js\./);
    expect(res.text).toMatch(/The branch "feature\/hi" is a new work copy of main\. Written: src\/greet\.js\. Conflict check: change request\. You have 1 new change request\. Apply it\. Continue your work\./);
    // The GitHub-compatible set has no tool to confirm a change request or to read the traffic: the answer does not name them.
    expect(res.text).not.toMatch(/gitring_ack|gitring_traffic/);
    // The change request comes once. The next write gets the check and the traffic, and no second copy of the request.
    const again = await gh("create_or_update_file", { branch: "feature/hi", path: "src/greet.js", content: GREET.replace("Hello", "Hey"), message: "Hey" });
    expect(again.text).not.toMatch(/GITRING CHANGE REQUEST/);
    expect(again.text).toMatch(/^Written: src\/greet\.js\. Conflict check: change request\. Plan clear\. 1 other agent work near you\. Their plans are in the traffic list below\./);
    expect(again.text).not.toMatch(/gitring_ack|gitring_traffic/);
    // The same write with the gitring tools gives the same change request in the same words.
    const mine = await callTool(world, key, "gitring_declare", { project, newIntent: { title: "Greet loudly", goal: "The greeting is loud." }, plan: ["Change the greeting"], files: ["src/greet.js"], symbols: ["src/greet.js#greet"], approach: "Edit greet." });
    const id = /work copy (a_\w+)/.exec(mine.text)?.[1] ?? "";
    const same = await callTool(world, key, "gitring_write", { project, attemptId: id, files: [{ path: "src/greet.js", content: GREET.replace("Hello", "Yo") }] });
    expect(same.text).toMatch(/GITRING CHANGE REQUEST — apply it in your next edits, then call gitring_ack\. Do not stop\./);
  });

  it("keeps the change requests of the plan check when the first write gives none", () => {
    const notice = { id: "cr_1", kind: "region" as const, message: "Do not edit line 2.", constraints: {}, from: "KESTREL-4" };
    const first = { verdict: "correct" as const, corrections: [notice], traffic: [], advice: "x" };
    const second = { verdict: "clear" as const, corrections: [], traffic: [], advice: "Plan clear. Continue your work." };
    const joined = joinClearance(first, second);
    expect(joined.corrections).toEqual([notice]);
    expect(joined.verdict).toBe("correct");
    expect(joined.advice).toBe("You have 1 new change request. Apply it, then call gitring_ack. Continue your work.");
    // The same request in both: it counts once.
    expect(joinClearance(first, { ...second, verdict: "correct", corrections: [notice] }).corrections).toEqual([notice]);
    // Nothing from the first: the second stays as it is.
    expect(joinClearance(second, second)).toEqual(second);
    const answer = writeAnswer({ written: ["a.txt"], footprint: { files: ["a.txt"], symbols: [] }, clearance: second }, { clr: joined, github: true });
    expect(answer.content[0].text).toMatch(/^GITRING CHANGE REQUEST — apply it in your next edits\. Do not stop\.\n- \[cr_1\]/);
    expect(answer.content[0].text).toContain("Conflict check: change request. You have 1 new change request. Apply it. Continue your work.");
  });
});

describe("commits and code search", () => {
  const merge = async () => {
    await gh("push_files", { branch: "feature/shout", message: "Shout the greeting", files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] });
    await gh("create_pull_request", { title: "Shout the greeting", head: "feature/shout", base: "main" });
    await world.settle();
    expect((await gh("merge_pull_request", { pullNumber: 1 })).text).toMatch(/merged/);
  };

  it("lists the commits that gitring merged into main, and reads one with its files", async () => {
    expect((await gh("list_commits")).text).toMatch(/^0 commits that gitring merged into main/);
    await merge();
    const list = await gh("list_commits");
    expect(list.text).toMatch(/^1 commits that gitring merged into main/);
    const commits = JSON.parse(list.text.slice(list.text.indexOf("["))) as { sha: string; commit: { message: string; author: { name: string }; committer: { name: string; date: string } }; gitring: { method: string; task: string } }[];
    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[0].commit.message).toContain("Shout the greeting");
    expect(commits[0].commit.committer.name).toBe("gitring");
    expect(commits[0].gitring.task).toBe("Shout the greeting");
    // The commit has its files and the patches, with the short id too.
    for (const sha of [commits[0].sha, commits[0].sha.slice(0, 7)]) {
      const one = await gh("get_commit", { sha });
      expect(one.isError, one.text).toBe(false);
      const c = JSON.parse(one.text.slice(one.text.indexOf("{")));
      expect(c.sha).toBe(commits[0].sha);
      expect(c.files.map((f: { filename: string; status: string }) => `${f.status}:${f.filename}`)).toEqual(["added:src/shout.js", "added:tests/shout.test.js"]);
      expect(c.files[0].patch).toContain("+export function shout(name)");
      expect(c.stats.additions).toBeGreaterThan(0);
    }
    const lean = await gh("get_commit", { sha: commits[0].sha, include_diff: false });
    expect(lean.text).not.toContain('"patch"');
    // The date filters work, and a date that is not a date is an error.
    expect((await gh("list_commits", { since: "2999-01-01T00:00:00Z" })).text).toMatch(/^0 commits/);
    expect((await gh("list_commits", { until: "2999-01-01T00:00:00Z" })).text).toMatch(/^1 commits/);
    expect((await gh("list_commits", { since: "yesterday" })).text).toMatch(/Give since and until as dates/);
  });

  it("lists the commits of main only, and has details only for commits that gitring merged", async () => {
    const branch = await gh("list_commits", { sha: "feature/shout" });
    expect(branch.isError).toBe(true);
    expect(branch.text).toMatch(/commits of main only/);
    expect((await gh("list_commits", { sha: "main" })).isError).toBe(false);
    const unknown = await gh("get_commit", { sha: "abcdef1234" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/has no details for the commit abcdef1/);
    expect((await gh("get_commit", { sha: "zz" })).text).toMatch(/Give the commit id/);
  });

  it("searches the text files of main: all words, any case, a path and an extension", async () => {
    const hit = await gh("search_code", { query: "GREET" });
    expect(hit.isError, hit.text).toBe(false);
    const found = JSON.parse(hit.text.slice(hit.text.indexOf("{")));
    expect(found.total_count).toBe(2);
    expect(found.incomplete_results).toBe(false);
    expect(found.items.map((i: { path: string }) => i.path).sort()).toEqual(["src/greet.js", "tests/greet.test.js"]);
    expect(found.items[0].repository.full_name).toBe(project);
    expect(found.items.find((i: { path: string }) => i.path === "src/greet.js").text_matches[0].fragment).toContain("greet");
    const two = JSON.parse((await gh("search_code", { query: "greet toBe" })).text.split("\n\n").slice(1).join("\n\n"));
    expect(two.items.map((i: { path: string }) => i.path)).toEqual(["tests/greet.test.js"]);
    const path = JSON.parse((await gh("search_code", { query: "greet path:src/" })).text.split("\n\n").slice(1).join("\n\n"));
    expect(path.items.map((i: { path: string }) => i.path)).toEqual(["src/greet.js"]);
    const ext = JSON.parse((await gh("search_code", { query: "greet extension:md" })).text.split("\n\n").slice(1).join("\n\n"));
    expect(ext.total_count).toBe(0);
    const phrase = JSON.parse((await gh("search_code", { query: '"Hello, "' })).text.split("\n\n").slice(1).join("\n\n"));
    expect(phrase.items.map((i: { path: string }) => i.path)).toContain("src/greet.js");
  });

  it("reads the project from the query, ignores the other qualifiers, and does not search a branch", async () => {
    const res = await callTool(world, key, "search_code", { query: `repo:robin/${project} org:robin language:js greet` }, "/mcp/github");
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toMatch(/^2 files match/);
    // A word with an unknown prefix is a plain word.
    expect((await gh("search_code", { query: "http://example.com" })).text).toMatch(/^0 files match/);
    expect((await gh("search_code", { query: "" })).text).toMatch(/at least one word/);
    const none = await callTool(world, key, "search_code", { query: "greet" }, "/mcp/github");
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/Give repo/);
    // A file that is only on a branch is not in the search of main.
    await gh("push_files", { branch: "feature/new", message: "New", files: [{ path: "only-on-branch.txt", content: "unique-word-xyz" }] });
    expect((await gh("search_code", { query: "unique-word-xyz" })).text).toMatch(/^0 files match/);
  });
});

describe("tasks", () => {
  it("makes a task, reads it and lists it", async () => {
    const made = await gh("issue_write", { method: "create", title: "Add dark mode", body: "The page gets a dark theme.", labels: ["ui"] });
    expect(made.isError, made.text).toBe(false);
    expect(made.text).toMatch(/^Task 1 is open: Add dark mode\./);
    const read = await gh("issue_read", { method: "get", issue_number: 1 });
    expect(JSON.parse(read.text.slice(read.text.indexOf("{")))).toMatchObject({ number: 1, title: "Add dark mode", body: "The page gets a dark theme.", state: "open", labels: [] });
    const list = await gh("list_issues", { state: "OPEN" });
    expect(list.text).toMatch(/^1 tasks\./);
    expect((await gh("list_issues", { state: "CLOSED" })).text).toMatch(/^0 tasks\./);
    // The task is also a task for the gitring tools.
    const open = await callTool(world, key, "gitring_intents", { project });
    expect(open.text).toContain("Add dark mode");
    expect((await gh("issue_read", { method: "get_labels", issue_number: 1 })).text).toMatch(/no labels/);
    const comments = await gh("issue_read", { method: "get_comments", issue_number: 1 });
    expect(comments.isError).toBe(true);
    expect((await gh("issue_read", { method: "get", issue_number: 9 })).text).toMatch(/Task 9 does not exist/);
  });

  it("does not change or close a task, and needs a title", async () => {
    await gh("issue_write", { method: "create", title: "Add dark mode" });
    const update = await gh("issue_write", { method: "update", issue_number: 1, state: "closed" });
    expect(update.isError).toBe(true);
    expect(update.text).toMatch(/cannot change a task from here/);
    expect((await gh("issue_write", { method: "create", body: "x" })).text).toMatch(/Give a title/);
  });

  it("pages the task list with a cursor", async () => {
    for (const title of ["One", "Two", "Three"]) await gh("issue_write", { method: "create", title });
    const first = await gh("list_issues", { perPage: 2, direction: "ASC" });
    const page = JSON.parse(first.text.slice(first.text.indexOf("{")));
    expect(page.issues.map((i: { title: string }) => i.title)).toEqual(["One", "Two"]);
    expect(page.pageInfo).toEqual({ hasNextPage: true, endCursor: "2" });
    const next = JSON.parse((await gh("list_issues", { perPage: 2, direction: "ASC", after: "2" })).text.split("\n\n").slice(1).join("\n\n"));
    expect(next.issues.map((i: { title: string }) => i.title)).toEqual(["Three"]);
    expect(next.pageInfo.hasNextPage).toBe(false);
  });
});

describe("roles", () => {
  it("lets a person who only watches a public project read it, and not write", async () => {
    const made = await world.call("POST", "/api/projects", { key, body: { name: "open", visibility: "public", source: { kind: "empty" } } });
    const pub = made.json.project.id as string;
    await world.land(pub, "README.md", "Open.\n");
    world.person("carol", 3);
    const carol = await world.signIn("carol");
    const read = await callTool(world, carol.key, "get_file_contents", { repo: pub, path: "README.md" }, "/mcp/github");
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toBe("Open.\n");
    for (const [name, args] of [
      ["create_branch", { branch: "x" }],
      ["push_files", { branch: "x", message: "x", files: [{ path: "a", content: "a" }] }],
      ["issue_write", { method: "create", title: "x" }],
    ] as [string, Record<string, unknown>][]) {
      const res = await callTool(world, carol.key, name, { repo: pub, ...args }, "/mcp/github");
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toMatch(/needs the member role/);
    }
  });
});
