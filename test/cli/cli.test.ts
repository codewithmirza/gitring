/**
 * The gitring command line (cli/gitring.mjs) against a fake server on this computer (node:http): the
 * command line, the requests it builds (REST, MCP JSON-RPC, OAuth forms, the WebSocket of watch), its
 * stored sign-in, and its words. The routes that a newer server adds (inbox, decide, clone-token, the MCP
 * tool gitring_create_project) are checked here by their request shape.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLIENT_ID,
  configDir,
  DEVICE_GRANT,
  gitAuthHeader,
  main,
  parseArgs,
  readCredentials,
  rpcMessage,
  serverOrigin,
  titleFrom,
  TOO_OLD,
  USAGE,
  writeCredentials,
  wsFrame,
  wsReadFrames,
  type CliIo,
} from "../../cli/gitring.mjs";
import { steViolations } from "../coord/ste";

/* ───────────── a fake server ───────────── */

interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  form?: Record<string, string>;
  json?: any;
}
interface Answer {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

const servers: Server[] = [];
const sockets: Socket[] = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gitring-cli-"));
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  rmSync(dir, { recursive: true, force: true });
});

async function fakeServer(handler: (req: Seen) => Answer | Promise<Answer>, upgrade?: (req: Seen, socket: Socket) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const s: Seen = { method: req.method!, path: req.url!, headers: req.headers, body };
    if ((req.headers["content-type"] ?? "").includes("x-www-form-urlencoded")) s.form = Object.fromEntries(new URLSearchParams(body));
    else if (body) {
      try {
        s.json = JSON.parse(body);
      } catch {
        /* text */
      }
    }
    seen.push(s);
    const a = await handler(s);
    res.writeHead(a.status ?? 200, { "content-type": a.text !== undefined ? "text/plain" : "application/json", ...(a.headers ?? {}) });
    res.end(a.text ?? JSON.stringify(a.json ?? {}));
  });
  if (upgrade) {
    server.on("upgrade", (req, socket) => {
      const s: Seen = { method: req.method!, path: req.url!, headers: req.headers, body: "" };
      seen.push(s);
      sockets.push(socket as Socket);
      upgrade(s, socket as Socket);
    });
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** The command line with a temporary config folder. Waits are recorded, not slept. */
async function run(argv: string[], io: CliIo = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const code = await main(argv, {
    env: {},
    configDir: dir,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    sleep: async (ms) => void sleeps.push(ms),
    ...io,
  });
  return { code, out, err, sleeps };
}

/** A stored sign-in for a server. */
function signedIn(origin: string, extra: Partial<{ accessToken: string; refreshToken: string; expiresAt: number }> = {}) {
  writeCredentials(dir, { version: 1, current: origin, servers: { [origin]: { clientId: CLIENT_ID, accessToken: "goa_old", refreshToken: "gor_old", expiresAt: Date.now() + 3600_000, scope: "mcp", user: "Robin", ...extra } } });
}

/* ───────────── the command line ───────────── */

describe("arguments", () => {
  it("reads commands, values and options", () => {
    expect(parseArgs([])).toEqual({ command: "help", args: [], flags: {} });
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["-h"]).command).toBe("help");
    expect(parseArgs(["tasks", "shop", "--help"]).command).toBe("help");
    expect(parseArgs(["login", "--server", "https://g.example", "--open"])).toEqual({ command: "login", args: [], flags: { server: "https://g.example", open: true } });
    expect(parseArgs(["new", "shop", "--template=js-library", "--describe", "A shop. It sells tea.", "--public", "--json"])).toEqual({
      command: "new",
      args: ["shop"],
      flags: { template: "js-library", describe: "A shop. It sells tea.", public: true, json: true },
    });
    expect(parseArgs(["task", "shop", "Dark mode", "--", "--goal starts with dashes"]).args).toEqual(["shop", "Dark mode", "--goal starts with dashes"]);
    expect(parseArgs(["clone", "shop", "folder"]).args).toEqual(["shop", "folder"]);
    expect(parseArgs(["yes", "ap_1"]).args).toEqual(["ap_1"]);
  });

  it("refuses a wrong command line with plain words and exit code 2", async () => {
    const cases: [string[], string][] = [
      [["fly"], "Unknown command fly."],
      [["projects", "--fast"], "Unknown option --fast."],
      [["new"], "Give a name for the project. Use: gitring new <name> [--template NAME] [--describe TEXT] [--public]"],
      [["task", "shop", "Only a title"], 'Give a project, a title and a goal. Use: gitring task <project> "title" "goal"'],
      [["back", "ap_1"], 'Give an item and a note. The note tells the agent what to change. Use: gitring back <item> "note"'],
      [["tasks", "a", "b"], "Too many arguments. Use: gitring tasks <project>"],
      [["tasks", "--template", "x", "shop"], "gitring tasks does not take --template. Use: gitring tasks <project>"],
      [["login", "--server"], "--server needs a value."],
      [["task", "shop", " ", "goal"], 'An argument is empty. Use: gitring task <project> "title" "goal"'],
    ];
    for (const [argv, words] of cases) {
      const res = await run(argv);
      expect([argv, res.code, res.err[0]]).toEqual([argv, 2, words]);
      expect(res.err[1]).toBe("Run gitring --help to see the commands.");
      for (const line of res.err) expect(steViolations(line)).toEqual([]);
    }
  });

  it("shows the help in plain words, with the rule for answers outside the app", async () => {
    const res = await run(["--help"]);
    expect(res.code).toBe(0);
    expect(res.out).toEqual(USAGE);
    for (const line of USAGE) expect([line, steViolations(line)]).toEqual([line, []]);
    expect(USAGE.join("\n")).toContain("An answer from the command line counts as your answer only when you allow answers outside the gitring app.");
    expect(USAGE.join("\n")).not.toMatch(/github/i);
    expect(steViolations(TOO_OLD)).toEqual([]);
  });

  it("takes https server addresses, and http only for this computer", () => {
    expect(serverOrigin("https://gitring.example.com/mcp")).toBe("https://gitring.example.com");
    expect(serverOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(serverOrigin("http://127.0.0.1:9000/x")).toBe("http://127.0.0.1:9000");
    expect(() => serverOrigin("http://gitring.example.com")).toThrow("Use https in the server address.");
    expect(() => serverOrigin("gitring.example.com")).toThrow("not a web address");
  });

  it("stores the sign-in in the config folder of the system", () => {
    expect(configDir({ GITRING_CONFIG_DIR: "/tmp/x" }, "linux", "/home/robin")).toBe("/tmp/x");
    expect(configDir({}, "linux", "/home/robin")).toBe("/home/robin/.config/gitring");
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/robin")).toBe("/xdg/gitring");
    expect(configDir({}, "darwin", "/Users/robin")).toBe("/Users/robin/Library/Application Support/gitring");
    expect(configDir({ APPDATA: "C:\\Users\\robin\\AppData\\Roaming" }, "win32", "C:\\Users\\robin")).toBe("C:\\Users\\robin\\AppData\\Roaming\\gitring");
    expect(configDir({}, "win32", "C:\\Users\\robin")).toBe("C:\\Users\\robin\\AppData\\Roaming\\gitring");
  });

  it("writes the stored sign-in for the person only, and ignores a file that is not its own", () => {
    writeCredentials(dir, { version: 1, current: "https://g.example", servers: { "https://g.example": { accessToken: "goa_a", refreshToken: "gor_a", expiresAt: 1, scope: "mcp" } } });
    expect(readCredentials(dir).servers["https://g.example"].accessToken).toBe("goa_a");
    if (process.platform !== "win32") expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, "credentials.json"), "not json");
    expect(readCredentials(dir)).toEqual({ version: 1, current: null, servers: {} });
  });

  it("makes short titles and git headers", () => {
    expect(titleFrom("A tea shop. It sells green tea.")).toBe("A tea shop");
    expect(titleFrom("x".repeat(100))).toHaveLength(80);
    expect(gitAuthHeader("secret123?expires=1700000000")).toBe(`Authorization: Basic ${Buffer.from("x:secret123").toString("base64")}`);
    expect(rpcMessage('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n', "text/event-stream")).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });
});

