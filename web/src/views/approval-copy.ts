/**
 * Settings: the words and the small rules for "when does a person say yes before a merge".
 *
 * Pure (no React): the Settings page and the Connect page use these, and a unit test keeps the words
 * true to the rules in core/approvals.ts. Words are plain (ASD-STE100): at most 20 words in a sentence.
 */
import type { ApproverRule, GitringEventType, LandingMode } from "../../../src/core/types";
import { isLandingMode } from "../../../src/core/types";
import { LARGE_FILES, LARGE_LINES } from "../../../src/core/approvals";

/** One choice of a radio group: a short name and one help text. */
export interface Choice<T extends string> {
  value: T;
  label: string;
  help: string;
  /** A short mark next to the label, for example "Recommended". */
  badge?: string;
}

export const LANDING_LEGEND = "When does a person say yes?";
export const APPROVER_LEGEND = "Who says yes?";

/**
 * The three landing choices. The help of "risky" names each sign of riskSigns (core/approvals.ts): the
 * parameters of a function change, build or deploy files change, files are deleted, the change is large.
 */
export const LANDING_CHOICES: Choice<LandingMode>[] = [
  {
    value: "automatic",
    label: "Only when the tests pass",
    help: "gitring merges the work by itself. A person still decides when no test ran or when work copies compete.",
  },
  {
    value: "risky",
    label: "When a change looks risky",
    badge: "Recommended",
    help:
      "gitring asks when the parameters of a function change, or when build or deploy files change. " +
      `It also asks when files are deleted, or when the change is large: ${LARGE_FILES} files or ${LARGE_LINES} changed lines. ` +
      "A person also decides when no test ran, or when work copies compete. New projects start with this choice.",
  },
  {
    value: "ask",
    label: "Before every merge",
    help: "A person says yes to every merge.",
  },
];

export const APPROVER_CHOICES: Choice<ApproverRule>[] = [
  {
    value: "sender",
    label: "The person who sent the agent (owners can always answer)",
    help: "If no person sent the agent, any member can answer.",
  },
  {
    value: "owner",
    label: "Only owners",
    help: "Members cannot answer, even for their own agents.",
  },
];

/**
 * The landing choice of a project. A server from before `landing` sends only `autoLand`: true means
 * "automatic" and false means "ask". With neither field, the default of a new project holds ("risky").
 */
export function landingOf(s: { landing?: unknown; autoLand?: unknown } | null | undefined): LandingMode {
  const landing = s?.landing;
  if (isLandingMode(landing)) return landing;
  if (typeof s?.autoLand === "boolean") return s.autoLand ? "automatic" : "ask";
  return "risky";
}

/** Who answers: the person who sent the agent, unless the settings say "owner". */
export function approverOf(s: { approver?: unknown } | null | undefined): ApproverRule {
  return s?.approver === "owner" ? "owner" : "sender";
}

/** Help for "Merge when no test runs" (the gitring test runner only: a container run decides by its exit code). */
export function untestedHelp(on: boolean): string {
  return on
    ? "When no test ran, gitring does not ask for that reason. The choice for “When does a person say yes?” still applies."
    : "When no test ran, a person must say yes. Turn this on to skip that question.";
}

const APPROVAL_EVENT_LABEL = "A person must say yes, or answered";

/** The events that a webhook can send. The label is the same text on the Settings page and on the Connect page. */
export const WEBHOOK_EVENTS: { value: GitringEventType; label: string }[] = [
  { value: "landing", label: "A merge" },
  { value: "correction", label: "A change request" },
  { value: "decision", label: "A person decided" },
  { value: "intent", label: "A new task" },
  { value: "approval", label: APPROVAL_EVENT_LABEL },
];

/** What the message of the `approval` event holds. */
export const APPROVAL_EVENT_HELP = "The message has the task, the change in one line, and the link where a person answers.";

/** The note under the events of a webhook: the name of the event, then what its message holds (two sentences, none too long). */
export const APPROVAL_EVENT_NOTE = `${APPROVAL_EVENT_LABEL}. ${APPROVAL_EVENT_HELP}`;

/** "A merge" gives "a merge" (the Connect page lists the events in a sentence). */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
