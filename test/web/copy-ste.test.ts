/**
 * Plain words (ASD-STE100) in the views and server messages whose text is inline in the source: no "-ing" forms,
 * at most 20 words in a sentence. The waiting words come from one small module.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyProblems, proseOf } from "../coord/copy-scan";
import { steViolations } from "../coord/ste";
import { NOT_SENT_YET, PLEASE_WAIT, TASK_ON_ITS_WAY, waitFor } from "../../web/src/app/wait-copy";

const VIEWS = [
  "web/src/views/InboxView.tsx",
  "web/src/app/QuestionCard.tsx",
  "web/src/views/ReplayView.tsx",
  "web/src/views/replay/captions.ts",
  "web/src/views/replay/Controls.tsx",
  "web/src/views/code/LineHistory.tsx",
  "web/src/views/code/CloneButton.tsx",
  "web/src/views/newproject/StartList.tsx",
  "web/src/views/newproject/start-text.ts",
  "web/src/views/newproject/steps.tsx",
  "web/src/views/AccountView.tsx",
  "web/src/app/Account.tsx",
  "web/src/views/connect-text.ts",
  "web/src/app/IntentsRail.tsx",
  "web/src/app/TopBar.tsx",
  "web/src/app/App.tsx",
  "web/src/views/CodeView.tsx",
];

describe("plain words in the views", () => {
  for (const file of VIEWS) {
    it(`${file} has no "-ing" forms and no long sentences`, () => {
      expect(copyProblems(file)).toEqual([]);
    });
  }

  it("keeps the waiting words short and plain", () => {
    for (const text of [PLEASE_WAIT, waitFor("the inbox"), NOT_SENT_YET, TASK_ON_ITS_WAY]) expect(steViolations(text)).toEqual([]);
    expect(waitFor("the inbox")).toBe("Please wait for the inbox");
  });

  it("uses no word that ends in -ing for a waiting label", () => {
    for (const file of VIEWS) {
      const src = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
        .join("\n");
      expect(src, file).not.toMatch(/"(Loading|Opening|Creating|Waiting|Sending|Reading|Connecting|Reconnecting)\b/);
    }
  });

  it("the scanner reads strings and JSX text", () => {
    const found = proseOf('const a = "Opening the project now";\nreturn <p>Loading the diff now</p>;\n');
    expect(found).toEqual(["Opening the project now", "Loading the diff now"]);
    expect(steViolations(found[0]).length).toBeGreaterThan(0);
  });
});
