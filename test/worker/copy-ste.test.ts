/**
 * Plain words (ASD-STE100) in the messages that the server shows to people and agents, and in the plugin skill.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyProblems } from "../coord/copy-scan";
import { steViolations } from "../coord/ste";

const SERVER = [
  "src/worker/mcp-projects.ts",
  "src/worker/projects.ts",
  "src/worker/mcp-history.ts",
  "src/worker/history-routes.ts",
  "src/worker/mcp.ts",
  "src/worker/mcp-kit.ts",
  "src/worker/mcp-approval.ts",
  "src/worker/mcp-github.ts",
  // The GitHub-compatible tools live in these files since mcp-github.ts was split.
  "src/worker/github-tools/shared.ts",
  "src/worker/github-tools/branches.ts",
  "src/worker/github-tools/pulls.ts",
  "src/worker/github-tools/tools-issues.ts",
  "src/worker/github-tools/tools-pulls.ts",
  "src/worker/github-tools/tools-read.ts",
  "src/worker/github-tools/tools-write.ts",
];

describe("plain words in the server messages", () => {
  for (const file of SERVER) {
    it(`${file} has no "-ing" forms and no long sentences`, () => {
      expect(copyProblems(file)).toEqual([]);
    });
  }
});

describe("the plugin skill", () => {
  const prose = readFileSync("plugins/gitring/skills/gitring/SKILL.md", "utf8")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^---[\s\S]*?---/, " ")
    .replace(/`[^`]*`/g, " ")
    .split("\n")
    .map((l) => l.replace(/^[\s>*#-]+|^\d+\.\s+/, "").replace(/\*\*/g, "").trim())
    .filter((l) => /\s/.test(l) && !l.startsWith("|"));

  it("has prose to check", () => {
    expect(prose.length).toBeGreaterThan(10);
  });

  it("has no GitHub-first wording", () => {
    expect(prose.join(" ")).not.toMatch(/pick a repository from github|github (sign-in|account) (first|is required)/i);
  });

  it("uses plain words in every sentence", () => {
    const problems = prose.flatMap((l) => steViolations(l).map((p) => `${p}`));
    expect(problems).toEqual([]);
  });
});
