/**
 * The words of the steward in the web app: the switch on the Settings page and the note in the decisions
 * list stay in plain style (ASD-STE100).
 */
import { describe, expect, it } from "vitest";
import type { Attempt, Intent, ProjectState, Question } from "../../src/core/types";
import { STEWARD_OPTIONS } from "../../src/core/inbox";
import { selectJudgmentQueue, type QuestionItem } from "../../web/src/state/selectors";
import { STEWARD_LABEL, stewardHelp } from "../../web/src/views/steward-copy";
import { steViolations } from "../coord/ste";

describe("the words of the steward", () => {
  it("keep the plain style on the Settings page", () => {
    for (const text of [STEWARD_LABEL, stewardHelp(true), stewardHelp(false)]) expect(steViolations(text), text).toEqual([]);
    expect(stewardHelp(true)).toContain("one answer: Seen");
    expect(stewardHelp(false)).toContain("Turn this on");
  });

  it("show a note of the steward in the decisions list with its one answer", () => {
    const q: Question = { id: "q_1", kind: "steward", status: "open", intentId: "i1", attemptIds: ["a1"], fact: "stuck-test:a1", measure: 3, facts: ["KESTREL-7 ran the tests 3 times in a row."], options: [...STEWARD_OPTIONS], askedAt: 40, updatedAt: 40 };
    const st = {
      project: { id: "shop", settings: { approver: "sender" } },
      intents: [{ id: "i1", title: "Add a search box", status: "underway", updatedAt: 9 } as Intent],
      attempts: [{ id: "a1", intentId: "i1", agentId: "g1", status: "underway", stats: { filesChanged: 1, additions: 1, deletions: 0, steps: 1 }, createdAt: 1, updatedAt: 1 } as Attempt],
      checks: [],
      agents: [{ id: "g1", callsign: "KESTREL-7", color: 3 }],
      questions: [q],
    } as unknown as ProjectState;
    const items = selectJudgmentQueue(st, { id: "u_robin", role: "owner" });
    expect(items).toHaveLength(1);
    const item = items[0] as QuestionItem;
    expect(item).toMatchObject({ kind: "question", title: "Add a search box", detail: "A note from the steward. Seen closes it", mayAnswer: true });
    expect(item.question.options).toEqual([{ id: "seen", label: "Seen" }]);
    expect(steViolations(item.detail)).toEqual([]);
  });
});
