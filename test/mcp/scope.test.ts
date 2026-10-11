/**
 * The OAuth scope mcp:read (read only) next to mcp (read and change). A token with only mcp:read can
 * call the tools that read (their read-only hint says so) and no other tool. A call that needs more gets
 * 403 with WWW-Authenticate error="insufficient_scope" and the scope that it needs. Tokens with the scope
 * mcp, and tokens made before the scope existed, keep working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessScope, MCP_PATH, scopeCovers } from "../../src/directory/oauth";
import { authorizationServerMetadata, consentAccess, mcpScopeChallenge } from "../../src/worker/oauth";
import { steViolations } from "../coord/ste";
import { ORIGIN, World } from "../github/harness";
import { callTool, makeProject, modernCall, oauthTokens, send } from "./support";

const URL_OF = { gitring: `${ORIGIN}/mcp`, github: `${ORIGIN}/mcp/github`, readonly: `${ORIGIN}/mcp/readonly` } as const;
const CHANGING = ["gitring_declare", "gitring_log", "gitring_write", "gitring_check", "gitring_submit", "gitring_ack", "gitring_update"];

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

const status = async (path: string, token: string, method = "tools/list", params?: Record<string, unknown>) => (await modernCall(world, { path, token, method, params })).status;

describe("the scope rules", () => {
  it("gives read only when the request asks for mcp:read alone, and the full scope in all other cases", () => {
    expect(accessScope(["mcp:read"])).toBe("mcp:read");
    expect(accessScope(["mcp:read", "offline_access"])).toBe("mcp:read");
    expect(accessScope(["mcp"])).toBe("mcp");
    expect(accessScope(["mcp", "mcp:read"])).toBe("mcp");
    // Older clients ask for no gitring scope, or for none at all: they get what they got before.
    expect(accessScope([])).toBe("mcp");
    expect(accessScope(["offline_access"])).toBe("mcp");
    expect(accessScope(["openid", "profile"])).toBe("mcp");
  });

  it("lets the full scope cover read only, and read only cover read only", () => {
    expect(scopeCovers("mcp", "mcp")).toBe(true);
    expect(scopeCovers("mcp", "mcp:read")).toBe(true);
    expect(scopeCovers("mcp:read", "mcp:read")).toBe(true);
    expect(scopeCovers("mcp:read", "mcp")).toBe(false);
    // A token with no scope on record is an older token: it has the full scope.
    expect(scopeCovers(null, "mcp")).toBe(true);
    expect(scopeCovers(undefined, "mcp:read")).toBe(true);
  });

  it("lists mcp:read in the OAuth metadata, and in the metadata of each endpoint", async () => {
    expect(authorizationServerMetadata(ORIGIN).scopes_supported).toEqual(["mcp", "mcp:read", "offline_access"]);
    for (const path of Object.values(MCP_PATH)) {
      const res = await world.call("GET", `/.well-known/oauth-protected-resource${path}`);
      expect(res.json.scopes_supported).toEqual(["mcp", "mcp:read"]);
    }
  });

  it("builds the 403 challenge with the error, the scope that is needed and the metadata of the endpoint", () => {
    expect(mcpScopeChallenge(ORIGIN, "/mcp/github")).toBe(
      `Bearer realm="gitring", error="insufficient_scope", scope="mcp", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/github", error_description="This tool changes data. The access token has the scope mcp:read. It needs the scope mcp."`,
    );
    expect(steViolations("This tool changes data. The access token has the scope mcp:read. It needs the scope mcp.")).toEqual([]);
  });

  it("says Read only or Read and change on the consent page", () => {
    expect(consentAccess("mcp:read").label).toBe("Read only");
    expect(consentAccess("mcp").label).toBe("Read and change");
    expect(consentAccess("mcp:read").can).toMatch(/cannot send plans, write code, run tests or ask gitring to merge/);
    expect(consentAccess("mcp").can).toMatch(/Send plans and write code to work copies/);
    for (const s of ["mcp", "mcp:read"]) expect(steViolations(consentAccess(s).can)).toEqual([]);
  });
});

describe("the tokens", () => {
  it("issues the scope that the request asks for", async () => {
    const cases: [string | undefined, string][] = [
      [undefined, "mcp"],
      ["mcp", "mcp"],
      ["mcp:read", "mcp:read"],
      ["mcp offline_access", "mcp"],
      ["mcp:read offline_access", "mcp:read"],
      ["offline_access", "mcp"],
      ["mcp mcp:read", "mcp"],
    ];
    for (const [asked, scope] of cases) expect((await oauthTokens(world, userId, undefined, asked)).scope, String(asked)).toBe(scope);
  });

  it("refuses a scope that gitring does not know", async () => {
    const reg = await world.dir.oauthRegister({ client_name: "Test", redirect_uris: ["http://localhost:4567/callback"], token_endpoint_auth_method: "none" });
    const started = await world.dir.oauthStart(
      { response_type: "code", client_id: String(reg.body.client_id), redirect_uri: "http://localhost:4567/callback", code_challenge: "x".repeat(43), code_challenge_method: "S256", scope: "mcp:admin" },
      ORIGIN,
    );
    expect(started.ok).toBe(false);
    expect((started as { redirect: string }).redirect).toContain("error=invalid_scope");
  });

  it("keeps the scope of a token when its refresh token makes a new one", async () => {
    const read = await oauthTokens(world, userId, undefined, "mcp:read");
    const next = await world.dir.oauthToken({ grant_type: "refresh_token", refresh_token: read.refresh_token, client_id: read.client_id }, null, ORIGIN);
    expect(next.status).toBe(200);
    expect(next.body.scope).toBe("mcp:read");
    const again = await world.dir.oauthToken({ grant_type: "refresh_token", refresh_token: String(next.body.refresh_token), client_id: read.client_id }, null, ORIGIN);
    expect(again.body.scope).toBe("mcp:read");
  });

  it("never widens a read-only sign-in through a wider grant of the same app", async () => {
    // The person allowed the app to read and change in one sign-in, and to read only in another.
    const full = await oauthTokens(world, userId, undefined, "mcp");
    const read = await oauthTokens(world, userId, undefined, "mcp:read", full.client_id);
    expect(read.scope).toBe("mcp:read");
    const next = await world.dir.oauthToken({ grant_type: "refresh_token", refresh_token: read.refresh_token, client_id: read.client_id }, null, ORIGIN);
    expect(next.body.scope).toBe("mcp:read");
    // The call with the new token still cannot change anything.
    const res = await modernCall(world, { token: String(next.body.access_token), method: "tools/call", params: { name: "gitring_declare", arguments: { project, newIntent: { title: "x", goal: "x" }, plan: [], files: [], approach: "x" } } });
    expect(res.status).toBe(403);
    // The sign-in with the full scope is still full.
    const fullNext = await world.dir.oauthToken({ grant_type: "refresh_token", refresh_token: full.refresh_token, client_id: full.client_id }, null, ORIGIN);
    expect(fullNext.body.scope).toBe("mcp");
  });

  it("asks the person again when a read-only grant meets a request to read and change, and not for the reverse", async () => {
    const read = await oauthTokens(world, userId, undefined, "mcp:read");
    expect(await world.dir.oauthHasGrant(userId, read.client_id, "mcp:read")).toBe(true);
    expect(await world.dir.oauthHasGrant(userId, read.client_id, "mcp")).toBe(false);
    // The person allows read and change: the grant is wider now, and covers both.
    await oauthTokens(world, userId, undefined, "mcp", read.client_id);
    expect(await world.dir.oauthHasGrant(userId, read.client_id, "mcp")).toBe(true);
    expect(await world.dir.oauthHasGrant(userId, read.client_id, "mcp:read")).toBe(true);
  });

  it("shows Read only or Read and change on the page where the person decides", async () => {
    world.signingIn = "alice";
    const url = await world.dir.signInUrl("github", ORIGIN, "/");
    const session = (await world.dir.finishSignIn("github", "code", new URL(url).searchParams.get("state")!)).token;
    const reg = await world.dir.oauthRegister({ client_name: "Test client", redirect_uris: ["http://localhost:4567/callback"], token_endpoint_auth_method: "none" });
    const page = async (scope?: string) => {
      const q = new URLSearchParams({ response_type: "code", client_id: String(reg.body.client_id), redirect_uri: "http://localhost:4567/callback", code_challenge: "c".repeat(43), code_challenge_method: "S256", ...(scope ? { scope } : {}) });
      return world.call("GET", `/oauth/authorize?${q}`, { headers: { cookie: `__Host-gitring=${session}` } });
    };
    const read = await page("mcp:read");
    expect(read.status).toBe(200);
    expect(read.text).toContain("Access: Read only");
    expect(read.text).toContain("It cannot send plans, write code, run tests or ask gitring to merge.");
    expect(read.text).not.toContain("Read and change");
    const full = await page("mcp");
    expect(full.text).toContain("Access: Read and change");
    expect((await page()).text).toContain("Access: Read and change");
  });
});

describe("a call with a read-only token", () => {
  it("lists all tools, and runs the tools that read, at every endpoint", async () => {
    const tok = await oauthTokens(world, userId, URL_OF.gitring, "mcp:read");
    expect(await status("/mcp", tok.access_token)).toBe(200);
    const mine = await callTool(world, tok.access_token, "gitring_intents", { project });
    expect(mine.isError).toBe(false);
    expect(mine.text).toMatch(/0 open tasks/);
    const gh = await oauthTokens(world, userId, URL_OF.github, "mcp:read");
    for (const [name, args] of [
      ["get_me", {}],
      ["get_file_contents", { repo: project, path: "/" }],
      ["list_branches", { repo: project }],
      ["list_issues", { repo: project }],
      ["search_repositories", { query: "shop" }],
    ] as [string, Record<string, unknown>][]) {
      const res = await callTool(world, gh.access_token, name, args, "/mcp/github");
      expect(res.rpc.status, name).toBe(200);
      expect(res.isError, `${name}: ${res.text}`).toBe(false);
    }
    const ro = await oauthTokens(world, userId, URL_OF.readonly, "mcp:read");
    expect((await callTool(world, ro.access_token, "gitring_intents", { project }, "/mcp/readonly")).isError).toBe(false);
  });

  it("answers 403 insufficient_scope to a tool that changes data, with the scope that it needs", async () => {
    const tok = await oauthTokens(world, userId, URL_OF.gitring, "mcp:read");
    const res = await modernCall(world, { token: tok.access_token, method: "tools/call", params: { name: "gitring_declare", arguments: { project, newIntent: { title: "Add a greeting", goal: "Say hello." }, plan: ["x"], files: ["a.txt"], approach: "One file." } } });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer realm="gitring", error="insufficient_scope", scope="mcp", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", error_description="This tool changes data. The access token has the scope mcp:read. It needs the scope mcp."`,
    );
    expect(res.body).toMatchObject({ error: "insufficient_scope" });
    // The call did nothing: no task, no work copy.
    const after = await callTool(world, key, "gitring_intents", { project });
    expect(after.text).toMatch(/0 open tasks\. 0 work copies/);
  });

  it("answers 403 for every tool that does not only read, in the gitring set", async () => {
    const tok = await oauthTokens(world, userId, URL_OF.gitring, "mcp:read");
    for (const name of CHANGING) {
      const res = await modernCall(world, { token: tok.access_token, method: "tools/call", params: { name, arguments: { project, attemptId: "a_x" } } });
      expect(res.status, name).toBe(403);
      expect(res.headers.get("www-authenticate"), name).toContain('error="insufficient_scope"');
    }
  });

  it("answers 403 for the GitHub tools that change data, and runs the one that only reports", async () => {
    const tok = await oauthTokens(world, userId, URL_OF.github, "mcp:read");
    for (const [name, args] of [
      ["create_branch", { repo: project, branch: "x" }],
      ["push_files", { repo: project, branch: "x", message: "x", files: [{ path: "a", content: "a" }] }],
      ["create_or_update_file", { repo: project, branch: "x", path: "a", content: "a", message: "x" }],
      ["delete_file", { repo: project, branch: "x", path: "a", message: "x" }],
      ["create_pull_request", { repo: project, title: "x", head: "x", base: "main" }],
      ["update_pull_request_branch", { repo: project, pullNumber: 1 }],
      ["issue_write", { repo: project, method: "create", title: "x" }],
    ] as [string, Record<string, unknown>][]) {
      const res = await modernCall(world, { path: "/mcp/github", token: tok.access_token, method: "tools/call", params: { name, arguments: args } });
      expect(res.status, name).toBe(403);
      expect(res.headers.get("www-authenticate"), name).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/github"`);
    }
    // merge_pull_request only reports: its hint says read-only. It never merges.
    const merge = await callTool(world, tok.access_token, "merge_pull_request", { repo: project, pullNumber: 1 }, "/mcp/github");
    expect(merge.rpc.status).toBe(200);
    expect(merge.text).toMatch(/does not exist, or it is not yours/);
    const branches = await callTool(world, key, "list_branches", { repo: project }, "/mcp/github");
    expect(branches.text).toMatch(/1 branches\. Main and 0 of yours/);
  });

  it("answers 403 when a batch holds a call that changes data", async () => {
    const tok = await oauthTokens(world, userId, URL_OF.gitring, "mcp:read");
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok.access_token}` };
    const call = (id: number, name: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { project } } });
    const res = await send(world, `${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify([call(1, "gitring_intents"), call(2, "gitring_write")]) });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("does not stop a name that is not a tool (the handler answers it), or a body that is not JSON", async () => {
    const tok = await oauthTokens(world, userId, URL_OF.gitring, "mcp:read");
    const unknown = await modernCall(world, { token: tok.access_token, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
    expect(unknown.status).not.toBe(403);
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok.access_token}` };
    const garbage = await send(world, `${ORIGIN}/mcp`, { method: "POST", headers, body: "not json" });
    expect(garbage.status).not.toBe(403);
    const preflight = await send(world, `${ORIGIN}/mcp`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
    expect(preflight.status).toBeLessThan(300);
  });
});

describe("tokens with the full scope", () => {
  it("keep working at every tool: the scope mcp, and an older token with no scope on record", async () => {
    const full = await oauthTokens(world, userId, URL_OF.gitring, "mcp");
    const plan = await callTool(world, full.access_token, "gitring_declare", { project, newIntent: { title: "Add a greeting", goal: "Say hello." }, plan: ["x"], files: ["a.txt"], approach: "One file." });
    expect(plan.rpc.status).toBe(200);
    expect(plan.isError, plan.text).toBe(false);
    // An older token has no scope on record.
    const older = await oauthTokens(world, userId);
    (world.dir as unknown as { sql: { exec(q: string): unknown } }).sql.exec("UPDATE oauth_tokens SET scope = NULL");
    const again = await callTool(world, older.access_token, "gitring_declare", { project, newIntent: { title: "Add a farewell", goal: "Say goodbye." }, plan: ["x"], files: ["b.txt"], approach: "One file." });
    expect(again.rpc.status).toBe(200);
    expect(again.isError, again.text).toBe(false);
    // And its refresh token makes a token with the full scope.
    const next = await world.dir.oauthToken({ grant_type: "refresh_token", refresh_token: older.refresh_token, client_id: older.client_id }, null, ORIGIN);
    expect(next.body.scope).toBe("mcp");
  });

  it("do not change for a personal API key: a key has no scope", async () => {
    for (const path of Object.values(MCP_PATH)) expect(await status(path, key), path).toBe(200);
    const plan = await callTool(world, key, "gitring_declare", { project, newIntent: { title: "Add a greeting", goal: "Say hello." }, plan: ["x"], files: ["a.txt"], approach: "One file." });
    expect(plan.isError, plan.text).toBe(false);
  });
});
