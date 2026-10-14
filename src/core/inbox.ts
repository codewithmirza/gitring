/**
 * The inbox of a person: everything that waits for that person in the projects where they may act.
 *
 *   approval   a merge waits for a yes (an Approval that waits)
 *   stopped    a merge stopped several times, and a yes starts it again (an Approval with reason "merge-stopped")
 *   question   a conflict check asks which work adapts, or work that did not merge needs a decision (a Question)
 *   task       a task waits for a person, and no question names it (old work; the person opens the task)
 *
 * These functions are pure: the project object builds the items of one project, and the Worker joins the
 * projects of a person (GET /api/me/inbox). The words are plain (ASD-STE100).
 */
import type { Approval, AgentInfo, Attempt, Intent, PairFacts, Person, Question, QuestionOption } from "./types";
import { approvalLine, approvalPath, canDecide } from "./approvals";
import { atLeast, type Role } from "./accounts";

export type InboxKind = "approval" | "stopped" | "question" | "task";

/** One button of an item. `note`: the person can add a note to this answer (for the agent). */
export interface InboxAction {
  id: string;
  label: string;
  primary?: boolean;
  note?: boolean;
}

export interface InboxItem {
  /** Stable for the life of the item (the id of the approval or the question). */
  key: string;
  kind: InboxKind;
  project: string;
  /** Set by the Worker, which knows the names of the projects. */
  projectName?: string;
  intentId: string;
  /** The title of the task. */
  title: string;
  /** What the person decides, in a few words. */
  headline: string;
  /** Why it waits for a person, in plain sentences. */
  why: string[];
  /** When gitring asked (milliseconds). The age of the item comes from this. */
  at: number;
  attemptId?: string;
  approvalId?: string;
  questionId?: string;
  /** The callsign of the agent (approvals). */
  agent?: string;
  /** The size of the change and the tests (approvals). */
  line?: string;
  /** Where the full facts are, in the gitring app. */
  link: string;
  actions: InboxAction[];
}

/* ───────────────────────── who may answer a question ───────────────────────── */

/**
 * Who may answer a question. The rules of approvals apply: a viewer never, an owner always. With the rule
 * "sender", a member who sent one of the agents may answer, and any member when no person sent them.
 */
export function canAnswerQuestion(senders: (Person | undefined)[], who: { id: string | null | undefined; role: Role | null | undefined }, rule: "sender" | "owner" = "sender"): boolean {
  if (!who.id || !atLeast(who.role, "member")) return false;
  if (who.role === "owner") return true;
  if (rule === "owner") return false;
  const known = senders.filter((s): s is Person => Boolean(s));
  return !known.length || known.some((s) => s.id === who.id);
}

/* ───────────────────────── the words of questions ───────────────────────── */

/** The answers of an escalation: `a` is the agent of the first work copy, `b` of the second. */
export function escalationOptions(a: string, b: string): QuestionOption[] {
  return [
    { id: "first", label: `${a} continues, ${b} adapts` },
    { id: "second", label: `${b} continues, ${a} adapts` },
    { id: "both", label: "No conflict: both continue" },
  ];
}

/** The answers when work did not merge and no agent tries again. */
export const REDO_OPTIONS: readonly QuestionOption[] = [
  { id: "redo", label: "Redo it on the new main" },
  { id: "park", label: "Pause the task" },
];

/** The one answer to a note of the steward: the person saw it, and the note closes. */
export const STEWARD_OPTIONS: readonly QuestionOption[] = [{ id: "seen", label: "Seen" }];

/** What a person decides on a question, in a few words. */
export function questionHeadline(kind: Question["kind"]): string {
  if (kind === "escalation") return "Which work adapts?";
  if (kind === "steward") return "A note from the steward";
  if (kind === "revert") return "gitring reverted a merge you said yes to";
  return "The work did not merge";
}

/** The short line under the title of a question in the decisions list. */
export function questionDetail(kind: Question["kind"]): string {
  if (kind === "escalation") return "Which work adapts? A person decides";
  if (kind === "steward") return "A note from the steward. Seen closes it";
  if (kind === "revert") return "gitring reverted a merge you said yes to. The tests failed on main. A person decides what happens next";
  return "The work did not merge. A person decides what happens next";
}

/** The answers when gitring reverted a merge that a person said yes to: the agent fixes it, or a built-in agent redoes it, or the task pauses. */
export const REVERT_OPTIONS: readonly QuestionOption[] = [
  { id: "ok", label: "Understood: the agent fixes it" },
  { id: "redo", label: "Redo it on the new main" },
  { id: "park", label: "Pause the task" },
];

/** What a person reads when gitring reverted a merge that they said yes to. Each line is one plain sentence. */
export function revertFacts(f: { title: string; agent: string; approvedBy: string; mergeSha: string; revertSha: string; failed: string[] }): string[] {
  const names = f.failed.length <= 3 ? f.failed.join(", ") : `${f.failed.slice(0, 3).join(", ")} and ${f.failed.length - 3} more`;
  return [
    `${f.approvedBy} said yes to the work of ${f.agent} on "${f.title}" (${f.mergeSha.slice(0, 7)}).`,
    `After the merge, the tests of main failed${names ? `: ${names}` : ""}.`,
    `gitring reverted the merge (${f.revertSha.slice(0, 7)}). The task is open again.`,
    `${f.agent} gets a change request with the failed tests.`,
  ];
}

/** "a, b, c" for up to three names, then "and N more". */
function listOf(items: string[], max = 3): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** The name of a symbol key: "src/a.js#price" gives "price". */
function nameOf(symbol: string): string {
  const at = symbol.lastIndexOf("#");
  return at >= 0 ? symbol.slice(at + 1) : symbol;
}

