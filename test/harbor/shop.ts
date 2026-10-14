/**
 * A small JavaScript project, its tasks, and scripted agents for the concurrency tests.
 *
 * Three kinds of task:
 *   solo      its own file; no other task touches it
 *   function  two tasks change the same function (`price`): the plans collide, one agent gives way
 *   file      two tasks add a function at the end of the same file: the plans do not collide in the
 *             plan check (other symbols), but the two texts meet at the same place when they merge
 *
 * Each task has real test files. They pass on the work of the task, and on main plus the work of every
 * other task, in any order. An agent edits the text that it reads, so its change goes on top of whatever
 * main holds at that time.
 */
import { runChecks } from "../../src/platform/checks/runner";
import { Scheduler, sleep, type Notice, type ToolResult, type World } from "./world";

export interface Edit {
  path: string;
  apply(text: string): string;
}

export interface TaskSpec {
  id: string;
  group: "solo" | "function" | "file";
  /** The two tasks of a pair share this value. */
  pair?: string;
  title: string;
  goal: string;
  plan: string[];
  files: string[];
  symbols: string[];
  approach: string;
  check: { path: string; content: string; description: string };
  edits: Edit[];
  /** When the task is in main, these files of main hold these texts. */
  landed: { path: string; has: string[] }[];
}

export interface Shop {
  files: Record<string, string>;
  tasks: TaskSpec[];
}

const lines = (...rows: string[]) => rows.join("\n") + "\n";
const pad = (n: number) => String(n).padStart(2, "0");

function testFile(file: string, imports: string, title: string, body: string): string {
  return lines('import { test, expect } from "../harness/test.js";', `import { ${imports} } from "../src/${file}";`, "", `test(${JSON.stringify(title)}, () => {`, `  ${body}`, "});");
}

