/**
 * The agent channel, end to end through the real Worker, the real Directory and the real project object:
 *
 *   - every answer about a work copy brings its new change requests, also the answers that only read
 *     (gitring_read and gitring_list keep the file text clean and bring them in a second block);
 *   - gitring_wait answers as soon as news arrives (a change request, a move of main, the answer of a
 *     person, a new status), or when the time is over;
 *   - gitring_ack checks the code, and an id that is not an open request is an error that names the open ones;
 *   - at a merge, a change request that the agent did not confirm closes ("closed"), it is not "acknowledged";
 *   - only the person who sent the agent (or an owner) changes a work copy, and only that person gets its requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeLoader, type NodeLoader } from "../checks/node-loader";
import { steViolations } from "../coord/ste";
import { World } from "../github/harness";
import { callTool, makeProject, modernCall } from "./support";

const GREET = 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n';
/** A test that passes for any change: the merges in these tests do not wait for a person. */
const OK_TEST = 'import { test, expect } from "../harness/test.js";\ntest("ok", () => expect(1).toBe(1));\n';

let world: World;
let loader: NodeLoader;
let key: string;
let session: string;
let project: string;

const cookie = (token: string) => ({ cookie: `__Host-gitring=${token}` });
const gr = (name: string, args: Record<string, unknown> = {}, as = key) => callTool(world, as, name, { project, ...args });
/** All text blocks of a tool answer. */
async function blocks(name: string, args: Record<string, unknown>, as = key): Promise<string[]> {
  const rpc = await modernCall(world, { token: as, method: "tools/call", params: { name, arguments: { project, ...args } } });
  return (rpc.body?.result?.content ?? []).map((c: { text: string }) => c.text);
}
const jsonOf = (text: string) => JSON.parse(text.slice(text.indexOf("\n{") + 1));
/** The sentences of an answer, without the JSON, the head line of the change requests (GITRING is a name) and quoted names. */
const words = (text: string) =>
  text
    .slice(0, text.indexOf("\n{") >= 0 ? text.indexOf("\n{") : undefined)
    .replace(/^GITRING CHANGE REQUEST.*$/m, "")
    .replace(/"[^"]*"/g, "x");

async function state() {
  const res = await world.call("GET", `/api/projects/${project}/state`, { key });
  return res.json as { project: { mainSha: string; repo: { name: string } }; corrections: { id: string; attemptId: string; status: string; check?: { applied: boolean | null; reason: string } }[] };
}

/** A plan for one task. Answers the work copy id and the text of the answer. */
async function plan(title: string, files: string[], symbols: string[] = [], as = key): Promise<{ id: string; text: string }> {
  const res = await gr("gitring_declare", { newIntent: { title, goal: `${title}.` }, plan: [title], files, symbols, approach: "Small change." }, as);
  const id = /work copy (a_\w+)/.exec(res.text)?.[1] ?? "";
  expect(id, res.text).not.toBe("");
  return { id, text: res.text };
}

/** A person sends the work back in the app: a change request (kind review) waits for the agent. */
async function sentBack(id: string, note: string): Promise<void> {
  const sub = await gr("gitring_submit", { attemptId: id, summary: "Done" });
  const approvalId = jsonOf(sub.text).approval.id as string;
  const back = await world.call("POST", `/api/projects/${project}/attempts/${id}/decide`, { headers: cookie(session), body: { approvalId, answer: "send-back", note } });
  expect(back.status, back.text).toBe(200);
}

async function askBeforeMerge() {
  const res = await world.call("PUT", `/api/projects/${project}/settings`, { headers: cookie(session), body: { landing: "ask" } });
  expect(res.status, res.text).toBe(200);
}

/** The agents that wait on the project object now. */
const waiters = () => (world.harbor(project) as unknown as { waiters: Map<string, Set<unknown>> }).waiters;