/**
 * What a person reads about two work copies that a conflict check could not decide on. `a` is the incoming work
 * copy (the facts are from its side). Each line is one plain sentence.
 */
export function escalationFacts(f: PairFacts, n: { a: string; b: string; taskA: string; taskB: string }): string[] {
  const out = [`${n.a} works on "${n.taskA}". ${n.b} works on "${n.taskB}".`];
  const lines = f.hunkOverlaps.slice(0, 3).map((o) => `${o.path} lines ${o.incoming[0]}–${o.incoming[1]}`);
  if (lines.length) out.push(`Both change the same lines: ${listOf(lines)}.`);
  for (const hit of f.interfaceHits.slice(0, 3)) {
    const [by, user] = hit.changedBy === "incoming" ? [n.a, n.b] : [n.b, n.a];
    out.push(`${by} changes the parameters of ${nameOf(hit.symbol)}. ${user} uses it in ${listOf(hit.usedAt)}.`);
  }
  const symbols = [...new Set(f.sharedSymbols.map(nameOf))];
  if (symbols.length) out.push(`Both change ${listOf(symbols)}.`);
  else if (!lines.length && f.sharedFiles.length) out.push(`Both change ${listOf(f.sharedFiles)}.`);
  if (out.length === 1) out.push(f.range <= 3 ? "The two changes are in files that import each other." : "The two changes are in files that are near each other.");
  out.push("gitring is not sure which work must adapt. A person decides. Both agents continue until then.");
  return out;
}

/* ───────────────────────── the items of one project ───────────────────────── */

export interface InboxInput {
  project: string;
  rule: "sender" | "owner";
  intents: Intent[];
  attempts: Attempt[];
  agents: Pick<AgentInfo, "id" | "callsign">[];
  questions: Question[];
}

const APPROVE_ACTIONS: InboxAction[] = [
  { id: "approve", label: "Yes, merge", primary: true },
  { id: "send-back", label: "Send back", note: true },
];

const STOPPED_ACTIONS: InboxAction[] = [
  { id: "approve", label: "Merge again", primary: true },
  { id: "send-back", label: "Send back", note: true },
];

/** The path of a task in the gitring app. */
export function taskPath(projectId: string, intentId: string): string {
  return `/tasks/${encodeURIComponent(intentId)}?project=${encodeURIComponent(projectId)}`;
}

function approvalItem(i: InboxInput, a: Attempt, ap: Approval, title: string, agent: string): InboxItem {
  const stopped = ap.reason === "merge-stopped";
  return {
    key: `ap:${ap.id}`,
    kind: stopped ? "stopped" : "approval",
    project: i.project,
    intentId: a.intentId,
    title,
    headline: stopped ? "The merge stopped" : "Merge this work into main?",
    why: ap.why,
    at: ap.askedAt,
    attemptId: a.id,
    approvalId: ap.id,
    agent,
    line: approvalLine(a),
    link: approvalPath(i.project, a.id),
    actions: stopped ? STOPPED_ACTIONS : APPROVE_ACTIONS,
  };
}

function questionItem(i: InboxInput, q: Question, title: string): InboxItem {
  return {
    key: `q:${q.id}`,
    kind: "question",
    project: i.project,
    intentId: q.intentId,
    title,
    headline: questionHeadline(q.kind),
    why: q.facts,
    at: q.askedAt,
    attemptId: q.attemptIds[0],
    questionId: q.id,
    link: taskPath(i.project, q.intentId),
    actions: q.options.map((o, n) => ({ id: o.id, label: o.label, ...(n === 0 ? { primary: true } : {}), ...(q.kind === "escalation" && o.id !== "both" ? { note: true } : {}) })),
  };
}

/**
 * What waits for this person in one project, oldest first. Only the items that the person may answer: an
 * approval of another sender is not in the inbox of a member.
 */
export function inboxOf(i: InboxInput, who: { id: string | null | undefined; role: Role | null | undefined }): InboxItem[] {
  if (!who.id || !atLeast(who.role, "member")) return [];
  const intentById = new Map(i.intents.map((x) => [x.id, x]));
  const attemptById = new Map(i.attempts.map((x) => [x.id, x]));
  const callsign = new Map(i.agents.map((g) => [g.id, g.callsign]));
  const titleOf = (intentId: string) => intentById.get(intentId)?.title ?? "A task";
  const out: InboxItem[] = [];
  const covered = new Set<string>();

  for (const a of i.attempts) {
    const ap = a.approval;
    if (a.status !== "ready" || ap?.status !== "waiting") continue;
    covered.add(a.intentId);
    if (!canDecide(ap, who, i.rule)) continue;
    out.push(approvalItem(i, a, ap, titleOf(a.intentId), callsign.get(a.agentId) ?? a.agentId));
  }

  for (const q of i.questions) {
    if (q.status !== "open") continue;
    covered.add(q.intentId);
    const senders = q.attemptIds.map((id) => attemptById.get(id)?.sender);
    if (!canAnswerQuestion(senders, who, i.rule)) continue;
    out.push(questionItem(i, q, titleOf(q.intentId)));
  }

  // A task that waits for a person, with no question about it (work from before questions existed).
  for (const t of i.intents) {
    if (t.status !== "judging" || covered.has(t.id)) continue;
    out.push({
      key: `task:${t.id}`,
      kind: "task",
      project: i.project,
      intentId: t.id,
      title: t.title,
      headline: "A person decides on this task",
      why: ["The work of this task waits for a person. Open the task to compare the work and decide."],
      at: t.updatedAt,
      link: taskPath(i.project, t.id),
      actions: [{ id: "open", label: "Open the task", primary: true }],
    });
  }
  return out.sort((x, y) => x.at - y.at);
}
