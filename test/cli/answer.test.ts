/**
 * Answers to merge questions from the gitring command line (`gitring yes` and `gitring back`), end to end
 * through the real Worker, the real Directory and the real project object.
 *
 * The token of the command line comes from the device grant. Its answer counts as the person's answer only
 * when the person allows answers outside the gitring app (contract C3, approvalsIn "agent" or "both"). When
 * the person chose "app", or when gitring cannot read the choice, only the gitring app counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeLoader, type NodeLoader } from "../checks/node-loader";
import { steViolations } from "../coord/ste";
import { World, ORIGIN } from "../github/harness";
import { callTool, makeProject } from "../mcp/support";
import { CLI_CLIENT_ID, DEVICE_GRANT } from "../../src/directory/device";
import { CLI_APP_ONLY, cliMayAnswer, cliMayCall } from "../../src/worker/cli";

const GREET = 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n';
const GREET_TEST = 'import { test, expect } from "../harness/test.js";\nimport { greet } from "../src/greet.js";\ntest("greets", () => expect(greet("Robin")).toBe("Hello, Robin!"));\n';
const SHOUT = 'import { greet } from "./greet.js";\nexport function shout(name) {\n  return greet(name).toUpperCase();\n}\n';
const SHOUT_TEST = 'import { test, expect } from "../harness/test.js";\nimport { shout } from "../src/shout.js";\ntest("shouts", () => expect(shout("Robin")).toBe("HELLO, ROBIN!"));\n';

let world: World;
let loader: NodeLoader;
let key: string;
let session: string;
let userId: string;
let project: string;

const cookie = (token: string) => ({ cookie: `__Host-gitring=${token}` });
const gr = (name: string, args: Record<string, unknown> = {}) => callTool(world, key, name, { project, ...args });
const factsOf = (text: string) => JSON.parse(text.slice(text.indexOf("{")));

/** The person's choice (contract C3), as the Directory of a newer gitring gives it. Absent: this gitring has no choices. */
function choose(approvalsIn: "agent" | "app" | "both" | null) {
  const dir = world.dir as unknown as { prefs?: (id: string) => Promise<{ approvalsIn: string }> };
  if (approvalsIn) dir.prefs = async () => ({ approvalsIn });
  else delete dir.prefs;
}

/** A token of the command line for the person (the device grant, as `gitring login` gets it). */
async function cliToken(scope = "mcp"): Promise<string> {
  const start = await world.dir.oauthDeviceStart({ client_id: CLI_CLIENT_ID, scope, resource: `${ORIGIN}/mcp` }, null, ORIGIN, "203.0.113.9");
  expect(start.status).toBe(200);
  const d = start.body as { device_code: string; user_code: string };
  expect(await world.dir.oauthDeviceDecide(d.user_code, userId, true)).not.toBeNull();
  const tok = await world.dir.oauthToken({ grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: CLI_CLIENT_ID }, null, ORIGIN);
  expect(tok.status).toBe(200);
  return String(tok.body.access_token);
}

async function mainSha(): Promise<string> {
  const res = await world.call("GET", `/api/projects/${project}/state`, { key });
  return String(res.json.project.mainSha);
}

/** A work copy that waits for a yes. Answers the work copy and the question. */
async function waitingWork(): Promise<{ id: string; approvalId: string }> {
  const plan = await gr("gitring_declare", { newIntent: { title: "Shout", goal: "A shout function exists." }, plan: ["Add shout"], files: ["src/shout.js", "tests/shout.test.js"], symbols: ["src/shout.js#shout"], approach: "New file." });
  const id = /work copy (a_\w+)/.exec(plan.text)?.[1] ?? "";
  expect(id, plan.text).not.toBe("");
  const wrote = await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] });
  expect(wrote.isError, wrote.text).toBe(false);
  const sub = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
  expect(sub.text).toMatch(/^A PERSON MUST SAY YES\./);
  return { id, approvalId: factsOf(sub.text).approval.id as string };
}

/** The request of `gitring yes` / `gitring back` (see test/cli/cli.test.ts for the command line itself). */
function decide(token: string, id: string, body: Record<string, unknown>) {
  return world.call("POST", `/api/projects/${project}/attempts/${id}/decide`, { key: token, body });
}

beforeEach(async () => {
  world = new World();
  loader = nodeLoader();
  vi.stubGlobal("fetch", world.fetch);
  await world.init({ LOADER: loader });
  world.person("alice", 1);
  ({ key, session, userId } = await world.signIn("alice"));
  project = await makeProject(world, key, "shop", { checks: { runner: "worker" } });
  await world.land(project, "src/greet.js", GREET);
  await world.land(project, "tests/greet.test.js", GREET_TEST);
  const ask = await world.call("PUT", `/api/projects/${project}/settings`, { headers: cookie(session), body: { landing: "ask" } });
  expect(ask.status, ask.text).toBe(200);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await world.settle();
  await loader.cleanup();
});

