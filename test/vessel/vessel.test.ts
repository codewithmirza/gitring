/**
 * The built-in agent (Vessel) with a scripted model and a project object stand-in: it sends the model name
 * to the brief, asks GLM 5.3 for "high" reasoning to plan and "low" in tool turns, and acknowledges a change
 * request only after the model saw it and acted on it.
 */
import { describe, expect, it, vi } from "vitest";
import { changedNote, firstLine, trimMessages, withOpenRequests, Vessel, type OpenRequest, type VesselConfig } from "../../src/vessel/vessel";
import type { ChatMessage } from "../../src/platform/ai/models";
import type * as T from "../../src/core/types";
import { steViolations } from "../coord/ste";

const MODEL = "@cf/zai-org/glm-5.3-flash";

function notice(id: string, message = "Keep formatPrice(p) in src/price.js. Continue your work."): T.CorrectionNotice {
  return { id, kind: "region", message, constraints: {}, from: "HERON-3" } as T.CorrectionNotice;
}

function clearance(corrections: T.CorrectionNotice[] = []): T.Clearance {
  return { verdict: "clear", corrections, traffic: [], advice: "Go on." } as unknown as T.Clearance;
}

/** A model answer: text, and tool calls (name, arguments). */
function answer(content: string, calls: [string, Record<string, unknown>][] = []) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          reasoning_content: "SECRET THOUGHTS",
          tool_calls: calls.map(([name, args], i) => ({ id: `call_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })),
        },
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
  };
}

/** A project object stand-in that records the calls of the vessel. */
function harborDouble(
  opts: { declared?: T.CorrectionNotice[]; onWrite?: (n: number) => T.CorrectionNotice[]; readText?: string; onAck?: (n: number, id: string) => unknown } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  let writes = 0;
  let acks = 0;
  const api = {
    brief: async (...args: unknown[]) => {
      calls.push({ method: "brief", args });
      return { intent: { id: "i_1", title: "Show prices", goal: "Show the price of each book.", checks: [] }, context: { "src/price.js": "export const p = 1;\n" }, checks: [], constraints: [], traffic: [] };
    },
    declare: async (...args: unknown[]) => {
      calls.push({ method: "declare", args });
      return { attemptId: "a_1", clearance: clearance(opts.declared ?? []) };
    },
    write: async (input: T.WriteInput) => {
      calls.push({ method: "write", args: [input] });
      writes += 1;
      return { written: input.files.map((f) => f.path), footprint: { files: [], symbols: [] }, clearance: clearance(opts.onWrite?.(writes) ?? []) };
    },
    read: async (_a: string, path: string) => ({ path, content: opts.readText ?? "x" }),
    list: async () => ["src/price.js"],
    check: async () => ({ id: "ck_1", ok: true, passed: 1, failed: 0, cases: [] }),
    log: async () => clearance(),
    submit: async (...args: unknown[]) => {
      calls.push({ method: "submit", args });
      return { attemptId: "a_1", status: "ready", next: "landing-queue", message: "Submitted.", clearance: clearance() };
    },
    ack: async (...args: unknown[]) => {
      calls.push({ method: "ack", args });
      acks += 1;
      return opts.onAck?.(acks, String(args[1])) ?? clearance();
    },
    attemptDiff: async () => ({ files: [] }),
    giveUp: async (...args: unknown[]) => {
      calls.push({ method: "giveUp", args });
      return "failed";
    },
  };
  return { api, calls };
}

/** A vessel with in-memory storage, the project object stand-in and a model that answers from a script. */
function vesselWith(harbor: ReturnType<typeof harborDouble>, script: unknown[]) {
  const inputs: { model: string; input: any }[] = [];
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => structuredClone(store.get(k)),
      put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
    },
  };
  const env = {
    HARBOR: { idFromName: (n: string) => n, get: () => harbor.api },
    AI: {
      run: async (model: string, input: any) => {
        inputs.push({ model, input: structuredClone(input) });
        const next = script.shift();
        if (!next) throw new Error("the script has no more answers");
        // A function is a slow answer (it returns a promise).
        return typeof next === "function" ? next() : next;
      },
    },
  };
  const vessel = new Vessel(ctx as never, env as never);
  const config: VesselConfig = { projectId: "shop", attemptId: "a_1", intentId: "i_1", agentId: "agt_1", callsign: "KESTREL-7", model: MODEL };
  return { vessel, inputs, config, stored: () => store.get("st") as { step: number; phase: string; messages: ChatMessage[] } };
}

const PLAN = answer(JSON.stringify({ plan: ["Change the price"], files: ["src/price.js"], symbols: [], approach: "Format the price." }));

describe("Vessel", () => {
  it("sends the model to the brief, and plans with high reasoning and works with low reasoning", async () => {
    const h = harborDouble();
    const { vessel, inputs, config } = vesselWith(h, [PLAN, answer("Done.", [["submit", { summary: "Prices show." }]])]);
    await vessel.start(config);
    await vessel.alarm();
    await vessel.alarm();
    expect(h.calls.find((c) => c.method === "brief")!.args[2]).toEqual({ model: MODEL });
    expect(inputs.map((x) => x.input.reasoning_effort)).toEqual(["high", "low"]);
    expect(inputs[0].input.max_tokens).toBeUndefined();
    // The reasoning text of the model never goes back into the conversation.
    expect(JSON.stringify(inputs[1].input.messages)).not.toContain("SECRET THOUGHTS");
  });

  it("acknowledges a change request after its next write, with the files of that write", async () => {
    // The first write brings a change request (the model has not seen it yet).
    const h = harborDouble({ onWrite: (n) => (n === 1 ? [notice("cr_1")] : []) });
    const { vessel, inputs, config } = vesselWith(h, [
      PLAN,
      answer("I add the price.", [["write_file", { path: "src/a.js", content: "a" }]]),
      answer("I apply the request.", [["write_file", { path: "src/b.js", content: "b" }], ["write_file", { path: "src/c.js", content: "c" }]]),
    ]);
    await vessel.start(config);
    await vessel.alarm(); // plan
    await vessel.alarm(); // write a.js: the change request arrives
    expect(h.calls.filter((c) => c.method === "ack")).toEqual([]);
    await vessel.alarm(); // the model sees the request, then writes b.js and c.js
    expect(JSON.stringify(inputs[2].input.messages)).toContain("[cr_1]");
    const acks = h.calls.filter((c) => c.method === "ack");
    expect(acks).toHaveLength(1);
    expect(acks[0].args.slice(0, 2)).toEqual(["a_1", "cr_1"]);
    expect(acks[0].args[2]).toBe("I changed src/b.js, src/c.js for this change request.");
    expect(steViolations(String(acks[0].args[2]))).toEqual([]);
  });

  it("acknowledges at the submit when the model wrote nothing after the request: no code change was needed", async () => {
    const h = harborDouble({ declared: [notice("cr_7")] });
    const { vessel, config } = vesselWith(h, [PLAN, answer("The code already keeps formatPrice(p).\nSo I submit.", [["submit", { summary: "No change." }]])]);
    await vessel.start(config);
    await vessel.alarm();
    expect(h.calls.filter((c) => c.method === "ack")).toEqual([]);
    await vessel.alarm();
    const order = h.calls.filter((c) => c.method === "ack" || c.method === "submit").map((c) => c.method);
    expect(order).toEqual(["ack", "submit"]);
    const ack = h.calls.find((c) => c.method === "ack")!;
    expect(ack.args[1]).toBe("cr_7");
    expect(ack.args[2]).toBe("No code change was needed: The code already keeps formatPrice(p).");
  });

  it("does not count a write from before the request, and never acknowledges a request twice", async () => {
    const h = harborDouble({ onWrite: (n) => (n === 1 ? [notice("cr_2")] : n === 2 ? [notice("cr_2")] : []) });
    const { vessel, config } = vesselWith(h, [
      PLAN,
      // Two writes in one turn: the request arrives with the first one, so the second one is not an answer to it.
      answer("Two files.", [["write_file", { path: "src/a.js", content: "a" }], ["write_file", { path: "src/b.js", content: "b" }]]),
      answer("Fix.", [["write_file", { path: "src/c.js", content: "c" }]]),
      answer("Done.", [["submit", { summary: "Done." }]]),
    ]);
    await vessel.start(config);
    for (let i = 0; i < 4; i++) await vessel.alarm();
    const acks = h.calls.filter((c) => c.method === "ack");
    expect(acks.map((a) => [a.args[1], a.args[2]])).toEqual([["cr_2", "I changed src/c.js for this change request."]]);
  });

  it("gives the plan call time to think (high reasoning)", async () => {
    vi.useFakeTimers();
    try {
      const h = harborDouble();
      // The plan comes after 150 seconds: more than a routine turn may take.
      const { vessel, config } = vesselWith(h, [() => new Promise((r) => setTimeout(() => r(PLAN), 150_000))]);
      await vessel.start(config);
      const step = vessel.alarm();
      await vi.advanceTimersByTimeAsync(150_000);
      await step;
      const declared = h.calls.find((c) => c.method === "declare")!;
      expect(JSON.stringify(declared.args)).toContain("Change the price");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not say that no change was needed when the step limit sends the work", async () => {
    const h = harborDouble({ declared: [notice("cr_7")] });
    const { vessel, config } = vesselWith(h, [PLAN]);
    await vessel.start(config);
    await vessel.alarm(); // plan: the request is in the prompt
    // The model used all its steps: the vessel sends the work.
    (vessel as unknown as { st: { step: number } }).st.step = 99;
    await vessel.alarm(); // working → submitted
    await vessel.alarm(); // submit
    expect(h.calls.filter((c) => c.method === "submit")).toHaveLength(1);
    expect(h.calls.filter((c) => c.method === "ack")).toEqual([]);
  });

  it("keeps a request open when the code check of the acknowledgement fails, and asks again after the next write", async () => {
    const h = harborDouble({
      declared: [notice("cr_7")],
      // The project object checks the code (contract C2): the first answer keeps the request open.
      onAck: (n) =>
        n === 1
          ? { correctionId: "cr_7", outcome: "open", check: { applied: false, reason: "Your code still edits lines 10–14 of src/price.js.", at: 1 }, message: "Change it.", clearance: clearance() }
          : { correctionId: "cr_7", outcome: "acknowledged", message: "Confirmed.", clearance: clearance() },
    });
    const { vessel, inputs, config } = vesselWith(h, [
      PLAN,
      answer("I edit the price.", [["write_file", { path: "src/a.js", content: "a" }]]),
      answer("I keep formatPrice now.", [["write_file", { path: "src/price.js", content: "p" }]]),
      answer("Done.", [["submit", { summary: "Done." }]]),
    ]);
    await vessel.start(config);
    for (let i = 0; i < 4; i++) await vessel.alarm();
    const acks = h.calls.filter((c) => c.method === "ack").map((c) => [c.args[1], c.args[2]]);
    expect(acks).toEqual([
      ["cr_7", "I changed src/a.js for this change request."],
      ["cr_7", "I changed src/price.js for this change request."],
    ]);
    // The model saw the reason before its second write.
    expect(JSON.stringify(inputs[2].input.messages)).toContain("[cr_7]");
    expect(JSON.stringify(inputs[2].input.messages)).toContain("still open: Your code still edits lines 10–14 of src/price.js.");
  });

  it("limits the tool answers of one turn, and stores only the history that the next turns can send", async () => {
    const big = "x".repeat(150_000);
    const reads = (n: number) => answer(`Read ${n}.`, [1, 2, 3, 4].map((i) => ["read_file", { path: `src/f${n}${i}.js` }] as [string, Record<string, unknown>]));
    const h = harborDouble({ readText: big });
    const { vessel, config, stored } = vesselWith(h, [PLAN, reads(1), reads(2), reads(3), reads(4), reads(5)]);
    await vessel.start(config);
    for (let i = 0; i < 6; i++) await vessel.alarm();
    const messages = stored().messages;
    // One turn: 2 answers of 100,000 characters (GLM 5.3), then the turn has no room left (2,000 each).
    const lastTurn = messages.slice(-4).map((m) => m.content?.length);
    expect(lastTurn).toEqual([100_000, 100_000, 2_000, 2_000]);
    // The stored history stays within the turn budget of the model, and keeps the system prompt and the brief.
    const chars = messages.reduce((n, m) => n + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
    expect(chars).toBeLessThanOrEqual(800_000);
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain("TASK: Show prices");
    expect(messages[2].role).toBe("assistant");
  });
});

describe("the prompt of a turn", () => {
  const sys: ChatMessage = { role: "system", content: "rules" };
  const brief: ChatMessage = { role: "user", content: "TASK" };
  const turn = (n: number, size: number): ChatMessage[] => [
    { role: "assistant", content: `turn ${n}`, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `c${n}`, name: "read_file", content: "x".repeat(size) },
  ];

  it("drops the oldest turns to stay under the character budget, and keeps the last turn", () => {
    const messages = [sys, brief, ...turn(1, 1000), ...turn(2, 1000), ...turn(3, 1000)];
    const out = trimMessages(messages, 2300);
    expect(out.slice(0, 2)).toEqual([sys, brief]);
    expect(out.map((m) => m.content?.slice(0, 6))).toEqual(["rules", "TASK", "turn 2", "xxxxxx", "turn 3", "xxxxxx"]);
    // A budget below the last turn keeps the last turn whole (the model needs its tool answers).
    expect(trimMessages(messages, 10).slice(2).map((m) => m.role)).toEqual(["assistant", "tool"]);
    // Without a budget, the message count decides (as before).
    expect(trimMessages(messages)).toEqual(messages);
  });

  it("never starts the history with a tool answer", () => {
    const messages = [sys, brief, ...turn(1, 10), ...turn(2, 10), ...turn(3, 10)];
    const out = trimMessages(messages, Infinity, 3);
    expect(out[2].role).toBe("assistant");
  });

  it("brings an open change request back when its turn left the history", () => {
    const open: OpenRequest[] = [{ notice: notice("cr_9"), files: [] }];
    const without = [sys, brief, ...turn(4, 10)];
    const out = withOpenRequests(without, open);
    expect(out).toHaveLength(without.length + 1);
    expect(out[2].role).toBe("user");
    expect(out[2].content).toContain("[cr_9]");
    const withIt: ChatMessage[] = [...without, { role: "user", content: "GITRING CHANGE REQUEST:\n- [cr_9] Keep it." }];
    expect(withOpenRequests(withIt, open)).toBe(withIt);
  });

  it("writes short notes", () => {
    expect(changedNote(["a", "b", "c", "d", "e", "f", "g", "h"])).toBe("I changed a, b, c, d, e, f and 2 more files for this change request.");
    expect(firstLine("  First line.\nSecond.")).toBe("First line.");
    expect(firstLine("x".repeat(300))).toHaveLength(200);
    expect(firstLine(null)).toBe("");
  });
});
