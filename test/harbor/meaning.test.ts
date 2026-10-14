/**
 * Approvals by meaning, rules by folder, inside the project object: a change of comments only never looks
 * risky; a rule by folder is checked when the plan comes (declare) and when the work comes (submit), with
 * plain words; a question for owners has no other answer; the settings keep the rules within bounds.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Attempt, FolderRule } from "../../src/core/types";
import { steViolations } from "../coord/ste";
import { CrashWorld } from "./crash-world";

const MIGRATION = "export const m = 1; // first migration\n";
const FILES = [
  { path: "src/a.js", text: "export const a = 1;\n" },
  { path: "migrations/001.js", text: MIGRATION },
  { path: "docs/guide.md", text: "# Guide\n" },
  { path: "infra/main.tf", text: 'resource "x" "y" {}\n' },
  { path: "tests/a.test.js", text: 'import { test, expect } from "../harness/test.js";\ntest("a", () => expect(1).toBe(1));\n' },
];

const ROBIN = { id: "u_robin", name: "Robin" };
const SAM = { id: "u_sam", name: "Sam" };
const OWNER = { ...ROBIN, role: "owner" as const };
const MEMBER = { ...SAM, role: "member" as const };
const human = (p: { id: string; name: string }) => ({ kind: "human" as const, ...p });

let world: CrashWorld;

async function start(settings: Record<string, unknown> = {}) {
  world = new CrashWorld();
  await world.start({ files: FILES, settings });
}

/** A person's agent sends a plan for these files. */
async function plan(by: { id: string; name: string }, files: string[], title = `Change ${files[0]}`) {
  return world.harbor.declare({ agent: { client: "test" }, newIntent: { title, goal: `${title}.` }, plan: ["Change the files"], files, symbols: [], approach: "Edit.", by: human(by) });
}

/** A person's agent plans, writes and submits. */
async function work(by: { id: string; name: string }, files: Record<string, string>, planned = Object.keys(files)) {
  const d = await plan(by, planned);
  await world.harbor.write({ attemptId: d.attemptId, files: Object.entries(files).map(([path, content]) => ({ path, content })) });
  const res = await world.harbor.submit(d.attemptId, "Done");
  return { ...res, attemptId: d.attemptId, rules: d.rules };
}

const attemptOf = (id: string): Attempt => world.inner.attempts.get(id)!;

afterEach(async () => {
  await world?.settle();
});

describe("approvals by meaning", () => {
  it("merges a change of comments only in a build folder without a question, and says the kind", async () => {
    await start({ landing: "risky" });
    const res = await work(ROBIN, { "migrations/001.js": MIGRATION.replace("first migration", "the first migration") });
    expect(res.next).toBe("landing-queue");
    expect(attemptOf(res.attemptId).meaning).toEqual({ kind: "comment-only", files: { "migrations/001.js": "comment-only" } });
    const st = await world.harbor.status(res.attemptId);
    expect(st.line).toMatch(/^1 file, \+1 -1\. .*Only comments change\.$/);
    expect(steViolations(st.line)).toEqual([]);
    await world.settle();
    expect(world.status(res.attemptId)).toBe("landed");
  });

  it("asks a person for a change of the code logic in a build folder, and the card says the kind", async () => {
    await start({ landing: "risky" });
    const res = await work(ROBIN, { "migrations/001.js": MIGRATION.replace("m = 1", "m = 2") });
    expect(res.next).toBe("awaiting-approval");
    expect(res.approval).toMatchObject({ reason: "looks-risky", approver: ROBIN });
    expect(res.approval!.why).toEqual(["Build or deploy files change: migrations/001.js."]);
    expect(attemptOf(res.attemptId).meaning?.kind).toBe("logic");
    const [item] = await world.harbor.inbox(OWNER);
    expect(item.line).toMatch(/The code logic changes\.$/);
    expect(item.why).toEqual(res.approval!.why);
  });

  it("sees white space, documentation and tests for what they are", async () => {
    await start({ landing: "risky" });
    const space = await work(ROBIN, { "src/a.js": "export const a  =  1;\n" });
    expect(attemptOf(space.attemptId).meaning?.kind).toBe("formatting-only");
    const docs = await work(ROBIN, { "docs/guide.md": "# Guide\n\nMore.\n" });
    expect(attemptOf(docs.attemptId).meaning?.kind).toBe("docs-only");
    const tests = await work(ROBIN, { "tests/b.test.js": 'import { test, expect } from "../harness/test.js";\ntest("b", () => expect(2).toBe(2));\n' });
    expect(attemptOf(tests.attemptId).meaning?.kind).toBe("test-only");
  });
});

