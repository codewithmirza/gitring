/**
 * The gitring command line against a whole gitring in this process (test/harbor/world.ts: the real Worker
 * routes, the real Directory and the real project objects). `gitring login` runs the device grant end to
 * end: the program asks for a code, the person allows it on /device in a browser (a session cookie), and
 * the program gets its token. Then the commands call REST and MCP with that token, and only the routes of
 * their commands accept it.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { s256 } from "../../src/directory/oauth";
import { DEVICE_GRANT } from "../../src/directory/device";
import { ORIGIN, World } from "../harbor/world";
import { isMissingTool, main, readCredentials, TOO_OLD, toolCallBody } from "../../cli/gitring.mjs";
import { steViolations } from "../coord/ste";

const DEVICE_ADDRESS = "203.0.113.9";

let world: World;
let dir: string;

beforeEach(async () => {
  world = new World();
  await world.init();
  dir = mkdtempSync(join(tmpdir(), "gitring-cli-"));
});

afterEach(async () => {
  await world.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A request to the Worker, as a browser or a program sends it. */
async function send(path: string, init: RequestInit & { cookie?: string; ip?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  headers.set("cf-connecting-ip", init.ip ?? "198.51.100.7");
  const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
  const req = new Request(url, { method: init.method, body: init.body, headers, redirect: "manual" });
  const ctx = { waitUntil: (p: Promise<unknown>) => void world.pending.push(p.catch(() => undefined)), passThroughOnException() {}, props: {} };
  return worker.fetch(req, world.env as never, ctx as never);
}

/** Robin: an API key (for the setup of a test) and a browser session (for the /device page). */
async function robin(): Promise<{ userId: string; key: string; session: string }> {
  const { userId, key } = await world.signIn("robin", 1);
  const url = await world.dir.signInUrl("github", ORIGIN, "/");
  const res = await world.dir.finishSignIn("github", "code", new URL(url).searchParams.get("state")!);
  expect(res.user.id).toBe(userId);
  return { userId, key, session: res.token! };
}

function cookieFrom(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0].slice(name.length + 1);
  return null;
}

/** The person opens /device with the code, reads the page, and answers. Answers the two pages. */
async function personAnswers(session: string, userCode: string, decision: "allow" | "deny") {
  const shown = await send(`/device?code=${encodeURIComponent(userCode)}`, { cookie: `__Host-gitring=${session}` });
  const html = await shown.text();
  expect(shown.status).toBe(200);
  const nonce = /name="confirm" value="([^"]+)"/.exec(html)![1];
  const bound = cookieFrom(shown, "__Host-gitring-device")!;
  expect(bound).toBe(nonce);
  const answered = await send("/device", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ code: userCode, confirm: nonce, decision }).toString(),
    cookie: `__Host-gitring=${session}; __Host-gitring-device=${bound}`,
  });
  return { shown: html, answered: { status: answered.status, html: await answered.text() } };
}

