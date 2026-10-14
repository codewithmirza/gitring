/**
 * The human loop through the real Worker, the real Directory and the real project object:
 *
 *   - change requests that submit delivers are never lost on the way to a person (text, link or form);
 *   - each person chooses where they answer merge questions (contract C3): in the chat, in the app, or both;
 *   - a person asks the agent to change some lines from the app (a line comment), and the agent gets it;
 *   - the inbox of a person (contract C4) and the answers to questions, over REST.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeLoader, type NodeLoader } from "../checks/node-loader";
import { steViolations } from "../coord/ste";
import { World, ORIGIN } from "../github/harness";
import { callTool, makeProject, modernCall, type Rpc } from "./support";

const GREET = 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n';
const GREET_TEST = 'import { test, expect } from "../harness/test.js";\nimport { greet } from "../src/greet.js";\ntest("greets", () => expect(greet("Robin")).toBe("Hello, Robin!"));\n';
const SHOUT = 'import { greet } from "./greet.js";\nexport function shout(name) {\n  return greet(name).toUpperCase();\n}\n';
const SHOUT_TEST = 'import { test, expect } from "../harness/test.js";\nimport { shout } from "../src/shout.js";\ntest("shouts", () => expect(shout("Robin")).toBe("HELLO, ROBIN!"));\n';

const FORMS = { elicitation: {} };

let world: World;
let loader: NodeLoader;
let key: string;
let session: string;
let userId: string;
let project: string;

const cookie = (token: string) => ({ cookie: `__Host-gitring=${token}` });
const gr = (name: string, args: Record<string, unknown> = {}, as = key) => callTool(world, as, name, { project, ...args });
const gh = (name: string, args: Record<string, unknown> = {}, as = key) => callTool(world, as, name, { repo: project, ...args }, "/mcp/github");

function call(name: string, args: Record<string, unknown>, o: { token?: string; path?: string; capabilities?: Record<string, unknown>; inputResponses?: unknown; requestState?: unknown } = {}): Promise<Rpc> {
  return modernCall(world, {
    path: o.path ?? "/mcp",
    token: o.token ?? key,
    method: "tools/call",
    capabilities: o.capabilities,
    params: { name, arguments: args, ...(o.inputResponses !== undefined ? { inputResponses: o.inputResponses } : {}), ...(o.requestState !== undefined ? { requestState: o.requestState } : {}) },
  });
}

const textOf = (rpc: Rpc): string => String(rpc.body?.result?.content?.[0]?.text ?? "");
const resultOf = (rpc: Rpc) => rpc.body?.result;

async function mainSha(): Promise<string> {
  return String((await world.call("GET", `/api/projects/${project}/state`, { key })).json.project.mainSha);
}

async function shoutWork(as = key): Promise<string> {
  const plan = await gr("gitring_declare", { newIntent: { title: "Shout", goal: "A shout function exists." }, plan: ["Add shout"], files: ["src/shout.js", "tests/shout.test.js"], symbols: ["src/shout.js#shout"], approach: "New file." }, as);
  const id = /work copy (a_\w+)/.exec(plan.text)?.[1] ?? "";
  expect(id, plan.text).not.toBe("");
  const wrote = await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] }, as);
  expect(wrote.isError, wrote.text).toBe(false);
  return id;
}

/** A person asks for a change on some lines of the work copy, in the app. Answers the change request. */
async function lineRequest(attemptId: string, text = "Name the parameter person.") {
  const res = await world.call("POST", `/api/projects/${project}/attempts/${attemptId}/requests`, { headers: cookie(session), body: { path: "src/shout.js", from: 2, to: 3, text } });
  expect(res.status, res.text).toBe(201);
  return res.json as { id: string; kind: string; message: string; status: string };
}

const setPrefs = (approvalsIn: string, as: Record<string, unknown> = { headers: cookie(session) }) => world.call("PUT", "/api/me/prefs", { ...as, body: { approvalsIn } });

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

