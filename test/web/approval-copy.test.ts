/**
 * The words of the Settings page for approvals: they stay in plain style (ASD-STE100) and true to the rules
 * of the server (core/approvals.ts, core/types.ts).
 */
import { describe, expect, it } from "vitest";
import { LARGE_FILES, LARGE_LINES, riskSigns } from "../../src/core/approvals";
import { DEFAULT_SETTINGS, withDefaults, type Attempt, type FileTouch, type GitringEventType } from "../../src/core/types";
import {
  APPROVAL_EVENT_HELP,
  APPROVAL_EVENT_NOTE,
  APPROVER_CHOICES,
  APPROVER_LEGEND,
  LANDING_CHOICES,
  LANDING_LEGEND,
  WEBHOOK_EVENTS,
  approverOf,
  landingOf,
  lowerFirst,
  untestedHelp,
} from "../../web/src/views/approval-copy";
import { steViolations } from "../coord/ste";

const touch = (status: FileTouch["status"]): FileTouch => ({ status, hunks: [], additions: 1, deletions: 0 });

/** An attempt with only the fields that riskSigns reads. */
function work(over: { files?: Record<string, FileTouch>; signatureChanged?: string[]; filesChanged?: number; additions?: number; deletions?: number }): Pick<Attempt, "footprint" | "stats"> {
  return {
    footprint: {
      files: over.files ?? { "src/a.js": touch("M") },
      symbols: { defined: [], modified: [], removed: [], signatureChanged: over.signatureChanged ?? [], referenced: [] },
      computedAt: 1,
    },
    stats: { filesChanged: over.filesChanged ?? 1, additions: over.additions ?? 4, deletions: over.deletions ?? 1, steps: 1 },
  };
}

describe("landingOf", () => {
  it("shows the choice that the project has", () => {
    expect(landingOf({ landing: "automatic" })).toBe("automatic");
    expect(landingOf({ landing: "risky" })).toBe("risky");
    expect(landingOf({ landing: "ask" })).toBe("ask");
  });

  it("reads a project from before the choice existed: autoLand true is automatic, false is ask", () => {
    expect(landingOf({ autoLand: true })).toBe("automatic");
    expect(landingOf({ autoLand: false })).toBe("ask");
  });

  it("lets `landing` win over `autoLand`", () => {
    expect(landingOf({ landing: "ask", autoLand: true })).toBe("ask");
    expect(landingOf({ landing: "risky", autoLand: false })).toBe("risky");
  });

  it("falls back to the default of a new project when it knows nothing", () => {
    expect(landingOf({})).toBe("risky");
    expect(landingOf(null)).toBe("risky");
    expect(landingOf(undefined)).toBe("risky");
    expect(landingOf({ landing: "sometimes", autoLand: "yes" })).toBe("risky");
  });

  it("reads the settings the same way as the server", () => {
    const inputs = [undefined, {}, { autoLand: true }, { autoLand: false }, { landing: "automatic" as const }, { landing: "ask" as const, autoLand: true }, { landing: "risky" as const }];
    for (const input of inputs) expect(landingOf(input), JSON.stringify(input)).toBe(withDefaults(input).landing);
  });
});

describe("approverOf", () => {
  it("asks the person who sent the agent, unless the settings say owner", () => {
    expect(approverOf({ approver: "owner" })).toBe("owner");
    expect(approverOf({ approver: "sender" })).toBe("sender");
    expect(approverOf({})).toBe("sender");
    expect(approverOf(null)).toBe("sender");
    expect(approverOf({ approver: "anyone" })).toBe("sender");
  });

  it("reads the settings the same way as the server", () => {
    for (const input of [undefined, {}, { approver: "owner" as const }, { approver: "sender" as const }]) expect(approverOf(input)).toBe(withDefaults(input).approver);
  });
});