/** The command line with this world as its network. `onSleep` runs at each wait of the program. */
function cli(opts: { onSleep?: (n: number, out: string[]) => Promise<void>; env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let sleeps = 0;
  const fetchImpl = async (input: string, init?: RequestInit) => send(input, { ...init, ip: DEVICE_ADDRESS });
  const run = async (argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await main(argv, {
      env: opts.env ?? {},
      fetch: fetchImpl as never,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      configDir: dir,
      sleep: async () => {
        sleeps++;
        await opts.onSleep?.(sleeps, out);
      },
    });
    return { code, out: [...out], err: [...err] };
  };
  return { run };
}

const codeIn = (out: string[]) => /this code: ([A-Z]{4}-[A-Z]{4})/.exec(out.join("\n"))![1];

describe("gitring login (device grant, end to end)", () => {
  it("signs in after the person allows the code on /device, and the commands then work with the token", async () => {
    const { session } = await robin();
    let pages: Awaited<ReturnType<typeof personAnswers>> | undefined;
    const { run } = cli({
      // The first wait: the program asked once ("pending"). Now the person allows it in the browser.
      onSleep: async (n, out) => {
        if (n === 2) pages = await personAnswers(session, codeIn(out), "allow");
      },
    });
    const login = await run(["login", "--server", ORIGIN]);
    expect(login.err).toEqual([]);
    expect(login.code).toBe(0);
    expect(login.out[0]).toBe("Open this page in a browser, and sign in to gitring:");
    expect(login.out[1]).toMatch(new RegExp(`^  ${ORIGIN}/device\\?code=[A-Z]{4}-[A-Z]{4}$`));
    expect(login.out.at(-1)).toBe(`You are signed in to ${ORIGIN} as robin.`);
    for (const line of login.out) expect(steViolations(line)).toEqual([]);

    // The page named the program and the code, and warned the person.
    expect(pages!.shown).toContain("<h1>Allow the gitring command line to use gitring as robin?</h1>");
    expect(pages!.shown).toContain(`<code>${codeIn(login.out)}</code>`);
    expect(pages!.shown).toContain(`from the address <code>${DEVICE_ADDRESS}</code>`);
    expect(pages!.shown).toContain("A person who sends you a code wants access to your account.");
    expect(pages!.answered.status).toBe(200);
    expect(pages!.answered.html).toContain("Your device is connected");

    // The token is stored for this server, only for the person, and never printed.
    const creds = readCredentials(dir);
    expect(creds.current).toBe(ORIGIN);
    const entry = creds.servers[ORIGIN];
    expect(entry.accessToken).toMatch(/^goa_/);
    expect(entry.refreshToken).toMatch(/^gor_/);
    expect(entry.user).toBe("robin");
    if (process.platform !== "win32") expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(login.out.join("\n")).not.toContain(entry.accessToken);

    const who = await run(["whoami"]);
    expect(who.out).toEqual([`robin on ${ORIGIN}`]);

    expect((await run(["projects"])).out).toEqual(["You have no projects. Make one: gitring new <name>"]);
    const made = await run(["new", "shop"]);
    expect(made.code).toBe(0);
    const id = /^gitring made the project (shop-[a-z0-9]+) \(private\)\.$/.exec(made.out[0])![1];
    expect(made.out[1]).toBe(`Open it: ${ORIGIN}/overview?project=${id}`);
    expect(made.out[2]).toBe(`Make a task: gitring task ${id} "title" "goal"`);
    const listed = await run(["projects"]);
    expect(listed.out[0]).toMatch(/^PROJECT\s+ROLE\s+NAME$/);
    expect(listed.out[1].split(/\s+/)).toEqual([id, "owner", "shop"]);

    const task = await run(["task", id, "Add dark mode", "A switch in the header turns dark mode on and off."]);
    expect(task.code).toBe(0);
    expect(task.out[0]).toMatch(/^gitring made the task i_\S+: Add dark mode\. Agents can take it now\.$/);
    // tasks calls the MCP endpoint with the same token.
    const tasks = await run(["tasks", id]);
    expect(tasks.err).toEqual([]);
    expect(tasks.out[0]).toMatch(/^TASK\s+STATUS\s+AGENTS\s+TITLE$/);
    expect(tasks.out[1]).toMatch(/^i_\S+\s+Open\s+0\s+Add dark mode$/);
    const json = await run(["tasks", id, "--json"]);
    expect(JSON.parse(json.out.join("\n")).intents[0].title).toBe("Add dark mode");
  });

  it("stops when the person cancels on /device", async () => {
    const { session } = await robin();
    let answered = "";
    const { run } = cli({
      onSleep: async (n, out) => {
        if (n === 1) answered = (await personAnswers(session, codeIn(out), "deny")).answered.html;
      },
    });
    const res = await run(["login", "--server", ORIGIN]);
    expect(res.code).toBe(1);
    expect(res.err).toEqual(["You stopped the sign-in in the browser. The command line got no access."]);
    expect(answered).toContain("You stopped the sign-in");
    expect(readCredentials(dir).servers).toEqual({});
  });

  it("ends the sign-in on the server at logout", async () => {
    const { session } = await robin();
    const { run } = cli({ onSleep: async (n, out) => void (n === 1 && (await personAnswers(session, codeIn(out), "allow"))) });
    expect((await run(["login", "--server", ORIGIN])).code).toBe(0);
    const token = readCredentials(dir).servers[ORIGIN].accessToken;
    expect((await mcpCall(token, "gitring_intents", {})).status).toBe(200);
    const out = await run(["logout"]);
    expect(out.out).toEqual([`You are signed out of ${ORIGIN}.`]);
    expect(readCredentials(dir)).toEqual({ version: 1, current: null, servers: {} });
    expect((await mcpCall(token, "gitring_intents", {})).status).toBe(401);
    expect((await run(["projects"])).err[0]).toBe("Sign in first: gitring login --server https://your-gitring.example.com");
  });
});

/** One MCP tool call with a token (no command line). */
async function mcpCall(token: string, name: string, args: Record<string, unknown>) {
  const res = await send("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
    body: JSON.stringify(toolCallBody(name, args)),
  });
  const text = await res.text();
  const data = text.trimStart().startsWith("{") ? text : (text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).at(-1) ?? "");
  let body: any;
  try {
    body = JSON.parse(data);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** A token of the device grant for Robin, straight from the routes (no command line). */
async function deviceToken(session: string, scope = "mcp", clientId = "gitring-cli"): Promise<string> {
  const start = await send("/oauth/device_authorization", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  });
  expect(start.status).toBe(200);
  const d = (await start.json()) as { device_code: string; user_code: string };
  await personAnswers(session, d.user_code, "allow");
  const tok = await send("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: clientId }).toString(),
  });
  expect(tok.status).toBe(200);
  return ((await tok.json()) as { access_token: string }).access_token;
}