describe("change requests on the way to a person are never lost", () => {
  it("are in the answer of gitring_submit with the link", async () => {
    const id = await shoutWork();
    const cr = await lineRequest(id);
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    expect(sub.text).toMatch(/^GITRING CHANGE REQUEST/);
    expect(sub.text).toContain(`[${cr.id}]`);
    expect(sub.text).toContain("alice asks you to change src/shout.js lines 2–3: Name the parameter person.");
    expect(sub.text).toContain("A PERSON MUST SAY YES. The work is not merged yet.");
  });

  it("are named in the form, and the answer of the second call holds them", async () => {
    const id = await shoutWork();
    const cr = await lineRequest(id);
    const first = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS });
    const r = resultOf(first);
    expect(r?.resultType, JSON.stringify(first.body)).toBe("input_required");
    const message = String(r.inputRequests.approval.params.message);
    expect(message).toContain("gitring also sent 1 change request to the agent. The work can change.");
    expect(steViolations(message.replace(/"[^"]*"/g, ""))).toEqual([]);
    // The person closes the form. The agent reads the answer of this second call only: the request is there.
    const done = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS, requestState: r.requestState, inputResponses: { approval: { action: "decline" } } });
    expect(textOf(done)).toMatch(/^GITRING CHANGE REQUEST/);
    expect(textOf(done)).toContain(`[${cr.id}]`);
    // Once the agent confirms it, the request is not sent again.
    expect((await gr("gitring_ack", { attemptId: id, correctionId: cr.id, note: "Done." })).isError).toBe(false);
    const again = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS, requestState: r.requestState, inputResponses: { approval: { action: "decline" } } });
    expect(textOf(again)).not.toContain(`[${cr.id}]`);
  });

  it("wait again when the person never answers the form: the next call of the agent holds them", async () => {
    const id = await shoutWork();
    const cr = await lineRequest(id);
    const first = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS });
    expect(resultOf(first)?.resultType).toBe("input_required");
    // The client never sends the second call. The agent calls another tool later: the request is there.
    const next = await gr("gitring_status", { attemptId: id });
    expect(next.text).toMatch(/^GITRING CHANGE REQUEST/);
    expect(next.text).toContain(`[${cr.id}]`);
    // It reaches the agent once: the call after that does not hold it again.
    expect((await gr("gitring_status", { attemptId: id })).text).not.toContain(`[${cr.id}]`);
  });

  it("are in the answer of create_pull_request (GitHub-compatible tools)", async () => {
    await gh("push_files", { branch: "feature/shout", message: "Shout", files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] });
    const st = await world.call("GET", `/api/projects/${project}/state`, { key });
    const at = (st.json.attempts as { id: string; course: { approach: string } }[]).find((a) => a.course.approach.includes("feature/shout"))!;
    const cr = await lineRequest(at.id);
    const pr = await gh("create_pull_request", { title: "Shout", head: "feature/shout", base: "main" });
    expect(pr.text).toMatch(/^GITRING CHANGE REQUEST/);
    expect(pr.text).toContain(`[${cr.id}]`);
    expect(pr.text).toContain("Pull request 1: waits for a person.");
  });
});

