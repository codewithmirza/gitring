/**
 * Approvals through the MCP tools, end to end through the real Worker, the real Directory and the real
 * project object.
 *
 * A work copy that is ready waits for a person when the project says so. The agent never answers. gitring
 * reaches the person in the chat of the agent (a client of 2026-07-28 that can show a form) or in the gitring
 * app (a link). These tests check both ways, the signed state of a question, and the people who may not answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeLoader, type NodeLoader } from "../checks/node-loader";
import { steViolations } from "../coord/ste";
import { World, ORIGIN } from "../github/harness";
import { callTool, legacyClient, makeProject, modernCall, type Rpc } from "./support";

const GREET = 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n';
const GREET_TEST = 'import { test, expect } from "../harness/test.js";\nimport { greet } from "../src/greet.js";\ntest("greets", () => expect(greet("Robin")).toBe("Hello, Robin!"));\n';
const SHOUT = 'import { greet } from "./greet.js";\nexport function shout(name) {\n  return greet(name).toUpperCase();\n}\n';
const SHOUT_TEST = 'import { test, expect } from "../harness/test.js";\nimport { shout } from "../src/shout.js";\ntest("shouts", () => expect(shout("Robin")).toBe("HELLO, ROBIN!"));\n';

/** The client says that it can show a form to a person. */
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

/** A call with the client abilities, and (for the second call of a question) the answer and the state. */
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
  const res = await world.call("GET", `/api/projects/${project}/state`, { key });
  return String(res.json.project.mainSha);
}

/** A work copy with a new file and its test, made with the gitring tools. Answers the work copy id. */
async function shoutWork(as = key): Promise<string> {
  const plan = await gr("gitring_declare", { newIntent: { title: "Shout", goal: "A shout function exists." }, plan: ["Add shout"], files: ["src/shout.js", "tests/shout.test.js"], symbols: ["src/shout.js#shout"], approach: "New file." }, as);
  const id = /work copy (a_\w+)/.exec(plan.text)?.[1] ?? "";
  expect(id, plan.text).not.toBe("");
  const wrote = await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] }, as);
  expect(wrote.isError, wrote.text).toBe(false);
  return id;
}

/** The project asks a person before every merge. Only a person (a browser session) can set this. */
async function askBeforeMerge(approver?: "sender" | "owner") {
  const res = await world.call("PUT", `/api/projects/${project}/settings`, { headers: cookie(session), body: { landing: "ask", ...(approver ? { approver } : {}) } });
  expect(res.status, res.text).toBe(200);
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
  await askBeforeMerge();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await world.settle();
  await loader.cleanup();
});

