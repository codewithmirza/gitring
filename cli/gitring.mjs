#!/usr/bin/env node
/**
 * gitring: the command line for people (plain Node 20 or later, no dependency).
 *
 *   gitring login [--server URL] [--open]     sign in with a code (OAuth device grant, RFC 8628)
 *   gitring logout | whoami
 *   gitring projects | new <name> | clone <project> [folder]
 *   gitring tasks <project> | task <project> "title" "goal"
 *   gitring inbox | yes <item> ["note"] | back <item> "note"
 *   gitring watch <project>                   the live log of a project (WebSocket)
 *
 * The sign-in gives an OAuth token for the MCP endpoint of the server. The token works for the REST routes
 * of these commands too (src/worker/cli.ts). It is stored in the config folder of the person
 * (credentials.json, mode 0600), never printed. Scripts set GITRING_URL and GITRING_TOKEN (a personal API
 * key) instead of a sign-in.
 *
 * Calls: the MCP endpoint (JSON-RPC over HTTP, the stateless 2026-07-28 form) for tasks and for new
 * projects from a template or a description; REST for the rest. A route that the server does not have
 * yet gives "This gitring server is too old for this command."
 */
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION = "0.9.2";
/** gitring's own OAuth client (every gitring knows it: src/directory/device.ts). */
export const CLIENT_ID = "gitring-cli";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const MCP_VERSION = "2026-07-28";
export const TOO_OLD = "This gitring server is too old for this command.";
export const CREDENTIALS_FILE = "credentials.json";

export const USAGE = [
  "gitring: the command line for people who work with agents on gitring.",
  "",
  "Usage: gitring <command> [options]",
  "",
  "Commands:",
  "  login [--server URL] [--open]     Sign in. You type a code in your browser.",
  "  logout                            Sign out on this computer.",
  "  whoami                            Show your name and your server.",
  "  projects                          List your projects.",
  "  new <name> [--template NAME] [--describe TEXT] [--public]",
  "                                    Make a project. With --describe, gitring also makes the first task and starts an agent.",
  "  clone <project> [folder]          Clone a project with git. gitring does not save the read token in the folder.",
  "  tasks <project>                   List the open tasks of a project.",
  '  task <project> "title" "goal"     Make a task. Agents can take it.',
  "  inbox                             List the items that wait for you in all your projects.",
  '  yes <item> ["note"]               Say yes to a merge question from your inbox.',
  '  back <item> "note"                Send the work back to the agent. The note tells the agent what to change.',
  "  watch <project>                   Show the log of a project live. Press Ctrl+C to stop.",
  "",
  "Options:",
  "  --server URL    The address of your gitring. The default is the server of your last sign-in.",
  "  --json          Show the answer as JSON.",
  "  -h, --help      Show this help.",
  "  --version       Show the version.",
  "",
  "Environment:",
  "  GITRING_URL     The address of your gitring, as with --server.",
  "  GITRING_TOKEN   A personal API key for scripts. Then you need no sign-in.",
  "",
  "Answers to merge questions:",
  "  An answer from the command line counts as your answer only when you allow answers outside the gitring app.",
  '  You set this in the gitring app: Account, "Where do you answer merge questions?".',
  '  With "In the gitring app", answer in the app. The command line shows the link.',
];

