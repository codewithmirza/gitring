/**
 * The three MCP endpoints: /mcp (the gitring tools), /mcp/github (GitHub-compatible tools) and
 * /mcp/readonly (the gitring tools that only read). Each endpoint is its own OAuth resource (RFC 9728
 * metadata, RFC 8707 binding): a token is good at the endpoint that it was made for, and at no other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MCP_PATH, audienceOk, canonicalResource, mcpSetOf } from "../../src/directory/oauth";
import { GITHUB_TOOLS } from "../../src/worker/mcp-github";
import { GITRING_TOOLS, toolSet } from "../../src/worker/mcp";
import { steViolations } from "../coord/ste";
import { ORIGIN, World } from "../github/harness";
import { callTool, legacyClient, makeProject, metadataProblems, modernCall, oauthTokens, send } from "./support";

const GITHUB_NAMES = [
  "get_me",
  "search_repositories",
  "get_file_contents",
  "get_repository_tree",
  "list_commits",
  "get_commit",
  "search_code",
  "list_branches",
  "create_branch",
  "push_files",
  "create_or_update_file",
  "delete_file",
  "create_pull_request",
  "pull_request_read",
  "list_pull_requests",
  "merge_pull_request",
  "update_pull_request_branch",
  "list_issues",
  "issue_read",
  "issue_write",
];
const READ_ONLY = ["gitring_intents", "gitring_list", "gitring_read", "gitring_traffic"];
const URL_OF = { gitring: `${ORIGIN}/mcp`, github: `${ORIGIN}/mcp/github`, readonly: `${ORIGIN}/mcp/readonly` } as const;

describe("resource rules", () => {
  it("knows the three paths, and no other", () => {
    expect(mcpSetOf("/mcp")).toBe("gitring");
    expect(mcpSetOf("/mcp/github")).toBe("github");
    expect(mcpSetOf("/mcp/readonly")).toBe("readonly");
    expect(mcpSetOf("/mcp/other")).toBeNull();
    expect(mcpSetOf("/mcp/github/")).toBeNull();
    expect(MCP_PATH).toEqual({ gitring: "/mcp", github: "/mcp/github", readonly: "/mcp/readonly" });
  });

  it("reads the address of the server as the default endpoint, and refuses a foreign resource", () => {
    expect(canonicalResource(ORIGIN, ORIGIN)).toBe(`${ORIGIN}/mcp`);
    expect(canonicalResource(`${ORIGIN}/`, ORIGIN)).toBe(`${ORIGIN}/mcp`);
    expect(canonicalResource(`${ORIGIN}/mcp/github/`, ORIGIN)).toBe(`${ORIGIN}/mcp/github`);
    expect(canonicalResource(`${ORIGIN}/mcp/other`, ORIGIN)).toBeNull();
    expect(canonicalResource("https://evil.example/mcp", ORIGIN)).toBeNull();
    expect(canonicalResource(`${ORIGIN}/mcp/github?x=1`, ORIGIN)).toBeNull();
  });

  it("binds a token to the exact endpoint, and a token with no resource to /mcp only", () => {
    for (const bound of Object.values(URL_OF)) {
      for (const called of Object.values(URL_OF)) expect(audienceOk(bound, ORIGIN, called), `${bound} at ${called}`).toBe(bound === called);
    }
    expect(audienceOk(null, ORIGIN, URL_OF.gitring)).toBe(true);
    expect(audienceOk(undefined, ORIGIN, URL_OF.github)).toBe(false);
    expect(audienceOk(null, ORIGIN, URL_OF.readonly)).toBe(false);
    expect(audienceOk(ORIGIN, ORIGIN, URL_OF.gitring)).toBe(true);
    expect(audienceOk(ORIGIN, ORIGIN, URL_OF.github)).toBe(false);
  });
});

describe("tool sets", () => {
  it("serves the gitring tools at /mcp, the read-only ones at /mcp/readonly and the GitHub ones at /mcp/github", () => {
    expect(toolSet("gitring").tools).toBe(GITRING_TOOLS);
    expect(toolSet("readonly").tools.map((t) => t.name).sort()).toEqual(READ_ONLY);
    expect(toolSet("github").tools).toBe(GITHUB_TOOLS);
  });

  it("has the GitHub tools, each name once, with the argument names of the GitHub tools", () => {
    expect(GITHUB_TOOLS.map((t) => t.name).sort()).toEqual([...GITHUB_NAMES].sort());
    const args = (name: string) => Object.keys(GITHUB_TOOLS.find((t) => t.name === name)!.inputSchema).sort();
    expect(args("get_file_contents")).toEqual(["owner", "path", "ref", "repo", "sha"]);
    expect(args("push_files")).toEqual(["branch", "files", "message", "owner", "repo"]);
    expect(args("create_or_update_file")).toEqual(["branch", "content", "message", "owner", "path", "repo", "sha"]);
    expect(args("delete_file")).toEqual(["branch", "message", "owner", "path", "repo"]);
    expect(args("create_branch")).toEqual(["branch", "from_branch", "owner", "repo"]);
    expect(args("create_pull_request")).toEqual(expect.arrayContaining(["owner", "repo", "title", "head", "base", "body", "draft"]));
    expect(args("pull_request_read")).toEqual(["after", "method", "owner", "page", "perPage", "pullNumber", "repo"]);
    expect(args("merge_pull_request")).toEqual(expect.arrayContaining(["owner", "repo", "pullNumber", "merge_method"]));
    expect(args("update_pull_request_branch")).toEqual(["expectedHeadSha", "owner", "pullNumber", "repo"]);
    expect(args("issue_read")).toEqual(["issue_number", "method", "owner", "page", "perPage", "repo"]);
    expect(args("search_repositories")).toEqual(expect.arrayContaining(["query", "page", "perPage"]));
  });

  it("gives every GitHub tool a title and all four hints", () => {
    expect(GITHUB_TOOLS.flatMap((t) => metadataProblems(t))).toEqual([]);
  });

  it("starts every GitHub tool description with the words GitHub-compatible", () => {
    for (const t of GITHUB_TOOLS) expect(t.description, t.name).toMatch(/^GitHub-compatible: /);
  });

  it("marks the GitHub tools that read, change, delete and merge", () => {
    const hints = (name: string) => GITHUB_TOOLS.find((t) => t.name === name)!.annotations;
    for (const name of ["get_me", "search_repositories", "get_file_contents", "get_repository_tree", "list_commits", "get_commit", "search_code", "list_branches", "pull_request_read", "list_pull_requests", "list_issues", "issue_read", "merge_pull_request"]) {
      expect(hints(name).readOnlyHint, name).toBe(true);
    }
    for (const name of ["create_branch", "push_files", "create_or_update_file", "delete_file", "create_pull_request", "update_pull_request_branch", "issue_write"]) {
      expect(hints(name).readOnlyHint, name).toBe(false);
    }
    // A write replaces text, and a delete removes a file: they can destroy earlier work. A branch, a pull request and a task only add.
    expect(GITHUB_TOOLS.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort()).toEqual(["create_or_update_file", "delete_file", "push_files", "update_pull_request_branch"]);
    expect(GITHUB_TOOLS.filter((t) => t.annotations.openWorldHint).map((t) => t.name)).toEqual(["create_pull_request"]);
  });

  it("uses plain words in the GitHub titles, descriptions and argument descriptions", () => {
    const problems: string[] = [];
    for (const t of GITHUB_TOOLS) {
      const texts = [t.title, t.description];
      const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        const n = node as Record<string, unknown>;
        if (typeof n.description === "string") texts.push(n.description);
        for (const v of Object.values(n)) walk(v);
      };
      walk(z.toJSONSchema(z.object(t.inputSchema)));
      for (const text of texts) for (const v of steViolations(text)) problems.push(`${t.name}: ${v}`);
      expect(t.title.split(/\s+/).length, t.name).toBeLessThanOrEqual(5);
    }
    expect(problems).toEqual([]);
    expect(steViolations(toolSet("github").instructions)).toEqual([]);
    expect(steViolations(toolSet("readonly").instructions)).toEqual([]);
  });
});

let world: World;
let key: string;
let userId: string;
let project: string;

beforeEach(async () => {
  world = new World();
  vi.stubGlobal("fetch", world.fetch);
  await world.init();
  world.person("alice", 1);
  ({ key, userId } = await world.signIn("alice"));
  project = await makeProject(world, key);
});
afterEach(() => vi.unstubAllGlobals());

const names = (res: { body: any }): string[] => (res.body.result.tools as { name: string }[]).map((t) => t.name).sort();

describe("OAuth metadata of each endpoint", () => {
  it("serves protected resource metadata (RFC 9728) for each endpoint, with the path of the endpoint", async () => {
    for (const [set, path] of Object.entries(MCP_PATH)) {
      const res = await world.call("GET", `/.well-known/oauth-protected-resource${path}`);
      expect(res.status, set).toBe(200);
      expect(res.json.resource).toBe(URL_OF[set as keyof typeof URL_OF]);
      expect(res.json.authorization_servers).toEqual([ORIGIN]);
      expect(res.json.scopes_supported).toEqual(expect.arrayContaining(["mcp"]));
    }
    const plain = await world.call("GET", "/.well-known/oauth-protected-resource");
    expect(plain.json.resource).toBe(URL_OF.gitring);
  });

  it("serves the authorization server metadata at the path of each endpoint too", async () => {
    for (const path of Object.values(MCP_PATH)) {
      const res = await world.call("GET", `/.well-known/oauth-authorization-server${path}`);
      expect(res.status, path).toBe(200);
      expect(res.json.issuer).toBe(ORIGIN);
      expect(res.json.scopes_supported).toEqual(expect.arrayContaining(["mcp", "offline_access"]));
    }
  });

  it("does not make resource metadata for a path that is not an endpoint", async () => {
    expect((await world.call("GET", "/.well-known/oauth-protected-resource/mcp/other")).status).toBe(404);
    expect((await world.call("GET", "/.well-known/oauth-protected-resource/api")).status).toBe(404);
  });

  it("points the 401 of each endpoint to the metadata of that endpoint", async () => {
    for (const [set, path] of Object.entries(MCP_PATH)) {
      const res = await modernCall(world, { path, method: "tools/list" });
      expect(res.status, set).toBe(401);
      // The read-only endpoint asks for the read-only scope. The others ask for the full scope.
      const scope = path === "/mcp/readonly" ? "mcp:read" : "mcp";
      expect(res.headers.get("www-authenticate"), set).toBe(`Bearer realm="gitring", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource${path}", scope="${scope}"`);
      const bad = await modernCall(world, { path, token: "gat_not-a-token", method: "tools/list" });
      expect(bad.status).toBe(401);
      expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(bad.headers.get("www-authenticate")).toContain(`oauth-protected-resource${path}"`);
    }
  });
});

describe("the audience of a token", () => {
  it("accepts a token at the endpoint that it was made for, and at no other endpoint", async () => {
    for (const bound of Object.keys(URL_OF) as (keyof typeof URL_OF)[]) {
      const tok = await oauthTokens(world, userId, URL_OF[bound]);
      for (const called of Object.keys(URL_OF) as (keyof typeof URL_OF)[]) {
        const res = await modernCall(world, { path: MCP_PATH[called], token: tok.access_token, method: "tools/list" });
        expect(res.status, `token for ${bound} at ${called}`).toBe(bound === called ? 200 : 401);
      }
    }
  });

  it("does not let a cached answer for one endpoint open another (the same token, both orders)", async () => {
    const tok = await oauthTokens(world, userId, URL_OF.github);
    expect((await modernCall(world, { path: "/mcp/github", token: tok.access_token, method: "tools/list" })).status).toBe(200);
    expect((await modernCall(world, { path: "/mcp", token: tok.access_token, method: "tools/list" })).status).toBe(401);
    expect((await modernCall(world, { path: "/mcp/github", token: tok.access_token, method: "tools/list" })).status).toBe(200);
    const other = await oauthTokens(world, userId, URL_OF.gitring);
    expect((await modernCall(world, { path: "/mcp", token: other.access_token, method: "tools/list" })).status).toBe(200);
    expect((await modernCall(world, { path: "/mcp/github", token: other.access_token, method: "tools/list" })).status).toBe(401);
    expect((await modernCall(world, { path: "/mcp/readonly", token: other.access_token, method: "tools/list" })).status).toBe(401);
  });

  it("accepts a token with no resource at /mcp only, as before", async () => {
    const tok = await oauthTokens(world, userId);
    expect((await modernCall(world, { path: "/mcp", token: tok.access_token, method: "tools/list" })).status).toBe(200);
    expect((await modernCall(world, { path: "/mcp/github", token: tok.access_token, method: "tools/list" })).status).toBe(401);
    expect((await modernCall(world, { path: "/mcp/readonly", token: tok.access_token, method: "tools/list" })).status).toBe(401);
  });

  it("reads the address of the server as /mcp (a client that asks for the origin)", async () => {
    const tok = await oauthTokens(world, userId, ORIGIN);
    expect((await modernCall(world, { path: "/mcp", token: tok.access_token, method: "tools/list" })).status).toBe(200);
    expect((await modernCall(world, { path: "/mcp/github", token: tok.access_token, method: "tools/list" })).status).toBe(401);
  });

  it("accepts a personal API key at all three endpoints (a key has no audience)", async () => {
    for (const path of Object.values(MCP_PATH)) expect((await modernCall(world, { path, token: key, method: "tools/list" })).status, path).toBe(200);
  });

  it("refuses a resource that is not one of the endpoints, at the authorization request", async () => {
    const reg = await world.dir.oauthRegister({ client_name: "Test", redirect_uris: ["http://localhost:4567/callback"], token_endpoint_auth_method: "none" });
    const started = await world.dir.oauthStart(
      { response_type: "code", client_id: String(reg.body.client_id), redirect_uri: "http://localhost:4567/callback", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: `${ORIGIN}/mcp/other` },
      ORIGIN,
    );
    expect(started.ok).toBe(false);
    const redirect = (started as { redirect: string }).redirect;
    expect(redirect).toContain("error=invalid_target");
    // The error says which resources exist.
    expect(decodeURIComponent(redirect)).toContain(`${ORIGIN}/mcp/github`);
  });

  it("refuses the code exchange for another resource than the one of the request", async () => {
    const reg = await world.dir.oauthRegister({ client_name: "Test", redirect_uris: ["http://localhost:4567/callback"], token_endpoint_auth_method: "none" });
    const clientId = String(reg.body.client_id);
    const { s256 } = await import("../../src/directory/oauth");
    const verifier = "v".repeat(20) + "-verifier-0123456789abcdefghijklmnop";
    const started = await world.dir.oauthStart({ response_type: "code", client_id: clientId, redirect_uri: "http://localhost:4567/callback", code_challenge: await s256(verifier), code_challenge_method: "S256", resource: URL_OF.github }, ORIGIN);
    if (!started.ok) throw new Error("authorize");
    const code = new URL((await world.dir.oauthApprove(started.request.id, userId, ORIGIN))!).searchParams.get("code")!;
    const wrong = await world.dir.oauthToken({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: "http://localhost:4567/callback", resource: URL_OF.gitring }, null, ORIGIN);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_target");
  });

  it("keeps the endpoint when a refresh token makes a new access token", async () => {
    const tok = await oauthTokens(world, userId, URL_OF.github);
    const next = await world.dir.oauthToken({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: tok.client_id }, null, ORIGIN);
    expect(next.status).toBe(200);
    const access = String(next.body.access_token);
    expect((await modernCall(world, { path: "/mcp/github", token: access, method: "tools/list" })).status).toBe(200);
    expect((await modernCall(world, { path: "/mcp", token: access, method: "tools/list" })).status).toBe(401);
    expect((await modernCall(world, { path: "/mcp/readonly", token: access, method: "tools/list" })).status).toBe(401);
  });
});

describe("the three endpoints", () => {
  it("lists the gitring tools at /mcp", async () => {
    expect(names(await modernCall(world, { token: key, method: "tools/list" }))).toEqual(GITRING_TOOLS.map((t) => t.name).sort());
  });

  it("lists only the tools that read at /mcp/readonly, each with the read-only hint", async () => {
    const res = await modernCall(world, { path: "/mcp/readonly", token: key, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(READ_ONLY);
    const tools = res.body.result.tools as { name: string; title?: string; annotations?: Record<string, unknown> }[];
    expect(tools.flatMap((t) => metadataProblems(t))).toEqual([]);
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    const found = await modernCall(world, { path: "/mcp/readonly", token: key, method: "server/discover" });
    expect(found.body.result.instructions).toMatch(/read-only/);
  });

  it("runs a read tool at /mcp/readonly, and cannot run a tool that changes work", async () => {
    const ok = await callTool(world, key, "gitring_intents", { project }, "/mcp/readonly");
    expect(ok.isError).toBe(false);
    expect(ok.text).toMatch(/0 open tasks/);
    for (const name of ["gitring_declare", "gitring_write", "gitring_submit", "gitring_check", "gitring_update", "gitring_ack", "gitring_log"]) {
      const res = await callTool(world, key, name, { project, attemptId: "a_x", files: [], plan: [], approach: "x", message: "x", summary: "x", correctionId: "c" }, "/mcp/readonly");
      // The tool is not there: a protocol error, or an error result. It is never a success.
      expect(res.rpc.body?.error !== undefined || res.isError, name).toBe(true);
      expect(res.text, name).not.toMatch(/Written|Conflict check|You are /);
    }
    // And it is still read-only after those calls: no work copy was made.
    const after = await callTool(world, key, "gitring_intents", { project }, "/mcp/readonly");
    expect(after.text).toMatch(/0 open tasks\. 0 work copies/);
  });

  it("lists the GitHub tools at /mcp/github, and the server instructions say how they work", async () => {
    const res = await modernCall(world, { path: "/mcp/github", token: key, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(names(res)).toEqual([...GITHUB_NAMES].sort());
    const tools = res.body.result.tools as { name: string; title?: string; description: string; annotations?: Record<string, unknown> }[];
    expect(tools.flatMap((t) => metadataProblems(t))).toEqual([]);
    for (const t of tools) {
      expect(t.annotations?.title, t.name).toBe(t.title);
      expect(t.description, t.name).toMatch(/^GitHub-compatible: /);
    }
    const found = await modernCall(world, { path: "/mcp/github", token: key, method: "server/discover" });
    expect(found.body.result.instructions).toMatch(/create_pull_request/);
  });

  it("keeps the gitring tools off /mcp/github and the GitHub tools off /mcp", async () => {
    const a = await callTool(world, key, "gitring_intents", { project }, "/mcp/github");
    expect(a.rpc.body?.error !== undefined || a.isError).toBe(true);
    const b = await callTool(world, key, "get_me", {}, "/mcp");
    expect(b.rpc.body?.error !== undefined || b.isError).toBe(true);
  });

  it("answers an unknown path below /mcp with 404 after the sign-in check", async () => {
    expect((await modernCall(world, { path: "/mcp/other", method: "tools/list" })).status).toBe(401);
    expect((await modernCall(world, { path: "/mcp/other", token: key, method: "tools/list" })).status).toBe(404);
  });

  it("answers the browser preflight of each endpoint", async () => {
    for (const path of Object.values(MCP_PATH)) {
      const res = await send(world, `${ORIGIN}${path}`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
      expect(res.status, path).toBeLessThan(300);
    }
  });

  it("connects with a client of the older era at /mcp/github and /mcp/readonly", async () => {
    const gh = await legacyClient(world, key, "/mcp/github");
    try {
      expect((await gh.listTools()).tools.map((t) => t.name).sort()).toEqual([...GITHUB_NAMES].sort());
      const me = await gh.callTool({ name: "get_me", arguments: {} });
      expect(((me.content as { text: string }[])[0].text)).toContain(project);
    } finally {
      await gh.close();
    }
    const ro = await legacyClient(world, key, "/mcp/readonly");
    try {
      expect((await ro.listTools()).tools.map((t) => t.name).sort()).toEqual(READ_ONLY);
    } finally {
      await ro.close();
    }
  });

  it("keeps the roles: a person with no access to a project cannot read it at any endpoint", async () => {
    world.person("mallory", 2);
    const mallory = await world.signIn("mallory");
    const tools: [string, string, Record<string, unknown>][] = [
      ["/mcp", "gitring_intents", { project }],
      ["/mcp/readonly", "gitring_intents", { project }],
      ["/mcp/github", "get_file_contents", { repo: project, path: "/" }],
      ["/mcp/github", "list_issues", { repo: project }],
    ];
    for (const [path, name, args] of tools) {
      const res = await callTool(world, mallory.key, name, args, path);
      expect(res.isError, `${path} ${name}`).toBe(true);
      expect(res.text, `${path} ${name}`).toMatch(/Unknown project|no access/);
    }
  });
});
