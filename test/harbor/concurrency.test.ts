/**
 * Many agents change one project at the same time, through the real Worker routes (POST /mcp with a
 * personal API key), the real Directory and the real HarborMaster, on the Artifacts test double.
 * Agents run the whole protocol: gitring_intents, gitring_declare, gitring_read, gitring_write,
 * gitring_check, gitring_submit, gitring_ack, gitring_update. The project has real test files, and the
 * tests run on the real code that gitring merges (see world.ts and shop.ts).
 *
 * What every run must keep true (checkRun):
 *   - every task lands, or a person decides it; no agent ends without one of them
 *   - no attempt stays in "declared", "underway", "ready" or "landing" without a reason
 *   - no task lands twice; landings are one after the other (each starts at the end of the one before)
 *   - main holds the change of every landed task (no lost update), and its tests pass
 *   - each landing commit has its trailers and its git note (the logbook)
 *   - a plan that meets another plan gets one change request, and the other agent continues
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTrailers, LOGBOOK_SCHEMA } from "../../src/core/logbook";
import { audit, runAll, ScriptedAgent, shop, shopFor, type AgentResult, type Audit, type Shop } from "./shop";
import { mulberry32, Scheduler, shuffled, sleep, World, type WorldOptions } from "./world";

interface Run {
  world: World;
  key: string;
  project: { id: string; mainRepo: string };
  shop: Shop;
  results: AgentResult[];
  audit: Audit;
  ms: number;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

async function newWorld(opts: WorldOptions = {}): Promise<{ world: World; key: string }> {
  const world = new World();
  worlds.push(world);
  await world.init(opts);
  const { key } = await world.signIn("robin", 1);
  return { world, key };
}

async function openProject(world: World, key: string, s: Shop) {
  const project = await world.createProject(key, "shop", s.files);
  for (const t of s.tasks) await world.addTask(key, project.id, { title: t.title, goal: t.goal, checks: [t.check] });
  return project;
}

/** All agents start together (Promise.all); the seed sets the start order and the pauses. */
async function execute(s: Shop, seed: number): Promise<Run> {
  const { world, key } = await newWorld();
  const project = await openProject(world, key, s);
  const sched = new Scheduler(seed);
  const order = shuffled(s.tasks, mulberry32(seed));
  const agents = order.map((t, i) => new ScriptedAgent(world, key, project.id, sched, t, i + 1));
  const t0 = performance.now(); // not Date.now: the test clock runs ahead of real time
  const results = await runAll(agents);
  const ms = Math.round(performance.now() - t0);
  return { world, key, project, shop: s, results, audit: await audit(world, project.id, project.mainRepo), ms };
}

/** What happened, in a few lines (for the message of a failed assertion). */
function story(run: Run): string {
  const { state } = run.audit;
  const rows = run.results.map((r) => `${r.task.id} ${r.callsign}: ${r.outcome}${r.reason ? ` (${r.reason})` : ""}, ${r.rounds} rounds, change requests: ${r.notices.map((n) => `${n.kind}<-${n.from ?? "-"}`).join(" ") || "none"}`);
  const logs = state.logs.filter((l) => ["correction", "stale", "decision", "land"].includes(l.kind)).map((l) => `${l.kind}: ${l.message.slice(0, 160)}`);
  return `\n${rows.join("\n")}\n--\n${logs.join("\n")}`;
}

const R1 = "R1-landed-has-way";
const R4 = "R4-first-declared-stands-on";