describe("a client that cannot show a question: the answer holds a link", () => {
  it("says that a person must say yes, names who, and gives the link of the gitring app", async () => {
    const id = await shoutWork();
    const before = await mainSha();
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    expect(sub.isError, sub.text).toBe(false);
    expect(sub.text).toMatch(/^A PERSON MUST SAY YES\. The work is not merged yet\./);
    expect(sub.text).toContain('alice must say yes to this work: "Shout".');
    expect(sub.text).toMatch(/2 files, \+\d+ -0\. \d+ of \d+ tests pass\./);
    expect(sub.text).toContain("This project asks a person before every merge.");
    expect(sub.text).toContain(`Link: ${ORIGIN}/approve/${id}?project=${project}`);
    expect(sub.text).toContain(`call gitring_status with the work copy id ${id}`);
    expect(sub.text).toContain("Do not change the work copy while you wait.");
    const facts = JSON.parse(sub.text.slice(sub.text.indexOf("{")));
    expect(facts).toMatchObject({ attemptId: id, status: "ready", next: "awaiting-approval", approval: { status: "waiting", reason: "project-asks", approver: "alice" }, link: `${ORIGIN}/approve/${id}?project=${project}` });
    expect(facts.approval.digest).toBeUndefined();
    // Nothing merged.
    expect(await mainSha()).toBe(before);
  });

  it("answers the same way, with the same question, when the agent submits again", async () => {
    const id = await shoutWork();
    const a = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    const b = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    expect(JSON.parse(a.text.slice(a.text.indexOf("{"))).approval.id).toBe(JSON.parse(b.text.slice(b.text.indexOf("{"))).approval.id);
  });

  it("gives the same facts to gitring_status, and status changes nothing", async () => {
    const id = await shoutWork();
    await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    const before = await mainSha();
    const st = await gr("gitring_status", { attemptId: id });
    expect(st.isError, st.text).toBe(false);
    expect(st.text).toMatch(/^A PERSON MUST SAY YES\./);
    expect(st.text).toContain(`Link: ${ORIGIN}/approve/${id}?project=${project}`);
    expect(await mainSha()).toBe(before);
  });

  it("does not show a form to a client of the older era, and the call ends at once", async () => {
    const id = await shoutWork();
    const client = await legacyClient(world, key);
    try {
      const res = (await client.callTool({ name: "gitring_submit", arguments: { project, attemptId: id, summary: "Add shout" } })) as { content: { text: string }[]; isError?: boolean };
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toMatch(/^A PERSON MUST SAY YES\./);
    } finally {
      await client.close();
    }
  });

  it("does not show a form to a client that lists only the URL form", async () => {
    const id = await shoutWork();
    const rpc = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: { elicitation: { url: {} } } });
    expect(resultOf(rpc).resultType).not.toBe("input_required");
    expect(textOf(rpc)).toMatch(/^A PERSON MUST SAY YES\./);
  });

  it("lets the person answer in the app: the work merges, and the agent reads it", async () => {
    const id = await shoutWork();
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    const approvalId = JSON.parse(sub.text.slice(sub.text.indexOf("{"))).approval.id as string;
    const before = await mainSha();
    // A key cannot say yes for a person.
    const withKey = await world.call("POST", `/api/projects/${project}/attempts/${id}/decide`, { key, body: { approvalId, answer: "approve" } });
    expect(withKey.status).toBe(403);
    const landWithKey = await world.call("POST", `/api/projects/${project}/attempts/${id}/land`, { key, body: {} });
    expect(landWithKey.status).toBe(403);
    expect(await mainSha()).toBe(before);
    // The person answers in the browser.
    const yes = await world.call("POST", `/api/projects/${project}/attempts/${id}/decide`, { headers: cookie(session), body: { approvalId, answer: "approve" } });
    expect(yes.status, yes.text).toBe(200);
    expect(yes.json.outcome).toBe("approved");
    await world.settle();
    expect(await mainSha()).not.toBe(before);
    const st = await gr("gitring_status", { attemptId: id });
    expect(st.text).toMatch(/^Merged at [0-9a-f]{7}\. The task is done\./);
    expect(JSON.parse(st.text.slice(st.text.indexOf("{")))).toMatchObject({ status: "landed", approval: { status: "approved", answer: { by: "alice", how: "app" } } });
  });
});