/** The project: `solo` single tasks and `pairs` pairs of each pair kind (function, file). */
export function shop(solo: number, pairs: number): Shop {
  const files: Record<string, string> = {
    "package.json": lines("{", '  "name": "shop",', '  "private": true,', '  "type": "module"', "}"),
    "README.md": lines("# Shop", "", "A small project for the concurrency tests."),
    "src/util.js": lines("export function clamp(n, lo, hi) {", "  return Math.min(hi, Math.max(lo, n));", "}"),
    "tests/util.test.js": lines(
      'import { test, expect } from "../harness/test.js";',
      'import { clamp } from "../src/util.js";',
      "",
      'test("clamp keeps a number in range", () => {',
      "  expect(clamp(15, 0, 10)).toBe(10);",
      "  expect(clamp(-5, 0, 10)).toBe(0);",
      "});",
    ),
  };
  const tasks: TaskSpec[] = [];

  for (let i = 1; i <= solo; i++) {
    const n = pad(i);
    const file = `solo${n}.js`;
    files[`src/${file}`] = lines(`export function name${n}() {`, `  return "solo ${n}";`, "}");
    tasks.push({
      id: `solo-${n}`,
      group: "solo",
      title: `Name of solo ${n}`,
      goal: `The function name${n} returns "solo ${n} v2".`,
      plan: [`Change the text that name${n} returns.`],
      files: [`src/${file}`],
      symbols: [`src/${file}#name${n}`],
      approach: `Edit name${n} in ${file}.`,
      check: { path: `tests/solo${n}.test.js`, description: `name${n} says v2`, content: testFile(file, `name${n}`, `name${n} says v2`, `expect(name${n}()).toBe("solo ${n} v2");`) },
      edits: [{ path: `src/${file}`, apply: (t) => t.replace(`return "solo ${n}";`, `return "solo ${n} v2";`) }],
      landed: [{ path: `src/${file}`, has: [`solo ${n} v2`] }],
    });
  }

  for (let k = 1; k <= pairs; k++) {
    const n = pad(k);
    const file = `price${n}.js`;
    files[`src/${file}`] = lines("export function price(cents) {", "  return cents;", "}", "", "export function label(name) {", "  return name;", "}");
    const common = { group: "function" as const, pair: `fn-${n}`, files: [`src/${file}`], symbols: [`src/${file}#price`] };
    tasks.push({
      ...common,
      id: `fn-${n}-a`,
      title: `Dollar sign on prices ${n}`,
      goal: `The function price shows a price as dollars, for example "$12.50".`,
      plan: ["Format the price as dollars in price."],
      approach: `Change price in ${file} to return a dollar text.`,
      check: { path: `tests/price${n}-dollars.test.js`, description: "price shows dollars", content: testFile(file, "price", "price shows dollars", `expect(price(1250)).toBe("$12.50");`) },
      edits: [
        {
          path: `src/${file}`,
          apply: (t) => (t.includes("Math.max(cents, 0)") ? t.replace("return Math.max(cents, 0);", 'return "$" + (Math.max(cents, 0) / 100).toFixed(2);') : t.replace("return cents;", 'return "$" + (cents / 100).toFixed(2);')),
        },
      ],
      landed: [{ path: `src/${file}`, has: ['"$"', ".toFixed(2)"] }],
    });
    tasks.push({
      ...common,
      id: `fn-${n}-b`,
      title: `No negative prices ${n}`,
      goal: `The function price never shows a negative price.`,
      plan: ["Clamp the price at zero in price."],
      approach: `Change price in ${file} to clamp at zero.`,
      check: { path: `tests/price${n}-clamp.test.js`, description: "price is never negative", content: testFile(file, "price", "price is never negative", `expect(String(price(-500))).not.toContain("-");`) },
      edits: [
        {
          path: `src/${file}`,
          apply: (t) => (t.includes('"$"') ? t.replace("(cents / 100)", "(Math.max(cents, 0) / 100)") : t.replace("return cents;", "return Math.max(cents, 0);")),
        },
      ],
      landed: [{ path: `src/${file}`, has: ["Math.max(cents, 0)"] }],
    });

    const mix = `mix${n}.js`;
    files[`src/${mix}`] = lines("export function first() {", '  return "first";', "}", "", "export function second() {", '  return "second";', "}");
    const same = { group: "file" as const, pair: `file-${n}`, files: [`src/${mix}`] };
    tasks.push({
      ...same,
      id: `file-${n}-c`,
      title: `Shout in capitals m${n}`,
      goal: `A new function shout returns the text in capitals with an exclamation mark.`,
      plan: ["Add shout at the end of the file."],
      symbols: [`src/${mix}#shout`],
      approach: `Add shout to ${mix}.`,
      check: { path: `tests/mix${n}-shout.test.js`, description: "shout works", content: testFile(mix, "shout", "shout works", `expect(shout("hi")).toBe("HI!");`) },
      edits: [{ path: `src/${mix}`, apply: (t) => (t.includes("function shout") ? t : `${t}\nexport function shout(text) {\n  return String(text).toUpperCase() + "!";\n}\n`) }],
      landed: [{ path: `src/${mix}`, has: ["function shout"] }],
    });
    tasks.push({
      ...same,
      id: `file-${n}-d`,
      title: `Whisper in lower case m${n}`,
      goal: `A new function whisper returns the text in lower case with three dots.`,
      plan: ["Add whisper at the end of the file."],
      symbols: [`src/${mix}#whisper`],
      approach: `Add whisper to ${mix}.`,
      check: { path: `tests/mix${n}-whisper.test.js`, description: "whisper works", content: testFile(mix, "whisper", "whisper works", `expect(whisper("HI")).toBe("hi...");`) },
      edits: [{ path: `src/${mix}`, apply: (t) => (t.includes("function whisper") ? t : `${t}\nexport function whisper(text) {\n  return String(text).toLowerCase() + "...";\n}\n`) }],
      landed: [{ path: `src/${mix}`, has: ["function whisper"] }],
    });
  }
  return { files, tasks };
}

/** A project for n agents: half solo tasks, the rest in function pairs and file pairs (2 + 2 tasks for each `pair`). */
export function shopFor(agents: number): Shop {
  const pairs = Math.max(1, Math.floor(agents / 8));
  return shop(agents - 4 * pairs, pairs);
}

/* ───────────────────────────── scripted agents ───────────────────────────── */

export interface AgentResult {
  task: TaskSpec;
  agentId: string;
  callsign: string;
  attemptId: string;
  /** landed: the work is in main. handed: a person decides. stopped: the agent ended without either. */
  outcome: "landed" | "handed" | "stopped";
  reason: string;
  rounds: number;
  /** Every change request that gitring sent to this agent, in order. */
  notices: (Notice & { tool: string })[];
  /** The calls of the agent, in order (tool name and result: ok or error). */
  trace: string[];
}

const MAX_ROUNDS = 8;
/** An agent waits at most this long for a merge or for another agent (a stuck run must end with a clear message). */
const WAIT_LIMIT_MS = 45_000;