/* ───────────── sign-in ───────────── */

describe("gitring login", () => {
  it("asks for a device code, polls at the given pace (slower after slow_down), and stores the tokens", async () => {
    let polls = 0;
    const srv = await fakeServer((r) => {
      if (r.path === "/oauth/device_authorization") {
        return { json: { device_code: "god_secret", user_code: "BCDF-GHJK", verification_uri: "x/device", verification_uri_complete: "https://g.example/device?code=BCDF-GHJK", expires_in: 600, interval: 5 } };
      }
      if (r.path === "/oauth/token") {
        polls++;
        if (polls === 1) return { status: 400, json: { error: "authorization_pending", error_description: "The person did not answer yet." } };
        if (polls === 2) return { status: 400, json: { error: "slow_down", error_description: "Ask less often." } };
        if (polls === 3) return { status: 400, json: { error: "authorization_pending" } };
        return { json: { access_token: "goa_new", refresh_token: "gor_new", token_type: "Bearer", expires_in: 3600, scope: "mcp" } };
      }
      if (r.path === "/api/me") return { json: { user: { id: "u_1", name: "Robin" } } };
      return { status: 404, text: "404 Not Found" };
    });
    const opened: string[] = [];
    const res = await run(["login", "--server", srv.origin, "--open"], { openUrl: (u) => void opened.push(u) });
    expect(res.err).toEqual([]);
    expect(res.code).toBe(0);
    expect(res.out).toEqual([
      "Open this page in a browser, and sign in to gitring:",
      "  https://g.example/device?code=BCDF-GHJK",
      "Check that the page shows this code: BCDF-GHJK",
      "The code works for 10 minutes. The command line waits for your answer.",
      `You are signed in to ${srv.origin} as Robin.`,
    ]);
    expect(opened).toEqual(["https://g.example/device?code=BCDF-GHJK"]);
    // 5 seconds, 5 seconds, then 10 seconds after slow_down.
    expect(res.sleeps).toEqual([5000, 5000, 10000, 10000]);
    const [start, ...rest] = srv.seen;
    expect(start.method).toBe("POST");
    expect(start.form).toEqual({ client_id: CLIENT_ID, scope: "mcp", resource: `${srv.origin}/mcp` });
    expect(rest[0].form).toEqual({ grant_type: DEVICE_GRANT, device_code: "god_secret", client_id: CLIENT_ID });
    expect(srv.seen.at(-1)!.headers.authorization).toBe("Bearer goa_new");
    const creds = readCredentials(dir);
    expect(creds.current).toBe(srv.origin);
    expect(creds.servers[srv.origin]).toMatchObject({ accessToken: "goa_new", refreshToken: "gor_new", scope: "mcp", user: "Robin" });
    expect(res.out.join("\n")).not.toContain("god_secret");
    for (const line of res.out) expect(steViolations(line)).toEqual([]);
  });

  it("says that an older server cannot do it", async () => {
    const srv = await fakeServer(() => ({ status: 404, text: "404 Not Found" }));
    const res = await run(["login", "--server", srv.origin]);
    expect(res).toMatchObject({ code: 1, err: [TOO_OLD] });
  });

  it("stops when the code expires, and asks for a server address first", async () => {
    const srv = await fakeServer((r) =>
      r.path === "/oauth/device_authorization" ? { json: { device_code: "god_x", user_code: "BCDF-GHJK", verification_uri: "u", expires_in: 600, interval: 5 } } : { status: 400, json: { error: "expired_token" } },
    );
    expect((await run(["login", "--server", srv.origin])).err).toEqual(["The code expired. Run gitring login again."]);
    expect((await run(["login"])).err[0]).toBe("Give the address of your gitring: gitring login --server https://your-gitring.example.com");
  });

  it("renews an old access token before a call, and stores the new pair", async () => {
    const srv = await fakeServer((r) => {
      if (r.path === "/oauth/token") return { json: { access_token: "goa_fresh", refresh_token: "gor_fresh", expires_in: 3600, scope: "mcp" } };
      if (r.path === "/api/projects") return { json: [{ id: "shop", name: "Shop", role: "owner" }] };
      return { status: 404, text: "404 Not Found" };
    });
    signedIn(srv.origin, { expiresAt: Date.now() - 1000 });
    const res = await run(["projects"]);
    expect(res.out).toEqual(["PROJECT  ROLE   NAME", "shop     owner  Shop"]);
    expect(srv.seen[0].form).toEqual({ grant_type: "refresh_token", refresh_token: "gor_old", client_id: CLIENT_ID });
    expect(srv.seen[1].headers.authorization).toBe("Bearer goa_fresh");
    expect(readCredentials(dir).servers[srv.origin]).toMatchObject({ accessToken: "goa_fresh", refreshToken: "gor_fresh" });
  });

  it("renews once after a 401, and asks for a new sign-in when the refresh token ended", async () => {
    let refreshOk = true;
    const srv = await fakeServer((r) => {
      if (r.path === "/oauth/token") return refreshOk ? { json: { access_token: "goa_2", refresh_token: "gor_2", expires_in: 3600 } } : { status: 400, json: { error: "invalid_grant" } };
      if (r.path === "/api/projects") return r.headers.authorization === "Bearer goa_2" ? { json: [] } : { status: 401, json: { error: "The API key is not valid." } };
      return { status: 404, text: "" };
    });
    signedIn(srv.origin);
    expect((await run(["projects"])).out).toEqual(["You have no projects. Make one: gitring new <name>"]);
    expect(srv.seen.map((s) => s.path)).toEqual(["/api/projects", "/oauth/token", "/api/projects"]);
    refreshOk = false;
    signedIn(srv.origin);
    const ended = await run(["projects"]);
    expect(ended).toMatchObject({ code: 1, err: [`Your sign-in to ${srv.origin} ended. Run: gitring login --server ${srv.origin}`] });
    expect(readCredentials(dir).servers).toEqual({});
  });

  it("uses GITRING_URL and GITRING_TOKEN (a personal API key) for scripts", async () => {
    const srv = await fakeServer((r) => (r.path === "/api/me" ? { json: { user: { name: "Robin" } } } : { status: 404, text: "" }));
    const res = await run(["whoami"], { env: { GITRING_URL: srv.origin, GITRING_TOKEN: "gk_script" } });
    expect(res.out).toEqual([`Robin on ${srv.origin} (personal API key)`]);
    expect(srv.seen[0].headers.authorization).toBe("Bearer gk_script");
    const noUrl = await run(["whoami"], { env: { GITRING_TOKEN: "gk_script" } });
    expect(noUrl).toMatchObject({ code: 2, err: ["GITRING_TOKEN is set. Set GITRING_URL or --server to the address of your gitring too.", "Run gitring --help to see the commands."] });
  });

  it("ends the sign-in on the server at logout, and forgets it here even when the server does not answer", async () => {
    const srv = await fakeServer(() => ({ status: 200, text: "" }));
    signedIn(srv.origin);
    const res = await run(["logout"]);
    expect(res.out).toEqual([`You are signed out of ${srv.origin}.`]);
    expect(srv.seen[0]).toMatchObject({ path: "/oauth/revoke", form: { token: "gor_old", token_type_hint: "refresh_token", client_id: CLIENT_ID } });
    signedIn("http://127.0.0.1:1");
    const offline = await run(["logout"]);
    expect(offline.out).toEqual(["You are signed out of http://127.0.0.1:1.", "The server did not confirm the end of the sign-in. To end it there, open Account, Connected apps in gitring."]);
    expect(readCredentials(dir).servers).toEqual({});
  });
});