beforeEach(async () => {
  world = new World();
  loader = nodeLoader();
  vi.stubGlobal("fetch", world.fetch);
  await world.init({ LOADER: loader });
  world.person("alice", 1);
  ({ key, session } = await world.signIn("alice"));
  project = await makeProject(world, key, "shop", { checks: { runner: "worker" } });
  await world.land(project, "src/greet.js", GREET);
  await world.land(project, "tests/ok.test.js", OK_TEST);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await world.settle();
  await loader.cleanup();
});

describe("change requests in the answers that only read", () => {
  it("keeps the file text clean in gitring_read and brings the change request in a second block", async () => {
    await askBeforeMerge();
    const { id } = await plan("Shout", ["src/shout.js"]);
    await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: "export const shout = (s) => s.toUpperCase();\n" }] });
    await sentBack(id, "Name it yell.");
    const [file, news] = await blocks("gitring_read", { attemptId: id, path: "src/shout.js" });
    expect(file).toBe("export const shout = (s) => s.toUpperCase();\n");
    expect(news).toMatch(/^GITRING CHANGE REQUEST — apply it in your next edits, then call gitring_ack\. Do not stop\.\n- \[cr_\w+\] \(sent back by a person\) alice sends your work back: Name it yell\./);
    expect(steViolations(words(news.replace(/^- \[cr_\w+\] /m, "")))).toEqual([]);
    // The request came once. The next read is the file alone.
    expect(await blocks("gitring_read", { attemptId: id, path: "src/shout.js" })).toEqual([file]);
  });

  it("brings the change request after the list of gitring_list", async () => {
    await askBeforeMerge();
    const { id } = await plan("Shout", ["src/shout.js"]);
    await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: "export const shout = 1;\n" }] });
    await sentBack(id, "Add a test.");
    const [list, news] = await blocks("gitring_list", { attemptId: id, dir: "src" });
    expect(list).toBe("src/greet.js\nsrc/shout.js");
    expect(news).toMatch(/^GITRING CHANGE REQUEST/);
    expect(news).toContain("alice sends your work back: Add a test.");
  });

  for (const tool of ["gitring_traffic", "gitring_check", "gitring_update"]) {
    it(`brings the change request in the answer of ${tool}, with the conflict check in the JSON`, async () => {
      await askBeforeMerge();
      const { id } = await plan("Shout", ["src/shout.js"]);
      await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: "export const shout = 1;\n" }] });
      await sentBack(id, "Use a longer name.");
      const res = await gr(tool, { attemptId: id });
      expect(res.isError, res.text).toBe(false);
      expect(res.text).toMatch(/^GITRING CHANGE REQUEST/);
      expect(res.text).toContain("Use a longer name.");
      expect(jsonOf(res.text).clearance.corrections).toHaveLength(1);
    });
  }

  it("does not give the change requests of a work copy to another member who reads it", async () => {
    await askBeforeMerge();
    world.person("bob", 2);
    const bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
    const { id } = await plan("Shout", ["src/shout.js"]);
    await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: "export const shout = 1;\n" }] });
    await sentBack(id, "Use a longer name.");
    // Bob reads the work copy of alice: he sees the file and the state, and not the change request.
    expect(await blocks("gitring_read", { attemptId: id, path: "src/shout.js" }, bob.key)).toEqual(["export const shout = 1;\n"]);
    const traffic = await gr("gitring_traffic", { attemptId: id }, bob.key);
    expect(traffic.text).not.toMatch(/GITRING CHANGE REQUEST/);
    const st = await gr("gitring_status", { attemptId: id }, bob.key);
    // The state says that the work went back. The change request itself stays for the agent of alice.
    expect(st.text).not.toMatch(/GITRING CHANGE REQUEST/);
    // The agent of alice still gets it.
    const [, news] = await blocks("gitring_read", { attemptId: id, path: "src/shout.js" });
    expect(news).toContain("Use a longer name.");
  });
});

