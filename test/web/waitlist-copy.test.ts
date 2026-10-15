/**
 * Plain words (ASD-STE100) in everything that a waiting person reads: the pages, the packs and the owner page.
 * At most 20 words in a sentence, no "-ing" forms. There is no payment word on the interest page.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyProblems } from "../coord/copy-scan";
import { steViolations } from "../coord/ste";
import { PLANS } from "../../src/core/plans";
import { CHAPTERS } from "../../web/src/views/story/copy";
import { INTEREST, JOIN, LANDING, SIGN_IN_ERRORS } from "../../web/src/views/waitlist/copy";

/** Words that end in "ing" but are not verb forms (the same list as test/coord/copy-scan.ts). */
const NOT_VERB_FORMS = new Set(["anything", "nothing", "something", "everything", "during", "thing", "string", "bring", "binding", "merging"]);

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function problems(texts: string[]): string[] {
  return texts.flatMap((t) =>
    steViolations(t).filter((p) => {
      const word = /^"-ing" form "([^"]*)"/.exec(p)?.[1]?.toLowerCase();
      return !(word && NOT_VERB_FORMS.has(word));
    }),
  );
}

describe("plain words on the waitlist pages", () => {
  it("uses short sentences and no -ing forms in the page copy", () => {
    expect(problems(strings([LANDING, JOIN, INTEREST, SIGN_IN_ERRORS]))).toEqual([]);
  });

  it("uses short sentences and no -ing forms on the cards of the packs", () => {
    const texts = PLANS.flatMap((p) => [p.name, p.tagline, p.forWho, ...p.points]);
    expect(problems(texts)).toEqual([]);
  });

  it("checks the words inside the views and the server pages", () => {
    const files = [
      "web/src/views/waitlist/Interest.tsx",
      "web/src/views/waitlist/Landing.tsx",
      "web/src/views/waitlist/Waitlist.tsx",
      "web/src/views/story/Chapter.tsx",
      "web/src/views/story/StaticStory.tsx",
      "web/src/views/story/StorySection.tsx",
      "web/src/views/story/Story.tsx",
      "src/worker/waitlist.ts",
      "src/worker/gate.ts",
    ];
    for (const file of files) {
      expect(copyProblems(file), file).toEqual([]);
    }
  });

  it("says what the interest page promises", () => {
    expect(INTEREST.title).toBe("Pick the pack you would use");
    expect(INTEREST.free).toBe("Nothing to pay. We only collect interest to learn what to build and charge. No card needed.");
    expect(INTEREST.submit).toBe("Count me in");
    expect(INTEREST.done).toBe("Your interest is recorded.");
    expect(INTEREST.next).toBe("We will email you or reach out when gitring opens to the public.");
    expect(LANDING.join).toBe("Join the waitlist");
  });

  it("has no checkout words and no card field on the interest page", () => {
    const view = readFileSync("web/src/views/waitlist/Interest.tsx", "utf8");
    const all = [JSON.stringify(INTEREST), view].join("\n");
    expect(all).not.toMatch(/upgrade|checkout|subscribe|buy now|cvc|card number|credit card|pay now/i);
    expect(view).not.toMatch(/autocomplete="cc-|type="(?:tel|number)"/);
  });

  it("tells the flow in the story and ends in the join button", () => {
    expect(CHAPTERS).toHaveLength(7);
    expect(CHAPTERS.map((c) => c.heading).join(" ")).toMatch(/Start a project[\s\S]*Connect your agents[\s\S]*plan first[\s\S]*checks plans[\s\S]*Tested work[\s\S]*yes[\s\S]*records why/);
    expect(LANDING.closingTitle).toBe("Join the waitlist");
    expect(LANDING.join).toBe("Join the waitlist");
    expect(JOIN.text).toBe("Sign in so we know who you are. Then you pick the pack you would use.");
  });

  it("has no card grid and no numbered list of steps any more", () => {
    expect("solves" in LANDING).toBe(false);
    expect("how" in LANDING).toBe(false);
    const css = readFileSync("web/src/views/waitlist/waitlist.css", "utf8");
    expect(css).not.toMatch(/\.wl-(grid|card|step)/);
  });
});