describe("where a person answers merge questions (approvalsIn)", () => {
  it("is 'both' at first, and the person changes it in the app", async () => {
    expect((await world.call("GET", "/api/me/prefs", { headers: cookie(session) })).json).toEqual({ approvalsIn: "both" });
    const put = await setPrefs("app");
    expect(put.status, put.text).toBe(200);
    expect(put.json).toEqual({ approvalsIn: "app" });
    expect((await world.call("GET", "/api/me/prefs", { key })).json).toEqual({ approvalsIn: "app" });
    expect((await setPrefs("never")).status).toBe(400);
    expect((await world.call("GET", "/api/me/prefs")).status).toBe(401);
  });

  it("lets a key make it stricter, but not undo 'app': an agent with the key cannot loosen it", async () => {
    // A key cannot choose "agent" either: that stops the push notifications of merge questions.
    expect((await setPrefs("agent", { key })).status).toBe(403);
    expect((await setPrefs("both", { key })).json).toEqual({ approvalsIn: "both" });
    expect((await setPrefs("app", { key })).json).toEqual({ approvalsIn: "app" });
    const loosen = await setPrefs("both", { key });
    expect(loosen.status).toBe(403);
    expect(steViolations(String(loosen.json.error).replace(/"[^"]*"/g, ""))).toEqual([]);
    expect((await world.call("GET", "/api/me/prefs", { key })).json).toEqual({ approvalsIn: "app" });
    expect((await setPrefs("agent")).json).toEqual({ approvalsIn: "agent" });
  });

  it("'app': gitring never asks in the chat, gives the link, and tells the agent to wait with gitring_wait", async () => {
    await setPrefs("app");
    const id = await shoutWork();
    const rpc = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS });
    expect(resultOf(rpc).resultType).not.toBe("input_required");
    const text = textOf(rpc);
    expect(text).toMatch(/^A PERSON MUST SAY YES\./);
    expect(text).toContain("The person answers in the gitring app only. gitring does not ask in this chat.");
    expect(text).toContain(`Link: ${ORIGIN}/approve/${id}?project=${project}`);
    expect(text).toContain(`To wait for the answer, call gitring_wait with the work copy id ${id}.`);
    expect(steViolations(text.slice(0, text.indexOf("\n\n")).replace(/Link: \S+/, "Link: x").replace(/"[^"]*"/g, ""))).toEqual([]);
    const st = await gr("gitring_status", { attemptId: id });
    expect(st.text).toContain("The person answers in the gitring app only.");
  });

  it("'app': an answer from the chat does not count, also with a state that gitring signed before", async () => {
    const id = await shoutWork();
    const before = await mainSha();
    const first = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS });
    const state = resultOf(first).requestState as string;
    await setPrefs("app");
    const done = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS, requestState: state, inputResponses: { approval: { action: "accept", content: { answer: "approve" } } } });
    expect(done.body.error, JSON.stringify(done.body)).toBeUndefined();
    expect(textOf(done)).toMatch(/^You chose to answer merge questions in the gitring app only\. gitring did not use the answer from this chat\. Answer in the app\./);
    await world.settle();
    expect(await mainSha()).toBe(before);
    const st = await gr("gitring_status", { attemptId: id });
    expect(JSON.parse(st.text.slice(st.text.indexOf("{"))).approval.status).toBe("waiting");
  });

  it("'app' of the sender also stops the form for an owner who calls with another key", async () => {
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
    const bobSession = { headers: cookie(bob.session) };
    expect((await setPrefs("app", bobSession)).status).toBe(200);
    // Bob sends the agent: he answers. He chose the app. Alice (an owner) calls with her key: no form.
    const id = await shoutWork(bob.key);
    const rpc = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS });
    expect(resultOf(rpc).resultType).not.toBe("input_required");
    expect(textOf(rpc)).toContain("bob must say yes");
  });

  it("'agent' and 'both' ask in the chat when the client can show a form", async () => {
    for (const where of ["agent", "both"]) {
      await setPrefs(where);
      const id = await shoutWork();
      const rpc = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS });
      expect(resultOf(rpc).resultType, where).toBe("input_required");
    }
  });

  it("'app' in the GitHub-compatible tools: no form, and the link", async () => {
    await setPrefs("app");
    await gh("push_files", { branch: "feature/shout", message: "Shout", files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] });
    const rpc = await call("create_pull_request", { repo: project, title: "Shout", head: "feature/shout", base: "main" }, { capabilities: FORMS, path: "/mcp/github" });
    expect(resultOf(rpc).resultType).not.toBe("input_required");
    expect(textOf(rpc)).toMatch(/^Pull request 1: waits for a person\./);
    expect(textOf(rpc)).toContain("The person answers in the gitring app only.");
  });
});