describe("gitring_wait", () => {
  it("answers at once with a change request that waits", async () => {
    await askBeforeMerge();
    const { id } = await plan("Shout", ["src/shout.js"]);
    await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: "export const shout = 1;\n" }] });
    await sentBack(id, "Use a longer name.");
    const t0 = performance.now();
    const res = await gr("gitring_wait", { attemptId: id, seconds: 30 });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(res.text).toMatch(/^GITRING CHANGE REQUEST/);
    const facts = jsonOf(res.text);
    expect(facts.status).toBe("underway");
    expect(facts.events.map((e: { kind: string }) => e.kind)).toEqual(["change-request"]);
    expect(facts.message).toBe("You have 1 new change request. Apply it, then call gitring_ack. Continue your work.");
  });

  it("answers with no news when the time is over", async () => {
    const { id } = await plan("Shout", ["src/shout.js"]);
    const res = await gr("gitring_wait", { attemptId: id, seconds: 1 });
    expect(res.isError, res.text).toBe(false);
    const facts = jsonOf(res.text);
    expect(facts.events).toEqual([]);
    expect(facts.status).toBe("declared");
    expect(res.text).toMatch(/^No news\. The work copy is new\. Call gitring_wait again, or continue your work\./);
    expect(steViolations(words(res.text))).toEqual([]);
    expect(waiters().size).toBe(0);
  });

  it("wakes when a person answers: the work comes back with a change request", async () => {
    await askBeforeMerge();
    const { id } = await plan("Shout", ["src/shout.js"]);
    await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: "export const shout = 1;\n" }] });
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Done" });
    const approvalId = jsonOf(sub.text).approval.id as string;
    const waiting = gr("gitring_wait", { attemptId: id, seconds: 30 });
    await vi.waitFor(() => expect(waiters().size).toBe(1), { timeout: 5000, interval: 10 });
    const back = await world.call("POST", `/api/projects/${project}/attempts/${id}/decide`, { headers: cookie(session), body: { approvalId, answer: "send-back", note: "Use a longer name." } });
    expect(back.status, back.text).toBe(200);
    const res = await waiting;
    expect(res.text).toMatch(/^GITRING CHANGE REQUEST/);
    const facts = jsonOf(res.text);
    expect(facts.events.map((e: { kind: string }) => e.kind).sort()).toEqual(["approval", "change-request", "status"]);
    expect(facts.events.find((e: { kind: string }) => e.kind === "approval")).toMatchObject({ approval: "sent-back", message: "alice sent the work back." });
    expect(facts.status).toBe("underway");
    expect(waiters().size).toBe(0);
  });

  it("wakes when a person says yes, and tells the agent that the work merged", async () => {
    await askBeforeMerge();
    const { id } = await plan("Shout", ["src/shout.js"]);
    await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: "export const shout = 1;\n" }] });
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Done" });
    const approvalId = jsonOf(sub.text).approval.id as string;
    const waiting = gr("gitring_wait", { attemptId: id, seconds: 30 });
    await vi.waitFor(() => expect(waiters().size).toBe(1), { timeout: 5000, interval: 10 });
    const yes = await world.call("POST", `/api/projects/${project}/attempts/${id}/decide`, { headers: cookie(session), body: { approvalId, answer: "approve" } });
    expect(yes.status, yes.text).toBe(200);
    const facts = jsonOf((await waiting).text);
    expect(facts.events[0]).toMatchObject({ kind: "approval", approval: "approved", message: "alice said yes to the merge." });
    await world.settle();
    // The work merged. A wait on a merged work copy answers at once.
    const again = await gr("gitring_wait", { attemptId: id, seconds: 30 });
    expect(jsonOf(again.text)).toMatchObject({ status: "landed", events: [{ kind: "status", status: "landed" }], message: "The work merged. The task is done." });
  });

  it("wakes the agents that wait when main moves", async () => {
    const far = await plan("Whisper", ["src/whisper.js"]);
    const mover = await plan("Shout", ["src/shout.js"]);
    await gr("gitring_write", { attemptId: mover.id, files: [{ path: "src/shout.js", content: "export const shout = 1;\n" }] });
    const waiting = gr("gitring_wait", { attemptId: far.id, seconds: 30 });
    await vi.waitFor(() => expect(waiters().size).toBe(1), { timeout: 5000, interval: 10 });
    const sub = await gr("gitring_submit", { attemptId: mover.id, summary: "Add shout" });
    expect(jsonOf(sub.text).next, sub.text).not.toBe("awaiting-approval");
    const res = await waiting;
    const facts = jsonOf(res.text);
    const moved = facts.events.find((e: { kind: string }) => e.kind === "main-moved");
    expect(moved, res.text).toBeDefined();
    expect(moved.message).toMatch(/^Main moved to [0-9a-f]{7}: "Shout" merged\.$/);
    expect(moved.mainSha).toBe((await state()).project.mainSha);
    expect(steViolations(words(res.text))).toEqual([]);
  });

  it("is a tool that changes state: the read-only endpoint does not have it", async () => {
    const { id } = await plan("Shout", ["src/shout.js"]);
    const res = await callTool(world, key, "gitring_wait", { project, attemptId: id, seconds: 1 }, "/mcp/readonly");
    expect(res.rpc.body?.error !== undefined || res.isError).toBe(true);
  });
});