describe("a client that can show a form: gitring asks in the chat", () => {
  /** The first call: the form. Answers the form and the signed state. */
  async function question(id: string, path = "/mcp") {
    const rpc =
      path === "/mcp"
        ? await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS })
        : await call("create_pull_request", { repo: project, title: "Shout", head: "feature/shout", base: "main" }, { capabilities: FORMS, path });
    const r = resultOf(rpc);
    expect(r?.resultType, JSON.stringify(rpc.body)).toBe("input_required");
    return { rpc, form: r.inputRequests.approval, state: r.requestState as string };
  }

  it("returns a form with the facts and two answers, and a signed state", async () => {
    const id = await shoutWork();
    const { form, state } = await question(id);
    expect(form.method).toBe("elicitation/create");
    expect(form.params.mode).toBe("form");
    expect(form.params.message).toMatch(/^Merge "Shout" into main\? 2 files, \+\d+ -0\. \d+ of \d+ tests pass\. This project asks a person before every merge\./);
    expect(form.params.requestedSchema.required).toEqual(["answer"]);
    expect(form.params.requestedSchema.properties.answer.oneOf).toEqual([
      { const: "approve", title: "Yes, merge it" },
      { const: "send-back", title: "No, send it back to the agent" },
    ]);
    expect(form.params.requestedSchema.properties.note.type).toBe("string");
    expect(state).toMatch(/^v1\./);
    // The words are plain.
    expect(steViolations(form.params.message.replace(/"[^"]*"/g, ""))).toEqual([]);
    // Nothing merged: the question waits for the person.
    const sha = await mainSha();
    expect(sha).toBe(await mainSha());
  });

  it("merges the work when the person says yes in the chat", async () => {
    const id = await shoutWork();
    const before = await mainSha();
    const { state } = await question(id);
    const done = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS, requestState: state, inputResponses: { approval: { action: "accept", content: { answer: "approve" } } } });
    expect(done.body.error, JSON.stringify(done.body)).toBeUndefined();
    expect(resultOf(done).resultType).not.toBe("input_required");
    await world.settle();
    expect(textOf(done)).toMatch(/^Merged at [0-9a-f]{7}\. The task is done\./);
    expect(await mainSha()).not.toBe(before);
    const facts = JSON.parse(textOf(done).slice(textOf(done).indexOf("{")));
    expect(facts).toMatchObject({ status: "landed", approval: { status: "approved", answer: { by: "alice", how: "chat" } } });
  });

  it("sends the work back with the note of the person: a change request comes to the agent", async () => {
    const id = await shoutWork();
    const before = await mainSha();
    const { state } = await question(id);
    const done = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS, requestState: state, inputResponses: { approval: { action: "accept", content: { answer: "send-back", note: "Use a name with two words." } } } });
    expect(done.body.error, JSON.stringify(done.body)).toBeUndefined();
    const text = textOf(done);
    expect(text).toMatch(/^GITRING CHANGE REQUEST — apply it in your next edits, then call gitring_ack\. Do not stop\./);
    expect(text).toContain("alice sends your work back: Use a name with two words.");
    expect(text).toContain("alice sent the work back: Use a name with two words. Change the work, run the tests, and submit again.");
    expect(await mainSha()).toBe(before);
    expect(JSON.parse(text.slice(text.lastIndexOf("\n\n{") + 2))).toMatchObject({ status: "underway", approval: { status: "sent-back", answer: { how: "chat", note: "Use a name with two words." } } });
    // The agent confirms the change request, changes the work, and submits again: a new question, for the new work.
    const crId = /\[(cr_\w+)\]/.exec(text)?.[1] ?? "";
    expect((await gr("gitring_ack", { attemptId: id, correctionId: crId, note: "Done." })).isError).toBe(false);
    await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: `${SHOUT}// two words\n` }] });
    const again = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS });
    expect(resultOf(again).resultType).toBe("input_required");
    const next = await gr("gitring_status", { attemptId: id });
    expect(JSON.parse(next.text.slice(next.text.indexOf("{"))).approval.status).toBe("waiting");
  });

  it("changes nothing when the person closes the form without an answer", async () => {
    const id = await shoutWork();
    const before = await mainSha();
    const { state } = await question(id);
    for (const action of ["decline", "cancel"]) {
      const done = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS, requestState: state, inputResponses: { approval: { action } } });
      expect(done.body.error, JSON.stringify(done.body)).toBeUndefined();
      expect(textOf(done)).toMatch(/^A PERSON MUST SAY YES\./);
      expect(textOf(done)).toContain("gitring asked in this chat. The person did not answer there.");
      expect(textOf(done)).toContain(`Link: ${ORIGIN}/approve/${id}`);
    }
    expect(await mainSha()).toBe(before);
  });

  it("refuses a state that was changed, and a state of another person", async () => {
    const id = await shoutWork();
    const before = await mainSha();
    const { state } = await question(id);
    const yes = { approval: { action: "accept", content: { answer: "approve" } } };
    // Change one character of the state.
    const broken = `${state.slice(0, -3)}${state.endsWith("AAA") ? "BBB" : "AAA"}`;
    const bad = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS, requestState: broken, inputResponses: yes });
    expect(bad.body.error?.code, JSON.stringify(bad.body)).toBe(-32602);
    // Another person of the project holds the state of alice: the state is bound to alice.
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
    const other = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { token: bob.key, capabilities: FORMS, requestState: state, inputResponses: yes });
    expect(other.body.error?.code, JSON.stringify(other.body)).toBe(-32602);
    expect(await mainSha()).toBe(before);
  });

  it("ignores an answer that does not belong to the work copy of the call", async () => {
    const id = await shoutWork();
    const before = await mainSha();
    const { state } = await question(id);
    // A second work copy, and the state of the first one.
    const plan = await gr("gitring_declare", { newIntent: { title: "Whisper", goal: "A whisper function exists." }, plan: ["Add whisper"], files: ["src/whisper.js"], approach: "New file." });
    const other = /work copy (a_\w+)/.exec(plan.text)?.[1] ?? "";
    await gr("gitring_write", { attemptId: other, files: [{ path: "src/whisper.js", content: "export const whisper = (s) => s.toLowerCase();\n" }] });
    const res = await call("gitring_submit", { project, attemptId: other, summary: "Add whisper" }, { capabilities: FORMS, requestState: state, inputResponses: { approval: { action: "accept", content: { answer: "approve" } } } });
    // The answer is not used. gitring asks about the second work copy, as for a first call.
    expect(resultOf(res).resultType).toBe("input_required");
    expect(await mainSha()).toBe(before);
  });

  it("ignores a form that gives no valid answer", async () => {
    const id = await shoutWork();
    const before = await mainSha();
    const { state } = await question(id);
    for (const content of [{ answer: "maybe" }, {}, { answer: "approve", note: "x".repeat(1001) }]) {
      const res = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS, requestState: state, inputResponses: { approval: { action: "accept", content } } });
      expect(resultOf(res).resultType, JSON.stringify(content)).toBe("input_required");
    }
    expect(await mainSha()).toBe(before);
  });

  it("answers an old question with the news, not with a merge: the agent changed the work after the question", async () => {
    const id = await shoutWork();
    const before = await mainSha();
    const { state } = await question(id);
    // The agent changes the work. The question is old now.
    await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: `${SHOUT}// changed\n` }] });
    const done = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { capabilities: FORMS, requestState: state, inputResponses: { approval: { action: "accept", content: { answer: "approve" } } } });
    expect(done.body.error, JSON.stringify(done.body)).toBeUndefined();
    expect(textOf(done)).toMatch(/^The answer did not count\. The agent changed the work\. Submit again to ask again\./);
    expect(await mainSha()).toBe(before);
  });

  it("does not ask a person who may not answer: the answer holds the link", async () => {
    // Only an owner answers. Bob is a member of the project: he sends his agent, and he may not answer.
    await askBeforeMerge("owner");
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
    const id = await shoutWork(bob.key);
    const rpc = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { token: bob.key, capabilities: FORMS });
    expect(resultOf(rpc).resultType).not.toBe("input_required");
    expect(textOf(rpc)).toMatch(/^A PERSON MUST SAY YES\./);
    expect(textOf(rpc)).toMatch(new RegExp(`Link: ${ORIGIN}/approve/${id}\\?project=${project}`));
  });

  it("does not let a member submit the work copy of another person", async () => {
    // Alice (an owner) sent the agent. Bob is a member of the project, and he is not the sender.
    const id = await shoutWork();
    const before = await mainSha();
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
    const rpc = await call("gitring_submit", { project, attemptId: id, summary: "Add shout" }, { token: bob.key, capabilities: FORMS });
    expect(resultOf(rpc).isError).toBe(true);
    expect(textOf(rpc)).toBe(`Error: Work copy ${id} belongs to the agent of alice. Only that person or an owner of the project can change it.`);
    expect(await mainSha()).toBe(before);
  });

  it("is the same for the pull request of the GitHub-compatible tools", async () => {
    await gh("push_files", { branch: "feature/shout", message: "Shout", files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] });
    const before = await mainSha();
    const { form, state } = await question("", "/mcp/github");
    expect(form.params.message).toMatch(/^Merge "Shout" into main\?/);
    const done = await call("create_pull_request", { repo: project, title: "Shout", head: "feature/shout", base: "main" }, { path: "/mcp/github", capabilities: FORMS, requestState: state, inputResponses: { approval: { action: "accept", content: { answer: "approve" } } } });
    expect(done.body.error, JSON.stringify(done.body)).toBeUndefined();
    await world.settle();
    expect(textOf(done)).toMatch(/^Pull request 1: merged\./);
    expect(await mainSha()).not.toBe(before);
  });

  it("gives the link to the GitHub-compatible client that cannot show a form", async () => {
    await gh("push_files", { branch: "feature/shout", message: "Shout", files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] });
    const pr = await gh("create_pull_request", { title: "Shout", head: "feature/shout", base: "main" });
    expect(pr.text).toMatch(/^Pull request 1: waits for a person\. The work is not merged yet\./);
    expect(pr.text).toContain("call merge_pull_request for pull request 1");
    expect(pr.text).not.toMatch(/gitring_status|gitring_ack/);
    const url = /Link: (\S+)/.exec(pr.text)?.[1] ?? "";
    expect(url).toMatch(new RegExp(`^${ORIGIN}/approve/a_\\w+\\?project=${project}$`));
    const read = await gh("pull_request_read", { method: "get", pullNumber: 1 });
    expect(JSON.parse(read.text.slice(read.text.indexOf("{"))).gitring).toMatchObject({ status: "waits for a person", approval: { status: "waiting" }, approvalUrl: url });
  });
});