/** The rules of the run. `requests: false` skips the part about change requests (a test that drives the steps itself). */
function checkRun(run: Run, { requests = true }: { requests?: boolean } = {}): void {
  const { results, shop: s, world } = run;
  const { state: st } = run.audit;
  const why = story(run);
  const task = (id: string) => results.find((r) => r.task.id === id)!;
  const intentOf = (r: AgentResult) => st.intents.find((i) => i.title === r.task.title)!;
  const attemptOf = (r: AgentResult) => st.attempts.find((x) => x.id === r.attemptId)!;

  // Every task lands, or a person decides it. No agent is lost, and each task has one attempt.
  expect(results, why).toHaveLength(s.tasks.length);
  expect(results.filter((r) => r.outcome === "stopped").map((r) => `${r.task.id}: ${r.reason}`), `agents that ended without a merge or a hand-off${why}`).toEqual([]);
  expect(st.attempts, why).toHaveLength(s.tasks.length);
  for (const r of results) {
    const intent = intentOf(r);
    const at = attemptOf(r);
    if (r.outcome === "landed") {
      expect([intent.status, at.status], `${r.task.id}${why}`).toEqual(["landed", "landed"]);
    } else {
      // Handed to a person: the work waits ("ready") and the task asks for a decision ("judging").
      expect([intent.status, at.status], `${r.task.id} is not handed to a person${why}`).toEqual(["judging", "ready"]);
    }
  }
  // No attempt stays in a state without a reason.
  for (const at of st.attempts) {
    const intent = st.intents.find((i) => i.id === at.intentId)!;
    const fine = at.status === "landed" || (at.status === "ready" && intent.status === "judging");
    expect(fine, `attempt ${at.id} (${intent.title}) is ${at.status}, the task is ${intent.status}${why}`).toBe(true);
  }
  // In this setup every agent works well, so every task lands.
  expect(results.filter((r) => r.outcome !== "landed").map((r) => r.task.id), `tasks that did not land${why}`).toEqual([]);

  // No task lands twice.
  const landed = results.filter((r) => r.outcome === "landed");
  expect(st.landings, why).toHaveLength(landed.length);
  expect(new Set(st.landings.map((l) => l.attemptId)).size).toBe(landed.length);
  expect(new Set(st.landings.map((l) => l.intentId)).size).toBe(landed.length);
  expect(new Set(st.landings.map((l) => l.mainAfter)).size).toBe(landed.length);
  expect(st.stats.landings).toBe(landed.length);
  for (const l of st.landings) expect(st.intents.find((i) => i.id === l.intentId)!.landedSha).toBe(l.mainAfter);

  // Landings are one after the other: each starts where the one before ended, no commit to main was
  // refused, and main commits form one line from the first commit to main now.
  expect(world.mainCommits.filter((c) => c.refused), "commits to main that the store refused").toEqual([]);
  expect(world.mainCommits).toHaveLength(st.landings.length);
  const history = [...run.audit.history].reverse(); // oldest first: the first commit, then one for each landing
  expect(history, why).toHaveLength(st.landings.length + 1);
  st.landings.forEach((l, i) => {
    expect(l.mainBefore, `landing ${i + 1} starts where landing ${i} ended`).toBe(history[i].hash);
    expect(l.mainAfter).toBe(history[i + 1].hash);
    expect(world.mainCommits[i].parent).toBe(history[i].hash);
  });
  expect(run.audit.mainSha).toBe(history.at(-1)!.hash);
  expect(st.project.mainSha).toBe(run.audit.mainSha);

  // The logbook: each landing commit has its trailers and its git note.
  for (const l of st.landings) {
    const commit = history.find((h) => h.hash === l.mainAfter)!;
    const tr = parseTrailers(commit.message);
    expect(tr["Gitring-Intent"], "trailer Gitring-Intent").toBe(l.intentId);
    expect(tr["Gitring-Attempt"], "trailer Gitring-Attempt").toBe(l.attemptId);
    expect(tr["Gitring-Method"], "trailer Gitring-Method").toBe(l.method);
    expect(tr["Gitring-Checks"], "trailer Gitring-Checks").toMatch(/^\d+\/\d+ pass$/);
    const raw = run.audit.notes.get(l.mainAfter);
    expect(raw, `git note of ${l.mainAfter.slice(0, 7)}`).toBeTruthy();
    const note = JSON.parse(raw!);
    expect(note.schema).toBe(LOGBOOK_SCHEMA);
    expect(note.intent.id).toBe(l.intentId);
    expect(note.attempt.id).toBe(l.attemptId);
    expect(note.method).toBe(l.method);
    expect(note.corrections).toHaveLength(Number(tr["Gitring-Corrections"]));
  }

  // No lost update: main holds the change of every landed task, and the tests of main pass.
  for (const r of landed) for (const f of r.task.landed) for (const text of f.has) expect(run.audit.main[f.path], `${r.task.id}: ${f.path} must hold ${text}`).toContain(text);
  expect(run.audit.finalTests, "the tests of the final main").toEqual({ ok: true, passed: s.tasks.length + 1, failed: 0 });

  if (!requests) return;

  // Change requests. A task alone gets none. Two tasks that meet (the same function, or the same place in
  // one file) get one change request while both work, to one agent. The other agent continues and gets
  // no change request from its partner. If the agent that gave way merges first, the partner then gets
  // one request about the merged change (rule R1: merged work continues).
  for (const r of results.filter((x) => x.task.group === "solo")) {
    expect(st.corrections.filter((c) => c.attemptId === r.attemptId).map((c) => c.kind), `${r.task.id} works alone${why}`).toEqual([]);
  }
  const callsignOf = (attemptId: string) => st.agents.find((g) => g.id === st.attempts.find((x) => x.id === attemptId)!.agentId)!.callsign;
  for (const pair of new Set(s.tasks.filter((t) => t.group !== "solo").map((t) => t.pair!))) {
    const [a, b] = s.tasks.filter((t) => t.pair === pair).map((t) => task(t.id));
    const ids = new Set([a.attemptId, b.attemptId]);
    const between = st.corrections
      .filter((c) => (c.kind === "region" || c.kind === "interface" || c.kind === "duplicate") && ids.has(c.attemptId) && c.standOnAttemptId && ids.has(c.standOnAttemptId))
      .sort((x, y) => x.createdAt - y.createdAt);
    const seen = between.map((c) => `${c.kind}/${c.rule}: ${callsignOf(c.attemptId)} gives way to ${callsignOf(c.standOnAttemptId!)}`);
    const whileBothWork = between.filter((c) => c.rule !== R1);
    expect(whileBothWork.map((c) => callsignOf(c.attemptId)), `${pair}: one agent gives way while both work${why}\n${seen.join("\n")}`).toHaveLength(1);
    const c = whileBothWork[0];
    expect(c.kind, pair).toBe("region");
    const standOn = st.attempts.find((x) => x.id === c.standOnAttemptId)!;
    const receiver = st.attempts.find((x) => x.id === c.attemptId)!;
    expect(["R2-waiting-stands-on", R4, "R6-smaller-gives-way"], `${pair}: rule ${c.rule}`).toContain(c.rule);
    if (c.rule === R4) expect(standOn.course.declaredAt, "the earlier plan continues").toBeLessThan(receiver.course.declaredAt);
    if (c.rule === "R2-waiting-stands-on") expect(["ready", "landed"], "the work that continues waits to merge").toContain(standOn.status);
    // After a merge: the request names merged work. The agent that gave way merged first (it was fast),
    // and its partner, which is still at work, must adapt to main.
    const order = st.landings.map((l) => l.attemptId);
    for (const late of between.filter((x) => x.rule === R1)) {
      expect(order.indexOf(late.standOnAttemptId!), `${pair}: the work that stands on is merged${why}`).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(late.attemptId), `${pair}: the agent that adapts merges after${why}`).toBeGreaterThan(order.indexOf(late.standOnAttemptId!));
      expect(late.attemptId, `${pair}: the request goes to the agent that stood on, not to the one that gave way${why}`).toBe(c.standOnAttemptId);
    }
    expect(between.length, `${pair}: at most two change requests${why}\n${seen.join("\n")}`).toBeLessThanOrEqual(2);
  }
  expect(st.corrections.filter((c) => c.status === "pending" || c.status === "delivered").map((c) => `${c.kind} ${c.status}`), `change requests that the agent did not confirm${why}`).toEqual([]);
}

