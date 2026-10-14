/**
 * Rules by folder (src/core/coord/folder-rules.ts): the path patterns, the safe bounds of a settings patch,
 * what the rules say about the files of a plan or of the work, and the plain words for people and agents.
 */
import { describe, expect, it } from "vitest";
import { MAX_FOLDER_RULES, MAX_RULE_MEMBERS, checkFolderRules, matchesPattern, planNotes, planRefusal, ruleReasons, rulesFor, sanitizeFolderRules } from "../../src/core/coord/folder-rules";
import type { FolderRule } from "../../src/core/types";
import { steViolations } from "../coord/ste";

const ROBIN = { id: "u_robin", name: "Robin" };
const SAM = { id: "u_sam", name: "Sam" };

const RULES: FolderRule[] = [
  { pattern: "migrations/**", rule: "owner-yes" },
  { pattern: "docs/**", rule: "no-yes" },
  { pattern: "infra/**", rule: "members", members: [ROBIN, SAM] },
];

describe("matchesPattern", () => {
  it("matches a folder and all in it with **", () => {
    expect(matchesPattern("migrations/**", "migrations/001.sql")).toBe(true);
    expect(matchesPattern("migrations/**", "migrations/2026/001.sql")).toBe(true);
    expect(matchesPattern("migrations/**", "src/migrations/001.sql")).toBe(false);
    expect(matchesPattern("migrations/**", "migrations.sql")).toBe(false);
  });

  it("matches one name part with *, and one character with ?", () => {
    expect(matchesPattern("docs/*.md", "docs/guide.md")).toBe(true);
    expect(matchesPattern("docs/*.md", "docs/api/guide.md")).toBe(false);
    expect(matchesPattern("src/**/*.test.js", "src/a/b/c.test.js")).toBe(true);
    expect(matchesPattern("src/**/*.test.js", "src/c.test.js")).toBe(true);
    expect(matchesPattern("src/a?.js", "src/a1.js")).toBe(true);
    expect(matchesPattern("src/a?.js", "src/a12.js")).toBe(false);
  });

  it("matches a name without a slash at any depth, a folder name with all in it", () => {
    expect(matchesPattern("*.sql", "db/x.sql")).toBe(true);
    expect(matchesPattern("*.sql", "x.sql")).toBe(true);
    expect(matchesPattern("*.sql", "x.sqlite")).toBe(false);
    expect(matchesPattern("migrations", "db/migrations/001.sql")).toBe(true);
    expect(matchesPattern("migrations", "db/migrations")).toBe(true);
    expect(matchesPattern("migrations", "db/migrationsx/a")).toBe(false);
  });

  it("reads a pattern that ends in a slash as the folder and all in it, and ignores a leading ./", () => {
    expect(matchesPattern("migrations/", "migrations/001.sql")).toBe(true);
    expect(matchesPattern("./migrations/**", "migrations/001.sql")).toBe(true);
    expect(matchesPattern("/migrations/**", "migrations/001.sql")).toBe(true);
  });

  it("treats the other characters of a path as text", () => {
    expect(matchesPattern("src/a.b.js", "src/aXb.js")).toBe(false);
    expect(matchesPattern("src/(x)/**", "src/(x)/y.js")).toBe(true);
    expect(matchesPattern("", "a")).toBe(false);
  });

  it("lists the rules of a path in their order", () => {
    expect(rulesFor(RULES, "migrations/1.sql").map((r) => r.rule)).toEqual(["owner-yes"]);
    expect(rulesFor(RULES, "src/a.js")).toEqual([]);
  });
});

describe("sanitizeFolderRules", () => {
  it("keeps good rules, trims patterns and drops the rest", () => {
    const out = sanitizeFolderRules([
      { pattern: "  migrations/** ", rule: "owner-yes" },
      { pattern: "docs/**", rule: "no-yes" },
      { pattern: "infra/**", rule: "members", members: [ROBIN, { id: "u_sam", name: "" }, ROBIN, { name: "no id" }] },
      { pattern: "", rule: "owner-yes" },
      { pattern: "x/**", rule: "anyone" },
      "not a rule",
      null,
    ]);
    expect(out).toEqual([
      { pattern: "migrations/**", rule: "owner-yes" },
      { pattern: "docs/**", rule: "no-yes" },
      { pattern: "infra/**", rule: "members", members: [ROBIN, { id: "u_sam", name: "u_sam" }] },
    ]);
  });

  it("holds the counts and the lengths within bounds", () => {
    const many = Array.from({ length: MAX_FOLDER_RULES + 5 }, (_, n) => ({ pattern: `f${n}/**`, rule: "owner-yes" }));
    expect(sanitizeFolderRules(many)).toHaveLength(MAX_FOLDER_RULES);
    const people = Array.from({ length: MAX_RULE_MEMBERS + 5 }, (_, n) => ({ id: `u${n}`, name: `P${n}` }));
    const [rule] = sanitizeFolderRules([{ pattern: "infra/**", rule: "members", members: people }]);
    expect(rule.rule === "members" && rule.members).toHaveLength(MAX_RULE_MEMBERS);
    expect(sanitizeFolderRules([{ pattern: "a".repeat(400), rule: "no-yes" }])[0].pattern).toHaveLength(200);
    expect(sanitizeFolderRules("nope")).toEqual([]);
  });
});

