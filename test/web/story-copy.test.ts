/**
 * The words of the landing story keep the plain-word rules.
 * They use short sentences, no code names, no hype words and no em dashes.
 * It also checks that the files of the first script of the landing import nothing heavy.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sentencesOf, steViolations } from "../coord/ste";
import { CAPTIONS, CHAPTERS, OPENING, SMALL } from "../../web/src/views/story/copy";
import { JOIN, LANDING } from "../../web/src/views/waitlist/copy";

const BANNED = [
  "delve", "tapestry", "landscape", "unlock", "unleash", "elevate", "empower", "leverage", "seamless", "robust",
  "game-changer", "revolutionize", "supercharge", "cutting-edge", "next-generation", "streamline", "harness", "journey",
  "effortless", "crafted", "in today's", "at the heart of", "it is worth noting", "dive into",
  "very", "truly", "really", "incredibly",
];
/** The code names that a person must never read (docs/CODE-STYLE.md). */
const CODE_NAMES = ["intent", "attempt", "course", "correction", "landing", "logbook", "vessel", "harbor", "callsign"];

const closing = [LANDING.closingTitle, JOIN.text, LANDING.closingNote];
const chapterTexts = CHAPTERS.flatMap((c) => [c.heading, c.rail, c.text]);
const all = [...Object.values(OPENING), ...chapterTexts, ...Object.values(SMALL), ...Object.values(CAPTIONS), ...closing];

/** A word of the text, with its edges cleaned. */
const wordsOf = (text: string) => text.split(/\s+/).map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")).filter(Boolean);

describe("the plain words of the landing story", () => {
  it("has at most 20 words in a sentence and no -ing form", () => {
    for (const text of all) expect(steViolations(text), text).toEqual([]);
  });

  it("has at most two sentences in a chapter text, and one in a heading", () => {
    for (const chapter of CHAPTERS) {
      expect(sentencesOf(chapter.text).length, chapter.id).toBeLessThanOrEqual(2);
      expect(sentencesOf(chapter.heading).length, chapter.id).toBe(1);
      expect(chapter.heading, chapter.id).not.toMatch(/[.!?]$/);
    }
  });

  it("writes headings in sentence case, with no all-caps word, and no From X to Y", () => {
    for (const heading of [OPENING.heading, ...CHAPTERS.map((c) => c.heading), LANDING.closingTitle]) {
      const [firstWord, ...rest] = wordsOf(heading);
      expect(firstWord[0], heading).toMatch(/[A-Za-z]/);
      for (const word of rest) expect(word, heading).toBe(word.toLowerCase());
      expect(heading).not.toMatch(/^from\b/i);
    }
    for (const label of [...CHAPTERS.map((c) => c.rail), SMALL.skip, SMALL.railLabel]) {
      for (const word of wordsOf(label).slice(1)) expect(word, label).toBe(word.toLowerCase());
    }
  });

  it("uses no hype word and no intensifier", () => {
    for (const text of all) {
      const lower = text.toLowerCase();
      for (const word of BANNED) expect(lower, `${word} in: ${text}`).not.toMatch(new RegExp(`(^|[^a-z-])${word.replace(/-/g, "\\-")}([^a-z-]|$)`));
    }
  });

  it("shows no code name to a person", () => {
    for (const text of all) {
      for (const name of CODE_NAMES) expect(text.toLowerCase(), `${name} in: ${text}`).not.toMatch(new RegExp(`\\b${name}s?\\b`));
    }
  });

  it("has no em dash, no emoji, no question and no not-but pair", () => {
    for (const text of all) {
      expect(text, text).not.toMatch(/[—–]/);
      expect(text, text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text, text).not.toMatch(/\?/);
      expect(text, text).not.toMatch(/\bnot\b[^.]*\bbut\b/i);
      expect(text, text).not.toMatch(/ · /);
    }
  });

  it("names the three agents of the example, and uses the plain names", () => {
    const text = all.join(" ");
    expect(text).toContain("HERON-2");
    expect(text).toContain("PETREL-9");
    for (const name of ["task", "plan", "change request", "merge", "merge record"]) expect(text).toContain(name);
  });

  it("says only what is true: no number of agents or users, no speed, no price, nothing about the future", () => {
    const text = all.join(" ").toLowerCase();
    expect(text).not.toMatch(/\b(thousands?|millions?|fast|faster|instant|instantly|uptime|customers?|quote|price|free|soon)/);
    expect(text).not.toMatch(/ai-powered|ai powered|\bai\b/);
    // Digits in the copy are only the real numbers: 20 nearest plans, distance 0 to 5, the names HERON-2 and PETREL-9.
    const digits = [...all.join(" ").matchAll(/\d+/g)].map((m) => m[0]);
    expect(new Set(digits)).toEqual(new Set(["20", "0", "5", "2", "9"]));
  });

  it("keeps the closing the same as the join step", () => {
    expect(JOIN.text).toBe("Sign in so we know who you are. Then you pick the pack you would use.");
    expect(LANDING.join).toBe("Join the waitlist");
    expect(LANDING.closed).toBe("gitring is not open to the public yet.");
  });
});

describe("the first script of the landing", () => {
  const FIRST = ["index.ts", "copy.ts", "Chapter.tsx", "StaticStory.tsx", "StorySection.tsx", "engine/scroll-root.ts", "place.ts"];
  const importsOf = (file: string) =>
    [...readFileSync(`web/src/views/story/${file}`, "utf8").matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm)].map((m) => m[1] ?? m[2]);

  it("imports only light files, and the one stylesheet of the stacked story", () => {
    const allowed = new Set(["react", "./copy", "./place", "./Chapter", "./StaticStory", "./StorySection", "./engine/scroll-root", "./story-base.css"]);
    for (const file of FIRST) for (const target of importsOf(file)) expect(allowed.has(target), `${file} imports ${target}`).toBe(true);
  });

  it("loads the pinned story only with a dynamic import", () => {
    const section = readFileSync("web/src/views/story/StorySection.tsx", "utf8");
    expect(section).toMatch(/lazy\(\(\) => import\("\.\/Story"\)\)/);
    expect(importsOf("StorySection.tsx")).not.toContain("./Story");
  });
});