/* ───────────── projects and tasks ───────────── */

/** An MCP answer as the server gives it: a headline, then JSON. `sse`: as an event stream. */
function toolAnswer(headline: string, json: unknown, sse = false): Answer {
  const rpc = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `${headline}\n\n${JSON.stringify(json, null, 2)}` }] } };
  return sse ? { text: `event: message\ndata: ${JSON.stringify(rpc)}\n\n`, headers: { "content-type": "text/event-stream" } } : { json: rpc };
}

describe("projects and tasks", () => {
  it("makes a project with REST, and a task", async () => {
    const srv = await fakeServer((r) => {
      if (r.path === "/api/projects") return { status: 201, json: { project: { id: "shop-a1b2", name: "shop", visibility: "public" }, state: {} } };
      if (r.path === "/api/projects/shop-a1b2/intents") return { json: { id: "i_7", title: "Dark mode" } };
      return { status: 404, text: "" };
    });
    signedIn(srv.origin);
    const made = await run(["new", "shop", "--public"]);
    expect(made.out[0]).toBe("gitring made the project shop-a1b2 (public).");
    expect(srv.seen[0]).toMatchObject({ method: "POST", json: { name: "shop", visibility: "public", source: { kind: "empty" } } });
    expect(srv.seen[0].headers["content-type"]).toBe("application/json");
    const task = await run(["task", "shop-a1b2", "Dark mode", "A switch turns dark mode on."]);
    expect(task.out).toEqual(["gitring made the task i_7: Dark mode. Agents can take it now."]);
    expect(srv.seen[1]).toMatchObject({ method: "POST", path: "/api/projects/shop-a1b2/intents", json: { title: "Dark mode", goal: "A switch turns dark mode on." } });
  });

  it("makes a project from a template or a description with the MCP tool gitring_create_project", async () => {
    const srv = await fakeServer((r) => toolAnswer("gitring made the project tea-shop. Agents start now.", { project: "tea-shop", url: "https://g.example/overview?project=tea-shop" }, true));
    signedIn(srv.origin);
    const res = await run(["new", "tea-shop", "--template", "js-library", "--describe", "A tea shop. It sells green tea."]);
    expect(res.err).toEqual([]);
    expect(res.out).toEqual(["gitring made the project tea-shop. Agents start now."]);
    const call = srv.seen[0];
    expect(call.path).toBe("/mcp");
    expect(call.headers).toMatchObject({ authorization: "Bearer goa_old", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "gitring_create_project", accept: "application/json, text/event-stream" });
    expect(call.json).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "gitring_create_project",
        arguments: {
          name: "tea-shop",
          visibility: "private",
          start: { kind: "template", template: "js-library" },
          description: "A tea shop. It sells green tea.",
          firstTask: { title: "A tea shop", goal: "A tea shop. It sells green tea." },
          launch: 1,
        },
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "gitring-cli" } },
      },
    });
  });

  it("says that an older server has no such tool", async () => {
    const srv = await fakeServer(() => ({ json: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "MCP error -32602: Tool gitring_create_project not found" } } }));
    signedIn(srv.origin);
    expect(await run(["new", "x", "--template", "empty"])).toMatchObject({ code: 1, err: [TOO_OLD] });
    const srv2 = await fakeServer(() => ({ json: { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Tool gitring_create_project not found" }] } } }));
    signedIn(srv2.origin);
    expect(await run(["new", "x", "--describe", "A tea shop."])).toMatchObject({ code: 1, err: [TOO_OLD] });
  });

  it("lists the open tasks with plain status words, and shows the words of a tool error", async () => {
    let fail = false;
    const srv = await fakeServer(() =>
      fail
        ? { json: { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "This project does not exist, or you have no access to it.\n\n{\n}" }] } } }
        : toolAnswer("2 open tasks. 1 work copies are active.", {
            intents: [
              { id: "i_1", title: "Dark mode", status: "underway", attempts: 1 },
              { id: "i_2", title: "Prices in euros", status: "judging", attempts: 0 },
            ],
            traffic: 1,
          }),
    );
    signedIn(srv.origin);
    const res = await run(["tasks", "shop"]);
    expect(res.out).toEqual(["TASK  STATUS             AGENTS  TITLE", "i_1   Agents work on it  1       Dark mode", "i_2   Needs a person     0       Prices in euros"]);
    expect(srv.seen[0].json.params).toMatchObject({ name: "gitring_intents", arguments: { project: "shop" } });
    fail = true;
    expect(await run(["tasks", "nope"])).toMatchObject({ code: 1, err: ["This project does not exist, or you have no access to it."] });
  });
});

