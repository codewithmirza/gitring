/**
 * scripts/meet.mjs: three scripted agents on a small shop project. The script runs against the real Worker
 * routes in this process (no network): the MCP client of the script connects and uses the tools of an outside
 * agent. The test reads what the agents read, as the script prints it.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { World } from "../harbor/world";
import { prepareMeet, runMeet } from "../../scripts/meet.mjs";

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

const ENV = { GITRING_URL: "https://gitring.example.com", GITRING_KEY: "gk_secret_value_123" };

describe("options", () => {
  it("needs a key and an https address, and reads the options", () => {
    expect(prepareMeet([], {}).code).toBe(2);
    expect(prepareMeet([], { GITRING_URL: ENV.GITRING_URL }).lines?.join("\n")).toMatch(/GITRING_KEY/);
    expect(prepareMeet([], { ...ENV, GITRING_URL: "http://gitring.example.com" }).lines?.join("\n")).toMatch(/https/);
    expect(prepareMeet([], { ...ENV, GITRING_URL: "http://localhost:8787" }).options).toEqual({ approval: false, waitSec: 180, keep: false });
    const full = prepareMeet(["--approval", "--wait", "30", "--keep"], ENV);
    expect(full.options).toEqual({ approval: true, waitSec: 30, keep: true });
    expect(full.endpoint?.href).toBe("https://gitring.example.com/mcp");
    expect(prepareMeet(["--wait=0"], ENV).options?.waitSec).toBe(0);
    expect(prepareMeet(["--wait", "many"], ENV).code).toBe(2);
    expect(prepareMeet(["--yes"], ENV).lines?.join("\n")).toMatch(/Unknown option --yes/);
    expect(prepareMeet(["--help"], {}).code).toBe(0);
  });

  it("never prints the key", () => {
    const bad = prepareMeet(["--wait", "many"], ENV);
    expect(bad.lines?.join("\n")).not.toContain(ENV.GITRING_KEY);
  });
});

async function inThisProcess() {
  const world = new World();
  worlds.push(world);
  await world.init();
  const { key } = await world.signIn("robin", 1);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const ctx = { waitUntil: (p: Promise<unknown>) => void world.pending.push(p.catch(() => undefined)), passThroughOnException() {}, props: {} };
    return worker.fetch(new Request(input, init), world.env as never, ctx as never);
  };
  return { world, key, fetchImpl };
}

describe("the story", () => {
  it("two agents change one function: a change request, then both changes in main. The agent that keeps its lines is told that it is clear", async () => {
    const { world, key, fetchImpl } = await inThisProcess();
    const said: string[] = [];
    const result = await runMeet({ endpoint: new URL("https://gitring.test/mcp"), key, options: { keep: true }, say: (l) => said.push(l), fetchImpl, pollMs: 20 });
    await world.settle();
    const text = said.join("\n");

    expect(result).toMatchObject({ ok: true, merges: 3, waiting: false });
    expect(result.changeRequests).toBeGreaterThanOrEqual(2);
    // What Agent B reads: a change request in its first answers, and again when main moved.
    expect(text).toMatch(/Agent B \(Cursor\) calls gitring_declare[^\n]*\n  │ GITRING CHANGE REQUEST — apply it in your next edits, then call gitring_ack\. Do not stop\./);
    expect(text).toMatch(/\(same lines; [A-Z]+-\d+ continues\) [A-Z]+-\d+ also changes formatPrice in src\/price\.js\. Do not rewrite formatPrice\./);
    expect(text).toMatch(/\(main moved; [A-Z]+-\d+ continues\) The task "Show thousands separators in prices" merged into main\./);
    // What Agent A reads: it keeps its lines, so its answers do not talk of a change request.
    const aWrite = text.split("Agent A (Claude Code) calls gitring_write")[1]?.split("\n\n")[0] ?? "";
    expect(aWrite).toMatch(/Conflict check: clear\. Plan clear\. 1 other agent works near you\./);
    expect(aWrite).not.toMatch(/change request/i);
    // The key is never in the report, and the project is kept (keep).
    expect(text).not.toContain(key);
    expect(text).toMatch(/Look at it: https:\/\/gitring\.test\/overview\?project=meet-/);

    // gitring checks the code: Agent B confirms before its change, so the change request stays open.
    expect(text).toMatch(/Agent B \(Cursor\) calls gitring_ack[^\n]*\n  │ Your code still edits lines? [\d–, and]+ of [\w/.]+\.js\. Change it, then call gitring_ack again\. The change request stays open\./);
    // Main holds both changes, and all three tasks merged one after the other.
    const state = await world.harbor(result.project).state();
    expect(state.landings).toHaveLength(3);
    // Agent B confirmed again after its change on the new main: no change request closed without an answer.
    const answered = state.corrections.filter((c) => c.status !== "superseded");
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.map((c) => c.status)).toEqual(answered.map(() => "acknowledged"));
    const files = await world.filesAt(state.project.repo.name, state.project.mainSha);
    expect(files["src/price.js"]).toContain('if (cents === 0) return "Free";');
    expect(files["src/price.js"]).toContain('.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",")');
    expect(files["tests/price.test.js"]).toContain("adds commas");
    expect(files["tests/price.test.js"]).toContain("shows Free");
  }, 60_000);

  it("archives the project at the end, unless --keep", async () => {
    const { world, key, fetchImpl } = await inThisProcess();
    const said: string[] = [];
    const result = await runMeet({ endpoint: new URL("https://gitring.test/mcp"), key, options: {}, say: (l) => said.push(l), fetchImpl, pollMs: 20 });
    await world.settle();
    expect(result.ok).toBe(true);
    expect(said.join("\n")).toMatch(new RegExp(`The project ${result.project} is archived\\.`));
    expect(said.join("\n")).not.toMatch(/Look at it/);
    const list = await fetchImpl("https://gitring.test/api/projects", { headers: { authorization: `Bearer ${key}` } });
    const body = (await list.json()) as { projects?: { id: string }[] } | { id: string }[];
    const ids = (Array.isArray(body) ? body : (body.projects ?? [])).map((p) => p.id);
    expect(ids).not.toContain(result.project);
  }, 60_000);

  it("a third agent changes two signatures: a person must say yes, and the project stays", async () => {
    const { world, key, fetchImpl } = await inThisProcess();
    const said: string[] = [];
    const result = await runMeet({ endpoint: new URL("https://gitring.test/mcp"), key, options: { approval: true, waitSec: 0 }, say: (l) => said.push(l), fetchImpl, pollMs: 20 });
    await world.settle();
    const text = said.join("\n");

    expect(result).toMatchObject({ ok: true, merges: 3, waiting: true });
    expect(text).toMatch(/A PERSON MUST SAY YES\. The work is not merged yet\./);
    expect(text).toMatch(/Why: The parameters of (cartTotal, formatPrice|formatPrice, cartTotal) change\. Other code can call them\./);
    expect(text).toMatch(/Link: https:\/\/gitring\.test\/approve\/a_\w+\?project=meet-/);
    expect(text).toMatch(/A key cannot say yes\. Only a person who is signed in can\./);
    expect(text).toMatch(/The project meet-[\w-]+ stays, because a person still has to answer\./);
    expect(text).not.toMatch(/is archived/);
    // The change waits: it is not in main.
    const state = await world.harbor(result.project).state();
    const files = await world.filesAt(state.project.repo.name, state.project.mainSha);
    expect(files["src/price.js"]).not.toContain("SIGNS");
    expect(state.intents.some((i: { status: string; title: string }) => i.title === "Show euros in the EU" && i.status === "judging")).toBe(true);
  }, 60_000);
});

describe("the files of the story", () => {
  it("the shop in examples/shop is the start of the story: the edits of the agents fit its text", () => {
    const price = readFileSync(new URL("../../examples/shop/src/price.js", import.meta.url), "utf8");
    expect(price).toBe('export function formatPrice(cents) {\n  return "$" + (cents / 100).toFixed(2);\n}\n');
    const test = readFileSync(new URL("../../examples/shop/tests/price.test.js", import.meta.url), "utf8");
    expect(test.endsWith('toBe("$19.99"));\n')).toBe(true);
    const cart = readFileSync(new URL("../../examples/shop/src/cart.js", import.meta.url), "utf8");
    expect(cart).toContain("export function cartTotal(items) {");
  });
});
