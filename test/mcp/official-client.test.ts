/**
 * The approval flow with the official MCP client SDK (2.x, the 2026-07-28 revision), not with hand-made JSON.
 *
 * What a person would see in the chat of an agent: the client shows a form, the person answers, the client
 * calls the tool again with the answer. The SDK does those steps. These tests check that a real client of the
 * new revision gets the form and that the answer works, and that a client of the old revision (the default of
 * the SDK) gets the link instead.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeLoader, type NodeLoader } from "../checks/node-loader";
import { World, ORIGIN } from "../github/harness";
import { makeProject, send } from "./support";

const GREET = 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n';
const GREET_TEST = 'import { test, expect } from "../harness/test.js";\nimport { greet } from "../src/greet.js";\ntest("greets", () => expect(greet("Robin")).toBe("Hello, Robin!"));\n';
const SHOUT = 'import { greet } from "./greet.js";\nexport function shout(name) {\n  return greet(name).toUpperCase();\n}\n';
const SHOUT_TEST = 'import { test, expect } from "../harness/test.js";\nimport { shout } from "../src/shout.js";\ntest("shouts", () => expect(shout("Robin")).toBe("HELLO, ROBIN!"));\n';

type Answer = { action: "accept"; content: { answer: "approve" | "send-back"; note?: string } } | { action: "decline" } | { action: "cancel" };

let world: World;
let loader: NodeLoader;
let key: string;
let session: string;
let project: string;
const clients: Client[] = [];

/**
 * A client of the official SDK, connected to the Worker. `era`: "2026" asks for the new revision (the SDK
 * does this only when told to), "default" keeps the SDK default (the 2025 sequence). `form`: what the person
 * answers when the client shows a form (absent: the client cannot show forms).
 */