describe("a person asks the agent to change some lines", () => {
  it("gives the agent a change request in the answer of its next call", async () => {
    const id = await shoutWork();
    const cr = await lineRequest(id, "Use the name person.");
    expect(cr).toMatchObject({ kind: "review", status: "pending" });
    const read = await gr("gitring_log", { attemptId: id, message: "Next step." });
    expect(read.text).toMatch(/^GITRING CHANGE REQUEST/);
    expect(read.text).toContain("alice asks you to change src/shout.js lines 2–3: Use the name person. Change it, run the tests, and call gitring_ack.");
  });

  it("is only for a person in the app, with valid lines and words", async () => {
    const id = await shoutWork();
    const url = `/api/projects/${project}/attempts/${id}/requests`;
    const body = { path: "src/shout.js", from: 2, to: 3, text: "Rename it." };
    expect((await world.call("POST", url, { key, body })).status).toBe(403);
    expect((await world.call("POST", url, { headers: cookie(session), body: { ...body, from: 0 } })).status).toBe(400);
    expect((await world.call("POST", url, { headers: cookie(session), body: { ...body, from: 4, to: 3 } })).status).toBe(400);
    expect((await world.call("POST", url, { headers: cookie(session), body: { ...body, text: " " } })).status).toBe(400);
    // A viewer cannot ask.
    world.person("eve", 3);
    const eve = await world.signIn("eve");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@eve", role: "viewer" } });
    expect((await world.call("POST", url, { headers: cookie(eve.session), body })).status).toBe(403);
  });
});

describe("the inbox of a person", () => {
  it("lists the merge questions of every project where the person may answer, with the project name", async () => {
    const id = await shoutWork();
    await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    const res = await world.call("GET", "/api/me/inbox", { headers: cookie(session) });
    expect(res.status, res.text).toBe(200);
    const items = res.json.items as { kind: string; attemptId: string; projectName: string; project: string; actions: { id: string }[]; link: string; title: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "approval", attemptId: id, project, projectName: "shop", title: "Shout", link: `/approve/${id}?project=${project}` });
    expect(items[0].actions.map((a) => a.id)).toEqual(["approve", "send-back"]);
    // Another member who did not send the agent has nothing to answer.
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
    expect((await world.call("GET", "/api/me/inbox", { headers: cookie(bob.session) })).json.items).toEqual([]);
    expect((await world.call("GET", "/api/me/inbox")).status).toBe(401);
    expect(userId).toBeTruthy();
  });

  it("answers a question only for a person in the app", async () => {
    const res = await world.call("POST", `/api/projects/${project}/questions/q_none/answer`, { key, body: { option: "both" } });
    expect(res.status).toBe(403);
    const unknown = await world.call("POST", `/api/projects/${project}/questions/q_none/answer`, { headers: cookie(session), body: { option: "both" } });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe("Unknown question.");
  });
});

describe("push notifications for the inbox", () => {
  it("are off without the keys of the deployment, and the app can see that", async () => {
    const res = await world.call("GET", "/api/me/push", { headers: cookie(session) });
    expect(res.json).toEqual({ available: false, devices: 0 });
    const sub = await world.call("POST", "/api/me/push", { headers: cookie(session), body: { endpoint: "https://push.example.org/send/abc" } });
    expect(sub.status).toBe(400);
  });

  it("are turned on and off only in the app: an agent with the key cannot stop them", async () => {
    const body = { endpoint: "https://push.example.org/send/abc" };
    expect((await world.call("POST", "/api/me/push", { key, body })).status).toBe(403);
    const off = await world.call("DELETE", "/api/me/push", { key, body });
    expect(off.status).toBe(403);
    expect(off.json.error).toBe("Turn off push notifications in the gitring app.");
    expect((await world.call("DELETE", "/api/me/push", { headers: cookie(session), body })).json).toEqual({ devices: 0 });
  });
});
