/**
 * Approvals in the web app: which merges wait for this person, and the words for them.
 * The rules (who may answer, the facts of a question) come from core/approvals through the selector. Nothing
 * here decides who may say yes: the Worker checks every answer again.
 */
import type { Approval, Attempt, Landing, Person } from "../../../src/core/types";
import { atLeast, type Role } from "../../../src/core/accounts";
import type { ApprovalResult } from "./api";
import { ago, METHOD_TEXT, shortSha } from "./format";
import { memo, selectJudgmentQueue, type ApprovalItem, type JudgmentItem } from "./selectors";
import { useStore } from "./store";

export type ApproverRule = "sender" | "owner";

/* ───────────── what waits for me ───────────── */

const NONE: JudgmentItem[] = [];

/** Everything that needs a person, oldest first, for the signed-in person (`mayAnswer` is set for them). */
export function useJudgmentQueue(): JudgmentItem[] {
  const state = useStore((s) => s.state);
  const id = useStore((s) => s.me?.user?.id ?? "");
  const role = useStore((s) => s.access);
  return state ? selectJudgmentQueue(state, { id, role }) : NONE;
}

const approvalsOf = memo((queue: JudgmentItem[]): ApprovalItem[] => queue.filter((x): x is ApprovalItem => x.kind === "approval"));
const answerableOf = memo((list: ApprovalItem[]): ApprovalItem[] => list.filter((x) => x.mayAnswer));

/** Every merge that waits for a yes, from anyone. Oldest first. */
export function useApprovals(): ApprovalItem[] {
  return approvalsOf(useJudgmentQueue());
}

/** The merges that wait for a yes from the person who looks, and that this person may answer. Oldest first. */
export function useMyQuestions(): ApprovalItem[] {
  return answerableOf(useApprovals());
}

/** The rule for who answers: the person who sent the agent, or only an owner. */
export function useApproverRule(): ApproverRule {
  return useStore((s) => (s.state?.project.settings?.approver === "owner" ? "owner" : "sender"));
}

/* ───────────── words ───────────── */

/** Who a question waits for: a name, "an owner" or "a member". */
export function waitsFor(approver: Person | undefined, rule: ApproverRule): string {
  if (rule === "owner") return "an owner";
  return approver?.name?.trim() || "a member";
}

/** Why the person who looks may not answer (the same sentences as the Worker). Empty: they may answer. */
export function cannotAnswerText(who: { signedIn: boolean; role: Role | null | undefined }, approver: Person | undefined, rule: ApproverRule): string {
  if (!who.signedIn) return "Sign in to answer.";
  if (!atLeast(who.role, "member")) return "You can view this project. Only a member can say yes. Ask an owner for the member role.";
  if (who.role === "owner") return "";
  if (rule === "owner") return "Only an owner of the project can answer this.";
  return approver ? `Only ${approver.name} (who sent the agent) or an owner of the project can answer this.` : "";
}

/** The sentence that a screen reader hears when new questions arrive. `titles` are the new ones. */
export function announceText(total: number, titles: string[]): string {
  if (!titles.length) return "";
  const head = `${total} ${total === 1 ? "merge waits" : "merges wait"} for you: ${titles[0]}`;
  return titles.length > 1 ? `${head} and ${titles.length - 1} more` : head;
}

/** The title of the browser tab: a count in front of the name while merges wait for the person. */
export function tabTitle(waiting: number, usual: string): string {
  return waiting > 0 ? `(${waiting}) gitring` : usual;
}

/* ───────────── what an answer did ───────────── */

/**
 * What an answer did, in the words that the screens use:
 *   merged      the work is in main (`landing`)
 *   waits       the work merges later: the hourly test budget is used
 *   not-merged  the person said yes, and the work did not merge: gitring does the task again on the new main
 *   sent-back   the work went back to the agent with the note
 *   already     somebody answered before
 *   old         the agent changed the work, so this question is closed
 *   refused     this person may not answer
 */
export type AnswerKind = "merged" | "waits" | "not-merged" | "sent-back" | "already" | "old" | "refused";

export function answerKind(r: Pick<ApprovalResult, "outcome" | "landing" | "waits">): AnswerKind {
  switch (r.outcome) {
    case "approved":
      return r.landing ? "merged" : r.waits ? "waits" : "not-merged";
    case "sent-back":
      return "sent-back";
    case "already":
      return "already";
    case "withdrawn":
      return "old";
    default:
      return "refused";
  }
}

