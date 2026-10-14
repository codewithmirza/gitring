/**
 * Agent-first projects over MCP: an agent creates a project with one call (a template, files, or a git
 * URL), lists the templates, and clones a project with a read token in a header. The answers use plain
 * words (ASD-STE100) and never put the token into a URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { steViolations } from "../coord/ste";
import { ORIGIN, World } from "../github/harness";
import { callTool, makeProject, modernCall, oauthTokens } from "./support";

let world: World;
let key: string;
let userId: string;
/** The built-in agents that started (the Vessel stand-in records them). */
let started: { projectId: string; attemptId: string; model: string }[];
/** The Vessel stand-in fails to start an agent. */
let failStart: boolean;

beforeEach(async () => {
  world = new World();
  vi.stubGlobal("fetch", world.fetch);
  started = [];
  failStart = false;
  const start = async (x: { projectId: string; attemptId: string; model: string }) => {
    if (failStart) throw new Error("The agent container did not start.");
    started.push(x);
  };
  await world.init({ VESSEL: { idFromName: (n: string) => n, get: () => ({ start }) } });
  // Artifacts makes read tokens; the git double does not, so the test gives one.
  const backend = world.backend as unknown as Record<string, unknown>;
  backend.createToken = async (_repo: string, scope: string) => ({ token: `art_${scope}_secret?expires=1767225600`, expiresAt: "2026-10-14T06:00:00.000Z" });
  backend.remoteUrl = async (repo: string) => `https://artifacts.test/git/${repo}.git`;
  world.person("robin", 1);
  ({ key, userId } = await world.signIn("robin"));
});
afterEach(() => vi.unstubAllGlobals());

/** The JSON part of a tool answer (after the headline). */
function dataOf(text: string): any {
  return JSON.parse(text.slice(text.indexOf("\n\n") + 2));
}

/** The sentences that people and agents read: the headline and the next steps. */
function plainProblems(text: string): string[] {
  const data = dataOf(text);
  const headline = text.slice(0, text.indexOf("\n\n"));
  return [headline, ...(data.next ?? [])].flatMap((s: string) => steViolations(s.replace(/https?:\/\/\S+/g, "the-link")));
}