/* ───────────── inbox and answers ───────────── */

const ITEMS = [
  {
    key: "ap_7hx2",
    kind: "approval",
    project: "shop",
    projectName: "Shop",
    intentId: "i_1",
    title: "Prices in euros",
    headline: "Merge the work of Kestrel?",
    why: ["The change touches 3 files.", "No test ran on the new code."],
    at: Date.now() - 2 * 3600_000,
    attemptId: "a_9",
    approvalId: "ap_7hx2",
    agent: "Kestrel",
    line: "3 files, +40 -2",
    link: "/approve/a_9?project=shop",
    actions: [{ id: "approve", label: "Yes, merge" }, { id: "send-back", label: "Send back", note: true }],
  },
  { key: "q_3kd1", kind: "question", project: "shop", projectName: "Shop", intentId: "i_2", title: "Dark mode", headline: "Which work adapts?", why: ["Both change the same lines."], at: Date.now() - 5 * 60_000, questionId: "q_3kd1", link: "/tasks/i_2?project=shop", actions: [] },
  { key: "ap_7zz9", kind: "approval", project: "shop", intentId: "i_3", title: "Logo", headline: "Merge?", why: [], at: Date.now(), attemptId: "a_10", approvalId: "ap_7zz9", link: "/approve/a_10?project=shop", actions: [] },
];