describe("checkFolderRules", () => {
  it("says nothing about files that no rule holds", () => {
    const v = checkFolderRules(RULES, ["src/a.js", "tests/a.test.js"], ROBIN.id);
    expect(v).toEqual({ ownerYes: [], notAllowed: [], noYes: false, none: true });
    expect(ruleReasons(v)).toEqual([]);
    expect(planNotes(v)).toEqual([]);
    expect(planRefusal(v)).toBeNull();
  });

  it("names the rules that need the yes of an owner, with their files", () => {
    const v = checkFolderRules(RULES, ["migrations/001.sql", "migrations/002.sql", "src/a.js"], ROBIN.id);
    expect(v.ownerYes).toEqual([{ pattern: "migrations/**", paths: ["migrations/001.sql", "migrations/002.sql"] }]);
    expect(v.noYes).toBe(false);
    expect(v.none).toBe(false);
    expect(ruleReasons(v)).toEqual(["A rule by folder: a change in migrations/** needs the yes of an owner. Files: migrations/001.sql, migrations/002.sql."]);
    expect(planNotes(v)).toEqual(["This plan touches migrations/**: a change there needs the yes of an owner."]);
  });

  it("lets the named members change a folder, and holds everybody else", () => {
    expect(checkFolderRules(RULES, ["infra/main.tf"], SAM.id).notAllowed).toEqual([]);
    const v = checkFolderRules(RULES, ["infra/main.tf"], "u_kim");
    expect(v.notAllowed).toEqual([{ pattern: "infra/**", paths: ["infra/main.tf"], members: [ROBIN, SAM] }]);
    expect(planRefusal(v)).toBe("This plan touches infra/**. Only the agents of Robin and Sam may change it. Change the plan, or ask an owner of the project.");
    expect(ruleReasons(v)).toEqual(["A rule by folder: only the agents of Robin and Sam may change infra/**. An owner must say yes to this work. Files: infra/main.tf."]);
    // No person sent the agent: the rule does not allow the change.
    expect(checkFolderRules(RULES, ["infra/main.tf"]).notAllowed).toHaveLength(1);
  });

  it("says that no yes is needed only when every file is under such a rule and no other rule holds one", () => {
    expect(checkFolderRules(RULES, ["docs/a.md", "docs/b/c.md"], ROBIN.id).noYes).toBe(true);
    expect(checkFolderRules(RULES, ["docs/a.md", "src/a.js"], ROBIN.id).noYes).toBe(false);
    expect(checkFolderRules(RULES, [], ROBIN.id).noYes).toBe(false);
    // A file under "no yes" and under "an owner says yes": the owner's yes wins.
    const both: FolderRule[] = [{ pattern: "docs/**", rule: "no-yes" }, { pattern: "**/*.md", rule: "owner-yes" }];
    const v = checkFolderRules(both, ["docs/a.md"], ROBIN.id);
    expect(v.noYes).toBe(false);
    expect(v.ownerYes).toHaveLength(1);
    expect(planNotes(checkFolderRules(RULES, ["docs/a.md"], ROBIN.id))).toEqual(["Every file of this plan is under a rule that needs no yes of a person."]);
  });

  it("names up to three files, then counts the rest", () => {
    const v = checkFolderRules(RULES, ["migrations/1", "migrations/2", "migrations/3", "migrations/4", "migrations/5"], ROBIN.id);
    expect(ruleReasons(v)[0]).toContain("Files: migrations/1, migrations/2, migrations/3 and 2 more.");
  });

  it("uses plain words in every sentence", () => {
    const v = checkFolderRules(RULES, ["migrations/001.sql", "infra/main.tf", "docs/a.md"], "u_kim");
    for (const s of [...ruleReasons(v), ...planNotes(v), planRefusal(v)!]) expect(steViolations(s), s).toEqual([]);
    const names: FolderRule[] = [{ pattern: "infra/**", rule: "members", members: [ROBIN, SAM, { id: "u_kim", name: "Kim" }] }];
    expect(planRefusal(checkFolderRules(names, ["infra/a"], "u_x"))).toContain("Only the agents of Robin, Sam and Kim may change it.");
    expect(planRefusal(checkFolderRules([{ pattern: "infra/**", rule: "members", members: [ROBIN] }], ["infra/a"], "u_x"))).toContain("Only the agents of Robin may change it.");
  });
});