describe("the choices", () => {
  it("lists the three landing choices in order, and marks the default as recommended", () => {
    expect(LANDING_CHOICES.map((c) => c.value)).toEqual(["automatic", "risky", "ask"]);
    expect(LANDING_CHOICES.filter((c) => c.badge).map((c) => [c.value, c.badge])).toEqual([["risky", "Recommended"]]);
    expect(DEFAULT_SETTINGS.landing).toBe("risky");
    expect(LANDING_CHOICES.find((c) => c.value === "risky")?.help).toContain("New projects start with this choice.");
  });

  it("names the choices as the brief says", () => {
    expect(LANDING_LEGEND).toBe("When does a person say yes?");
    expect(LANDING_CHOICES.map((c) => c.label)).toEqual(["Only when the tests pass", "When a change looks risky", "Before every merge"]);
    expect(APPROVER_LEGEND).toBe("Who says yes?");
    expect(APPROVER_CHOICES.map((c) => [c.value, c.label])).toEqual([
      ["sender", "The person who sent the agent (owners can always answer)"],
      ["owner", "Only owners"],
    ]);
    expect(DEFAULT_SETTINGS.approver).toBe("sender");
  });

  it("gives each choice one help text, in plain words", () => {
    for (const c of [...LANDING_CHOICES, ...APPROVER_CHOICES]) {
      expect(c.help.length, c.value).toBeGreaterThan(0);
      expect(steViolations(`${c.label}. ${c.help}`), c.value).toEqual([]);
    }
    for (const bad of [/harbor/i, /vessel/i, /footprint/i, /digest/i, /autoLand/]) {
      for (const c of [...LANDING_CHOICES, ...APPROVER_CHOICES]) expect(`${c.label} ${c.help}`, c.value).not.toMatch(bad);
    }
  });

  it("says in the risky help what the server calls risky", () => {
    const help = LANDING_CHOICES.find((c) => c.value === "risky")!.help;
    // One sample for each sign of riskSigns; each sample shows exactly that sign.
    const samples: [string, Pick<Attempt, "footprint" | "stats">, RegExp][] = [
      ["a function gets other parameters", work({ signatureChanged: ["src/a.js#price"] }), /parameters of a function change/],
      ["a build file changes", work({ files: { "package.json": touch("M") } }), /build or deploy files change/],
      ["a file is deleted", work({ files: { "src/old.js": touch("D") } }), /files are deleted/],
      ["many files change", work({ filesChanged: LARGE_FILES }), new RegExp(`change is large: ${LARGE_FILES} files`)],
      ["many lines change", work({ additions: LARGE_LINES - 10, deletions: 10 }), new RegExp(`${LARGE_LINES} changed lines`)],
    ];
    for (const [name, attempt, words] of samples) {
      expect(riskSigns(attempt).length, name).toBe(1);
      expect(help, name).toMatch(words);
    }
  });

  it("names the size at which a change counts as large", () => {
    // One file or one line below the numbers in the help: no sign. At the numbers: a sign.
    expect(riskSigns(work({ filesChanged: LARGE_FILES - 1 }))).toEqual([]);
    expect(riskSigns(work({ filesChanged: LARGE_FILES })).length).toBe(1);
    expect(riskSigns(work({ additions: LARGE_LINES - 1, deletions: 0 }))).toEqual([]);
    expect(riskSigns(work({ additions: LARGE_LINES, deletions: 0 })).length).toBe(1);
    const help = LANDING_CHOICES.find((c) => c.value === "risky")!.help;
    expect(help).toContain(`${LARGE_FILES} files`);
    expect(help).toContain(`${LARGE_LINES} changed lines`);
  });

  it("says that a person decides in every mode when no test ran or work copies compete", () => {
    for (const value of ["automatic", "risky"] as const) {
      const help = LANDING_CHOICES.find((c) => c.value === value)!.help;
      expect(help, value).toMatch(/no test ran/);
      expect(help, value).toMatch(/work copies compete/);
    }
  });
});

describe("untestedHelp", () => {
  it("tells what the switch does in both states, in plain words", () => {
    expect(untestedHelp(false)).toContain("a person must say yes");
    expect(untestedHelp(true)).toContain("does not ask");
    expect(untestedHelp(true)).toContain("still applies");
    expect(steViolations(untestedHelp(false))).toEqual([]);
    expect(steViolations(untestedHelp(true))).toEqual([]);
  });
});

describe("the webhook events", () => {
  const VALID: GitringEventType[] = ["landing", "correction", "decision", "intent", "approval", "question"];

  it("lists the six events that a webhook can send, with the approval and question events last", () => {
    expect(WEBHOOK_EVENTS.map((e) => e.value)).toEqual(VALID);
    expect(WEBHOOK_EVENTS.find((e) => e.value === "question")?.label).toBe("A person must decide, or answered");
    expect(WEBHOOK_EVENTS.find((e) => e.value === "approval")?.label).toBe("A person must say yes, or answered");
  });

  it("has a short plain label for each event", () => {
    for (const e of WEBHOOK_EVENTS) {
      expect(e.label.length, e.value).toBeGreaterThan(0);
      expect(steViolations(`${e.label}.`), e.value).toEqual([]);
    }
  });

  it("describes the message of the approval event in plain words", () => {
    expect(APPROVAL_EVENT_HELP).toBe("The message has the task, the change in one line, and the link where a person answers.");
    expect(steViolations(APPROVAL_EVENT_HELP)).toEqual([]);
  });

  it("puts the name of the event and its help in two sentences (the Settings page), and in one (the Connect page)", () => {
    expect(APPROVAL_EVENT_NOTE).toBe("A person must say yes, or answered. The message has the task, the change in one line, and the link where a person answers.");
    expect(steViolations(APPROVAL_EVENT_NOTE)).toEqual([]);
    expect(steViolations(`For approval, ${lowerFirst(APPROVAL_EVENT_HELP)}`)).toEqual([]);
  });
});

describe("lowerFirst", () => {
  it("lowers the first letter only", () => {
    expect(lowerFirst("A merge")).toBe("a merge");
    expect(lowerFirst("A person must say yes, or answered")).toBe("a person must say yes, or answered");
    expect(lowerFirst("")).toBe("");
    expect(lowerFirst("gitring")).toBe("gitring");
  });
});
