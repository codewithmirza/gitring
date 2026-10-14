/**
 * The first view of a new project: a description on top, then the sources with GitHub last. The words
 * are plain (ASD-STE100), a description gives a name and a template, and a link opens the template step.
 */
import { describe, expect, it } from "vitest";
import { agentsHint, CONNECT_GITHUB_NOTE, DESCRIBE_HINT, DESCRIBE_LABEL, NEW_PROJECT_LEDE, SOURCES } from "../../web/src/views/newproject/start-text";
import { nameFromDescription } from "../../web/src/views/newproject/match";
import { draftFromLink, EMPTY_DRAFT } from "../../web/src/views/newproject/draft";
import { pickTemplate } from "../../src/core/templates";
import { steViolations } from "../coord/ste";

describe("the first view of a new project", () => {
  it("lists the sources in the planned order, and GitHub is not one of them", () => {
    expect(SOURCES.map((s) => s.title)).toEqual(["Template", "Empty project", "Upload a folder", "Push with git", "Import from a git URL"]);
    // GitHub shows up only as one host among others.
    for (const s of SOURCES) expect(s.title).not.toMatch(/github/i);
    expect(SOURCES.find((s) => s.kind === "git")!.text).toMatch(/any host: GitLab, Codeberg, GitHub and others/);
  });

  it("uses plain words", () => {
    const texts = [DESCRIBE_LABEL, DESCRIBE_HINT, NEW_PROJECT_LEDE, `Connect GitHub ${CONNECT_GITHUB_NOTE}`, ...SOURCES.map((s) => s.text), ...[0, 1, 3].map(agentsHint)];
    // "bring" is an STE verb, not an "-ing" form: the checker only reads the end of a word.
    expect(texts.flatMap((t) => steViolations(t)).filter((v) => !v.includes('"bring"'))).toEqual([]);
    expect(NEW_PROJECT_LEDE).toBe("Describe it, start from a template, or bring your code. Agents start at once.");
  });

  it("says how many built-in agents start", () => {
    expect(agentsHint(0)).toMatch(/^No agent starts/);
    expect(agentsHint(1)).toBe("1 built-in agent starts on the first task at once.");
    expect(agentsHint(2)).toMatch(/^2 built-in agents start/);
  });
});

describe("a description", () => {
  it("gives a short project name", () => {
    expect(nameFromDescription("A JSON API for my shop, with a cart and tests")).toBe("JSON API for my shop");
    expect(nameFromDescription("The landing page of Robin's bakery. It shows the opening hours.")).toBe("Landing page of Robin's bakery");
    expect(nameFromDescription("a tool that converts very long markdown documents into slides for talks")).toBe("Tool that converts very long markdown");
    expect(nameFromDescription("   ")).toBe("");
  });

  it("picks the template that fits", () => {
    expect(pickTemplate("A JSON API for my shop, with a cart and tests")).toBe("worker-api");
    expect(pickTemplate("The landing page of Robin's bakery")).toBe("static-site");
  });
});

describe("links", () => {
  it("open the template step", () => {
    expect(draftFromLink(new URLSearchParams("new=template"), EMPTY_DRAFT).step).toEqual({ kind: "template" });
    expect(EMPTY_DRAFT.description).toBe("");
  });

  it("open the URL step of 'Import from a git URL', also without a URL", () => {
    expect(draftFromLink(new URLSearchParams("new=git"), EMPTY_DRAFT).step).toEqual({ kind: "git", url: "" });
    expect(draftFromLink(new URLSearchParams("new=git&url="), EMPTY_DRAFT).step).toEqual({ kind: "git", url: "" });
  });
});
