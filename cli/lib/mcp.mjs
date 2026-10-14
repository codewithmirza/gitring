/**
 * Calls one MCP tool of the server (JSON-RPC over HTTP) and reads the text and the JSON of its answer.
 * Called by the commands tasks and new. Read next: src/worker/cli.ts for the REST routes.
 * Never keep a session: each call is complete in itself (the stateless form of MCP 2026-07-28).
 */
import { MCP_VERSION, TOO_OLD, VERSION } from "./constants.mjs";
import { CliError } from "./errors.mjs";
import { http, isMissingRoute } from "./http.mjs";
import { okJson } from "./rest.mjs";
import { bearer } from "./session.mjs";

// ───── Reading an answer ─────

/** The last JSON block of a tool answer (the text has a headline, then JSON). */
export function lastJson(text) {
  const lines = String(text).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === "{" || lines[i] === "[") {
      try {
        return JSON.parse(lines.slice(i).join("\n"));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** The JSON-RPC message of an MCP answer: a JSON body, or the last "data:" line of an event stream. */
export function rpcMessage(text, contentType = "") {
  if (String(contentType).includes("text/event-stream")) {
    const data = String(text)
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    try {
      return data.length ? JSON.parse(data[data.length - 1]) : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The JSON-RPC body of one MCP tool call, in the stateless form (MCP 2026-07-28): no session, the envelope in _meta. */
export function toolCallBody(name, args, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "gitring-cli", version: VERSION },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

const MISSING_TOOL = /\b(not found|unknown tool|no such tool)\b/i;

/** Does an MCP error say that the server has no tool of this name (an older server)? */
export function isMissingTool(name, message) {
  const m = String(message ?? "");
  return m.includes(name) && MISSING_TOOL.test(m);
}

// ───── One tool call ─────

/** One MCP tool call. Answers the text of the tool and its JSON block. */
export async function tool(ctx, s, name, args) {
  const body = JSON.stringify(toolCallBody(name, args));
  const send = async (token) =>
    http(ctx, "POST", `${s.origin}/mcp`, {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": name,
      },
      body,
    });
  let res = await send(await bearer(ctx, s));
  if (res.status === 401 && s.kind === "oauth") res = await send(await bearer(ctx, s, true));
  const rpc = rpcMessage(res.text, res.headers?.get?.("content-type") ?? "");
  if (!rpc || (!rpc.result && !rpc.error)) {
    if (isMissingRoute(res)) throw new CliError(TOO_OLD);
    okJson(s, res);
    throw new CliError(`The MCP endpoint gave no answer (${res.status}).`);
  }
  if (rpc.error) {
    const msg = String(rpc.error.message ?? "");
    if (isMissingTool(name, msg)) throw new CliError(TOO_OLD);
    throw new CliError(msg || "The MCP endpoint refused the call.");
  }
  const text = String(rpc.result.content?.find?.((c) => c.type === "text")?.text ?? "");
  if (rpc.result.isError) {
    if (isMissingTool(name, text)) throw new CliError(TOO_OLD);
    throw new CliError(headline(text) || "The tool refused the call.");
  }
  return { text, json: lastJson(text) };
}

/** The words of a tool answer before its JSON block. */
export function headline(text) {
  const lines = String(text).split("\n");
  const end = lines.findIndex((l) => l === "{" || l === "[");
  return (end >= 0 ? lines.slice(0, end) : lines).join("\n").trim();
}
