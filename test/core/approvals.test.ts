/**
 * Approvals by meaning and by folder (src/core/approvals.ts): a change of comments, white space or
 * documentation only shows no sign of risk; a rule by folder makes the question one for owners; the line
 * of a card says what kind of change it is.
 */
import { describe, expect, it } from "vitest";
import { approvalLine, approvalNeeded, canDecide, riskSigns } from "../../src/core/approvals";
import { checkFolderRules } from "../../src/core/coord/folder-rules";
import type { Attempt, ChangeKind, CheckRun, FileTouch, FolderRule } from "../../src/core/types";
import { steViolations } from "../coord/ste";

const touch = (status: FileTouch["status"]): FileTouch => ({ status, hunks: [], additions: 1, deletions: 0 });
const run = (over: Partial<CheckRun> = {}): CheckRun => ({ id: "c1", subject: "s", scope: "attempt", ok: true, passed: 12, failed: 0, cases: [], ms: 1, at: 1, ran: 12, ...over });

/** A large change of a build file with a changed signature: three signs of risk, when the kind does not say otherwise. */
function risky(kind?: ChangeKind): Pick<Attempt, "footprint" | "stats" | "meaning"> {
  return {
    footprint: {
      files: { "package.json": touch("M"), "src/a.js": touch("M") },
      symbols: { defined: [], modified: [], removed: [], signatureChanged: ["src/a.js#price"], referenced: [] },
      computedAt: 1,
    },
    stats: { filesChanged: 2, additions: 700, deletions: 10, steps: 1 },
    ...(kind ? { meaning: { kind, files: { "package.json": kind, "src/a.js": kind } } } : {}),
  };
}

const ROBIN = { id: "u_robin", name: "Robin" };
const RULES: FolderRule[] = [
  { pattern: "migrations/**", rule: "owner-yes" },
  { pattern: "docs/**", rule: "no-yes" },
  { pattern: "infra/**", rule: "members", members: [ROBIN] },
];

describe("riskSigns by meaning", () => {
  it("shows no sign for a change of comments, white space or documentation only", () => {
    expect(riskSigns(risky()).length).toBe(3);
    expect(riskSigns(risky("logic")).length).toBe(3);
    expect(riskSigns(risky("test-only")).length).toBe(3);
    for (const kind of ["comment-only", "formatting-only", "docs-only"] as const) expect(riskSigns(risky(kind)), kind).toEqual([]);
  });
});

