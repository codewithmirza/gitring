/**
 * gitring is the home of a project; GitHub is one optional import and sync target:
 *   - a project starts from a template (tests that run at once), an upload, a push or any git URL;
 *   - gitring guesses the tests of imported, pushed and uploaded code (rules, then a model);
 *   - a GitHub import starts with sync off, and a push on GitHub changes main only when sync is on;
 *   - after GitHub changes come in, the tests run on main; a failure opens a task and keeps the pull.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "./harness";
import { nodeLoader } from "../checks/node-loader";
import { steViolations } from "../coord/ste";
import { callTool } from "../mcp/support";

const loader = nodeLoader();
afterAll(() => loader.cleanup());

let world: World;
let started: { projectId: string; attemptId: string }[];
let failStart: boolean;
let modelCalls: string[];
let modelAnswer: string;
/** How long the model takes to answer (ms). */
let modelDelay: number;
/** The test settings of the project when each built-in agent started. */
let checksAtStart: unknown[];
/** What the test container answers (container runner). */
let dockAnswer: Record<string, unknown>;

beforeEach(async () => {
  world = new World();
  vi.stubGlobal("fetch", world.fetch);
  started = [];
  failStart = false;
  modelCalls = [];
  modelAnswer = '{"test": ""}';
  modelDelay = 0;
  checksAtStart = [];
  dockAnswer = { ok: false, stage: "no-test", exitCode: 1, installMs: 5, testMs: 0, reused: false, log: "" };
  await world.init({
    LOADER: loader,
    VESSEL: {
      idFromName: (n: string) => n,
      get: () => ({
        start: async (x: { projectId: string; attemptId: string }) => {
          if (failStart) throw new Error("The agent container did not start.");
          started.push(x);
          checksAtStart.push((await world.harbor(x.projectId).settings()).checks);
        },
      }),
    },
    AI: {
      run: async (model: string) => {
        modelCalls.push(model);
        if (modelDelay) await new Promise((r) => setTimeout(r, modelDelay));
        return { choices: [{ message: { content: modelAnswer } }] };
      },
    },
    DRYDOCK: { idFromName: (n: string) => n, get: () => ({ run: async () => dockAnswer }) },
  });
});
afterEach(() => vi.unstubAllGlobals());

const pushEvent = (n: number) => world.hook("push", `s-${n}`, { ref: "refs/heads/main", repository: { full_name: "robin/shop", default_branch: "main" } });

describe("a project from a template", () => {
  it("has the template in one commit, and its tests run in the gitring test runner", async () => {
    world.person("robin", 1);
    const { key } = await world.signIn("robin");
    const made = await world.call("POST", "/api/projects", { key, body: { name: "Robin lib", source: { kind: "template", template: "js-library" } } });
    expect(made.status, made.text).toBe(201);
    const id = made.json.project.id as string;
    const h = world.harbor(id);
    expect((await h.settings()).checks).toEqual({ runner: "worker" });
    expect(JSON.parse((await h.file("main", "package.json"))!).name).toBe("robin-lib");
    const st = await h.state();
    const head = await world.backend.readCommit(st.project.repo.name, st.project.mainSha);
    expect(head?.message).toMatch(/^Start Robin lib from the JavaScript library template/);
    expect(head?.message).toContain("Gitring-Seed: template js-library");
    // A work copy of the first task runs the template's tests: they pass, and they really ran.
    const plan = await callTool(world, key, "gitring_declare", { project: id, newIntent: { title: "Add words", goal: "Split text into words." }, plan: ["Test"], files: ["src/index.js"], approach: "Tests." });
    const attemptId = /"attemptId": "([^"]+)"/.exec(plan.text)?.[1];
    expect(attemptId, plan.text).toBeDefined();
    const run = await h.check(attemptId!);
    expect(run.ok).toBe(true);
    expect(run.ran).toBe(3);
  });

  it("refuses a template that does not exist, and names the templates", async () => {
    world.person("robin", 1);
    const { key } = await world.signIn("robin");
    const res = await world.call("POST", "/api/projects", { key, body: { name: "x", source: { kind: "template", template: "rails" } } });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Choose a template: empty, js-library, worker-api, static-site.");
    expect((await world.call("GET", "/api/projects", { key })).json).toHaveLength(0);
  });

  it("makes the first task and starts built-in agents in the same request", async () => {
    world.person("robin", 1);
    const { key } = await world.signIn("robin");
    const made = await world.call("POST", "/api/projects", {
      key,
      body: { name: "Robin site", source: { kind: "template", template: "static-site" }, firstTask: { goal: "A page about my bakery. Show the opening hours." }, launch: 2 },
    });
    expect(made.status, made.text).toBe(201);
    expect(made.json.task.title).toBe("A page about my bakery");
    expect(made.json.launched).toHaveLength(2);
    expect(started.map((s) => s.attemptId).sort()).toEqual([...made.json.launched].sort());
  });

  it("keeps the project and the task when the built-in agents do not start, and says why", async () => {
    world.person("robin", 1);
    const { key } = await world.signIn("robin");
    failStart = true;
    const made = await world.call("POST", "/api/projects", {
      key,
      body: { name: "Robin api", source: { kind: "template", template: "worker-api" }, firstTask: { goal: "Add a /time route." }, launch: 1 },
    });
    expect(made.status, made.text).toBe(201);
    expect(made.json.task.title).toBe("Add a /time route");
    expect(made.json.launched).toEqual([]);
    expect(made.json.note).toBe("The first task is open. The built-in agents did not start: The agent container did not start.");
    expect(steViolations(made.json.note)).toEqual([]);
    expect((await world.call("GET", "/api/projects", { key })).json).toHaveLength(1);
  });
});

