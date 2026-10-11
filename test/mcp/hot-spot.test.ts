/**
 * Many agents edit the same lines of one file at the same time. Each agent that must give way gets ONE change
 * request for those lines. The request names the work copy that continues, and says how many more continue.
 * It does not repeat the same advice once for each rival (that would be 19 change requests for 20 agents).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { steViolations } from "../coord/ste";
import { World } from "../github/harness";
import { callTool, makeProject } from "./support";

const NOTES = "one\ntwo\nthree\nfour\nfive\n";
const lineTwo = (k: number) => `one\nLINE ${k}\nthree\nfour\nfive\n`;

let world: World;
let key: string;
let project: string;

beforeEach(async () => {
  world = new World();
  vi.stubGlobal("fetch", world.fetch);
  await world.init();
  world.person("alice", 1);
  ({ key } = await world.signIn("alice"));
  project = await makeProject(world, key, "hot");
  await world.land(project, "notes.md", NOTES);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await world.settle();
});

const gr = (name: string, args: Record<string, unknown>) => callTool(world, key, name, { project, ...args });

/** Tasks that have nothing in common but the file, so gitring does not take them for one task. */
const TASKS = [
  { title: "Correct the greeting", goal: "The greeting uses the name of the customer." },
  { title: "Add a warning about taxes", goal: "Prices show that taxes are not included." },
  { title: "Translate the footer to French", goal: "French readers get a footer in their language." },
  { title: "Shorten the legal notice", goal: "The legal notice fits on one screen." },
  { title: "Link the privacy page", goal: "Every page links to the privacy page." },
];

/** An agent that declares a plan on notes.md and writes line 2. Answers the work copy id and the answer of the write. */
async function agent(k: number): Promise<{ id: string; wrote: string }> {
  const t = TASKS[k - 1];
  const plan = await gr("gitring_declare", { newIntent: { title: t.title, goal: t.goal }, plan: [`Change line 2 to LINE ${k}.`], files: ["notes.md"], symbols: [], approach: "Edit one line." });
  const id = /work copy (a_\w+)/.exec(plan.text)?.[1] ?? "";
  expect(id, plan.text).not.toBe("");
  const wrote = await gr("gitring_write", { attemptId: id, files: [{ path: "notes.md", content: lineTwo(k) }] });
  expect(wrote.isError, wrote.text).toBe(false);
  return { id, wrote: wrote.text };
}

async function stateOf() {
  const res = await world.call("GET", `/api/projects/${project}/state`, { key });
  expect(res.status, res.text).toBe(200);
  return res.json as { corrections: { id: string; attemptId: string; standOnAttemptId?: string; alsoStandOn?: string[]; kind: string; status: string; message: string }[] };
}

describe("one hot spot, one change request", () => {
  it("gives each later agent one change request for the same lines, and counts the other agents in it", async () => {
    const agents: { id: string; wrote: string }[] = [];
    for (let k = 1; k <= 4; k++) agents.push(await agent(k));

    const { corrections } = await stateOf();
    const live = (id: string) => corrections.filter((c) => c.attemptId === id && c.kind === "region" && c.status !== "superseded");
    expect(live(agents[0].id), "the first agent continues: no change request").toHaveLength(0);
    for (let i = 1; i < 4; i++) expect(live(agents[i].id), `agent ${i + 1} gets one change request for line 2`).toHaveLength(1);

    // The request of agent 4 names one work copy and counts the two others.
    const last = live(agents[3].id)[0];
    const rivals = agents.slice(0, 3).map((a) => a.id).sort();
    expect([last.standOnAttemptId, ...(last.alsoStandOn ?? [])].sort(), "all three rivals are in the one request").toEqual(rivals);
    expect(last.alsoStandOn).toHaveLength(2);
    // The request names the rival that was declared last. An agent that waits for that one stands in a row behind the others:
    // if every agent waited for the first one, all would wake up together and meet again.
    expect(last.standOnAttemptId, "the request names the rival that was declared last").toBe(agents[2].id);
    const live3 = live(agents[2].id)[0];
    expect(live3.standOnAttemptId, "agent 3 waits for agent 2").toBe(agents[1].id);
    expect(live3.alsoStandOn).toEqual([agents[0].id]);
    expect(last.message).toMatch(/edits line 2 of notes\.md\. Your edits overlap this line\./);

    // The agent reads the same in its answer: one line, with the count.
    const requests = agents[3].wrote.split("\n").filter((l) => l.startsWith("- [cr_"));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("(same lines; ");
    expect(requests[0]).toContain(" and 2 more continue)");
    expect(steViolations(requests[0].replace(/^- \[[^\]]+\] \([^)]*\) /, ""))).toEqual([]);
  });

  it("keeps two places apart: a rival that edits other lines gets its own change request", async () => {
    // A long file, so that line 2 and line 10 are far apart.
    const text = (edit: Record<number, string> = {}) => `${Array.from({ length: 12 }, (_, i) => edit[i + 1] ?? `l${i + 1}`).join("\n")}\n`;
    await world.land(project, "long.md", text());
    const declare = async (t: (typeof TASKS)[number], lines: number[]) => {
      const plan = await gr("gitring_declare", { newIntent: { title: t.title, goal: t.goal }, plan: [`Change lines ${lines.join(" and ")}.`], files: ["long.md"], symbols: [], approach: "Edit lines." });
      const id = /work copy (a_\w+)/.exec(plan.text)?.[1] ?? "";
      expect(id, plan.text).not.toBe("");
      const edit = Object.fromEntries(lines.map((n) => [n, `${t.title} ${n}`]));
      const wrote = await gr("gitring_write", { attemptId: id, files: [{ path: "long.md", content: text(edit) }] });
      expect(wrote.isError, wrote.text).toBe(false);
      return id;
    };
    const a = await declare(TASKS[0], [2]);
    const b = await declare(TASKS[1], [10]);
    const c = await declare(TASKS[2], [2, 10]);
    const { corrections } = await stateOf();
    const live = (id: string) => corrections.filter((x) => x.attemptId === id && x.kind === "region" && x.status !== "superseded");
    expect(live(a), "line 2 and line 10 are far apart: a and b do not meet").toHaveLength(0);
    expect(live(b)).toHaveLength(0);
    const forC = live(c);
    expect(forC, "c meets a at line 2 and b at line 10: two places, two change requests").toHaveLength(2);
    expect(forC.map((x) => x.standOnAttemptId).sort()).toEqual([a, b].sort());
    expect(forC.every((x) => !x.alsoStandOn?.length), "no rival joins a request about another place").toBe(true);
  });
});