async function official(opts: { era: "2026" | "default"; form?: (params: { message: string; requestedSchema?: { properties?: Record<string, unknown> } }) => Answer; path?: string }) {
  const shown: { message: string; fields: string[] }[] = [];
  const client = new Client(
    { name: "official-sdk-test", version: "1.0.0" },
    {
      capabilities: opts.form ? { elicitation: { form: {} } } : {},
      ...(opts.era === "2026" ? { versionNegotiation: { mode: "auto" as const } } : {}),
    },
  );
  if (opts.form) {
    const form = opts.form;
    client.setRequestHandler("elicitation/create", async (req) => {
      const params = req.params as unknown as { message: string; requestedSchema?: { properties?: Record<string, unknown> } };
      shown.push({ message: params.message, fields: Object.keys(params.requestedSchema?.properties ?? {}) });
      return form(params) as never;
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}${opts.path ?? "/mcp"}`), {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => send(world, input, init)) as typeof fetch,
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return { client, shown };
}

const textOf = (r: unknown): string => ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");

async function mainSha(): Promise<string> {
  const res = await world.call("GET", `/api/projects/${project}/state`, { key });
  return String(res.json.project.mainSha);
}

/** A work copy with a new file and its test, written through the client. */
async function shoutWork(client: Client): Promise<string> {
  const plan = await client.callTool({ name: "gitring_declare", arguments: { project, newIntent: { title: "Shout", goal: "A shout function exists." }, plan: ["Add shout"], files: ["src/shout.js", "tests/shout.test.js"], symbols: ["src/shout.js#shout"], approach: "New file." } });
  const id = /work copy (a_\w+)/.exec(textOf(plan))?.[1] ?? "";
  expect(id, textOf(plan)).not.toBe("");
  const wrote = await client.callTool({ name: "gitring_write", arguments: { project, attemptId: id, files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] } });
  expect((wrote as { isError?: boolean }).isError, textOf(wrote)).toBeFalsy();
  return id;
}

beforeEach(async () => {
  world = new World();
  loader = nodeLoader();
  vi.stubGlobal("fetch", world.fetch);
  await world.init({ LOADER: loader });
  world.person("alice", 1);
  ({ key, session } = await world.signIn("alice"));
  project = await makeProject(world, key, "shop", { checks: { runner: "worker" } });
  await world.land(project, "src/greet.js", GREET);
  await world.land(project, "tests/greet.test.js", GREET_TEST);
  const ask = await world.call("PUT", `/api/projects/${project}/settings`, { headers: { cookie: `__Host-gitring=${session}` }, body: { landing: "ask" } });
  expect(ask.status, ask.text).toBe(200);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  vi.unstubAllGlobals();
  await world.settle();
  await loader.cleanup();
});

describe("a client of the 2026-07-28 revision that can show a form", () => {
  it("agrees on the new revision, and shows the person one form with the facts", async () => {
    const { client, shown } = await official({ era: "2026", form: () => ({ action: "accept", content: { answer: "approve" } }) });
    expect(client.getNegotiatedProtocolVersion?.()).toBe("2026-07-28");
    const id = await shoutWork(client);
    await client.callTool({ name: "gitring_submit", arguments: { project, attemptId: id, summary: "Add shout" } });
    expect(shown).toHaveLength(1);
    expect(shown[0].message).toMatch(/^Merge "Shout" into main\? 2 files, \+\d+ -0\. \d+ of \d+ tests pass\. This project asks a person before every merge\.$/);
    expect(shown[0].fields).toEqual(["answer", "note"]);
  });

  it("merges the work when the person says yes in the form", async () => {
    const { client } = await official({ era: "2026", form: () => ({ action: "accept", content: { answer: "approve" } }) });
    const id = await shoutWork(client);
    const before = await mainSha();
    const done = await client.callTool({ name: "gitring_submit", arguments: { project, attemptId: id, summary: "Add shout" } });
    expect((done as { isError?: boolean }).isError, textOf(done)).toBeFalsy();
    expect(textOf(done)).toMatch(/^Merged at [0-9a-f]{7}\./);
    expect(await mainSha()).not.toBe(before);
    // The record names the person and the chat as the way of the answer.
    const st = await client.callTool({ name: "gitring_status", arguments: { project, attemptId: id } });
    expect(JSON.parse(textOf(st).slice(textOf(st).indexOf("{")))).toMatchObject({ status: "landed", approval: { status: "approved", answer: { by: "alice", how: "chat" } } });
  });

  it("sends the work back with the note of the person, and nothing merges", async () => {
    const { client } = await official({ era: "2026", form: () => ({ action: "accept", content: { answer: "send-back", note: "Use a name with two words." } }) });
    const id = await shoutWork(client);
    const before = await mainSha();
    const done = await client.callTool({ name: "gitring_submit", arguments: { project, attemptId: id, summary: "Add shout" } });
    expect(textOf(done)).toContain("alice sends your work back: Use a name with two words.");
    expect(await mainSha()).toBe(before);
  });

  it.each(["decline", "cancel"] as const)("leaves the work waiting when the person closes the form (%s)", async (action) => {
    const { client } = await official({ era: "2026", form: () => ({ action }) });
    const id = await shoutWork(client);
    const before = await mainSha();
    const done = await client.callTool({ name: "gitring_submit", arguments: { project, attemptId: id, summary: "Add shout" } });
    expect(textOf(done)).toMatch(/^A PERSON MUST SAY YES\./);
    expect(textOf(done)).toContain(`Link: ${ORIGIN}/approve/${id}?project=${project}`);
    expect(await mainSha()).toBe(before);
  });

  it("is the same for the pull request of the GitHub-compatible tools", async () => {
    const { client, shown } = await official({ era: "2026", path: "/mcp/github", form: () => ({ action: "accept", content: { answer: "approve" } }) });
    await client.callTool({ name: "push_files", arguments: { repo: project, branch: "feature/shout", message: "Shout", files: [{ path: "src/shout.js", content: SHOUT }, { path: "tests/shout.test.js", content: SHOUT_TEST }] } });
    const before = await mainSha();
    const pr = await client.callTool({ name: "create_pull_request", arguments: { repo: project, title: "Shout", head: "feature/shout", base: "main" } });
    expect(shown).toHaveLength(1);
    expect(textOf(pr)).toMatch(/^Pull request 1: merged\./);
    expect(await mainSha()).not.toBe(before);
  });
});

describe("a client that gets the link", () => {
  it("gets the link when it cannot show a form (the new revision, no form ability)", async () => {
    const { client, shown } = await official({ era: "2026" });
    const id = await shoutWork(client);
    const done = await client.callTool({ name: "gitring_submit", arguments: { project, attemptId: id, summary: "Add shout" } });
    expect(shown).toHaveLength(0);
    expect(textOf(done)).toMatch(/^A PERSON MUST SAY YES\./);
    expect(textOf(done)).toContain(`Link: ${ORIGIN}/approve/${id}?project=${project}`);
  });

  it("gets the link when the SDK keeps its default (the 2025 sequence), even with a form handler", async () => {
    const { client, shown } = await official({ era: "default", form: () => ({ action: "accept", content: { answer: "approve" } }) });
    expect(client.getNegotiatedProtocolVersion?.()).not.toBe("2026-07-28");
    const id = await shoutWork(client);
    const before = await mainSha();
    const done = await client.callTool({ name: "gitring_submit", arguments: { project, attemptId: id, summary: "Add shout" } });
    expect(shown).toHaveLength(0);
    expect(textOf(done)).toMatch(/^A PERSON MUST SAY YES\./);
    expect(textOf(done)).toContain(`Link: ${ORIGIN}/approve/${id}?project=${project}`);
    expect(await mainSha()).toBe(before);
  });
});