describe("the guess of the tests", () => {
  it("reads an uploaded folder, and keeps the tests that the person gave", async () => {
    world.person("robin", 1);
    const { key } = await world.signIn("robin");
    const pkg = JSON.stringify({ name: "shop", scripts: { test: "vitest run" } });
    const guessed = await world.call("POST", "/api/projects", { key, body: { name: "a", source: { kind: "upload" }, files: [{ path: "package.json", text: pkg }, { path: "package-lock.json", text: "{}" }] } });
    const given = await world.call("POST", "/api/projects", {
      key,
      body: { name: "b", source: { kind: "upload" }, files: [{ path: "package.json", text: pkg }], settings: { checks: { runner: "container", test: "npm run custom" } } },
    });
    await world.settle();
    expect((await world.harbor(guessed.json.project.id).settings()).checks).toEqual({ runner: "container", install: "npm ci", test: "npm test" });
    expect((await world.harbor(given.json.project.id).settings()).checks).toEqual({ runner: "container", test: "npm run custom" });
    expect(modelCalls).toEqual([]);
  });

  it("asks the GLM model after a push when the rules find no test command, then starts the agents", async () => {
    world.person("robin", 1);
    const { key } = await world.signIn("robin");
    const made = await world.call("POST", "/api/projects", { key, body: { name: "Tool", source: { kind: "push" }, firstTask: { title: "Add a flag", goal: "Add --verbose." }, launch: 1 } });
    expect(made.status, made.text).toBe(201);
    expect(made.json.launchAfterImport).toBe(true);
    expect(started).toHaveLength(0);
    const id = made.json.project.id as string;
    // Robin pushes a repository that the rules do not know.
    const repo = made.json.state.project.repo.name as string;
    await world.backend.commit({ repo, branch: "main", parent: "", message: "First", author: { name: "Robin", email: "r@example.test" }, changes: [{ path: "README.md", content: "# Tool\n\nTest it with: make check\n" }, { path: "Makefile", content: "check:\n\t./run-checks\n" }] });
    modelAnswer = '{"install": "", "test": "make check", "why": "The README names make check."}';
    const checked = await world.call("POST", `/api/projects/${id}/import/check`, { key });
    expect(checked.status, checked.text).toBe(200);
    await world.settle();
    expect(modelCalls).toEqual(["@cf/zai-org/glm-5.3-flash"]);
    const h = world.harbor(id);
    expect((await h.settings()).checks).toEqual({ runner: "container", test: "make check" });
    const st = await h.state();
    const line = st.logs.map((l) => l.message).find((m) => m.startsWith("Tests: "));
    expect(line).toBe('Tests: gitring runs "make check". A model guessed these commands. An owner can change them in Settings → Tests.');
    expect(steViolations(line!)).toEqual([]);
    // The agent that Robin asked for starts now, on the first task.
    expect(started).toHaveLength(1);
    expect(st.attempts[0].intentId).toBe(made.json.task.id);
  });

  /** A push project that waits for its push, with a first task and one built-in agent. */
  async function pushProject(name: string, opts: { launch?: number } = {}) {
    world.person("robin", 1);
    const { key } = await world.signIn("robin");
    const made = await world.call("POST", "/api/projects", { key, body: { name, source: { kind: "push" }, ...(opts.launch ? { firstTask: { title: "Add a flag", goal: "Add --verbose." }, launch: opts.launch } : {}) } });
    expect(made.status, made.text).toBe(201);
    const id = made.json.project.id as string;
    const push = async () => {
      const repo = made.json.state.project.repo.name as string;
      await world.backend.commit({ repo, branch: "main", parent: "", message: "First", author: { name: "Robin", email: "r@example.test" }, changes: [{ path: "README.md", content: "# Tool\n\nTest it with: make check\n" }, { path: "Makefile", content: "check:\n\t./run-checks\n" }] });
      const checked = await world.call("POST", `/api/projects/${id}/import/check`, { key });
      expect(checked.status, checked.text).toBe(200);
      await world.settle();
    };
    return { id, key, h: world.harbor(id), push };
  }

  it("starts the agents after the guess, so that their first tests use the guessed commands", async () => {
    const { push } = await pushProject("Tool", { launch: 1 });
    modelAnswer = '{"install": "", "test": "make check"}';
    // The model is slow: the agent waits for its answer.
    modelDelay = 40;
    await push();
    expect(started).toHaveLength(1);
    expect(checksAtStart).toEqual([{ runner: "container", test: "make check" }]);
  });

  it("keeps the test commands of a project from before the record of the choice", async () => {
    const { key, h, id, push } = await pushProject("Tool");
    expect((await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { checks: { runner: "container", test: "make all" } } })).status).toBe(200);
    // A project from before "checksSet": the commands are there, the record of the choice is not.
    (h as unknown as { db: { setMeta(k: string, v: unknown): void } }).db.setMeta("checksSet", undefined);
    modelAnswer = '{"install": "", "test": "make check"}';
    await push();
    expect((await h.settings()).checks).toEqual({ runner: "container", test: "make all" });
    expect(modelCalls).toEqual([]);
  });

  it("forgets the choice of the tests when the project object starts again with a new project", async () => {
    world.person("robin", 1);
    const { key } = await world.signIn("robin");
    const pkg = JSON.stringify({ name: "shop", scripts: { test: "vitest run" } });
    const made = await world.call("POST", "/api/projects", { key, body: { name: "a", source: { kind: "upload" }, files: [{ path: "package.json", text: pkg }], settings: { checks: { runner: "container", test: "npm run custom" } } } });
    expect(made.status, made.text).toBe(201);
    const id = made.json.project.id as string;
    await world.settle();
    // The same project id again (a project that was not made, then made again): a new upload.
    const h = world.harbor(id);
    await h.init({ projectId: id, name: "a", source: { kind: "upload", files: 2 }, files: [{ path: "package.json", text: pkg }, { path: "package-lock.json", text: "{}" }] });
    await world.settle();
    expect((await h.settings()).checks).toEqual({ runner: "container", install: "npm ci", test: "npm test" });
  });
});