describe("gitring inbox, yes and back", () => {
  it("lists the items with the commands that answer them", async () => {
    const srv = await fakeServer((r) => (r.path === "/api/me/inbox" ? { json: { items: ITEMS, at: Date.now() } } : { status: 404, text: "" }));
    signedIn(srv.origin);
    const res = await run(["inbox"]);
    expect(res.code).toBe(0);
    expect(res.out.slice(0, 7)).toEqual([
      "ap_7hx2  Shop  Merge the work of Kestrel?  (2 hours)",
      "  Task: Prices in euros. Agent: Kestrel. 3 files, +40 -2",
      "  The change touches 3 files.",
      "  No test ran on the new code.",
      '  Answer: gitring yes ap_7hx2, or gitring back ap_7hx2 "note"',
      `  ${srv.origin}/approve/a_9?project=shop`,
      "q_3kd1  Shop  Which work adapts?  (5 minutes)",
    ]);
    expect(res.out).toContain("  Answer in the gitring app.");
    for (const line of res.out) expect(steViolations(line)).toEqual([]);
  });

  it("says when the inbox is empty, and when the server has no inbox yet", async () => {
    let old = false;
    const srv = await fakeServer(() => (old ? { status: 404, text: "404 Not Found" } : { json: { items: [] } }));
    signedIn(srv.origin);
    expect((await run(["inbox"])).out).toEqual(["No item waits for you."]);
    old = true;
    expect(await run(["inbox"])).toMatchObject({ code: 1, err: [TOO_OLD] });
    expect(await run(["yes", "ap_7hx2"])).toMatchObject({ code: 1, err: [TOO_OLD] });
  });

  it("answers yes and back to the decide route of the work copy, with the id of the question", async () => {
    const srv = await fakeServer((r) => {
      if (r.path === "/api/me/inbox") return { json: { items: ITEMS } };
      if (r.path === "/api/projects/shop/attempts/a_9/decide") {
        return { json: { outcome: r.json.answer === "approve" ? "approved" : "sent-back", message: r.json.answer === "approve" ? "gitring merges the work now." : "The agent got your note." } };
      }
      return { status: 404, text: "" };
    });
    signedIn(srv.origin);
    expect((await run(["yes", "ap_7h"])).out).toEqual(["gitring merges the work now."]);
    expect(srv.seen[1]).toMatchObject({ method: "POST", path: "/api/projects/shop/attempts/a_9/decide", json: { approvalId: "ap_7hx2", answer: "approve" } });
    expect((await run(["back", "ap_7hx2", "Keep the old function name."])).out).toEqual(["The agent got your note."]);
    expect(srv.seen[3].json).toEqual({ approvalId: "ap_7hx2", answer: "send-back", note: "Keep the old function name." });
  });

  it("points to the app when the server does not take answers from the command line", async () => {
    const srv = await fakeServer((r) => {
      if (r.path === "/api/me/inbox") return { json: { items: ITEMS } };
      return { status: 403, json: { error: "A person must answer in the gitring app. A key or an agent token cannot say yes for a person." } };
    });
    signedIn(srv.origin);
    const res = await run(["yes", "ap_7hx2"]);
    expect(res.code).toBe(1);
    expect(res.err).toEqual([`A person must answer in the gitring app. A key or an agent token cannot say yes for a person. Answer in the gitring app: ${srv.origin}/approve/a_9?project=shop`]);
  });

  it("refuses an item that is not a merge question, a key that waits nowhere, and a start that fits two items", async () => {
    const srv = await fakeServer(() => ({ json: { items: ITEMS } }));
    signedIn(srv.origin);
    expect((await run(["yes", "q_3kd1"])).err).toEqual([`This item is not a merge question. Answer it in the gitring app: ${srv.origin}/tasks/i_2?project=shop`]);
    expect((await run(["yes", "ap_nope"])).err).toEqual(["No item ap_nope waits for you. Run gitring inbox to see the items."]);
    expect((await run(["yes", "ap_7"])).err).toEqual(["More than one item starts with ap_7. Give more of the key."]);
    expect(srv.seen.every((s) => s.path === "/api/me/inbox")).toBe(true);
  });
});