describe("gitring_ack", () => {
  /** Two agents of alice edit line 2 of src/greet.js. The second one gets a change request. Answers its id. */
  async function sameLines(): Promise<{ first: string; second: string; request: string }> {
    const first = await plan("Greet politely", ["src/greet.js"], ["src/greet.js#greet"]);
    await gr("gitring_write", { attemptId: first.id, files: [{ path: "src/greet.js", content: GREET.replace("Hello", "Good day") }] });
    const second = await plan("Greet loudly", ["src/greet.js"], ["src/greet.js#greet"]);
    const w = await gr("gitring_write", { attemptId: second.id, files: [{ path: "src/greet.js", content: GREET.replace("Hello", "Hey") }] });
    expect(`${second.text}\n${w.text}`).toMatch(/GITRING CHANGE REQUEST/);
    const open = (await state()).corrections.filter((c) => c.attemptId === second.id && (c.status === "delivered" || c.status === "pending"));
    expect(open).toHaveLength(1);
    return { first: first.id, second: second.id, request: open[0].id };
  }

  it("keeps the request open while the code still edits the lines, and closes it when the code keeps out", async () => {
    const { second, request } = await sameLines();
    const no = await gr("gitring_ack", { attemptId: second, correctionId: request, note: "Done." });
    expect(no.isError, no.text).toBe(false);
    expect(no.text).toMatch(/^Your code still edits line 2 of src\/greet\.js\. Change it, then call gitring_ack again\. The change request stays open\./);
    expect(jsonOf(no.text)).toMatchObject({ correctionId: request, outcome: "open", check: { applied: false } });
    expect(steViolations(words(no.text))).toEqual([]);
    let c = (await state()).corrections.find((x) => x.id === request)!;
    expect(c.status).toBe("delivered");
    expect(c.check).toMatchObject({ applied: false, reason: "Your code still edits line 2 of src/greet.js." });

    // The agent keeps line 2 as it is, and adds its change in a new block below.
    await gr("gitring_write", { attemptId: second, files: [{ path: "src/greet.js", content: `${GREET}export function greetLoudly(name) {\n  return greet(name).toUpperCase();\n}\n` }] });
    const yes = await gr("gitring_ack", { attemptId: second, correctionId: request, note: "My change is below the function." });
    expect(yes.text).toMatch(/^Confirmed\. Your code keeps the lines of the change request\./);
    expect(jsonOf(yes.text)).toMatchObject({ outcome: "acknowledged", check: { applied: true } });
    c = (await state()).corrections.find((x) => x.id === request)!;
    expect(c.status).toBe("acknowledged");
    // A second confirmation changes nothing.
    expect(jsonOf((await gr("gitring_ack", { attemptId: second, correctionId: request })).text).outcome).toBe("already");
  });

  it("refuses an id that is not an open change request of the work copy, and names the open ones", async () => {
    const { first, second, request } = await sameLines();
    const unknown = await gr("gitring_ack", { attemptId: second, correctionId: "cr_nothere" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toBe(`Error: cr_nothere is not a change request of work copy ${second}. Open change requests of ${second}: ${request}.`);
    // The request of another work copy is foreign here.
    const foreign = await gr("gitring_ack", { attemptId: first, correctionId: request });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toBe(`Error: ${request} is not a change request of work copy ${first}. Work copy ${first} has no open change request.`);
    expect(steViolations(foreign.text.replace(/^Error: /, ""))).toEqual([]);
    // Nothing changed.
    expect((await state()).corrections.find((x) => x.id === request)!.status).toBe("delivered");
  });

  it("closes the change requests that the agent did not confirm when the work merges, and the git note says so", async () => {
    const { second, request } = await sameLines();
    const sub = await gr("gitring_submit", { attemptId: second, summary: "Greet loudly" });
    expect(jsonOf(sub.text).next, sub.text).toBe("landing-queue");
    await world.settle();
    const st = await state();
    expect(st.corrections.find((x) => x.id === request)!.status).toBe("closed");
    const note = JSON.parse((await world.backend.readNote(st.project.repo.name, st.project.mainSha))!);
    expect(note.attempt.id).toBe(second);
    expect(note.corrections).toEqual([expect.objectContaining({ id: request, status: "closed" })]);
    // A confirmation after the merge changes nothing.
    const late = await gr("gitring_ack", { attemptId: second, correctionId: request });
    expect(jsonOf(late.text)).toMatchObject({ outcome: "already" });
    expect(late.text).toMatch(new RegExp(`^The change request ${request} closed when the work merged\\.`));
  });
});

describe("work copy owners", () => {
  let bob: { key: string; session: string };
  beforeEach(async () => {
    world.person("bob", 2);
    bob = await world.signIn("bob");
    await world.call("POST", `/api/projects/${project}/members`, { key, body: { who: "@bob", role: "member" } });
  });

  it("lets only the person who sent the agent, or an owner, change a work copy", async () => {
    const { id } = await plan("Shout", ["src/shout.js"]);
    const refused = `Error: Work copy ${id} belongs to the agent of alice. Only that person or an owner of the project can change it.`;
    for (const [name, args] of [
      ["gitring_write", { files: [{ path: "src/shout.js", content: "x" }] }],
      ["gitring_log", { message: "Work." }],
      ["gitring_check", {}],
      ["gitring_update", {}],
      ["gitring_ack", { correctionId: "cr_x" }],
      ["gitring_wait", { seconds: 1 }],
      ["gitring_submit", { summary: "Done" }],
    ] as [string, Record<string, unknown>][]) {
      const res = await gr(name, { attemptId: id, ...args }, bob.key);
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toBe(refused);
    }
    expect(steViolations(refused.replace(/^Error: /, ""))).toEqual([]);
    // Bob can read it.
    expect((await gr("gitring_list", { attemptId: id }, bob.key)).isError).toBe(false);
    // Alice is an owner: she can change the work copy of the agent of bob.
    const his = await plan("Whisper", ["src/whisper.js"], [], bob.key);
    const w = await gr("gitring_write", { attemptId: his.id, files: [{ path: "src/whisper.js", content: "export const whisper = 1;\n" }] });
    expect(w.isError, w.text).toBe(false);
  });

  it("lets the Claude Code hook of the sender edit the work copy, and ignores the hook of another person", async () => {
    const { id } = await plan("Shout", ["src/shout.js"]);
    const edit = { attemptId: id, cwd: "/work/shop", tool_name: "Write", tool_input: { file_path: "/work/shop/src/shout.js", content: "export const shout = 2;\n" } };
    const other = await world.call("POST", `/hooks/claude/${project}`, { key: bob.key, body: edit });
    expect(other.status).toBe(200);
    expect(other.json).toEqual({});
    expect((await gr("gitring_read", { attemptId: id, path: "src/shout.js" })).text).toBe("The file src/shout.js does not exist.");
    const mine = await world.call("POST", `/hooks/claude/${project}`, { key, body: edit });
    expect(mine.status).toBe(200);
    expect((await gr("gitring_read", { attemptId: id, path: "src/shout.js" })).text).toBe("export const shout = 2;\n");
  });
});
