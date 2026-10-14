/**
 * The history tools and the project tools, read directly: which tools only read (and so work at /mcp/readonly),
 * the plain words of their descriptions, and the error paths of the history routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { steViolations } from "../coord/ste";
import { World } from "../github/harness";
import { HISTORY_TOOLS } from "../../src/worker/mcp-history";
import { PROJECT_TOOLS } from "../../src/worker/mcp-projects";
import { readOnlyTools } from "../../src/worker/mcp-kit";
import { callTool, makeProject, metadataProblems } from "./support";

describe("tool definitions", () => {
  it("marks every history tool as read-only, so the read-only endpoint has all of them", () => {
    expect(HISTORY_TOOLS.map((t) => t.name)).toEqual(["gitring_why", "gitring_history", "gitring_search", "gitring_diff"]);
    for (const t of HISTORY_TOOLS) expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(readOnlyTools(HISTORY_TOOLS).map((t) => t.name)).toEqual(HISTORY_TOOLS.map((t) => t.name));
  });

  it("marks the project tools: only the template list reads", () => {
    const hint = (name: string) => PROJECT_TOOLS.find((t) => t.name === name)!.annotations;
    expect(PROJECT_TOOLS.map((t) => t.name).sort()).toEqual(["gitring_clone", "gitring_create_project", "gitring_templates"]);
    expect(hint("gitring_templates").readOnlyHint).toBe(true);
    expect(hint("gitring_create_project")).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    // A clone makes a read token, so it is not read-only: the read-only endpoint does not list it.
    expect(hint("gitring_clone").readOnlyHint).toBe(false);
    expect(readOnlyTools(PROJECT_TOOLS).map((t) => t.name)).toEqual(["gitring_templates"]);
  });

  it("gives every tool a title, a plain description and a title in its annotations", () => {
    for (const t of [...HISTORY_TOOLS, ...PROJECT_TOOLS]) {
      expect(metadataProblems({ name: t.name, title: t.title, annotations: t.annotations }), t.name).toEqual([]);
      expect(steViolations(t.description), t.name).toEqual([]);
    }
  });

  it("asks for a project in every history tool", () => {
    for (const t of HISTORY_TOOLS) expect(Object.keys(t.inputSchema), t.name).toContain("project");
  });
});

describe("history routes and tools: error paths", () => {
  let world: World;
  let key: string;
  let project: string;

  beforeEach(async () => {
    world = new World();
    vi.stubGlobal("fetch", world.fetch);
    await world.init();
    world.person("alice", 1);
    ({ key } = await world.signIn("alice"));
    project = await makeProject(world, key, "shop");
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await world.settle();
  });

  it("answers an unknown project in plain words, for the routes and for the tools", async () => {
    for (const path of ["why?path=a.js", "history", "search?q=x", "compare?from=main&to=main"]) {
      const res = await world.call("GET", `/api/projects/nope/${path}`, { key });
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.status, path).toBeLessThan(500);
      expect(steViolations(String(res.json.error)), path).toEqual([]);
    }
    const tool = await callTool(world, key, "gitring_history", { project: "nope" });
    expect(tool.isError).toBe(true);
    expect(steViolations(tool.text.replace(/^Error: /, ""))).toEqual([]);
  });

  it("refuses a person who is not a member, on every route", async () => {
    world.person("sam", 2);
    const sam = await world.signIn("sam");
    for (const path of ["why?path=a.js", "history", "search?q=x", "compare?from=main&to=main"]) {
      const res = await world.call("GET", `/api/projects/${project}/${path}`, { key: sam.key });
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.status, path).toBeLessThan(500);
    }
    const tool = await callTool(world, sam.key, "gitring_search", { project, query: "x" });
    expect(tool.isError).toBe(true);
  });

  it("ignores a limit that is not a number, and answers an unknown version in plain words", async () => {
    const base = `/api/projects/${project}`;
    const hist = await world.call("GET", `${base}/history?limit=many`, { key });
    expect(hist.status, hist.text).toBe(200);
    const search = await world.call("GET", `${base}/search?q=zzzz&limit=many`, { key });
    expect(search.status, search.text).toBe(200);
    const cmp = await world.call("GET", `${base}/compare?from=main&to=nope`, { key });
    expect(cmp.status).toBeGreaterThanOrEqual(400);
    expect(String(cmp.json.error)).toBe('Unknown version "nope". Use main, a commit id or a work copy id.');
  });
});