describe("GitHub is optional", () => {
  it("starts a GitHub import with sync off, also for a person who can push", async () => {
    world.person("alice", 1).access.set("robin/shop", { read: true, push: true });
    const { key } = await world.signIn("alice");
    const off = await world.call("POST", "/api/projects", { key, body: { name: "shop", source: { kind: "github", repo: "robin/shop" } } });
    expect(off.status, off.text).toBe(201);
    expect(off.json.state.project.settings.github).toMatchObject({ repo: "robin/shop", mode: "off" });
    // The person can turn it on in the same request.
    const on = await world.call("POST", "/api/projects", { key, body: { name: "shop2", source: { kind: "github", repo: "robin/shop" }, settings: { github: { mode: "pull-request" } } } });
    expect(on.json.state.project.settings.github.mode).toBe("pull-request");
  });

  it("guesses sync off, and says whether the person can turn it on", async () => {
    world.person("alice", 1).access.set("robin/shop", { read: true, push: true });
    world.person("sam", 2);
    const alice = await world.signIn("alice");
    const guess = await world.call("GET", "/api/github/guess?repo=robin/shop", { key: alice.key });
    expect(guess.status, guess.text).toBe(200);
    expect(guess.json.sync).toBe("off");
    expect(guess.json.canSync).toBe(true);
    expect(guess.json.reasons.join(" ")).toMatch(/GitHub sync is off/);
    const sam = await world.signIn("sam");
    const other = await world.call("GET", "/api/github/guess?repo=robin/shop", { key: sam.key });
    expect(other.json.sync).toBe("off");
    expect(other.json.canSync).toBeUndefined();
  });

  it("brings a GitHub push into main only when sync is on", async () => {
    world.person("alice", 1).access.set("robin/shop", { read: true, push: true });
    const { id, key, h, mainSha } = await world.linkedProject("alice", { repo: "robin/shop", mode: "off" });
    world.gh.push({ "news.txt": "from GitHub\n" }, "News");
    expect((await pushEvent(1)).status).toBe(202);
    await world.settle();
    expect((await h.state()).project.mainSha).toBe(mainSha);
    expect(world.ghState(id).pull).toBeUndefined();
    // The owner turns sync on: the next push comes in.
    expect((await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { github: { mode: "pull-request" } } })).status).toBe(200);
    await world.settle();
    world.gh.push({ "more.txt": "more\n" }, "More");
    await pushEvent(2);
    await world.settle();
    expect(world.ghState(id).pull?.state).toBe("merged");
    expect(await h.file("main", "more.txt")).toBe("more\n");
  });
});