/* ───────────────────────────── scenario 1: eight agents ───────────────────────────── */

describe("eight agents on a small JavaScript project", () => {
  it("lands every task, keeps every change, and keeps the rules (seed 1)", async () => {
    const run = await execute(shopFor(8), 1);
    expect(run.shop.tasks.map((t) => t.group).sort()).toEqual(["file", "file", "function", "function", "solo", "solo", "solo", "solo"]);
    checkRun(run);
  });

  it("calls the real protocol: every agent used the tools of an outside agent", async () => {
    const run = await execute(shopFor(8), 2);
    checkRun(run);
    const used = new Set(run.world.calls.map((c) => c.tool));
    for (const tool of ["gitring_intents", "gitring_declare", "gitring_read", "gitring_write", "gitring_check", "gitring_submit", "gitring_ack", "gitring_update"]) expect(used.has(tool), tool).toBe(true);
    for (const r of run.results) expect(r.trace[0], r.task.id).toBe("gitring_intents:ok");
  });
});

/* ───────────────────────────── scenario 2: 24 and 60 agents ───────────────────────────── */

describe.each([
  { agents: 24, seeds: [11, 12, 13], limitMs: 15_000 },
  { agents: 60, seeds: [21, 22, 23], limitMs: 20_000 },
])("$agents agents at once", ({ agents, seeds, limitMs }) => {
  it.each(seeds)(`lands every task (seed %i)`, async (seed) => {
    const run = await execute(shopFor(agents), seed);
    checkRun(run);
    console.log(`${agents} agents, seed ${seed}: ${run.ms} ms, ${run.world.calls.length} calls, ${run.audit.state.landings.length} landings, ${run.audit.state.corrections.length} change requests`);
    expect(run.ms, `${agents} agents took ${run.ms} ms`).toBeLessThan(limitMs);
  }, 60_000);
});