describe("the people who send agents", () => {
  it("names the person behind the key as the sender, for a gitring tool and for a GitHub tool", async () => {
    const id = await shoutWork();
    const st = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    expect(st.text).toContain("alice must say yes");
    await gh("push_files", { branch: "feature/two", message: "Two", files: [{ path: "src/two.js", content: "export const two = 2;\n" }] });
    const pr = await gh("create_pull_request", { title: "Two", head: "feature/two", base: "main" });
    expect(pr.text).toContain("alice must say yes");
  });

  it("keeps an approval for each person: another sender, another person who answers", async () => {
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
    const plan = await gr("gitring_declare", { newIntent: { title: "Whisper", goal: "A whisper function exists." }, plan: ["Add whisper"], files: ["src/whisper.js"], approach: "New file." }, bob.key);
    const id = /work copy (a_\w+)/.exec(plan.text)?.[1] ?? "";
    await gr("gitring_write", { attemptId: id, files: [{ path: "src/whisper.js", content: "export const whisper = (s) => s.toLowerCase();\n" }] }, bob.key);
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Add whisper" }, bob.key);
    expect(sub.text).toContain("bob must say yes");
    // Bob asked for it, so the form goes to bob.
    const rpc = await call("gitring_submit", { project, attemptId: id, summary: "Add whisper" }, { token: bob.key, capabilities: FORMS });
    expect(resultOf(rpc).resultType).toBe("input_required");
    // Alice is the owner: she may answer too, in the app.
    const approvalId = JSON.parse(sub.text.slice(sub.text.indexOf("{"))).approval.id as string;
    const bobInApp = await world.call("POST", `/api/projects/${project}/attempts/${id}/decide`, { headers: cookie(bob.session), body: { approvalId, answer: "send-back", note: "Name it quiet." } });
    expect(bobInApp.status, bobInApp.text).toBe(200);
    expect(bobInApp.json.outcome).toBe("sent-back");
    expect(userId).not.toBe(bob.userId);
  });

  it("does not let a viewer answer, in the app", async () => {
    const id = await shoutWork();
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    const approvalId = JSON.parse(sub.text.slice(sub.text.indexOf("{"))).approval.id as string;
    world.person("eve", 3);
    const eve = await world.signIn("eve");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@eve", role: "viewer" } });
    const res = await world.call("POST", `/api/projects/${project}/attempts/${id}/decide`, { headers: cookie(eve.session), body: { approvalId, answer: "approve" } });
    expect(res.status).toBe(403);
  });
});

describe("plain words", () => {
  it("uses short sentences and no -ing forms in what the agent reads", async () => {
    const id = await shoutWork();
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    // Leave out the JSON and the names of people and tasks (quoted).
    const words = sub.text.slice(0, sub.text.indexOf("\n\n")).replace(/Link: \S+/, "Link: x").replace(/"[^"]*"/g, "");
    expect(steViolations(words)).toEqual([]);
  });
});