/* ───────────── one question, from asked to answered ───────────── */

/**
 * Where a question stands, for the approve page:
 *   waiting     asked, and nobody answered yet
 *   merged      a person said yes, and the work is in main
 *   queued      a person said yes, and the merge is in the queue (or waits for the test budget)
 *   redo        a person said yes, and the work did not merge: gitring does the task again on the new main
 *   sent-back   a person sent the work back to the agent
 *   closed      the question cannot get an answer any more (the agent changed the work, or the work copy closed)
 *   none        gitring never asked about this work copy
 */
export type Phase =
  | { kind: "waiting" }
  | { kind: "merged"; landing?: Landing }
  | { kind: "queued" }
  | { kind: "redo" }
  | { kind: "sent-back" }
  | { kind: "closed"; text: string }
  | { kind: "none" };

export function phaseOf(a: Pick<Attempt, "status" | "approval">, landing?: Landing): Phase {
  const ap = a.approval;
  if (!ap) return a.status === "landed" ? { kind: "merged", landing } : { kind: "none" };
  switch (ap.status) {
    case "waiting":
      return a.status === "ready" ? { kind: "waiting" } : { kind: "closed", text: "The work is not ready now." };
    case "approved":
      if (landing || a.status === "landed") return { kind: "merged", landing };
      return a.status === "ready" || a.status === "landing" ? { kind: "queued" } : { kind: "redo" };
    case "sent-back":
      return { kind: "sent-back" };
    default:
      return { kind: "closed", text: ap.closed?.trim() || "The agent changed the work, or the work copy closed." };
  }
}

/** What the page says in place of the answer buttons once the question has an answer. */
export interface Outcome {
  tone: "clear" | "caution" | "correction" | "neutral";
  headline: string;
  /** Plain sentences under the headline. */
  lines: string[];
  /** What the person wrote when they sent the work back. */
  note?: string;
  /** The merge record of a merge that happened. */
  landingId?: string;
}

function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function describeOutcome(i: { phase: Phase; approval?: Approval; me: string; builtin: boolean; mergeUntil?: number; now: number }): Outcome | null {
  const { phase, approval } = i;
  const answer = approval?.answer;
  const mine = answer ? answer.by.id === i.me : false;
  const who = !answer ? "A person" : mine ? "You" : answer.by.name;
  const rel = answer ? ago(answer.at, i.now) : "";
  const when = rel === "now" ? " just now" : rel ? ` ${rel}` : "";
  // An answer from somebody else: say so first.
  const other = answer && !mine ? [`Already answered by ${answer.by.name}.`] : [];
  switch (phase.kind) {
    case "merged":
      return {
        tone: "clear",
        headline: phase.landing ? `Merged into main ${shortSha(phase.landing.mainAfter)}` : "Merged into main",
        lines: [...other, `${who} said yes${when}.`, ...(phase.landing ? [`Method: ${METHOD_TEXT[phase.landing.method] ?? phase.landing.method}.`] : [])],
        landingId: phase.landing?.id,
      };
    case "queued":
      return {
        tone: "clear",
        headline: i.mergeUntil ? "Approved. The merge waits." : "Approved. The merge is in the queue.",
        lines: [
          ...other,
          `${who} said yes${when}.`,
          i.mergeUntil ? `The test budget for this hour is used. gitring tries again at ${clockOf(i.mergeUntil)}.` : "gitring combines the work with main, runs the tests, then merges it.",
        ],
      };
    case "redo":
      return { tone: "caution", headline: "Approved. The work did not merge.", lines: [...other, `${who} said yes${when}.`, "gitring does the task again on the new main."] };
    case "sent-back":
      return {
        tone: "correction",
        headline: "Sent back",
        lines: [...other, `${who} sent this work back${when}.`, i.builtin ? "A built-in agent does the task again and reads the note." : "The agent changes the work and submits again."],
        note: answer?.note,
      };
    case "closed":
      return { tone: "neutral", headline: "This question is closed", lines: [phase.text] };
    case "none":
      return { tone: "neutral", headline: "No yes is needed", lines: ["gitring did not ask a person about this work copy.", "gitring merges work by itself when its tests pass."] };
    default:
      return null;
  }
}