/* ───────────── clone ───────────── */

describe("gitring clone", () => {
  it("asks for a read token and gives it to git in the environment, never in the command or the output", async () => {
    const srv = await fakeServer((r) =>
      r.path === "/api/projects/shop/clone-token" ? { json: { remote: "https://acct.artifacts.example/git/ns/shop.git", token: "art_secret?expires=1700000000", expiresAt: "2026-10-13T18:00:00Z" } } : { status: 404, text: "" },
    );
    signedIn(srv.origin);
    const calls: { cmd: string; args: string[]; env?: Record<string, string | undefined> }[] = [];
    const res = await run(["clone", "shop", "my-shop"], { processEnv: { PATH: "/bin" }, run: async (cmd, args, opts) => (calls.push({ cmd, args, env: opts.env }), 0) });
    expect(res.code).toBe(0);
    expect(srv.seen[0]).toMatchObject({ method: "POST", path: "/api/projects/shop/clone-token" });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("git");
    expect(calls[0].args).toEqual(["clone", "https://acct.artifacts.example/git/ns/shop.git", "my-shop"]);
    expect(calls[0].env).toMatchObject({ PATH: "/bin", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: gitAuthHeader("art_secret"), GIT_TERMINAL_PROMPT: "0" });
    expect(JSON.stringify([calls[0].args, res.out, res.err])).not.toContain("art_secret");
    expect(res.out.at(-1)).toBe("gitring cloned shop into my-shop. The read token is not in the folder.");
  });

  it("says when the server has no clone tokens yet, and when git fails", async () => {
    let old = true;
    const srv = await fakeServer(() => (old ? { status: 404, text: "404 Not Found" } : { json: { remote: "https://r.example/shop.git", token: "t" } }));
    signedIn(srv.origin);
    expect(await run(["clone", "shop"], { run: async () => 0 })).toMatchObject({ code: 1, err: [TOO_OLD] });
    old = false;
    const failed = await run(["clone", "shop"], { run: async () => 128 });
    expect(failed.err).toEqual(["git clone did not finish. Check that git 2.31 or later is installed, and read the git message above."]);
  });
});