describe("rules by folder", () => {
  const RULES: FolderRule[] = [
    { pattern: "migrations/**", rule: "owner-yes" },
    { pattern: "docs/**", rule: "no-yes" },
    { pattern: "infra/**", rule: "members", members: [ROBIN] },
  ];

  it("tells the agent with the plan that a folder needs the yes of an owner", async () => {
    await start({ landing: "automatic", folderRules: RULES });
    const d = await plan(SAM, ["migrations/002.js", "src/a.js"]);
    expect(d.rules).toEqual(["This plan touches migrations/**: a change there needs the yes of an owner."]);
    for (const s of d.rules!) expect(steViolations(s)).toEqual([]);
    expect((await plan(SAM, ["src/a.js"])).rules).toBeUndefined();
    expect((await plan(SAM, ["docs/guide.md"])).rules).toEqual(["Every file of this plan is under a rule that needs no yes of a person."]);
  });

  it("asks an owner for work in such a folder, in automatic mode, and no member can answer", async () => {
    await start({ landing: "automatic", folderRules: RULES });
    const res = await work(SAM, { "migrations/002.js": "export const m2 = 1;\n" });
    expect(res.next).toBe("awaiting-approval");
    expect(res.approval).toMatchObject({ status: "waiting", reason: "folder-rule", ownerOnly: true });
    expect(res.approval!.approver).toBeUndefined();
    expect(res.approval!.why).toEqual(["A rule by folder: a change in migrations/** needs the yes of an owner. Files: migrations/002.js."]);
    expect(res.message).toBe("All tests pass. An owner of the project must say yes before this merges.");
    expect(steViolations(res.message)).toEqual([]);

    // The sender is a member: not in the inbox, and no answer counts.
    expect(await world.harbor.inbox(MEMBER)).toEqual([]);
    const refused = await world.harbor.decide(res.attemptId, { answer: "approve" }, MEMBER);
    expect(refused.outcome).toBe("refused");
    expect(refused.message).toBe("Only an owner of the project can answer this.");
    expect(world.status(res.attemptId)).toBe("ready");

    // An owner sees it and says yes: the work merges.
    const [item] = await world.harbor.inbox(OWNER);
    expect(item).toMatchObject({ kind: "approval", attemptId: res.attemptId, why: res.approval!.why });
    expect((await world.harbor.decide(res.attemptId, { answer: "approve" }, OWNER)).outcome).toBe("approved");
    await world.settle();
    expect(world.status(res.attemptId)).toBe("landed");
  });

  it("refuses the plan of another person's agent for a folder of named members, and accepts theirs", async () => {
    await start({ landing: "automatic", folderRules: RULES });
    await expect(plan(SAM, ["infra/main.tf"])).rejects.toThrow("This plan touches infra/**. Only the agents of Robin may change it. Change the plan, or ask an owner of the project.");
    const d = await plan(ROBIN, ["infra/main.tf"]);
    expect(d.rules).toBeUndefined();
    // A plan without a person behind it is refused too.
    await expect(world.harbor.declare({ agent: { client: "test" }, newIntent: { title: "Infra", goal: "Infra." }, plan: [], files: ["infra/main.tf"], symbols: [], approach: "Edit." })).rejects.toThrow(/Only the agents of Robin may change it/);
  });

  it("asks an owner when work changed such a folder anyway", async () => {
    await start({ landing: "automatic", folderRules: RULES });
    const res = await work(SAM, { "infra/main.tf": 'resource "x" "z" {}\n' }, ["src/a.js"]);
    expect(res.next).toBe("awaiting-approval");
    expect(res.approval).toMatchObject({ reason: "folder-rule", ownerOnly: true });
    expect(res.approval!.why).toEqual(["A rule by folder: only the agents of Robin may change infra/**. An owner must say yes to this work. Files: infra/main.tf."]);
    const robin = await work(ROBIN, { "infra/main.tf": 'resource "x" "w" {}\n' });
    expect(robin.next).toBe("landing-queue");
  });

  it("does not let a member merge work under a rule for owners with the merge button", async () => {
    await start({ landing: "automatic", folderRules: RULES });
    const d = await plan(SAM, ["src/a.js"]);
    await world.harbor.write({ attemptId: d.attemptId, files: [{ path: "infra/main.tf", content: 'resource "x" "z" {}\n' }] });
    const refused = await world.harbor.land(d.attemptId, "Merge it", human(SAM), "member");
    expect(refused).toMatchObject({ refused: true, message: "A rule by folder needs the yes of an owner for this work. An owner must merge it." });
    expect(steViolations(refused.message)).toEqual([]);
    expect(world.status(d.attemptId)).not.toBe("landed");
    const ok = await world.harbor.land(d.attemptId, "Merge it", human(ROBIN), "owner");
    expect(ok.refused).toBeUndefined();
  });

  it("needs no yes for work under a no-yes rule, also when the project asks before every merge", async () => {
    await start({ landing: "ask", folderRules: RULES });
    const docs = await work(SAM, { "docs/guide.md": "# Guide\n\nMore.\n" });
    expect(docs.next).toBe("landing-queue");
    await world.settle();
    expect(world.status(docs.attemptId)).toBe("landed");
    // Docs and code together: the project asks, as before.
    const mixed = await work(SAM, { "docs/guide.md": "# Guide!\n", "src/a.js": "export const a = 2;\n" });
    expect(mixed.next).toBe("awaiting-approval");
    expect(mixed.approval).toMatchObject({ reason: "project-asks", approver: SAM });
  });

  it("keeps the rules of a settings patch within bounds", async () => {
    await start();
    const saved = await world.harbor.updateSettings({
      folderRules: [{ pattern: " migrations/** ", rule: "owner-yes" }, { pattern: "", rule: "no-yes" }, { pattern: "x/**", rule: "anyone" }, { pattern: "infra/**", rule: "members", members: [ROBIN, ROBIN] }] as unknown as FolderRule[],
    });
    const want = [
      { pattern: "migrations/**", rule: "owner-yes" },
      { pattern: "infra/**", rule: "members", members: [ROBIN] },
    ];
    expect(saved.folderRules).toEqual(want);
    expect((await world.harbor.state()).project.settings.folderRules).toEqual(want);
    // A patch without rules keeps them; an empty list clears them.
    await world.harbor.updateSettings({ landing: "ask" });
    expect((await world.harbor.settings()).folderRules).toEqual(want);
    await world.harbor.updateSettings({ folderRules: [] });
    expect((await world.harbor.settings()).folderRules).toEqual([]);
  });
});
