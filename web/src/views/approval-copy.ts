/**
 * Settings: the words and the small rules for "when does a person say yes before a merge".
 *
 * Pure (no React): the Settings page and the Connect page use these, and a unit test keeps the words
 * true to the rules in core/approvals.ts. Words are plain (ASD-STE100): at most 20 words in a sentence.
 */
import type { ApproverRule, FolderRule, GitringEventType, LandingMode } from "../../../src/core/types";
import { isLandingMode } from "../../../src/core/types";
import { LARGE_FILES, LARGE_LINES } from "../../../src/core/approvals";
import { MAX_FOLDER_RULES } from "../../../src/core/coord/folder-rules";

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

/** Under the three choices: it is true for every choice, so it is said once. */
export const PERSON_ALSO_DECIDES = "A person also decides when no test ran or when work copies compete.";

/**
 * The three landing choices. The help of "risky" names each sign of riskSigns (core/approvals.ts): the
 * parameters of a function change, build or deploy files change, files are deleted, the change is large.
 */
export const LANDING_CHOICES: Choice<LandingMode>[] = [
  {
    value: "automatic",
    label: "Only when the tests pass",
    help: "gitring merges the work by itself when the tests pass.",
  },
  {
    value: "risky",
    label: "When a change looks risky",
    badge: "Recommended",
    help:
      "gitring asks when the parameters of a function change, build or deploy files change, or files are deleted. " +
      `It also asks when the change is large: ${LARGE_FILES} files or ${LARGE_LINES} changed lines.`,
  },
  {
    value: "ask",
    label: "Before every merge",
    help: "A person says yes to every merge.",
  },
];

/**
 * What gitring does with work that no question holds back, by the choice of the project. The decisions list says it
 * when it is empty: the sentence must be true for every choice.
 */
export function quietText(mode: LandingMode): string {
  switch (mode) {
    case "automatic":
      return "gitring merges work when its tests pass.";
    case "risky":
      return "gitring merges safe work when its tests pass. It asks you about risky work.";
    default:
      return "gitring asks you before every merge.";
  }
}

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

/* ───────────── rules by folder ───────────── */

export type FolderRuleKind = FolderRule["rule"];

export const FOLDER_RULES_LEGEND = "Rules by folder";

/** What the section says first: what a rule is, and the three kinds of pattern. */
export const FOLDER_RULES_HELP =
  "A rule says who says yes to a change in a folder or a file. " +
  `Examples: migrations/** (a folder and all in it), docs/*.md (one folder), *.sql (a name, in any folder). At most ${MAX_FOLDER_RULES} rules.`;

/** The three kinds of a rule, with one help text each. */
export const FOLDER_RULE_CHOICES: Choice<FolderRuleKind>[] = [
  { value: "owner-yes", label: "An owner says yes", help: "A change there needs the yes of an owner, in every merge choice above." },
  { value: "no-yes", label: "No yes needed", help: "A change there merges when its tests pass, also when no test ran. Work copies that compete still need a person." },
  { value: "members", label: "Only the agents of these members", help: "The plan of another agent is refused. Work that changed the files anyway needs the yes of an owner." },
];

/** The label of a kind of rule, for a list. */
export function folderRuleLabel(kind: FolderRuleKind): string {
  return FOLDER_RULE_CHOICES.find((c) => c.value === kind)?.label ?? kind;
}

/** The rules of a project as the Settings page edits them (a server from before rules sends none). */
export function folderRulesOf(s: { folderRules?: unknown } | null | undefined): FolderRule[] {
  return Array.isArray(s?.folderRules) ? (s!.folderRules as FolderRule[]) : [];
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
  // A question for a person: which work adapts, or what happens with work that did not merge.
  { value: "question", label: "A person must decide, or answered" },
];

/** What the message of the `approval` event holds. */
export const APPROVAL_EVENT_HELP = "The message has the task, the change in one line, and the link where a person answers.";

/** The note under the events of a webhook: the name of the event, then what its message holds (two sentences, none too long). */
export const APPROVAL_EVENT_NOTE = `${APPROVAL_EVENT_LABEL}. ${APPROVAL_EVENT_HELP}`;

/** "A merge" gives "a merge" (the Connect page lists the events in a sentence). */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
