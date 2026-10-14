/**
 * The platform can stop a project object while a call is on its way ("Connection closed: this Durable Object
 * instance is no longer active"). One real load run saw it three times in 72 submits. An agent must not see
 * that: gitring sends the same call again to a new stub when the call is safe to send twice, and it says in
 * plain words what happened when the call is not safe or the object stays away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeLoader, type NodeLoader } from "../checks/node-loader";
import { steViolations } from "../coord/ste";
import { World } from "../github/harness";
import { fail, isObjectReset, retryAfterReset } from "../../src/worker/mcp-kit";
import { callTool, makeProject } from "./support";

const RESET = "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.";
const reset = (): Error => new Error(RESET);

describe("isObjectReset", () => {
  it("knows the messages of a restart, and the retryable flag of the platform", () => {
    expect(isObjectReset(reset())).toBe(true);
    expect(isObjectReset(new Error("Durable Object reset because its code was updated."))).toBe(true);
    expect(isObjectReset(new Error("Network connection lost."))).toBe(true);
    expect(isObjectReset(Object.assign(new Error("anything"), { retryable: true }))).toBe(true);
  });

  it("does not take other errors for a restart", () => {
    expect(isObjectReset(new Error("Unknown task. Give intentId from gitring_intents, or give newIntent."))).toBe(false);
    expect(isObjectReset(new Error("Work copy a_1 is landed."))).toBe(false);
    expect(isObjectReset(undefined)).toBe(false);
    expect(isObjectReset(null)).toBe(false);
  });

  it("does not send again to an object that has too much to do", () => {
    expect(isObjectReset(Object.assign(new Error(RESET), { retryable: true, overloaded: true }))).toBe(false);
  });
});

describe("retryAfterReset", () => {
  /** A project object that fails with a restart for the first `bad` calls of each method it is asked. */
  function fakeObject(log: string[], id: number, bad: number, err: () => Error = reset) {
    const seen = new Map<string, number>();
    const fire = (name: string, value: unknown) => async (...args: unknown[]) => {
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      log.push(`${id}:${name}(${args.join(",")})`);
      if (n <= bad) throw err();
      return value;
    };
    return {
      read: fire("read", "text"),
      submit: fire("submit", "submitted"),
      declare: fire("declare", "declared"),
      name: "object",
    };
  }

  it("sends a read again to a new stub, after 250 and 500 ms", async () => {
    const log: string[] = [];
    const sleeps: number[] = [];
    let made = 0;
    // Object 1 and 2 are stopped; object 3 works.
    const stub = retryAfterReset(() => fakeObject(log, ++made, made <= 2 ? 99 : 0), async (ms) => void sleeps.push(ms));
    expect(await stub.read("a.txt")).toBe("text");
    expect(log).toEqual(["1:read(a.txt)", "2:read(a.txt)", "3:read(a.txt)"]);
    expect(sleeps).toEqual([250, 500]);
    expect(made).toBe(3);
  });

  it("gives up after three calls and hands the error on", async () => {
    const log: string[] = [];
    const sleeps: number[] = [];
    const stub = retryAfterReset(() => fakeObject(log, 1, 99), async (ms) => void sleeps.push(ms));
    await expect(stub.submit("a_1")).rejects.toThrow(/no longer active/);
    expect(log).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("sends a submit again (the same work twice gives the same answer)", async () => {
    const log: string[] = [];
    let made = 0;
    const stub = retryAfterReset(() => fakeObject(log, ++made, made === 1 ? 1 : 0), async () => undefined);
    expect(await stub.submit("a_1")).toBe("submitted");
    expect(log).toEqual(["1:submit(a_1)", "2:submit(a_1)"]);
  });

  it("does not send declare again: when the first call did run, a second one would make a second work copy", async () => {
    const log: string[] = [];
    const sleeps: number[] = [];
    const stub = retryAfterReset(() => fakeObject(log, 1, 1), async (ms) => void sleeps.push(ms));
    await expect(stub.declare("task")).rejects.toThrow(/no longer active/);
    expect(log).toEqual(["1:declare(task)"]);
    expect(sleeps).toEqual([]);
  });

  it("tells the agent to look before it sends declare again (the first call can have made the work copy)", async () => {
    const stub = retryAfterReset(() => fakeObject([], 1, 1), async () => undefined);
    const err = await stub.declare("task").catch((e: unknown) => e);
    expect(isObjectReset(err)).toBe(true);
    const text = fail(err).content[0].text;
    expect(text).toBe("Error: gitring restarted this project for a moment. Call gitring_status or gitring_intents to see if your call took effect before you send it again.");
    expect(steViolations(text.replace(/^Error: /, ""))).toEqual([]);
    // The GitHub-compatible set names its own tools.
    const gh = retryAfterReset(() => fakeObject([], 1, 1), async () => undefined, "Call list_branches or list_issues to see if your call took effect before you send it again.");
    expect(fail(await gh.declare("task").catch((e: unknown) => e)).content[0].text).toMatch(/Call list_branches or list_issues/);
    // Another error of declare stays as it is.
    const other = retryAfterReset(() => fakeObject([], 1, 1, () => new Error("Unknown task.")), async () => undefined);
    expect(fail(await other.declare("task").catch((e: unknown) => e)).content[0].text).toBe("Error: Unknown task.");
  });

  it("passes other errors through at once", async () => {
    const log: string[] = [];
    const sleeps: number[] = [];
    const stub = retryAfterReset(() => fakeObject(log, 1, 99, () => new Error("Work copy a_1 is landed.")), async (ms) => void sleeps.push(ms));
    await expect(stub.read("x")).rejects.toThrow("Work copy a_1 is landed.");
    expect(log).toEqual(["1:read(x)"]);
    expect(sleeps).toEqual([]);
  });

  it("is not a promise, and gives plain values as they are", async () => {
    const stub = retryAfterReset(() => fakeObject([], 1, 0));
    expect(await Promise.resolve(stub)).toBe(stub); // a "then" would make the await wait for ever
    expect(stub.name).toBe("object");
  });

  it("keeps what the caller sets on it (the Worker adds the role of the person to the object)", async () => {
    const stub = Object.assign(retryAfterReset(() => fakeObject([], 1, 0)), { role: "member" });
    expect(stub.role).toBe("member");
    expect(await stub.read("a.txt")).toBe("text");
  });

  it("keeps `this` of the object when it calls a method", async () => {
    class Counter {
      private n = 0;
      async read(): Promise<number> {
        return ++this.n;
      }
    }
    const stub = retryAfterReset(() => new Counter());
    expect(await stub.read()).toBe(1);
    expect(await stub.read()).toBe(2);
  });
});