describe("gitring_create_project", () => {
  it("creates a project from a template with a first task and a built-in agent", async () => {
    const res = await callTool(world, key, "gitring_create_project", {
      name: "Robin API",
      start: { kind: "template", template: "worker-api" },
      firstTask: { title: "Add a /time route", goal: "GET /time answers the server time as JSON." },
      launch: 1,
    });
    expect(res.isError, res.text).toBe(false);
    expect(plainProblems(res.text)).toEqual([]);
    const data = dataOf(res.text);
    expect(data.project).toMatch(/^robin-api-/);
    expect(data.url).toBe(`${ORIGIN}/overview?project=${data.project}`);
    expect(data.tests).toEqual({ runner: "worker" });
    expect(data.task.title).toBe("Add a /time route");
    expect(data.launched).toHaveLength(1);
    expect(started.map((s) => s.projectId)).toEqual([data.project]);
    expect(res.text).toMatch(/1 built-in agent works on the task "Add a \/time route"/);

    // The project belongs to Robin, and main holds the template.
    const info = await world.call("GET", `/api/projects/${data.project}`, { key });
    expect(info.json.role).toBe("owner");
    expect(info.json.source).toEqual({ kind: "template", template: "worker-api" });
    const h = world.harbor(data.project);
    expect(await h.file("main", "src/routes.js")).toContain("export async function route(request)");
    expect(await h.file("main", "AGENTS.md")).toContain("gitring_declare");

    // The clone command sends the read token in a header, never in the URL.
    const secret = "art_read_secret";
    expect(data.clone.header).toBe(`Authorization: Basic ${btoa(`x:${secret}`)}`);
    expect(data.clone.clone).toMatch(/^git -c http\.extraHeader="Authorization: Basic [A-Za-z0-9+/=]+" clone --branch main https:\/\/\S+ robin-api-/);
    expect(data.clone.clone).not.toContain(secret);
    expect(data.clone.clone).not.toMatch(/https:\/\/[^\s]*@/);
  });

  it("keeps the project when the built-in agents do not start, and says why", async () => {
    failStart = true;
    const res = await callTool(world, key, "gitring_create_project", {
      name: "Robin API",
      start: { kind: "template", template: "worker-api" },
      firstTask: { goal: "Add a /time route." },
      launch: 1,
    });
    expect(res.isError, res.text).toBe(false);
    expect(plainProblems(res.text)).toEqual([]);
    const data = dataOf(res.text);
    expect(data.task.title).toBe("Add a /time route");
    expect(data.launched).toBeUndefined();
    expect(data.note).toBe("The first task is open. The built-in agents did not start: The agent container did not start.");
    expect(res.text).toContain(`Call gitring_declare with project "${data.project}", intentId "${data.task.id}"`);
  });

  it("creates a project from files and guesses the tests from them", async () => {
    const res = await callTool(world, key, "gitring_create_project", {
      name: "Robin lib",
      start: { kind: "files", files: [{ path: "package.json", content: JSON.stringify({ name: "robin-lib", scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }) }, { path: "src/a.js", content: "export const a = 1;\n" }] },
    });
    expect(res.isError, res.text).toBe(false);
    const id = dataOf(res.text).project as string;
    await world.settle();
    const settings = await world.harbor(id).settings();
    expect(settings.checks).toEqual({ runner: "container", install: "npm install", test: "npm test" });
    expect(await world.harbor(id).file("main", "src/a.js")).toBe("export const a = 1;\n");
    // No task was asked for: the next step tells the agent how to send one.
    expect(dataOf(res.text).next[0]).toMatch(/newIntent/);
  });

  it("keeps the tests that the agent gives", async () => {
    const res = await callTool(world, key, "gitring_create_project", {
      name: "Robin lib",
      start: { kind: "files", files: [{ path: "package.json", content: JSON.stringify({ scripts: { test: "vitest run" } }) }] },
      tests: { install: "npm ci", test: "npm run test:all" },
    });
    const id = dataOf(res.text).project as string;
    await world.settle();
    expect((await world.harbor(id).settings()).checks).toEqual({ runner: "container", install: "npm ci", test: "npm run test:all" });
  });

  it("imports any git URL, and starts the agents when the import is done", async () => {
    const res = await callTool(world, key, "gitring_create_project", {
      name: "Shop",
      description: "A small shop. Add a cart page.",
      start: { kind: "git", url: "https://codeberg.org/robin/shop" },
      launch: 2,
    });
    expect(res.isError, res.text).toBe(false);
    expect(plainProblems(res.text)).toEqual([]);
    const data = dataOf(res.text);
    expect(data.source).toEqual({ kind: "git", url: "https://codeberg.org/robin/shop", host: "other" });
    expect(data.clone).toBeUndefined();
    expect(data.task.title).toBe("A small shop");
    expect(res.text).toMatch(/gitring imports https:\/\/codeberg\.org\/robin\/shop/);
    expect(res.text).toMatch(/start on the task "A small shop" when the import is done/);
    expect(started).toHaveLength(0);
  });

  it("starts an empty project from the empty template, as the app does", async () => {
    const res = await callTool(world, key, "gitring_create_project", { name: "Robin notes", start: { kind: "empty" } });
    expect(res.isError, res.text).toBe(false);
    const data = dataOf(res.text);
    expect(data.source).toEqual({ kind: "template", template: "empty" });
    expect(data.tests).toEqual({ runner: "worker" });
    // Other agents that come later learn from AGENTS.md to send a plan to gitring.
    expect(await world.harbor(data.project).file("main", "AGENTS.md")).toContain("gitring_declare");
  });

  it("says that no built-in agent started when launch has no task", async () => {
    const res = await callTool(world, key, "gitring_create_project", { name: "Robin lib", start: { kind: "template", template: "js-library" }, launch: 2 });
    expect(res.isError, res.text).toBe(false);
    expect(plainProblems(res.text)).toEqual([]);
    const data = dataOf(res.text);
    expect(data.note).toBe("No built-in agent started: give firstTask or description to start agents on a first task.");
    expect(steViolations(data.note)).toEqual([]);
    expect(res.text.slice(0, res.text.indexOf("\n\n"))).toContain(data.note);
    expect(started).toHaveLength(0);
  });

  it("explains a missing template, URL or file list", async () => {
    const a = await callTool(world, key, "gitring_create_project", { name: "x", start: { kind: "template" } });
    expect(a.isError).toBe(true);
    expect(a.text).toMatch(/Give start\.template: one of empty, js-library, worker-api, static-site/);
    const b = await callTool(world, key, "gitring_create_project", { name: "x", start: { kind: "git" } });
    expect(b.text).toMatch(/Give start\.url/);
    const c = await callTool(world, key, "gitring_create_project", { name: "x", start: { kind: "git", url: "http://insecure.example/r" } });
    expect(c.isError).toBe(true);
    expect(c.text).toMatch(/https URL/);
  });

  it("needs the scope mcp: a token with mcp:read cannot create a project", async () => {
    const tok = await oauthTokens(world, userId, `${ORIGIN}/mcp`, "mcp:read");
    const res = await modernCall(world, { token: tok.access_token, method: "tools/call", params: { name: "gitring_create_project", arguments: { name: "x", start: { kind: "empty" } } } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("insufficient_scope");
    // The template list only reads: the same token may call it.
    const list = await modernCall(world, { token: tok.access_token, method: "tools/call", params: { name: "gitring_templates", arguments: {} } });
    expect(list.status).toBe(200);
  });
});

describe("gitring_templates", () => {
  it("lists the templates in plain words", async () => {
    const res = await callTool(world, key, "gitring_templates", {});
    expect(res.isError).toBe(false);
    const list = dataOf(res.text) as { id: string; summary: string }[];
    expect(list.map((t) => t.id)).toEqual(["empty", "js-library", "worker-api", "static-site"]);
    expect(steViolations(res.text.slice(0, res.text.indexOf("\n\n")))).toEqual([]);
  });
});

describe("gitring_clone", () => {
  it("gives a member a clone command with a 6-hour read token in a header", async () => {
    const project = await makeProject(world, key);
    const res = await callTool(world, key, "gitring_clone", { project });
    expect(res.isError, res.text).toBe(false);
    expect(steViolations(res.text.slice(0, res.text.indexOf("\n\n")))).toEqual([]);
    const clone = dataOf(res.text);
    expect(clone.token).toBe("art_read_secret?expires=1767225600");
    expect(clone.clone).toContain(`git -c http.extraHeader="${clone.header}" clone --branch main `);
    expect(clone.pull).toBe(`git -c http.extraHeader="${clone.header}" pull`);
    expect(clone.clone).not.toContain("art_read_secret");
  });

  it("refuses a person who is not a member", async () => {
    const project = await makeProject(world, key);
    world.person("sam", 2);
    const sam = await world.signIn("sam");
    const res = await callTool(world, sam.key, "gitring_clone", { project });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Unknown project|no access/);
  });

  it("says why there is no clone of a project whose import did not finish", async () => {
    const res = await callTool(world, key, "gitring_create_project", { name: "Shop", start: { kind: "git", url: "https://codeberg.org/robin/shop" } });
    const id = dataOf(res.text).project as string;
    const h = world.harbor(id) as unknown as { project: { importing: { error?: string } } };
    h.project.importing.error = "The import took more than 20 minutes. Try a smaller repository or a shallower branch.";
    const clone = await callTool(world, key, "gitring_clone", { project: id });
    expect(clone.isError).toBe(true);
    expect(clone.text).toBe("Error: The import did not finish: The import took more than 20 minutes. Try a smaller repository or a shallower branch.");
  });

  it("is also a REST route for members", async () => {
    const project = await makeProject(world, key);
    const res = await world.call("POST", `/api/projects/${project}/clone-token`, { key });
    expect(res.status).toBe(200);
    expect(res.json.header).toMatch(/^Authorization: Basic /);
    const anon = await world.call("POST", `/api/projects/${project}/clone-token`);
    expect(anon.status).toBe(401);
  });
});