export class CliError extends Error {
  /** 1: the command did not finish. 2: the command line is wrong. */
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/* ───────────────────────── arguments ───────────────────────── */

/** Each command: the number of arguments (min, max), the usage line, and the options it takes. */
const SPEC = {
  login: { min: 0, max: 0, usage: "gitring login [--server URL] [--open]", flags: ["open"] },
  logout: { min: 0, max: 0, usage: "gitring logout" },
  whoami: { min: 0, max: 0, usage: "gitring whoami" },
  projects: { min: 0, max: 0, usage: "gitring projects" },
  new: { min: 1, max: 1, usage: "gitring new <name> [--template NAME] [--describe TEXT] [--public]", flags: ["template", "describe", "public"], missing: "Give a name for the project" },
  clone: { min: 1, max: 2, usage: "gitring clone <project> [folder]", missing: "Give a project" },
  tasks: { min: 1, max: 1, usage: "gitring tasks <project>", missing: "Give a project" },
  task: { min: 3, max: 3, usage: 'gitring task <project> "title" "goal"', missing: "Give a project, a title and a goal" },
  inbox: { min: 0, max: 0, usage: "gitring inbox" },
  yes: { min: 1, max: 2, usage: 'gitring yes <item> ["note"]', missing: "Give an item from gitring inbox" },
  back: { min: 2, max: 2, usage: 'gitring back <item> "note"', missing: "Give an item and a note. The note tells the agent what to change" },
  watch: { min: 1, max: 1, usage: "gitring watch <project>", missing: "Give a project" },
};
const VALUE_FLAGS = new Set(["server", "template", "describe"]);
const BOOL_FLAGS = new Set(["json", "open", "public", "help", "version"]);
/** Options that every command takes. */
const COMMON = new Set(["server", "json", "help", "version"]);

/** Read the command line. Throws CliError (code 2) with plain words when it is wrong. */
export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--") {
      rest.push(...argv.slice(i + 1).map(String));
      break;
    }
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (!a.startsWith("--") || a === "--") {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (eq < 0 && String(value).startsWith("--"))) throw new CliError(`--${name} needs a value.`, 2);
      flags[name] = String(value);
    } else if (BOOL_FLAGS.has(name) && eq < 0) {
      flags[name] = true;
    } else {
      throw new CliError(`Unknown option ${a}.`, 2);
    }
  }
  if (!rest.length) return { command: flags.version && !flags.help ? "version" : "help", args: [], flags };
  const [command, ...args] = rest;
  if (command === "help") return { command: "help", args: [], flags };
  const spec = SPEC[command];
  if (!spec) throw new CliError(`Unknown command ${command}.`, 2);
  if (flags.help) return { command: "help", args: [], flags };
  for (const f of Object.keys(flags)) {
    if (!COMMON.has(f) && !(spec.flags ?? []).includes(f)) throw new CliError(`gitring ${command} does not take --${f}. Use: ${spec.usage}`, 2);
  }
  if (args.length < spec.min) throw new CliError(`${spec.missing}. Use: ${spec.usage}`, 2);
  if (args.length > spec.max) throw new CliError(`Too many arguments. Use: ${spec.usage}`, 2);
  if (args.some((x) => !x.trim())) throw new CliError(`An argument is empty. Use: ${spec.usage}`, 2);
  return { command, args, flags };
}

/* ───────────────────────── server, config, credentials ───────────────────────── */

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** The origin of a server address. https, or http to this computer only (a token never goes over plain http). */
export function serverOrigin(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    throw new CliError("The server address is not a web address. Use https://your-gitring.example.com.", 2);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.test(u.hostname))) {
    throw new CliError("Use https in the server address. The command line uses http only for localhost.", 2);
  }
  return u.origin;
}

/** The config folder of the person: GITRING_CONFIG_DIR, else the place that the system uses for app settings. */
export function configDir(env, platform, home) {
  if (env.GITRING_CONFIG_DIR) return env.GITRING_CONFIG_DIR;
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "gitring");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "gitring");
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), "gitring");
}

function joinIn(dir, file) {
  return dir.includes("\\") && !dir.includes("/") ? win32.join(dir, file) : posix.join(dir.replace(/\\/g, "/"), file);
}

/** The stored sign-ins: one per server, and the server of the last sign-in. */
export function readCredentials(dir) {
  try {
    const raw = JSON.parse(readFileSync(joinIn(dir, CREDENTIALS_FILE), "utf8"));
    if (raw && raw.version === 1 && raw.servers && typeof raw.servers === "object") return { version: 1, current: raw.current ?? null, servers: raw.servers };
  } catch {
    /* no file, or a file that is not ours */
  }
  return { version: 1, current: null, servers: {} };
}

/** Write the sign-ins. Only the person can read the file (mode 0600, folder 0700). */
export function writeCredentials(dir, creds) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = joinIn(dir, CREDENTIALS_FILE);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/* ───────────────────────── HTTP ───────────────────────── */