/* ───────────────────────────── scenario 3: main moves while agents work ───────────────────────────── */

/**
 * Three agents. `far` works in its own file. `mover` and `near` each add a function to the same file:
 * the plan check finds no meeting (other symbols), so nobody gets a change request when they start.
 */
async function trio(seed: number) {
  const { world, key } = await newWorld();
  const full = shop(1, 1);
  const tasks = ["solo-01", "file-01-c", "file-01-d"].map((id) => full.tasks.find((t) => t.id === id)!);
  const s: Shop = { files: full.files, tasks };
  const project = await openProject(world, key, s);
  const sched = new Scheduler(seed);
  const [far, mover, near] = tasks.map((t, i) => new ScriptedAgent(world, key, project.id, sched, t, i + 1));
  for (const a of [far, mover, near]) expect(await a.start(), a.callsign).toBeUndefined();
  for (const a of [far, mover, near]) expect(a.notices, `${a.callsign} has no change request yet`).toEqual([]);
  const finish = async (results: AgentResult[]): Promise<Run> => ({ world, key, project, shop: s, results, audit: await audit(world, project.id, project.mainRepo), ms: 0 });
  return { world, key, project, far, mover, near, path: mover.spec.files[0], finish };
}

describe("main moves while agents work", () => {
  it("tells the agent near the change, moves every work copy to the new main, and keeps both changes", async () => {
    const t = await trio(31);
    const { world, project, far, mover, near } = t;

    const moved = await mover.work();
    expect(moved.outcome).toBe("landed");
    const state = await world.harbor(project.id).state();
    const landing = state.landings[0];
    expect(state.landings).toHaveLength(1);

    // The agent near the change gets one notice with its next report: main moved. It names the mover and the file.
    // (A change request rides on the answers of declare, log, write, submit and ack.)
    await near.call("gitring_log", { message: "Reading the code." });
    expect(near.notices.map((n) => `${n.kind}<-${n.from}`)).toEqual([`upstream<-${mover.callsign}`]);
    expect(near.notices[0].message).toContain(t.path);
    expect(near.notices[0].message).toContain(mover.spec.title);
    const up = await near.call("gitring_update");
    expect(up.ok).toBe(true);
    expect(up.json.mainSha, "gitring_update brings the new main").toBe(landing.mainAfter);
    await near.ackAll();

    // The agent far from the change gets no notice. Its work copy moves to the new main anyway.
    await far.call("gitring_log", { message: "Reading the code." });
    const farUp = await far.call("gitring_update");
    expect(farUp.ok).toBe(true);
    expect(farUp.json.mainSha).toBe(landing.mainAfter);
    expect(far.notices, "no change request for the far agent").toEqual([]);
    const after = await world.harbor(project.id).state();
    for (const a of [near, far]) expect(after.attempts.find((x) => x.id === a.attemptId)!.baseSha, `${a.callsign} is on the new main`).toBe(landing.mainAfter);

    // Both finish on the new main. The file holds the change of the mover and the change of the near agent.
    const [nearRes, farRes] = await Promise.all([near.work(), far.work()]);
    const run = await t.finish([farRes, moved, nearRes]);
    checkRun(run, { requests: false });
    expect(run.audit.main[t.path]).toContain("function shout");
    expect(run.audit.main[t.path]).toContain("function whisper");
    expect(near.notices.filter((n) => n.kind === "upstream")).toHaveLength(1);
    expect(far.notices).toEqual([]);
  });

  it("refuses a write on text that main changed after the read, and accepts it on the new text", async () => {
    const t = await trio(32);
    const { world, project, far, mover, near, path } = t;

    const old = await near.call("gitring_read", { path });
    const moved = await mover.work();
    expect(moved.outcome).toBe("landed");

    // The near agent writes its change on the text that it read before main moved: both changes are at the same place.
    const w = await near.call("gitring_write", { files: [{ path, content: near.spec.edits[0].apply(old.text) }], message: "On the old text" });
    expect(w.ok).toBe(true);
    expect(w.json.written).toEqual([]);
    expect(w.json.refused).toHaveLength(1);
    expect(w.json.refused[0].path).toBe(path);
    expect(w.json.refused[0].reason).toMatch(/changed after your last read: main moved\. Read .+ again/);

    // The agent reads again, and its change goes on top of the change that main holds.
    const fresh = await near.call("gitring_read", { path });
    expect(fresh.text).toContain("function shout");
    const w2 = await near.call("gitring_write", { files: [{ path, content: near.spec.edits[0].apply(fresh.text) }], message: "On the new text" });
    expect(w2.json.refused ?? []).toEqual([]);
    expect(w2.json.written).toEqual([path]);

    const [nearRes, farRes] = await Promise.all([near.work(), far.work()]);
    const run = await t.finish([farRes, moved, nearRes]);
    checkRun(run, { requests: false });
    expect(run.audit.main[t.path]).toContain("function shout");
    expect(run.audit.main[t.path]).toContain("function whisper");
  });

  it("lands the work once when the agent submits many times at once", async () => {
    const t = await trio(33);
    const { world, far, mover, near, path } = t;
    const r = await mover.call("gitring_read", { path });
    await mover.call("gitring_write", { files: [{ path, content: mover.spec.edits[0].apply(r.text) }], message: mover.spec.title });
    expect((await mover.call("gitring_check")).ok).toBe(true);
    const answers = await Promise.all([1, 2, 3, 4].map(() => mover.call("gitring_submit", { summary: "Done" })));
    for (const a of answers) expect(a.text, "each answer is an answer, not a crash").not.toMatch(/TypeError|Cannot read|undefined/);
    expect(await mover.waitForMerge()).toBe("landed");

    const [nearRes, farRes] = await Promise.all([near.work(), far.work()]);
    const run = await t.finish([farRes, mover.done("landed", "", 1), nearRes]);
    checkRun(run, { requests: false });
    expect(run.audit.state.landings.filter((l) => l.attemptId === mover.attemptId), "the work of the mover lands once").toHaveLength(1);
    expect(world.mainCommits).toHaveLength(3);
  });
});

