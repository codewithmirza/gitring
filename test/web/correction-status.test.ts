/**
 * The words of the app for the state of a change request: a request that the agent did not confirm before the
 * merge reads "Closed at merge", and a confirmation that failed the code check says why.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Correction } from "../../src/core/types";
import { CorrectionNotice } from "../../web/src/design/components/CorrectionNotice";
import { steViolations } from "../coord/ste";

const request = (patch: Partial<Correction>): Correction => ({
  id: "cr_1",
  attemptId: "a_1",
  standOnAttemptId: "a_2",
  kind: "region",
  rule: "R4-first-declared-stands-on",
  message: "Do not edit line 2 of src/greet.js.",
  constraints: { avoidRegions: [{ path: "src/greet.js", lines: [2, 2] }] },
  checkId: "k_1",
  status: "delivered",
  createdAt: 0,
  ...patch,
});
const html = (c: Correction) => renderToStaticMarkup(createElement(CorrectionNotice, { correction: c, from: "KESTREL-4", to: "ROBIN-1", now: 0 }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the state of a change request in the app", () => {
  it("says that a request closed at the merge when the agent did not confirm it", () => {
    const markup = html(request({ status: "closed" }));
    expect(text(markup)).toContain("Closed at merge");
    expect(markup).toContain("Change request cr_1 for ROBIN-1");
    expect(text(markup)).not.toContain("Acknowledged");
  });

  it("says why a confirmation failed the code check while the request stays open", () => {
    const reason = "Your code still edits line 2 of src/greet.js.";
    const markup = html(request({ status: "delivered", ackNote: "Done.", check: { applied: false, reason, at: 0 } }));
    const words = text(markup);
    expect(words).toContain(`The agent confirmed it, but the code check failed: ${reason}`);
    expect(steViolations(`The agent confirmed it, but the code check failed. ${reason}`)).toEqual([]);
    // After a confirmation that passed, the note of the failed check goes away.
    expect(text(html(request({ status: "acknowledged", check: { applied: true, reason: "Your code keeps the lines of the change request.", at: 0 } })))).not.toContain("code check failed");
  });
});