describe("a yes from the command line", () => {
  it("counts as the person's answer when the person allows answers outside the app: the work merges", async () => {
    choose("both");
    const { id, approvalId } = await waitingWork();
    const token = await cliToken();
    const before = await mainSha();
    const yes = await decide(token, id, { approvalId, answer: "approve" });
    expect(yes.status, yes.text).toBe(200);
    expect(yes.json.outcome).toBe("approved");
    await world.settle();
    expect(await mainSha()).not.toBe(before);
    const st = await gr("gitring_status", { attemptId: id });
    expect(factsOf(st.text)).toMatchObject({ status: "landed", approval: { status: "approved", answer: { by: "alice", how: "cli" } } });
    // The log says where the answer came from.
    const state = await world.call("GET", `/api/projects/${project}/state`, { key });
    const said = (state.json.logs as { message: string }[]).find((l) => l.message.includes("says yes"));
    expect(said?.message).toMatch(/^alice says yes to the work of \S+ on "Shout" with the gitring command line\.$/);
    expect(steViolations(said!.message.replace(/"[^"]*"/g, ""))).toEqual([]);
  });

  it("sends the work back with the note when the person answers in the agent's chat", async () => {
    choose("agent");
    const { id, approvalId } = await waitingWork();
    const back = await decide(await cliToken(), id, { approvalId, answer: "send-back", note: "Use a name with two words." });
    expect(back.status, back.text).toBe(200);
    expect(back.json.outcome).toBe("sent-back");
    const st = await gr("gitring_status", { attemptId: id });
    expect(factsOf(st.text)).toMatchObject({ status: "underway", approval: { status: "sent-back", answer: { how: "cli", note: "Use a name with two words." } } });
  });
});

describe("answers from the command line that do not count", () => {
  it("are refused when the person answers only in the gitring app, and when gitring cannot read the choice", async () => {
    const { id, approvalId } = await waitingWork();
    const token = await cliToken();
    const before = await mainSha();
    for (const choice of ["app", null] as const) {
      choose(choice);
      const res = await decide(token, id, { approvalId, answer: "approve" });
      expect([choice, res.status, res.json.error]).toEqual([choice, 403, CLI_APP_ONLY]);
    }
    expect(steViolations(CLI_APP_ONLY)).toEqual([]);
    expect(await mainSha()).toBe(before);
    // The question still waits, and the person can answer in the app.
    const st = await gr("gitring_status", { attemptId: id });
    expect(factsOf(st.text).approval.status).toBe("waiting");
    const inApp = await world.call("POST", `/api/projects/${project}/attempts/${id}/decide`, { headers: cookie(session), body: { approvalId, answer: "approve" } });
    expect(inApp.status, inApp.text).toBe(200);
    expect(inApp.json.outcome).toBe("approved");
  });

  it("never come from a key or from a read-only sign-in of the command line", async () => {
    choose("both");
    const { id, approvalId } = await waitingWork();
    const withKey = await decide(key, id, { approvalId, answer: "approve" });
    expect(withKey.status).toBe(403);
    expect(withKey.json.error).toBe("A person must answer in the gitring app. A key or an agent token cannot say yes for a person.");
    // A read-only sign-in works at /mcp only: the REST route does not know the token.
    const readOnly = await decide(await cliToken("mcp:read"), id, { approvalId, answer: "approve" });
    expect(readOnly.status).toBe(401);
    expect(factsOf((await gr("gitring_status", { attemptId: id })).text).approval.status).toBe("waiting");
  });
});

describe("the rules of the command line's token", () => {
  it("open only the routes of its commands", () => {
    expect(cliMayCall("POST", "/api/projects/shop/attempts/a_1/decide")).toBe(true);
    expect(cliMayCall("get", "/ws/shop")).toBe(true);
    expect(cliMayCall("POST", "/api/projects/shop/attempts/a_1/land")).toBe(false);
    expect(cliMayCall("POST", "/api/projects/shop/questions/q_1/answer")).toBe(false);
    expect(cliMayCall("PUT", "/api/me/prefs")).toBe(false);
    expect(cliMayCall("DELETE", "/api/projects/shop")).toBe(false);
  });

  it("let an answer count only for the command line, with the full scope, and a choice that is not 'app'", () => {
    const cli = { via: "oauth", clientId: CLI_CLIENT_ID, scope: "mcp", user: { id: "u_1" } };
    expect(cliMayAnswer(cli, undefined)).toBe(true);
    expect(cliMayAnswer(cli, "both")).toBe(true);
    expect(cliMayAnswer(cli, "agent")).toBe(true);
    expect(cliMayAnswer(cli, "app")).toBe(false);
    expect(cliMayAnswer({ ...cli, scope: "mcp:read" }, "both")).toBe(false);
    expect(cliMayAnswer({ ...cli, clientId: "gitring-other" }, "both")).toBe(false);
    expect(cliMayAnswer({ ...cli, via: "key" }, "both")).toBe(false);
    expect(cliMayAnswer({ ...cli, user: null }, "both")).toBe(false);
  });
});