describe("the answer of a tool after a restart", () => {
  it("is a plain sentence, and tells the agent that its work is kept", () => {
    const res = fail(reset());
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toBe("Error: gitring restarted this project for a moment. The work you already sent is kept. Send the same call again.");
    expect(text).not.toMatch(/Durable Object/);
    expect(steViolations(text.replace(/^Error: /, ""))).toEqual([]);
  });

  it("keeps the message of every other error", () => {
    expect(fail(new Error("Unknown task. Give intentId.")).content[0].text).toBe("Error: Unknown task. Give intentId.");
  });
});

describe("through the Worker: a stop of the project object while an agent works", () => {
  let world: World;
  let loader: NodeLoader;
  let key: string;
  let project: string;
  /** Calls the next `stops` times that the Worker sends to a method of a project object fail with a restart. */
  const stops = { method: "", left: 0, calls: 0 };

  const gr = (name: string, args: Record<string, unknown> = {}) => callTool(world, key, name, { project, ...args });

  beforeEach(async () => {
    world = new World();
    loader = nodeLoader();
    vi.stubGlobal("fetch", world.fetch);
    await world.init({ LOADER: loader });
    world.person("alice", 1);
    ({ key } = await world.signIn("alice"));
    project = await makeProject(world, key, "shop", { checks: { runner: "worker" } });
    await world.land(project, "src/greet.js", 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n');
    // The namespace of the test world gives the same object each time. This one stops a method on demand.
    const ns = world.env.HARBOR as { get: (id: string) => Record<string, unknown> };
    const real = ns.get.bind(ns);
    stops.method = "";
    stops.left = 0;
    stops.calls = 0;
    ns.get = (id: string) =>
      new Proxy(real(id), {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (prop === stops.method) {
              stops.calls += 1;
              if (stops.left > 0) {
                stops.left -= 1;
                throw reset();
              }
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await world.settle();
    await loader.cleanup();
  });

  async function work(): Promise<string> {
    const plan = await gr("gitring_declare", { newIntent: { title: "Shout", goal: "A shout function exists." }, plan: ["Add shout"], files: ["src/shout.js"], symbols: [], approach: "New file." });
    const id = /work copy (a_\w+)/.exec(plan.text)?.[1] ?? "";
    expect(id, plan.text).not.toBe("");
    const wrote = await gr("gitring_write", { attemptId: id, files: [{ path: "src/shout.js", content: 'import { greet } from "./greet.js";\nexport const shout = (n) => greet(n).toUpperCase();\n' }] });
    expect(wrote.isError, wrote.text).toBe(false);
    return id;
  }

  it("a submit that meets two stops works: the agent sees no error", async () => {
    const id = await work();
    stops.method = "submit";
    stops.left = 2;
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    expect(sub.isError, sub.text).toBe(false);
    expect(stops.calls).toBe(3);
    expect(sub.text).toMatch(/landed|merged/i);
  });

  it("a submit that meets three stops gives the agent a plain sentence", async () => {
    const id = await work();
    stops.method = "submit";
    stops.left = 3;
    const sub = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    expect(sub.isError).toBe(true);
    expect(sub.text).toBe("Error: gitring restarted this project for a moment. The work you already sent is kept. Send the same call again.");
    // The object is back: the same call works, and the work lands once.
    stops.left = 0;
    const again = await gr("gitring_submit", { attemptId: id, summary: "Add shout" });
    expect(again.isError, again.text).toBe(false);
    expect(again.text).toMatch(/landed|merged/i);
  });

  it("a plan that meets a stop tells the agent to look before it sends the plan again", async () => {
    stops.method = "declare";
    stops.left = 1;
    const res = await gr("gitring_declare", { newIntent: { title: "Shout", goal: "A shout function exists." }, plan: ["Add shout"], files: ["src/shout.js"], symbols: [], approach: "New file." });
    expect(res.isError).toBe(true);
    expect(res.text).toBe("Error: gitring restarted this project for a moment. Call gitring_status or gitring_intents to see if your call took effect before you send it again.");
    // gitring did not send it again by itself.
    expect(stops.calls).toBe(1);
  });

  it("a branch write of the GitHub-compatible set that meets a stop names the tools of that set", async () => {
    stops.method = "declare";
    stops.left = 1;
    const res = await callTool(world, key, "push_files", { repo: project, branch: "feature/x", message: "x", files: [{ path: "x.txt", content: "x" }] }, "/mcp/github");
    expect(res.isError).toBe(true);
    expect(res.text).toBe("Error: gitring restarted this project for a moment. Call list_branches or list_issues to see if your call took effect before you send it again.");
  });

  it("a read of the app (REST) meets a stop and still answers", async () => {
    stops.method = "state";
    stops.left = 1;
    const res = await world.call("GET", `/api/projects/${project}/state`, { key });
    expect(res.status, res.text).toBe(200);
    expect(stops.calls).toBe(2);
  });
});