/* ───────────────────────────── bugs that the runs found ───────────────────────────── */

/** The two tasks that add a function to the same file, and two agents for them. */
async function filePair(seed: number, opts: WorldOptions = {}) {
  const { world, key } = await newWorld(opts);
  const full = shop(0, 1);
  const tasks = full.tasks.filter((t) => t.group === "file");
  const s: Shop = { files: full.files, tasks };
  const project = await openProject(world, key, s);
  const sched = new Scheduler(seed);
  const [a, b] = tasks.map((t, i) => new ScriptedAgent(world, key, project.id, sched, t, i + 1));
  expect(await a.start(), a.callsign).toBeUndefined();
  expect(await b.start(), b.callsign).toBeUndefined();
  return { world, key, project, s, a, b, path: a.spec.files[0] };
}

describe("bugs that the runs found", () => {
  it("lands the work once when a second submit finishes its tests after the merge (fixed)", async () => {
    // An agent sends gitring_submit again (a retry after a time-out, for example). The tests of the second
    // call take longer than the first merge. Before the fix, the second call put the work copy back to
    // "ready" after it had merged, and gitring merged the same work a second time (an empty 3-way merge
    // commit on main, and a second landing record for one work copy).
    const { world, key } = await newWorld();
    const full = shop(1, 0);
    const task = full.tasks[0];
    const s: Shop = { files: full.files, tasks: [task] };
    const project = await openProject(world, key, s);
    const agent = new ScriptedAgent(world, key, project.id, new Scheduler(1), task, 1);
    expect(await agent.start()).toBeUndefined();
    const path = task.files[0];
    const r = await agent.call("gitring_read", { path });
    await agent.call("gitring_write", { files: [{ path, content: task.edits[0].apply(r.text) }], message: task.title });
    expect((await agent.call("gitring_check")).ok).toBe(true);
    // The second call of the tests ends 400 ms later than it would.
    const h = world.harbor(project.id) as unknown as { check(id: string): Promise<unknown> };
    const check = h.check.bind(h);
    let calls = 0;
    h.check = async (id: string) => {
      const mine = ++calls;
      const run = await check(id);
      if (mine === 2) await sleep(400);
      return run;
    };
    const first = await agent.call("gitring_submit", { summary: "Done" });
    expect(first.json.next).toBe("landing-queue");
    const second = await agent.call("gitring_submit", { summary: "Done again" });
    expect(second.ok).toBe(true);
    expect(second.json.next, "the second answer says that the work is merged").toBe("landed");
    await world.settle();
    const run = await world.harbor(project.id).state();
    expect(run.landings, "one landing for one work copy").toHaveLength(1);
    expect(world.mainCommits, "one commit to main").toHaveLength(1);
    expect(run.attempts[0].status).toBe("landed");
  });

  it("keeps the work of an agent that answers while gitring gives the work back (fixed)", async () => {
    // Both agents write at the same place and submit together. The first merge goes in. The second work
    // copy cannot merge, and gitring gives it back to its agent. When the agent calls gitring while this
    // happens, the work must stay with the agent. (Before the fix: TypeError in returnToAgent; the merge
    // stopped, and the work copy stayed in "ready" for ever.)
    const { world, project, s, a, b, path } = await filePair(41);
    for (const x of [a, b]) {
      const r = await x.call("gitring_read", { path });
      await x.call("gitring_write", { files: [{ path, content: x.spec.edits[0].apply(r.text) }], message: x.spec.title });
      await x.ackAll();
    }
    // The agent answers at the moment gitring has set "given back" and waits for the store: it calls gitring_traffic.
    const h = world.harbor(project.id) as unknown as { putAttempt(at: { id: string; returned?: unknown }): void; traffic(id: string): Promise<unknown> };
    const put = h.putAttempt.bind(h);
    const hooked: string[] = [];
    h.putAttempt = (at) => {
      put(at);
      if (at.returned && !hooked.length) {
        hooked.push(at.id);
        void h.traffic(at.id).catch(() => undefined);
      }
    };
    expect((await a.call("gitring_check")).ok).toBe(true);
    expect((await b.call("gitring_check")).ok).toBe(true);
    const sent = await Promise.all([a.call("gitring_submit", { summary: "Done" }), b.call("gitring_submit", { summary: "Done" })]);
    expect(sent.map((x) => x.json?.next)).toEqual(["landing-queue", "landing-queue"]);

    await vi.waitFor(() => expect(hooked, "gitring gave one work copy back").toHaveLength(1), { timeout: 15_000, interval: 20 });
    const loser = hooked[0] === a.attemptId ? a : b;
    const winner = loser === a ? b : a;
    expect(await winner.waitForMerge()).toBe("landed");
    await world.settle();
    const mid = await world.harbor(project.id).state();
    expect(mid.attempts.find((x) => x.id === loser.attemptId)!.status, "the work is with the agent, not stuck").toBe("underway");
    expect(mid.logs.filter((l) => /stopped/.test(l.message)).map((l) => l.message)).toEqual([]);

    // The agent applies the change request and lands its change on top of the other change.
    const res = await loser.work();
    expect(res.outcome).toBe("landed");
    const run: Run = { world, key: "", project, shop: s, results: [winner.done("landed", "", 1), res], audit: await audit(world, project.id, project.mainRepo), ms: 0 };
    checkRun(run, { requests: false });
    expect(run.audit.main[path]).toContain("function shout");
    expect(run.audit.main[path]).toContain("function whisper");
  });

  // BUG (not fixed, see rules.ts): two plans with the same declaredAt (the same millisecond) give two
  // change requests, one to each agent, and each one says "give way to the other". Rule R4 (earlier plan
  // continues) cannot decide when the times are equal. Rule R6 then says "on a tie, the plan that is
  // checked now gives way", and each plan is the one that is checked at its own turn: the later plan at
  // its declare, the earlier plan at its next report. Both agents then wait for each other.
  // A Worker clock does not move while a request runs, so two declares that arrive together can read the
  // same millisecond. The other tests use a clock that never repeats a value (see World.init).
  it.fails("gives one change request, not two, when two plans have the same time", async () => {
    const { world, key } = await newWorld({ strictClock: false });
    const frozen = Date.now();
    Date.now = () => frozen;
    const full = shop(0, 1);
    const tasks = full.tasks.filter((t) => t.group === "function");
    const project = await openProject(world, key, { files: full.files, tasks });
    const sched = new Scheduler(42);
    const [a, b] = tasks.map((t, i) => new ScriptedAgent(world, key, project.id, sched, t, i + 1));
    expect(await a.start()).toBeUndefined();
    expect(await b.start()).toBeUndefined();
    await a.call("gitring_log", { message: "Reading the code." });
    await b.call("gitring_log", { message: "Reading the code." });
    const told = [a, b].filter((x) => x.notices.some((n) => n.kind === "region" && n.from));
    expect(told.map((x) => x.callsign), "one agent gives way").toHaveLength(1);
  });
});
