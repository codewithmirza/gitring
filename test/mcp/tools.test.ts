/**
 * The MCP tools of gitring: every tool has a title and true hints (directories need them), the words are
 * plain (ASD-STE100), and the server answers both eras of the protocol: 2026-07-28 (stateless:
 * "server/discover" and no session) and the older one (a client that starts with "initialize").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GITRING_TOOLS } from "../../src/worker/mcp";
import { authorizationServerMetadata } from "../../src/worker/oauth";
import { steViolations } from "../coord/ste";
import { World } from "../github/harness";
import { callTool, legacyClient, makeProject, metadataProblems, modernCall, MODERN } from "./support";

const HISTORY = ["gitring_why", "gitring_history", "gitring_search", "gitring_diff"];
const NAMES = ["gitring_intents", "gitring_declare", "gitring_log", "gitring_traffic", "gitring_read", "gitring_list", "gitring_write", "gitring_check", "gitring_submit", "gitring_ack", "gitring_update", "gitring_status", "gitring_wait", "gitring_create_project", "gitring_templates", "gitring_clone", ...HISTORY];
const READ_ONLY = ["gitring_intents", "gitring_list", "gitring_read", "gitring_status", "gitring_templates", "gitring_traffic", ...HISTORY].sort();

describe("tool definitions", () => {
  it("has the gitring tools, each name once", () => {
    expect(GITRING_TOOLS.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("fails for a tool with no title, or with a missing hint", () => {
    expect(metadataProblems({ name: "x" })).toEqual(["x: no title", "x: no readOnlyHint", "x: no destructiveHint", "x: no idempotentHint", "x: no openWorldHint"]);
    expect(metadataProblems({ name: "x", title: "X", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } })).toEqual(["x: no openWorldHint"]);
    expect(metadataProblems({ name: "x", title: "X", annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: false } })).toEqual(["x: read-only and destructive"]);
    expect(metadataProblems({ name: "x", title: "X", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } })).toEqual([]);
  });

  it("gives every tool a title and all four hints", () => {
    expect(GITRING_TOOLS.flatMap((t) => metadataProblems(t))).toEqual([]);
  });

  it("marks the tools that only read, and no other tool", () => {
    expect(GITRING_TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort()).toEqual(READ_ONLY);
  });

  it("marks only the merge and the project creation (an import) as tools that talk to other systems", () => {
    expect(GITRING_TOOLS.filter((t) => t.annotations.openWorldHint).map((t) => t.name)).toEqual(["gitring_submit", "gitring_create_project"]);
  });

  it("marks the tools that can overwrite or delete work, and no merge or report", () => {
    const destructive = GITRING_TOOLS.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
    expect(destructive).toEqual(["gitring_update", "gitring_write"]);
  });

  it("uses plain words in titles, descriptions and argument descriptions", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const t of GITRING_TOOLS) {
      const texts = [t.title, t.description];
      const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        const n = node as Record<string, unknown>;
        if (typeof n.description === "string") texts.push(n.description);
        for (const v of Object.values(n)) walk(v);
      };
      walk(z.toJSONSchema(z.object(t.inputSchema)));
      checked += texts.length;
      for (const text of texts) for (const v of steViolations(text)) problems.push(`${t.name}: ${v}`);
    }
    expect(problems).toEqual([]);
    // The walk found the argument descriptions too (not only the titles and descriptions).
    expect(checked).toBeGreaterThan(GITRING_TOOLS.length * 2 + 10);
    expect(steViolations("The tool is testing the things.")).not.toEqual([]);
  });

  it("keeps titles short", () => {
    for (const t of GITRING_TOOLS) expect(t.title.split(/\s+/).length, t.name).toBeLessThanOrEqual(4);
  });
});

describe("OAuth server metadata", () => {
  it("lists offline_access, because gitring issues refresh tokens", () => {
    expect(authorizationServerMetadata("https://gitring.example").scopes_supported).toEqual(expect.arrayContaining(["mcp", "offline_access"]));
    expect(authorizationServerMetadata("https://gitring.example").grant_types_supported).toContain("refresh_token");
  });
});

let world: World;
let key: string;
let project: string;

beforeEach(async () => {
  world = new World();
  vi.stubGlobal("fetch", world.fetch);
  await world.init();
  world.person("alice", 1);
  ({ key } = await world.signIn("alice"));
  project = await makeProject(world, key);
});
afterEach(() => vi.unstubAllGlobals());

describe("MCP 2026-07-28 (no session)", () => {
  it("answers server/discover with the version, the server and its instructions", async () => {
    const res = await modernCall(world, { token: key, method: "server/discover" });
    expect(res.status).toBe(200);
    const result = res.body.result;
    expect(result.supportedVersions).toContain(MODERN);
    expect(result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("gitring");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.instructions).toMatch(/gitring_intents/);
    expect(steViolations(result.instructions)).toEqual([]);
  });

  it("lists every tool with a title and all four hints", async () => {
    const res = await modernCall(world, { token: key, method: "tools/list" });
    expect(res.status).toBe(200);
    const tools = res.body.result.tools as { name: string; title?: string; description: string; annotations?: Record<string, unknown>; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
    expect(tools.flatMap((t) => metadataProblems(t))).toEqual([]);
    for (const t of tools) {
      expect(t.annotations?.title, `${t.name}: annotations.title`).toBe(t.title);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort()).toEqual(READ_ONLY);
  });

  it("runs a tool: the project list, the task list and a plan", async () => {
    const mine = await callTool(world, key, "gitring_intents", {});
    expect(mine.isError).toBe(false);
    expect(mine.text).toContain(project);
    const open = await callTool(world, key, "gitring_intents", { project });
    expect(open.text).toMatch(/0 open tasks/);
    const plan = await callTool(world, key, "gitring_declare", { project, newIntent: { title: "Add a greeting", goal: "Say hello." }, plan: ["Write the file"], files: ["hello.txt"], approach: "One file." });
    expect(plan.isError).toBe(false);
    expect(plan.text).toMatch(/You are .* on the task "Add a greeting"/);
  });

  it("answers a tool error as a tool result, not as a protocol error", async () => {
    const res = await callTool(world, key, "gitring_intents", { project: "no-such-project" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Error: Unknown project/);
  });

  it("needs a credential", async () => {
    const res = await modernCall(world, { method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});

describe("MCP of the older era (initialize first)", () => {
  it("connects with the SDK 1.30 client, lists the tools and calls one", async () => {
    const client = await legacyClient(world, key);
    try {
      expect(client.getServerVersion()?.name).toBe("gitring");
      expect(client.getInstructions()).toMatch(/gitring_intents/);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
      expect(tools.flatMap((t) => metadataProblems(t))).toEqual([]);
      const answer = await client.callTool({ name: "gitring_intents", arguments: { project } });
      const content = answer.content as { type: string; text: string }[];
      expect(answer.isError).toBeFalsy();
      expect(content[0].text).toMatch(/0 open tasks/);
    } finally {
      await client.close();
    }
  });

  it("refuses an older client with no credential", async () => {
    await expect(legacyClient(world, "gk_not-a-key")).rejects.toThrow();
  });
});