describe("approvalNeeded with rules by folder", () => {
  it("asks an owner when a rule says so, in every mode, and names the rule", () => {
    const rules = checkFolderRules(RULES, ["migrations/001.sql"], ROBIN.id);
    for (const mode of ["automatic", "risky", "ask"] as const) {
      const need = approvalNeeded({ mode, untested: false, competing: 0, signs: [], rules })!;
      expect(need.reason, mode).toBe("folder-rule");
      expect(need.ownerOnly, mode).toBe(true);
      expect(need.why[0], mode).toBe("A rule by folder: a change in migrations/** needs the yes of an owner. Files: migrations/001.sql.");
    }
    const ask = approvalNeeded({ mode: "ask", untested: false, competing: 0, signs: [], rules })!;
    expect(ask.why).toEqual(["A rule by folder: a change in migrations/** needs the yes of an owner. Files: migrations/001.sql.", "This project asks a person before every merge."]);
  });

  it("asks an owner for work that changed a folder of other people's agents", () => {
    const rules = checkFolderRules(RULES, ["infra/main.tf"], "u_sam");
    const need = approvalNeeded({ mode: "automatic", untested: false, competing: 0, signs: [], rules })!;
    expect(need).toMatchObject({ reason: "folder-rule", ownerOnly: true });
    expect(need.why).toEqual(["A rule by folder: only the agents of Robin may change infra/**. An owner must say yes to this work. Files: infra/main.tf."]);
    expect(approvalNeeded({ mode: "automatic", untested: false, competing: 0, signs: [], rules: checkFolderRules(RULES, ["infra/main.tf"], ROBIN.id) })).toBeNull();
  });

  it("skips the question of the setting and of a missing test for work under a no-yes rule", () => {
    const rules = checkFolderRules(RULES, ["docs/guide.md"], ROBIN.id);
    expect(approvalNeeded({ mode: "ask", untested: true, competing: 0, signs: ["A sign."], rules })).toBeNull();
    expect(approvalNeeded({ mode: "risky", untested: false, competing: 0, signs: ["A sign."], rules })).toBeNull();
    // Competing work copies still need a person.
    const need = approvalNeeded({ mode: "ask", untested: true, competing: 1, signs: [], rules })!;
    expect(need.reason).toBe("competing");
    expect(need.why).toEqual(["2 work copies compete on this task. A person chooses one."]);
    expect(need.ownerOnly).toBeUndefined();
  });

  it("keeps the old answers when no rule holds the files", () => {
    const rules = checkFolderRules(RULES, ["src/a.js"], ROBIN.id);
    expect(approvalNeeded({ mode: "automatic", untested: false, competing: 0, signs: [], rules })).toBeNull();
    expect(approvalNeeded({ mode: "ask", untested: false, competing: 0, signs: [], rules })).toMatchObject({ reason: "project-asks" });
    expect(approvalNeeded({ mode: "risky", untested: false, competing: 0, signs: ["A sign."], rules })).toMatchObject({ reason: "looks-risky", why: ["A sign."] });
    expect(approvalNeeded({ mode: "automatic", untested: true, competing: 0, signs: [], rules })).toMatchObject({ reason: "no-test-ran" });
  });

  it("puts a missing test before a rule in the main reason, and keeps both in why", () => {
    const rules = checkFolderRules(RULES, ["migrations/001.sql"], ROBIN.id);
    const need = approvalNeeded({ mode: "automatic", untested: true, competing: 0, signs: [], rules })!;
    expect(need.reason).toBe("no-test-ran");
    expect(need.ownerOnly).toBe(true);
    expect(need.why).toHaveLength(2);
    for (const w of need.why) expect(steViolations(w), w).toEqual([]);
  });
});

describe("canDecide for owners only", () => {
  it("lets no member answer a question for owners, not even the sender", () => {
    const ap = { approver: undefined, ownerOnly: true };
    expect(canDecide(ap, { id: ROBIN.id, role: "member" })).toBe(false);
    expect(canDecide(ap, { id: "u_sam", role: "member" })).toBe(false);
    expect(canDecide(ap, { id: "u_kim", role: "owner" })).toBe(true);
    expect(canDecide(ap, { id: "u_eve", role: "viewer" })).toBe(false);
    // Without the mark, the old rules hold.
    expect(canDecide({ approver: ROBIN }, { id: ROBIN.id, role: "member" })).toBe(true);
  });
});

describe("approvalLine with the kind of change", () => {
  it("says the kind of change after the size and the tests", () => {
    const base = { stats: { filesChanged: 2, additions: 9, deletions: 1, steps: 3 }, checks: run() };
    expect(approvalLine(base)).toBe("2 files, +9 -1. 12 of 12 tests pass.");
    expect(approvalLine({ ...base, meaning: { kind: "comment-only", files: {} } })).toBe("2 files, +9 -1. 12 of 12 tests pass. Only comments change.");
    expect(approvalLine({ ...base, meaning: { kind: "logic", files: {} } })).toBe("2 files, +9 -1. 12 of 12 tests pass. The code logic changes.");
    // No changed file: nothing to say about the kind.
    expect(approvalLine({ ...base, stats: { ...base.stats, filesChanged: 0 }, meaning: { kind: "formatting-only", files: {} } })).toBe("0 files, +9 -1. 12 of 12 tests pass.");
  });
});
