/**
 * README.md: the words stay plain (ASD-STE100: at most 20 words a sentence, no "-ing" verb forms), it
 * names every MCP tool and every command of the command line, and gitring comes before GitHub in it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GITRING_TOOLS } from "../../src/worker/mcp";
import { USAGE } from "../../cli/gitring.mjs";
import { steViolations } from "../coord/ste";

const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

/** The commands of the command line, from its help text (one line each, two spaces in). */
const COMMANDS = USAGE.flatMap((line) => {
  const m = /^ {2}([a-z]+)\b/.exec(line);
  return m ? [m[1]] : [];
});

/** Words that end in "-ing" and are not verb forms: nouns, a preposition, and the name of a Settings section. */
const NOT_VERB_FORMS = new Set(["anything", "binding", "bring", "Bring", "during", "everything", "Merging", "nothing", "something", "string", "thing"]);

/** The README without its code blocks. */
const withoutCode = (markdown: string) => markdown.replace(/```[\s\S]*?```/g, "\n");

/** The prose of the README: one unit for each paragraph, list item, heading and table cell. Code stays out. */
export function proseUnits(markdown: string): string[] {
  const text = withoutCode(markdown)
    // A code span is one identifier for the checker (a command, a path, an option, an event name).
    .replace(/`[^`\n]*`/g, (code) => `_${code.slice(1, -1).replace(/\s+/g, "_")}`)
    // A link keeps its text; an image goes. Bold marks go, so that a sentence can end inside them.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "");
  const units: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^\|\s*-+\s*(\|\s*-+\s*)*\|?$/.test(line)) continue;
    if (line.startsWith("|")) {
      for (const cell of line.split("|").map((c) => c.trim()).filter(Boolean)) units.push(cell);
      continue;
    }
    units.push(line.replace(/^#+\s*/, "").replace(/^(?:[-*]|\d+\.)\s+/, ""));
  }
  return units;
}

function problems(unit: string): string[] {
  return steViolations(unit).filter((p) => {
    const m = /^"-ing" form "([^"]+)"/.exec(p);
    return !(m && NOT_VERB_FORMS.has(m[1]));
  });
}

describe("README", () => {
  it("uses plain words in every paragraph, list item, heading and table cell", () => {
    const found = proseUnits(README).flatMap((unit) => problems(unit));
    expect(found).toEqual([]);
  });

  it("names every MCP tool of gitring", () => {
    for (const t of GITRING_TOOLS) expect(README, t.name).toContain(`\`${t.name}\``);
  });

  it("names every command of the command line", () => {
    expect(COMMANDS).toContain("login");
    expect(COMMANDS).toContain("watch");
    for (const name of COMMANDS) expect(README, name).toMatch(new RegExp(`\`gitring ${name}\\b`));
  });

  it("says what gitring is before it names GitHub", () => {
    const prose = withoutCode(README);
    const start = prose.indexOf("## Start");
    expect(start).toBeGreaterThan(0);
    expect(prose.indexOf("GitHub")).toBeGreaterThan(start);
  });

  it("keeps the licence", () => {
    expect(README).toMatch(/## License\n\nMIT\. See \[LICENSE\]\(LICENSE\)\./);
  });
});

describe("proseUnits", () => {
  it("splits table rows into cells, strips list markers and headings, and keeps code out", () => {
    const md = ["# Title", "", "A line with `some code here`.", "", "| A | B |", "|---|---|", "| one | **two** words |", "", "- item one", "1. item two", "", "```", "code block", "```"].join("\n");
    expect(proseUnits(md)).toEqual(["Title", "A line with _some_code_here.", "A", "B", "one", "two words", "item one", "item two"]);
  });

  it("treats a code span of one word as an identifier, so an event name like `landing` is not a verb form", () => {
    expect(proseUnits("The events: `landing` and `intent`.").flatMap((u) => problems(u))).toEqual([]);
  });

  it("keeps the text of a link and drops the address", () => {
    expect(proseUnits("See [the page](https://example.com/a).")).toEqual(["See the page."]);
  });
});