describe("tests after GitHub changes", () => {
  const failing = 'import { test, expect } from "../harness/test.js";\nimport { sum } from "../src/sum.js";\ntest("sum adds", () => expect(sum(1, 2)).toBe(3));\n';

  it("runs the tests on main; a failure opens one high-priority task and keeps the pull", async () => {
    world.person("alice", 1).access.set("robin/shop", { read: true, push: true });
    const { id, key, h } = await world.linkedProject("alice");
    expect((await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { checks: { runner: "worker" } } })).status).toBe(200);
    world.gh.push({ "src/sum.js": "export const sum = (a, b) => a - b;\n", "tests/sum.test.js": failing }, "Add sum");
    const pulled = await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    expect(pulled.json.pull.state).toBe("merged");
    // The pull stays: main has the GitHub change.
    expect(await h.file("main", "src/sum.js")).toBe("export const sum = (a, b) => a - b;\n");
    const fix = (await h.state()).intents.filter((i) => i.title === "Fix the tests after GitHub changes");
    expect(fix).toHaveLength(1);
    expect(fix[0].priority).toBe("high");
    expect(fix[0].goal).toContain("1 of 1 tests fail on main");
    expect(fix[0].goal).toContain("tests/sum.test.js sum adds");

    // More failing GitHub changes while the task is open: no second task.
    world.gh.push({ "src/sum.js": "export const sum = (a, b) => a * b;\n" }, "Change sum");
    await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    expect((await h.state()).intents.filter((i) => i.title === "Fix the tests after GitHub changes")).toHaveLength(1);
  });

  it("opens no task when the tests pass", async () => {
    world.person("alice", 1).access.set("robin/shop", { read: true, push: true });
    const { id, key, h } = await world.linkedProject("alice");
    await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { checks: { runner: "worker" } } });
    world.gh.push({ "src/sum.js": "export const sum = (a, b) => a + b;\n", "tests/sum.test.js": failing }, "Add sum");
    await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    const st = await h.state();
    expect(st.intents.filter((i) => i.title === "Fix the tests after GitHub changes")).toHaveLength(0);
    expect(st.logs.some((l) => l.message === "Tests after the GitHub changes: 1/1 pass.")).toBe(true);
  });

  it("says that the tests did not run when the project has no test command, and opens no task", async () => {
    world.person("alice", 1).access.set("robin/shop", { read: true, push: true });
    const { id, key, h } = await world.linkedProject("alice");
    // The default: a test container. The repository has no test script.
    expect((await h.settings()).checks).toEqual({ runner: "container" });
    world.gh.push({ "news.txt": "from GitHub\n" }, "News");
    await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    const st = await h.state();
    expect(st.intents.filter((i) => i.title === "Fix the tests after GitHub changes")).toHaveLength(0);
    const line = st.logs.map((l) => l.message).find((m) => m.startsWith("Tests after the GitHub changes"));
    expect(line).toBe("Tests after the GitHub changes: not run. No test command. The project has no package.json test script. An owner sets the test command in Settings → Tests.");
    expect(steViolations(line!)).toEqual([]);
    expect(st.logs.find((l) => l.message === line)?.data).toMatchObject({ ok: false });
  });

  it("opens one task when two runs of the tests end at the same time", async () => {
    world.person("alice", 1).access.set("robin/shop", { read: true, push: true });
    const { h } = await world.linkedProject("alice");
    const tester = h as unknown as {
      loadMain(): Promise<unknown>;
      runTreeChecks(): Promise<unknown>;
      testMainAfterPull(repo: string, main: unknown, what: string): Promise<unknown>;
    };
    // Two pulls in a row: both runs of the tests fail, and they end at the same moment.
    const failed = { id: "ck_1", subject: "x", scope: "main", ok: false, passed: 0, failed: 1, ran: 1, cases: [{ file: "tests/sum.test.js", name: "sum adds", ok: false, ms: 1, error: "Expected 3, got -1" }], ms: 1, at: 1, runner: "worker" };
    tester.runTreeChecks = async () => failed;
    const main = await tester.loadMain();
    await Promise.all([tester.testMainAfterPull("robin/shop", main, "1 commit"), tester.testMainAfterPull("robin/shop", main, "1 commit")]);
    expect((await h.state()).intents.filter((i) => i.title === "Fix the tests after GitHub changes")).toHaveLength(1);
  });
});