/* ───────────── watch ───────────── */

/** A frame from a server: no mask (RFC 6455 §5.1). */
function serverFrame(opcode: number, payload: Buffer | string, fin = true): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = data.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, data.length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 126, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([head, data]);
}

function acceptSocket(req: Seen, socket: Socket) {
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
}

describe("gitring watch", () => {
  it("prints the last logs, then each new one, over a WebSocket with the token; it answers pings", async () => {
    const fromClient: Buffer[] = [];
    let connections = 0;
    const logs = Array.from({ length: 12 }, (_, i) => ({ id: `lg_${i + 1}`, at: Date.UTC(2026, 9, 13, 9, 0, i), kind: "system", message: `Log ${i + 1}.` }));
    const srv = await fakeServer(
      () => ({ status: 404, text: "" }),
      (req, socket) => {
        connections++;
        acceptSocket(req, socket);
        socket.on("data", (d) => fromClient.push(Buffer.from(d)));
        const event = JSON.stringify({ type: "log", log: { id: "lg_13", at: Date.UTC(2026, 9, 13, 9, 1, 0), kind: "landing", message: "gitring merged the work of Kestrel." } });
        socket.write(serverFrame(0x1, JSON.stringify({ type: "snapshot", state: { logs } })));
        // A message in two frames, and a ping between other frames.
        socket.write(serverFrame(0x1, event.slice(0, 20), false));
        socket.write(serverFrame(0x0, event.slice(20), true));
        socket.write(serverFrame(0x9, "hi"));
        socket.write(serverFrame(0x1, JSON.stringify([{ type: "log", log: logs[11] }, { type: "attempt" }])));
        setTimeout(() => socket.end(serverFrame(0x8, Buffer.from([0x03, 0xe9]))), 50);
      },
    );
    signedIn(srv.origin);
    const res = await run(["watch", "shop"], { watchRetries: 0 });
    expect(connections).toBe(1);
    const up = srv.seen.find((s) => s.path === "/ws/shop")!;
    expect(up.headers.authorization).toBe("Bearer goa_old");
    expect(up.headers.upgrade).toBe("websocket");
    expect(res.out[0]).toBe("The live log of shop. Press Ctrl+C to stop.");
    // The last 10 logs of the snapshot, then the new one; the log that came twice shows once.
    expect(res.out.slice(1).map((l) => l.replace(/^\d\d:\d\d:\d\d {2}/, ""))).toEqual([...logs.slice(2).map((l) => l.message), "gitring merged the work of Kestrel."]);
    for (const line of res.out.slice(1)) expect(line).toMatch(/^\d\d:\d\d:\d\d {2}/);
    expect(res).toMatchObject({ code: 1, err: ["The live log stopped. The connection closed."] });
    // The client answered the ping with a pong (masked, as a client must).
    const frames = wsReadFrames(Buffer.concat(fromClient)).frames;
    expect(frames.find((f) => f.opcode === 0xa)?.payload.toString()).toBe("hi");
  });

  it("connects again after a close, and stops when the access is gone", async () => {
    let connections = 0;
    const srv = await fakeServer(
      () => ({ status: 404, text: "" }),
      (req, socket) => {
        connections++;
        acceptSocket(req, socket);
        if (connections === 1) socket.end(serverFrame(0x8, Buffer.from([0x03, 0xe9])));
        else socket.end(serverFrame(0x8, Buffer.concat([Buffer.from([0x11, 0x33]), Buffer.from("Your access to this project changed.")])));
      },
    );
    signedIn(srv.origin);
    const res = await run(["watch", "shop"], { watchRetries: 3 });
    expect(connections).toBe(2);
    expect(res.sleeps).toEqual([1000]);
    expect(res.err).toEqual(["You cannot watch shop. The project does not exist, or your access changed. Your access to this project changed."]);
  });

  it("asks for a new sign-in when the server refuses the WebSocket with 401", async () => {
    const srv = await fakeServer(() => ({ status: 401, json: { error: "Sign in to open this project." } }));
    signedIn(srv.origin);
    const res = await run(["watch", "shop"], { watchRetries: 0 });
    expect(res.err).toEqual([`Your sign-in to ${srv.origin} ended. Run: gitring login --server ${srv.origin}`]);
  });

  it("reads and writes frames of every length form, masked and not", () => {
    for (const size of [0, 5, 125, 126, 70_000]) {
      const payload = Buffer.alloc(size, 7);
      const masked = wsFrame(0x1, payload);
      expect(masked[1] & 0x80).toBe(0x80);
      const read = wsReadFrames(Buffer.concat([masked, Buffer.from([0x81])]));
      expect(read.frames).toHaveLength(1);
      expect(read.frames[0]).toMatchObject({ fin: true, opcode: 1 });
      expect(read.frames[0].payload.equals(payload)).toBe(true);
      // The start of the next frame waits for more bytes.
      expect(read.rest.length).toBe(1);
    }
  });
});

/* ───────────── no secrets in the words ───────────── */

describe("secrets", () => {
  it("never prints a stored token", async () => {
    const srv = await fakeServer((r) => (r.path === "/api/projects" ? { json: [] } : r.path === "/api/me" ? { json: { user: { name: "Robin" } } } : { status: 500, json: { error: "Boom." } }));
    signedIn(srv.origin, { accessToken: "goa_TOPSECRET", refreshToken: "gor_TOPSECRET" });
    const outputs = [await run(["projects"]), await run(["whoami"]), await run(["whoami", "--json"]), await run(["inbox"])];
    expect(JSON.stringify(outputs)).not.toContain("TOPSECRET");
    expect(readFileSync(join(dir, "credentials.json"), "utf8")).toContain("goa_TOPSECRET");
  });
});