/** One HTTP call. A network failure becomes a CliError with plain words. */
async function http(ctx, method, url, { headers = {}, body } = {}) {
  let res;
  try {
    res = await ctx.fetch(url, { method, headers: { "user-agent": `gitring-cli/${VERSION}`, ...headers }, body });
  } catch (e) {
    throw new CliError(`The command line could not reach ${new URL(url).origin}. Check the address and your network. (${e?.message ?? e})`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

function postForm(ctx, url, fields) {
  return http(ctx, "POST", url, { headers: FORM, body: new URLSearchParams(fields).toString() });
}

/** A server answer that is not JSON at a route that a newer server has: the route does not exist here. */
function isMissingRoute(res) {
  return res.status === 404 && !(res.json && typeof res.json === "object" && ("error" in res.json || "message" in res.json));
}

/** The plain words of an error answer. */
function errorText(res) {
  const j = res.json;
  if (j && typeof j === "object") {
    const words = j.error_description ?? j.message ?? j.error;
    if (typeof words === "string" && words) return words;
  }
  return `The server answered ${res.status}.`;
}

/* ───────────────────────── who calls ───────────────────────── */

/** The server and the credential of this call: GITRING_TOKEN (a key), or the stored sign-in. */
function session(ctx) {
  const key = ctx.env.GITRING_TOKEN;
  if (key) {
    const raw = ctx.flags.server ?? ctx.env.GITRING_URL;
    if (!raw) throw new CliError("GITRING_TOKEN is set. Set GITRING_URL or --server to the address of your gitring too.", 2);
    return { origin: serverOrigin(raw), kind: "key", token: key };
  }
  const creds = readCredentials(ctx.configDir);
  const raw = ctx.flags.server ?? ctx.env.GITRING_URL ?? creds.current;
  if (!raw) throw new CliError("Sign in first: gitring login --server https://your-gitring.example.com");
  const origin = serverOrigin(raw);
  if (!creds.servers[origin]) throw new CliError(`You are not signed in to ${origin}. Run: gitring login --server ${origin}`);
  return { origin, kind: "oauth" };
}

/** The access token of a sign-in, renewed when it ends within a minute (or now, with `force`). */
async function bearer(ctx, s, force = false) {
  if (s.kind === "key") return s.token;
  const entry = readCredentials(ctx.configDir).servers[s.origin];
  if (!entry) throw new CliError(`You are not signed in to ${s.origin}. Run: gitring login --server ${s.origin}`);
  if (!force && Number(entry.expiresAt) - ctx.now() > 60_000) return entry.accessToken;
  const res = await postForm(ctx, `${s.origin}/oauth/token`, { grant_type: "refresh_token", refresh_token: entry.refreshToken, client_id: CLIENT_ID });
  if (res.status !== 200 || !res.json?.access_token) {
    if (res.json?.error === "invalid_grant" || res.json?.error === "invalid_client") {
      forget(ctx, s.origin);
      throw new CliError(`Your sign-in to ${s.origin} ended. Run: gitring login --server ${s.origin}`);
    }
    throw new CliError(`The command line could not renew your sign-in. ${errorText(res)} Try again.`);
  }
  remember(ctx, s.origin, { ...entry, ...tokensOf(ctx, res.json) });
  return res.json.access_token;
}

function tokensOf(ctx, t) {
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: ctx.now() + Number(t.expires_in ?? 3600) * 1000, scope: t.scope ?? "mcp" };
}

function remember(ctx, origin, entry, makeCurrent = false) {
  const creds = readCredentials(ctx.configDir);
  creds.servers[origin] = entry;
  if (makeCurrent || !creds.current) creds.current = origin;
  writeCredentials(ctx.configDir, creds);
}

function forget(ctx, origin) {
  const creds = readCredentials(ctx.configDir);
  if (!creds.servers[origin]) return false;
  delete creds.servers[origin];
  if (creds.current === origin) creds.current = Object.keys(creds.servers)[0] ?? null;
  writeCredentials(ctx.configDir, creds);
  return true;
}

/** A REST call with the credential. A 401 with a sign-in renews the token once. */
async function rest(ctx, s, method, path, body) {
  const send = async (token) =>
    http(ctx, method, `${s.origin}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let res = await send(await bearer(ctx, s));
  if (res.status === 401 && s.kind === "oauth") res = await send(await bearer(ctx, s, true));
  return res;
}

/** The JSON of a REST answer that worked; else a CliError with the words of the server. */
function okJson(s, res) {
  if (res.status >= 200 && res.status < 300) return res.json;
  if (isMissingRoute(res)) throw new CliError(TOO_OLD);
  if (res.status === 401) {
    throw new CliError(s.kind === "key" ? "The key in GITRING_TOKEN is not valid." : `Your sign-in to ${s.origin} does not work for this. Run: gitring login --server ${s.origin}`);
  }
  throw new CliError(errorText(res));
}

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

/** One MCP tool call. Answers the text of the tool and its JSON block. */
async function tool(ctx, s, name, args) {
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
function headline(text) {
  const lines = String(text).split("\n");
  const end = lines.findIndex((l) => l === "{" || l === "[");
  return (end >= 0 ? lines.slice(0, end) : lines).join("\n").trim();
}

/* ───────────────────────── words ───────────────────────── */

const TASK_WORDS = {
  draft: "Draft",
  open: "Open",
  underway: "Agents work on it",
  judging: "Needs a person",
  landing: "In the merge queue",
  landed: "Merged",
  parked: "Paused",
  "merged-into": "Duplicate",
};

/** "3 minutes", "2 hours", "4 days". */
export function age(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "less than a minute";
  if (m < 60) return m === 1 ? "1 minute" : `${m} minutes`;
  const h = Math.floor(m / 60);
  if (h < 48) return h === 1 ? "1 hour" : `${h} hours`;
  return `${Math.floor(h / 24)} days`;
}

/** Rows of text in columns. */
function table(rows) {
  if (!rows.length) return [];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? String(cell ?? "") : String(cell ?? "").padEnd(widths[i]))).join("  ").trimEnd());
}

function clock(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** A short title from a description: its first sentence, at most 80 characters. */
export function titleFrom(text) {
  const first = String(text).trim().split(/(?<=[.!?])\s|\n/)[0].replace(/[.!?]+$/, "").trim();
  return first.length > 80 ? `${first.slice(0, 77).trimEnd()}...` : first;
}

/* ───────────────────────── commands ───────────────────────── */

async function login(ctx) {
  const creds = readCredentials(ctx.configDir);
  const raw = ctx.flags.server ?? ctx.env.GITRING_URL ?? creds.current;
  if (!raw) throw new CliError("Give the address of your gitring: gitring login --server https://your-gitring.example.com", 2);
  const origin = serverOrigin(raw);
  const start = await postForm(ctx, `${origin}/oauth/device_authorization`, { client_id: CLIENT_ID, scope: "mcp", resource: `${origin}/mcp` });
  if (isMissingRoute(start)) throw new CliError(TOO_OLD);
  if (start.status !== 200 || !start.json?.device_code) throw new CliError(`gitring did not start the sign-in. ${errorText(start)}`);
  const d = start.json;
  const page = d.verification_uri_complete ?? d.verification_uri;
  ctx.out("Open this page in a browser, and sign in to gitring:");
  ctx.out(`  ${page}`);
  ctx.out(`Check that the page shows this code: ${d.user_code}`);
  ctx.out(`The code works for ${Math.max(1, Math.round(Number(d.expires_in ?? 600) / 60))} minutes. The command line waits for your answer.`);
  if (ctx.flags.open) ctx.openUrl(page);
  let interval = Math.max(1, Number(d.interval) || 5);
  const deadline = ctx.now() + Number(d.expires_in ?? 600) * 1000;
  let faults = 0;
  for (;;) {
    await ctx.sleep(interval * 1000);
    if (ctx.now() > deadline) throw new CliError("The code expired. Run gitring login again.");
    let res;
    try {
      res = await postForm(ctx, `${origin}/oauth/token`, { grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: CLIENT_ID });
    } catch (e) {
      // A short network fault: ask again. Many faults in a row stop the sign-in.
      if (++faults >= 5) throw e;
      continue;
    }
    if (res.status === 200 && res.json?.access_token) {
      remember(ctx, origin, { clientId: CLIENT_ID, ...tokensOf(ctx, res.json) }, true);
      break;
    }
    const code = res.json?.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval += 5;
      continue;
    }
    if (code === "access_denied") throw new CliError("You stopped the sign-in in the browser. The command line got no access.");
    if (code === "expired_token") throw new CliError("The code expired. Run gitring login again.");
    if ((res.status >= 500 || res.status === 429) && ++faults < 5) continue;
    throw new CliError(`gitring refused the sign-in. ${errorText(res)}`);
  }
  const s = { origin, kind: "oauth" };
  const me = okJson(s, await rest(ctx, s, "GET", "/api/me"));
  const name = me?.user?.name ?? "you";
  const entry = readCredentials(ctx.configDir).servers[origin];
  remember(ctx, origin, { ...entry, user: name }, true);
  ctx.out(`You are signed in to ${origin} as ${name}.`);
  return 0;
}

async function logout(ctx) {
  const creds = readCredentials(ctx.configDir);
  const raw = ctx.flags.server ?? ctx.env.GITRING_URL ?? creds.current;
  if (!raw) {
    ctx.out("You are not signed in.");
    return 0;
  }
  const origin = serverOrigin(raw);
  const entry = creds.servers[origin];
  if (!entry) {
    ctx.out(`You are not signed in to ${origin}.`);
    return 0;
  }
  // End the sign-in on the server too (RFC 7009). The refresh token ends all tokens of this sign-in.
  let revoked = false;
  try {
    const res = await postForm(ctx, `${origin}/oauth/revoke`, { token: entry.refreshToken, token_type_hint: "refresh_token", client_id: CLIENT_ID });
    revoked = res.status === 200;
  } catch {
    revoked = false;
  }
  forget(ctx, origin);
  ctx.out(`You are signed out of ${origin}.`);
  if (!revoked) ctx.out("The server did not confirm the end of the sign-in. To end it there, open Account, Connected apps in gitring.");
  return 0;
}

async function whoami(ctx) {
  const s = session(ctx);
  const me = okJson(s, await rest(ctx, s, "GET", "/api/me"));
  if (ctx.flags.json) return printJson(ctx, { server: s.origin, user: me?.user ?? null, via: s.kind });
  if (!me?.user) throw new CliError(`The server does not know this sign-in. Run: gitring login --server ${s.origin}`);
  ctx.out(`${me.user.name} on ${s.origin}${s.kind === "key" ? " (personal API key)" : ""}`);
  return 0;
}

async function projects(ctx) {
  const s = session(ctx);
  const list = okJson(s, await rest(ctx, s, "GET", "/api/projects")) ?? [];
  if (ctx.flags.json) return printJson(ctx, list);
  if (!list.length) {
    ctx.out("You have no projects. Make one: gitring new <name>");
    return 0;
  }
  for (const line of table([["PROJECT", "ROLE", "NAME"], ...list.map((p) => [p.id, p.role ?? "", p.name])])) ctx.out(line);
  return 0;
}

async function newProject(ctx, [name]) {
  const s = session(ctx);
  const visibility = ctx.flags.public ? "public" : "private";
  const { template, describe } = ctx.flags;
  if (template || describe) {
    // A template or a description: the MCP tool of agent-first projects (contract C5) does it in one call.
    const args = {
      name,
      visibility,
      start: template ? { kind: "template", template } : { kind: "empty" },
      ...(describe ? { description: describe, firstTask: { title: titleFrom(describe), goal: describe }, launch: 1 } : {}),
    };
    const res = await tool(ctx, s, "gitring_create_project", args);
    if (ctx.flags.json) return printJson(ctx, res.json ?? { text: res.text });
    ctx.out(headline(res.text));
    return 0;
  }
  const made = okJson(s, await rest(ctx, s, "POST", "/api/projects", { name, visibility, source: { kind: "empty" } }));
  const id = made?.project?.id;
  if (!id) throw new CliError("The server did not say the id of the new project.");
  if (ctx.flags.json) return printJson(ctx, made.project);
  ctx.out(`gitring made the project ${id} (${visibility}).`);
  ctx.out(`Open it: ${s.origin}/overview?project=${encodeURIComponent(id)}`);
  ctx.out(`Make a task: gitring task ${id} "title" "goal"`);
  return 0;
}

/** The git header for a read token of Artifacts (Basic, user "x"). The token text can end in "?expires=…". */
export function gitAuthHeader(token) {
  const secret = String(token).split("?expires=")[0];
  return `Authorization: Basic ${Buffer.from(`x:${secret}`).toString("base64")}`;
}

async function clone(ctx, [project, folder]) {
  const s = session(ctx);
  const access = okJson(s, await rest(ctx, s, "POST", `/api/projects/${encodeURIComponent(project)}/clone-token`, {}));
  if (!access?.remote || !access?.token) throw new CliError("The server did not give a clone address.");
  const dir = folder ?? project;
  if (ctx.flags.json) return printJson(ctx, { project, remote: access.remote, folder: dir, ...(access.expiresAt ? { expiresAt: access.expiresAt } : {}) });
  ctx.out(`gitring runs: git clone ${access.remote} ${dir}`);
  // The token goes to git in the environment (git 2.31 or later), not in the command line or the folder.
  const code = await ctx.run("git", ["clone", access.remote, dir], {
    env: { ...ctx.processEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: gitAuthHeader(access.token), GIT_TERMINAL_PROMPT: "0" },
  });
  if (code !== 0) throw new CliError("git clone did not finish. Check that git 2.31 or later is installed, and read the git message above.");
  ctx.out(`gitring cloned ${project} into ${dir}. The read token is not in the folder.`);
  return 0;
}

async function tasks(ctx, [project]) {
  const s = session(ctx);
  const res = await tool(ctx, s, "gitring_intents", { project });
  const list = res.json?.intents ?? [];
  if (ctx.flags.json) return printJson(ctx, res.json ?? { intents: [] });
  if (!list.length) {
    ctx.out(`${project} has no open tasks. Make one: gitring task ${project} "title" "goal"`);
    return 0;
  }
  for (const line of table([["TASK", "STATUS", "AGENTS", "TITLE"], ...list.map((t) => [t.id, TASK_WORDS[t.status] ?? t.status, String(t.attempts ?? 0), t.title])])) ctx.out(line);
  return 0;
}

async function task(ctx, [project, title, goal]) {
  const s = session(ctx);
  const made = okJson(s, await rest(ctx, s, "POST", `/api/projects/${encodeURIComponent(project)}/intents`, { title, goal }));
  if (ctx.flags.json) return printJson(ctx, made);
  if (!made?.id) throw new CliError("The server did not say the id of the new task.");
  ctx.out(`gitring made the task ${made.id}: ${made.title ?? title}. Agents can take it now.`);
  return 0;
}

async function inboxItems(ctx, s) {
  const res = okJson(s, await rest(ctx, s, "GET", "/api/me/inbox"));
  return Array.isArray(res?.items) ? res.items : [];
}

async function inbox(ctx) {
  const s = session(ctx);
  const items = await inboxItems(ctx, s);
  if (ctx.flags.json) return printJson(ctx, { items });
  if (!items.length) {
    ctx.out("No item waits for you.");
    return 0;
  }
  const now = ctx.now();
  for (const it of items) {
    ctx.out(`${it.key}  ${it.projectName ?? it.project}  ${it.headline ?? it.title}  (${age(now - Number(it.at ?? now))})`);
    if (it.title && it.headline) ctx.out(`  Task: ${it.title}${it.agent ? `. Agent: ${it.agent}` : ""}${it.line ? `. ${it.line}` : ""}`);
    for (const why of (it.why ?? []).slice(0, 3)) ctx.out(`  ${why}`);
    if (it.kind === "approval" || it.kind === "stopped") ctx.out(`  Answer: gitring yes ${it.key}, or gitring back ${it.key} "note"`);
    else ctx.out("  Answer in the gitring app.");
    if (it.link) ctx.out(`  ${it.link.startsWith("/") ? `${s.origin}${it.link}` : it.link}`);
  }
  return 0;
}

/** An item of the inbox by its key, or by a start of the key that only one item has. */
function findItem(items, key) {
  const exact = items.find((x) => x.key === key);
  if (exact) return exact;
  const hits = items.filter((x) => String(x.key).startsWith(key));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new CliError(`More than one item starts with ${key}. Give more of the key.`);
  throw new CliError(`No item ${key} waits for you. Run gitring inbox to see the items.`);
}

async function answer(ctx, [key, note], approve) {
  const s = session(ctx);
  const item = findItem(await inboxItems(ctx, s), key);
  const link = item.link ? (item.link.startsWith("/") ? `${s.origin}${item.link}` : item.link) : `${s.origin}/`;
  if ((item.kind !== "approval" && item.kind !== "stopped") || !item.attemptId || !item.approvalId) {
    throw new CliError(`This item is not a merge question. Answer it in the gitring app: ${link}`);
  }
  const res = await rest(ctx, s, "POST", `/api/projects/${encodeURIComponent(item.project)}/attempts/${encodeURIComponent(item.attemptId)}/decide`, {
    approvalId: item.approvalId,
    answer: approve ? "approve" : "send-back",
    ...(note ? { note } : {}),
  });
  if (res.status === 403) throw new CliError(`${errorText(res)} Answer in the gitring app: ${link}`);
  const out = okJson(s, res);
  if (ctx.flags.json) return printJson(ctx, out);
  ctx.out(out?.message ?? (approve ? "gitring took your yes." : "gitring sent the work back."));
  return out?.outcome === "refused" ? 1 : 0;
}

/* ───────────────────────── watch: the live log over a WebSocket ───────────────────────── */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_MAX_FRAME = 64 * 1024 * 1024;

/** One client frame (RFC 6455 §5.2): FIN, the opcode, the length, and the payload under a random mask. */
export function wsFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const mask = randomBytes(4);
  let head;
  if (data.length < 126) {
    head = Buffer.alloc(2);
    head[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  head[0] = 0x80 | opcode;
  const body = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) body[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

/**
 * Read frames from a buffer. Answers the complete frames and the bytes that are left (a frame that is
 * not complete yet). Server frames have no mask, but a masked frame is read too.
 */
export function wsReadFrames(buf) {
  const frames = [];
  let rest = buf;
  for (;;) {
    if (rest.length < 2) break;
    const fin = (rest[0] & 0x80) !== 0;
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    let len = rest[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (rest.length < 4) break;
      len = rest.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (rest.length < 10) break;
      const big = rest.readBigUInt64BE(2);
      if (big > BigInt(WS_MAX_FRAME)) throw new Error("A frame from the server is too large.");
      len = Number(big);
      off = 10;
    }
    const maskAt = off;
    if (masked) off += 4;
    if (rest.length < off + len) break;
    let payload = Buffer.from(rest.subarray(off, off + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= rest[maskAt + (i % 4)];
    frames.push({ fin, opcode, payload });
    rest = rest.subarray(off + len);
  }
  return { frames, rest };
}

/**
 * Open a WebSocket (RFC 6455) with headers (a browser WebSocket cannot send Authorization). Calls
 * `on.text(string)` for each text message and `on.close(code, reason)` once at the end. Answers send(text)
 * and close().
 */
export function openSocket(url, headers, on) {
  const u = new URL(url);
  const secure = u.protocol === "wss:" || u.protocol === "https:";
  const key = randomBytes(16).toString("base64");
  let socket = null;
  let ended = false;
  const end = (code, reason) => {
    if (ended) return;
    ended = true;
    // A server that does not close its side must not keep the program alive.
    if (socket) setTimeout(() => socket.destroy(), 1000).unref?.();
    on.close(code, reason);
  };
  const req = (secure ? httpsRequest : httpRequest)({
    hostname: u.hostname.replace(/^\[|\]$/g, ""),
    port: u.port || (secure ? 443 : 80),
    path: `${u.pathname}${u.search}`,
    method: "GET",
    headers: { ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key, "user-agent": `gitring-cli/${VERSION}` },
  });
  req.on("upgrade", (res, sock, head) => {
    socket = sock;
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    if (res.headers["sec-websocket-accept"] !== accept) {
      sock.destroy();
      end(1002, "The server did not accept the WebSocket.");
      return;
    }
    let buf = Buffer.alloc(0);
    let parts = [];
    const feed = (chunk) => {
      if (ended) return;
      buf = Buffer.concat([buf, chunk]);
      let read;
      try {
        read = wsReadFrames(buf);
      } catch (e) {
        sock.destroy();
        end(1009, String(e?.message ?? e));
        return;
      }
      buf = read.rest;
      for (const f of read.frames) {
        if (f.opcode === 0x8) {
          const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
          const reason = f.payload.subarray(2).toString("utf8");
          try {
            sock.end(wsFrame(0x8, f.payload.subarray(0, 2)));
          } catch {
            /* closed */
          }
          end(code, reason);
          return;
        }
        if (f.opcode === 0x9) sock.write(wsFrame(0xa, f.payload));
        else if (f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0) {
          parts.push(f.payload);
          if (f.fin) {
            const whole = Buffer.concat(parts);
            parts = [];
            on.text(whole.toString("utf8"));
          }
        }
      }
    };
    sock.on("data", feed);
    sock.on("close", () => end(1006, "The connection closed."));
    sock.on("error", () => end(1006, "The connection failed."));
    on.open?.();
    // Frames that came with the answer of the upgrade (even a close frame) are read at once.
    if (head?.length) feed(Buffer.from(head));
  });
  req.on("response", (res) => {
    res.resume();
    end(res.statusCode === 401 ? 4401 : res.statusCode === 403 || res.statusCode === 404 ? 4403 : 1006, `The server answered ${res.statusCode}.`);
  });
  req.on("error", (e) => end(1006, String(e?.message ?? e)));
  req.end();
  return {
    send(text) {
      if (socket && !ended) socket.write(wsFrame(0x1, text));
    },
    close() {
      if (socket && !ended) {
        try {
          socket.end(wsFrame(0x8, Buffer.from([0x03, 0xe8])));
        } catch {
          /* closed */
        }
      }
      end(1000, "");
    },
  };
}

/** One live connection: resolves with the close code and reason. `onLive` runs when the first state arrives. */
function watchOnce(ctx, s, project, token, seen, onLive) {
  return new Promise((resolve) => {
    let ping = null;
    let sock = null;
    const url = `${s.origin.replace(/^http/, "ws")}/ws/${encodeURIComponent(project)}`;
    const print = (log) => {
      if (!log?.id || seen.has(log.id)) return;
      seen.add(log.id);
      if (seen.size > 5000) seen.delete(seen.values().next().value);
      ctx.out(ctx.flags.json ? JSON.stringify(log) : `${clock(Number(log.at ?? ctx.now()))}  ${log.message}`);
    };
    sock = ctx.connect(url, { authorization: `Bearer ${token}` }, {
      open() {
        // The server answers "pong". It keeps the connection open through proxies.
        ping = setInterval(() => sock?.send("ping"), 30_000);
        ping.unref?.();
      },
      text(raw) {
        if (raw === "pong") return;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        for (const ev of Array.isArray(msg) ? msg : [msg]) {
          if (ev?.type === "snapshot") {
            const logs = ev.state?.logs ?? [];
            if (!seen.size) for (const log of logs.slice(-10)) print(log);
            else for (const log of logs) print(log);
            onLive();
          } else if (ev?.type === "log") print(ev.log);
        }
      },
      close(code, reason) {
        if (ping) clearInterval(ping);
        resolve({ code, reason });
      },
    });
  });
}

async function watch(ctx, [project]) {
  const s = session(ctx);
  const seen = new Set();
  if (!ctx.flags.json) ctx.out(`The live log of ${project}. Press Ctrl+C to stop.`);
  let tries = 0;
  for (;;) {
    let live = false;
    const { code, reason } = await watchOnce(ctx, s, project, await bearer(ctx, s), seen, () => {
      live = true;
    });
    if (code === 4401) throw new CliError(s.kind === "key" ? "The key in GITRING_TOKEN is not valid." : `Your sign-in to ${s.origin} ended. Run: gitring login --server ${s.origin}`);
    if (code === 4403) throw new CliError(`You cannot watch ${project}. The project does not exist, or your access changed. ${reason}`.trim());
    // A deploy or a restart of the project closes the connection: connect again, a little later each time.
    tries = live ? 1 : tries + 1;
    if (tries > ctx.watchRetries) throw new CliError(`The live log stopped. ${reason || "The connection closed."}`.trim());
    await ctx.sleep(Math.min(30_000, 1000 * 2 ** (tries - 1)));
  }
}

function printJson(ctx, value) {
  ctx.out(JSON.stringify(value, null, 2));
  return 0;
}

const RUN = {
  login,
  logout,
  whoami,
  projects,
  new: newProject,
  clone,
  tasks,
  task,
  inbox,
  yes: (ctx, args) => answer(ctx, args, true),
  back: (ctx, args) => answer(ctx, args, false),
  watch,
};

/* ───────────────────────── the program ───────────────────────── */

function openInBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* the person opens the page */
  }
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Run the command line. `io` replaces the outside world in tests: env, fetch, out, err, configDir, sleep,
 * now, run (child processes), openUrl, connect (WebSocket) and watchRetries. Answers the exit code.
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const ctx = {
    env,
    processEnv: io.processEnv ?? process.env,
    fetch: io.fetch ?? ((...a) => globalThis.fetch(...a)),
    out: io.out ?? ((line) => process.stdout.write(`${line}\n`)),
    err: io.err ?? ((line) => process.stderr.write(`${line}\n`)),
    configDir: io.configDir ?? configDir(env, process.platform, homedir()),
    sleep: io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: io.now ?? (() => Date.now()),
    run: io.run ?? runCommand,
    openUrl: io.openUrl ?? openInBrowser,
    connect: io.connect ?? openSocket,
    watchRetries: io.watchRetries ?? 8,
    flags: {},
  };
  try {
    const { command, args, flags } = parseArgs(argv);
    ctx.flags = flags;
    if (command === "help") {
      for (const line of USAGE) ctx.out(line);
      return 0;
    }
    if (command === "version") {
      ctx.out(VERSION);
      return 0;
    }
    return (await RUN[command](ctx, args)) ?? 0;
  } catch (e) {
    if (e instanceof CliError) {
      ctx.err(e.message);
      if (e.code === 2) ctx.err("Run gitring --help to see the commands.");
      return e.code;
    }
    ctx.err(`The command line stopped with an error: ${e?.message ?? e}`);
    return 1;
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
