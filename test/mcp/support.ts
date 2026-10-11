/**
 * Helpers for the MCP tests: a request to the real Worker with the Response back, one JSON-RPC call in
 * the 2026-07-28 era (stateless: the version, the client and its abilities travel in each request), and a
 * client of the older era (SDK 1.30: it starts with "initialize").
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { s256 } from "../../src/directory/oauth";
import worker from "../../src/worker/index";
import { ORIGIN, type World } from "../github/harness";

export const MODERN = "2026-07-28";

/** What a directory needs from a tool: a title, and all four hints (a boolean each). */
export function metadataProblems(t: { name: string; title?: string; annotations?: object }): string[] {
  const a = (t.annotations ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (!t.title || !t.title.trim()) problems.push(`${t.name}: no title`);
  for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    if (typeof a[hint] !== "boolean") problems.push(`${t.name}: no ${hint}`);
  }
  if (a.readOnlyHint === true && a.destructiveHint !== false) problems.push(`${t.name}: read-only and destructive`);
  return problems;
}

/** A request to the Worker. The Response is not read. */
export function send(world: World, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request && !init ? input : new Request(input instanceof Request ? input.url : input, init);
  const ctx = { waitUntil: (p: Promise<unknown>) => void world.pending.push(p.catch(() => undefined)), passThroughOnException() {}, props: {} };
  return worker.fetch(req, world.env as never, ctx as never);
}

/** The JSON-RPC answer of an MCP response: a JSON body, or the last message of an event stream. */
export async function messageOf(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return data.length ? JSON.parse(data[data.length - 1]) : null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface Rpc {
  status: number;
  headers: Headers;
  /** The JSON-RPC message (or the plain error body of the Worker). */
  body: any;
}

/** One call in the 2026-07-28 era: no session, the envelope in params._meta, the method and name in headers. */
export async function modernCall(
  world: World,
  opts: { path?: string; token?: string; method: string; params?: Record<string, unknown>; headers?: Record<string, string>; /** What the client says it can do. Default: nothing. */ capabilities?: Record<string, unknown> },
): Promise<Rpc> {
  const params = {
    ...(opts.params ?? {}),
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientInfo": { name: "gitring-test", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": opts.capabilities ?? {},
    },
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MODERN,
    "mcp-method": opts.method,
    ...(opts.method === "tools/call" ? { "mcp-name": String(opts.params?.name ?? "") } : {}),
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.headers ?? {}),
  };
  const res = await send(world, `${ORIGIN}${opts.path ?? "/mcp"}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: opts.method, params }) });
  return { status: res.status, headers: res.headers, body: await messageOf(res) };
}

/** A tool call in the 2026-07-28 era. Answers the text of the result. */
export async function callTool(world: World, token: string, name: string, args: Record<string, unknown>, path = "/mcp"): Promise<{ text: string; isError: boolean; rpc: Rpc }> {
  const rpc = await modernCall(world, { path, token, method: "tools/call", params: { name, arguments: args } });
  const result = rpc.body?.result;
  return { text: String(result?.content?.[0]?.text ?? ""), isError: Boolean(result?.isError), rpc };
}

/** An MCP client of the older era (SDK 1.30), connected to the Worker. It sends "initialize" first. */
export async function legacyClient(world: World, token: string, path = "/mcp"): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}${path}`), {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => send(world, input, init)) as typeof fetch,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "legacy-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** A project of this person (empty repository). Answers its id. `settings`: for example { checks: { runner: "worker" } } to run tests in the loader of the test world. */
export async function makeProject(world: World, key: string, name = "shop", settings?: Record<string, unknown>): Promise<string> {
  const made = await world.call("POST", "/api/projects", { key, body: { name, visibility: "private", source: { kind: "empty" }, ...(settings ? { settings } : {}) } });
  if (made.status !== 201) throw new Error(`project: ${made.text}`);
  return made.json.project.id as string;
}

const VERIFIER = "v".repeat(20) + "-verifier-0123456789abcdefghijklmnop";
const CALLBACK = "http://localhost:4567/callback";

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  client_id: string;
  scope: string;
}

/**
 * Tokens from the real OAuth flow of the Directory (register, authorize, approve, code exchange) for a
 * person. `resource`: the endpoint the token is for (RFC 8707). Leave it out for a token with no resource.
 * `scope`: the scopes that the app asks for (leave it out: none). `clientId`: an app that is registered already.
 */
export async function oauthTokens(world: World, userId: string, resource?: string, scope?: string, clientId?: string): Promise<OAuthTokens> {
  const id = clientId ?? String((await world.dir.oauthRegister({ client_name: "Test client", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" })).body.client_id);
  const started = await world.dir.oauthStart(
    { response_type: "code", client_id: id, redirect_uri: CALLBACK, code_challenge: await s256(VERIFIER), code_challenge_method: "S256", state: "s", resource, scope },
    ORIGIN,
  );
  if (!started.ok) throw new Error(`authorize: ${JSON.stringify(started)}`);
  const back = await world.dir.oauthApprove(started.request.id, userId, ORIGIN);
  const code = new URL(back!).searchParams.get("code")!;
  const tok = await world.dir.oauthToken({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: id, redirect_uri: CALLBACK, resource }, null, ORIGIN);
  if (tok.status !== 200) throw new Error(`token: ${JSON.stringify(tok.body)}`);
  return { ...(tok.body as unknown as OAuthTokens), client_id: id };
}