/**
 * One external agent: it picks its task, sends its plan, reads and writes files, runs the tests, asks
 * for the merge, and obeys change requests. A change request that names an agent that continues makes
 * this agent wait until that agent leaves the traffic (it merged or stopped), then edit the new text.
 */
export class ScriptedAgent {
  readonly id: string;
  readonly callsign: string;
  attemptId = "";
  readonly notices: (Notice & { tool: string })[] = [];
  readonly trace: string[] = [];
  private waitFor = new Set<string>();
  private unacked: Notice[] = [];

  constructor(
    readonly world: World,
    readonly key: string,
    readonly project: string,
    readonly sched: Scheduler,
    readonly spec: TaskSpec,
    readonly n: number,
  ) {
    this.id = `agent-${pad(n)}`;
    this.callsign = `BOT-${n}`;
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const res = await this.world.tool(this.key, tool, { project: this.project, ...(this.attemptId && tool !== "gitring_intents" && tool !== "gitring_declare" ? { attemptId: this.attemptId } : {}), ...args });
    this.trace.push(`${tool}:${res.ok ? "ok" : "error"}${res.notices.length ? `:${res.notices.length} change request` : ""}`);
    for (const nt of res.notices) {
      this.notices.push({ ...nt, tool });
      this.unacked.push(nt);
      if ((nt.kind === "region" || nt.kind === "interface") && nt.from) this.waitFor.add(nt.from);
    }
    return res;
  }

  /**
   * Confirm every change request that the agent got and did not confirm yet. gitring checks the code: a request
   * that the code still breaks stays open, and the agent confirms it again after its next edit.
   */
  async ackAll(): Promise<void> {
    const later: Notice[] = [];
    while (this.unacked.length) {
      const nt = this.unacked.shift()!;
      // An answer to the ack can hold new change requests: `call` adds them to `unacked`.
      const res = await this.call("gitring_ack", { correctionId: nt.id, note: `Applied: ${nt.kind}.` });
      if (res.json?.outcome === "open") later.push(nt);
    }
    this.unacked.push(...later);
  }

  /** Wait until the agents that continue have left the traffic (merged or stopped). */
  private async giveWay(): Promise<void> {
    const names = [...this.waitFor];
    this.waitFor.clear();
    if (!names.length) return;
    const until = performance.now() + WAIT_LIMIT_MS;
    for (let polls = 0; performance.now() < until; polls++) {
      const t = await this.call("gitring_traffic");
      const near: { callsign: string }[] = t.json?.vessels ?? [];
      if (!names.some((nm) => near.some((v) => v.callsign === nm))) return;
      await this.sched.backoff(this.id, polls);
    }
  }

  /** After a submit that went to the merge queue: wait for the merge, or for the work to come back. */
  async waitForMerge(): Promise<"landed" | "returned" | "closed"> {
    const until = performance.now() + WAIT_LIMIT_MS;
    for (let polls = 0; performance.now() < until; polls++) {
      await this.sched.backoff(this.id, polls);
      // gitring_update answers with an error once the work copy is merged. A report (gitring_log)
      // carries the change requests: the work comes back when it cannot merge.
      const u = await this.call("gitring_update");
      if (!u.ok) return /is merged/.test(u.text) ? "landed" : "closed";
      // The answer of gitring_update carries the change requests too: the work came back.
      if (u.notices.length) return "returned";
      if (polls % 4 === 3) {
        const l = await this.call("gitring_log", { message: "Waiting for the merge." });
        if (l.notices.length) return "returned";
      }
    }
    return "closed";
  }

  /** The result of this agent (a test that drives the steps itself builds the result with this). */
  done(outcome: AgentResult["outcome"], reason: string, rounds: number): AgentResult {
    return { task: this.spec, agentId: this.id, callsign: this.callsign, attemptId: this.attemptId, outcome, reason, rounds, notices: this.notices, trace: this.trace };
  }

  /** The agent finds its task and sends its plan. It returns a result only when the agent cannot go on. */
  async start(): Promise<AgentResult | undefined> {
    const { spec } = this;
    await this.sched.pause(this.id);
    const list = await this.call("gitring_intents");
    const intent = (list.json?.intents ?? []).find((i: { title: string }) => i.title === spec.title);
    if (!intent) return this.done("stopped", `The task "${spec.title}" is not in the list of open tasks.`, 0);
    await this.sched.pause(this.id);
    const d = await this.call("gitring_declare", {
      intentId: intent.id,
      plan: spec.plan,
      files: spec.files,
      symbols: spec.symbols,
      approach: spec.approach,
      agent: { id: this.id, name: this.callsign, client: "vitest", model: "scripted" },
    });
    if (!d.ok) return this.done("stopped", `declare failed: ${d.text.slice(0, 200)}`, 0);
    this.attemptId = d.json.attemptId;
    await this.ackAll();
    return undefined;
  }

