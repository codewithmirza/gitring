/**
 * The first minute of a person: the start page, the Projects page and its cards. The words are plain (ASD-STE100), and no host name,
 * protocol or code name shows before the person has made a project. Pure words only: the pictures are in tmp/shots.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyProblems, proseOfFile } from "../coord/copy-scan";
import { steViolations } from "../coord/ste";
import { NOTHING_WAITS, canAnswerHere, cardFacts, sourceLine, waitingByProject, waitsText } from "../../web/src/views/projects/card-text";
import type { InboxItem } from "../../web/src/state/inbox";
import type { ProjectInfo } from "../../src/core/accounts";

const FILES = [
  "web/src/views/HomeView.tsx",
  "web/src/views/ProjectsView.tsx",
  "web/src/views/projects/ProjectCard.tsx",
  "web/src/views/projects/WaitingQuestion.tsx",
  "web/src/views/projects/card-text.ts",
  "web/src/views/home/HeroMap.tsx",
  "web/src/views/newproject/RepoRow.tsx",
];

const project = (patch: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({ id: "p1", name: "corner-shop", visibility: "private", role: "owner", ownerName: "Mirza", createdAt: Date.now() - 7 * 60_000, source: { kind: "empty" }, ...patch }) as ProjectInfo;

describe("the words of the first minute", () => {
  for (const file of FILES) {
    it(`${file} has no "-ing" forms and no long sentences`, () => {
      expect(copyProblems(file)).toEqual([]);
    });
  }

  it("names no host and no protocol on the start page and the Projects page", () => {
    for (const file of ["web/src/views/ProjectsView.tsx", "web/src/views/projects/ProjectCard.tsx", "web/src/views/home/HeroMap.tsx"]) {
      expect(proseOfFile(file).join(" "), file).not.toMatch(/Cloudflare|Artifacts|MCP|OAuth|3-way/);
    }
    const home = proseOfFile("web/src/views/HomeView.tsx")
      .filter((t) => !/Codex app|Built on Cloudflare/.test(t))
      .join(" ");
    expect(home).not.toMatch(/Cloudflare|Artifacts|OAuth|3-way|fast-forward/);
    expect(readFileSync("web/src/views/ProjectsView.tsx", "utf8")).toContain("A project is the code that your agents change together.");
  });

  it("keeps the words of a card plain", () => {
    for (const text of [waitsText(1), waitsText(3), NOTHING_WAITS, sourceLine(project()), ...cardFacts(project({ role: "member", visibility: "public" }), true)]) {
      // "Nothing" is a noun, not an "-ing" form of a verb.
      expect(steViolations(text).filter((v) => !v.includes('"Nothing"')), text).toEqual([]);
    }
    expect(waitsText(1)).toBe("1 question waits");
    expect(waitsText(2)).toBe("2 questions wait");
  });

  it("leads a card with the questions that wait, and never joins facts with dots", () => {
    const item = (key: string, projectId: string) => ({ key, project: projectId }) as InboxItem;
    const byProject = waitingByProject([item("a", "p1"), item("b", "p1"), item("c", "p2")]);
    expect(byProject?.get("p1")).toHaveLength(2);
    expect(byProject?.get("p3")).toBeUndefined();
    expect(waitingByProject(null)).toBeNull();
    for (const facts of [cardFacts(project(), false), cardFacts(project({ role: "viewer", visibility: "public" }), true)]) {
      expect(facts.join(" ")).not.toContain("·");
    }
    expect(cardFacts(project(), false)).toEqual(["Created 7 min ago"]);
  });

  it("says nothing about a quiet project to a person who cannot answer in it", () => {
    expect(canAnswerHere(project({ role: "owner" }))).toBe(true);
    expect(canAnswerHere(project({ role: "member" }))).toBe(true);
    expect(canAnswerHere(project({ role: "viewer" }))).toBe(false);
  });

  it("puts the source of a project last, in plain words", () => {
    expect(sourceLine(project({ source: { kind: "empty" } }))).toBe("Started empty");
    expect(sourceLine(project({ source: { kind: "upload", files: 1 } as ProjectInfo["source"] }))).toBe("Uploaded folder with 1 file");
    expect(sourceLine(project({ source: { kind: "push" } as ProjectInfo["source"] }))).toBe("Pushed with git");
  });
});