describe("the command line's token at the REST API", () => {
  it("works only for the routes of the commands: never for keys, settings, members or deletion", async () => {
    const { session, key } = await robin();
    const made = await world.call("POST", "/api/projects", { key, body: { name: "shop", visibility: "private", source: { kind: "empty" } } });
    expect(made.status).toBe(201);
    const shop = made.json.project.id as string;
    const token = await deviceToken(session);
    const auth = { authorization: `Bearer ${token}` };
    expect((await send("/api/projects", { headers: auth })).status).toBe(200);
    expect((await send("/api/me", { headers: auth })).status).toBe(200);
    const refused: [string, string, unknown?][] = [
      ["GET", "/api/keys"],
      ["POST", "/api/keys", { name: "stolen" }],
      ["PUT", `/api/projects/${shop}/settings`, { approver: "owner" }],
      ["POST", `/api/projects/${shop}/members`, { login: "mallory" }],
      ["DELETE", `/api/projects/${shop}`],
      ["GET", "/api/oauth/grants"],
    ];
    for (const [method, path, body] of refused) {
      const res = await send(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
    // The project and the person's keys are as before.
    expect((await world.call("GET", `/api/projects/${shop}`, { key })).status).toBe(200);
  });

  it("is not open to the tokens of other apps, nor to a read-only sign-in of the command line", async () => {
    const { session, userId } = await robin();
    // An MCP app that the person allowed with the code flow: its token works at /mcp only.
    const reg = await world.dir.oauthRegister({ client_name: "Claude Code", redirect_uris: ["http://localhost:4567/callback"] });
    const id = String(reg.body.client_id);
    const verifier = "v".repeat(20) + "-verifier-0123456789abcdefghijklmnop";
    const started = await world.dir.oauthStart({ response_type: "code", client_id: id, redirect_uri: "http://localhost:4567/callback", code_challenge: await s256(verifier), code_challenge_method: "S256", resource: `${ORIGIN}/mcp` }, ORIGIN);
    if (!started.ok) throw new Error("start");
    const code = new URL((await world.dir.oauthApprove(started.request.id, userId, ORIGIN))!).searchParams.get("code")!;
    const app = await world.dir.oauthToken({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: id, resource: `${ORIGIN}/mcp` }, null, ORIGIN);
    const appToken = String(app.body.access_token);
    expect((await mcpCall(appToken, "gitring_intents", {})).status).toBe(200);
    expect((await send("/api/projects", { headers: { authorization: `Bearer ${appToken}` } })).status).toBe(401);
    // The command line, signed in to read only: MCP reads work, REST does not.
    const readOnly = await deviceToken(session, "mcp:read");
    expect((await mcpCall(readOnly, "gitring_intents", {})).status).toBe(200);
    expect((await send("/api/projects", { headers: { authorization: `Bearer ${readOnly}` } })).status).toBe(401);
  });
});

describe("the /device page", () => {
  it("asks a person who is not signed in to sign in, and comes back to the same code", async () => {
    await robin();
    const page = await send("/device?code=bcdf-ghjk");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("<h1>Connect a device to gitring</h1>");
    expect(html).toContain(`href="/auth/github/start?return=${encodeURIComponent("/device?code=BCDF-GHJK")}"`);
    const stopped = await (await send("/device?signin_error=stopped")).text();
    expect(stopped).toContain("You stopped the sign-in.");
  });

  it("shows a form for the code, and plain words for a wrong code", async () => {
    const { session } = await robin();
    const cookie = `__Host-gitring=${session}`;
    const form = await (await send("/device", { cookie })).text();
    expect(form).toContain('<form method="get" action="/device" class="card">');
    expect(form).toContain("You are signed in as robin. Type the code that your device shows.");
    const wrong = await send("/device?code=BCDF-GHJK", { cookie });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("This code does not work. It expired, or it is not the code of your device.");
    const malformed = await send("/device?code=12", { cookie });
    expect(await malformed.text()).toContain("A code has 8 letters, for example BCDF-GHJK.");
  });

  it("refuses an answer from another browser and from another site", async () => {
    const { session } = await robin();
    const start = await send("/oauth/device_authorization", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "client_id=gitring-cli" });
    const d = (await start.json()) as { user_code: string; device_code: string };
    const shown = await send(`/device?code=${d.user_code}`, { cookie: `__Host-gitring=${session}` });
    const nonce = /name="confirm" value="([^"]+)"/.exec(await shown.text())![1];
    const form = new URLSearchParams({ code: d.user_code, confirm: nonce, decision: "allow" }).toString();
    const post = (headers: Record<string, string>, cookie: string) => send("/device", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: form, cookie });
    // Without the cookie of the page (another browser): refused.
    const other = await post({ origin: ORIGIN, "sec-fetch-site": "same-origin" }, `__Host-gitring=${session}`);
    expect(other.status).toBe(400);
    expect(await other.text()).toContain("Open this page in the same browser");
    // From another site: refused before the page.
    const cross = await post({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }, `__Host-gitring=${session}; __Host-gitring-device=${nonce}`);
    expect(cross.status).toBe(403);
    // Without a sign-in: refused.
    const anon = await post({ origin: ORIGIN, "sec-fetch-site": "same-origin" }, `__Host-gitring-device=${nonce}`);
    expect(anon.status).toBe(401);
    // The program still waits.
    const tok = await send("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: "gitring-cli" }).toString() });
    expect(((await tok.json()) as { error: string }).error).toBe("authorization_pending");
  });

  it("uses plain words (ASD-STE100) on the page that asks the person", async () => {
    const { session } = await robin();
    const start = await send("/oauth/device_authorization", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "client_id=gitring-cli" });
    const d = (await start.json()) as { user_code: string };
    const html = await (await send(`/device?code=${d.user_code}`, { cookie: `__Host-gitring=${session}` })).text();
    const body = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
    const texts = [...body.matchAll(/<(h1|h2|p)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2].replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/g, " "));
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) expect(steViolations(t)).toEqual([]);
  });

  it("answers CORS preflights of programs at the device endpoint", async () => {
    const res = await send("/oauth/device_authorization", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("what an older server answers", () => {
  it("is plain to detect: a route it does not have answers 404 with no JSON, a tool it does not have names the tool", async () => {
    const { key } = await robin();
    const missing = await world.call("GET", "/api/no-such-route", { key });
    expect(missing.status).toBe(404);
    expect(missing.json).toBeNull();
    const tool = await mcpCall(key, "gitring_no_such_tool", {});
    const words = tool.body?.error?.message ?? tool.body?.result?.content?.[0]?.text ?? "";
    expect(isMissingTool("gitring_no_such_tool", words)).toBe(true);
    expect(TOO_OLD).toBe("This gitring server is too old for this command.");
  });
});