  async run(): Promise<AgentResult> {
    return (await this.start()) ?? (await this.work());
  }

  /** From the plan to the merge: read, write, check, submit, and obey change requests. */
  async work(): Promise<AgentResult> {
    const { spec } = this;
    const done = (outcome: AgentResult["outcome"], reason: string, rounds: number) => this.done(outcome, reason, rounds);
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      await this.giveWay();
      await this.sched.pause(this.id);
      await this.call("gitring_update");
      const writes: { path: string; content: string }[] = [];
      for (const e of spec.edits) {
        const r = await this.call("gitring_read", { path: e.path });
        const after = e.apply(r.text);
        if (after !== r.text) writes.push({ path: e.path, content: after });
      }
      if (writes.length) {
        await this.sched.pause(this.id);
        const w = await this.call("gitring_write", { files: writes, message: spec.title });
        await this.ackAll();
        if (!w.ok) return done("stopped", `write failed: ${w.text.slice(0, 200)}`, round);
        if (w.json?.refused?.length) continue; // main moved after the last read: read again
      }
      if (this.waitFor.size) continue; // a change request to wait: wait, then edit the new text
      await this.sched.pause(this.id);
      const c = await this.call("gitring_check");
      if (!c.ok || c.json?.ok === false) {
        await this.sched.backoff(this.id, round);
        continue;
      }
      await this.sched.pause(this.id);
      const s = await this.call("gitring_submit", { summary: `Done: ${spec.title}` });
      await this.ackAll();
      const next = s.json?.next as string | undefined;
      if (next === "awaiting-approval") return done("handed", "A person chooses.", round);
      if (next === "landed") return done("landed", "", round);
      if (next === "landing-queue") {
        const end = await this.waitForMerge();
        await this.ackAll();
        if (end === "landed") return done("landed", "", round);
        if (end === "closed") return done("stopped", "The work copy closed without a merge.", round);
        continue; // the work came back with a change request
      }
      // fix-checks: the tests of the merged result fail; edit again on the new main
      await this.sched.backoff(this.id, round);
    }
    return done("stopped", `no merge after ${MAX_ROUNDS} rounds`, MAX_ROUNDS);
  }
}

/* ───────────────────────────── the record after a run ───────────────────────────── */

export interface Audit {
  state: Awaited<ReturnType<ReturnType<World["harbor"]>["state"]>>;
  mainRepo: string;
  mainSha: string;
  /** Files of main now. */
  main: Record<string, string>;
  /** First-parent history of main, newest first. */
  history: { hash: string; message: string }[];
  notes: Map<string, string | null>;
  /** The tests of the project, run on the final main. */
  finalTests: { ok: boolean; passed: number; failed: number };
}

export async function audit(world: World, project: string, mainRepo: string): Promise<Audit> {
  await world.settle();
  const h = world.harbor(project);
  const state = await h.state();
  const mainSha = (await world.backend.resolve(mainRepo, state.project.repo.defaultBranch))!;
  const main = await world.filesAt(mainRepo, mainSha);
  const history = (await world.backend.log(mainRepo, state.project.repo.defaultBranch, 500)).map((c) => ({ hash: c.hash, message: c.message }));
  const notes = new Map<string, string | null>();
  for (const c of history) notes.set(c.hash, await world.backend.readNote(mainRepo, c.hash));
  const testPaths = Object.keys(main).filter((p) => /^tests\/.+\.test\.(js|mjs)$/.test(p)).sort();
  const run = await runChecks(world.loader, `final-${mainSha}`, { files: new Map(Object.entries(main)), testPaths });
  return { state, mainRepo, mainSha, main, history, notes, finalTests: { ok: run.ok, passed: run.passed, failed: run.failed } };
}

/** Run all agents at once (Promise.all). Seeds change the start order and the pauses. */
export async function runAll(agents: ScriptedAgent[]): Promise<AgentResult[]> {
  return Promise.all(agents.map((a) => a.run()));
}
