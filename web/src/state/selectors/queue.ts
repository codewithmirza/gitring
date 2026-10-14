/**
 * The queue of things that need a person: questions, merge approvals, escalations and work that waits for a pick.
 * Read by the shell (toasts, the tray and the top bar) through state/approvals.ts. The signed-in person decides who may answer.
 */
import type { AgentInfo, ApprovalReason, Attempt, CourseCheck, Intent, Person, ProjectState, Question } from "../../../../src/core/types";
import { noTestRan } from "../../../../src/core/types";
import type { Role } from "../../../../src/core/accounts";
import { approvalLine, canDecide } from "../../../../src/core/approvals";
import { canAnswerQuestion, questionDetail } from "../../../../src/core/inbox";
import { isActiveAttempt } from "./indexes";
import { byId, memo } from "./memo";

/* ───────────── types ───────────── */

/**
 * A question that asks a person to say yes to a merge. There is one for each work copy that is ready and
 * waits for the answer (`approval.status` is "waiting").
 */
export interface ApprovalItem {
  key: string;
  kind: "approval";
  intentId: string;
  /** The title of the task. */
  title: string;
  attemptId: string;
  approvalId: string;
  callsign: string;
  /** The agent's color number: --v0 to --v11. */
  color: number;
  /** One sentence for a glance: the size of the change and the tests (approvalLine). */
  line: string;
  /** Why a person must say yes, in plain sentences. */
  why: string[];
  reason: ApprovalReason;
  /** The person who answers. Absent: any member. An owner can always answer. */
  approver?: Person;
  /** Only an owner answers: a rule by folder asks for the yes of an owner. */
  ownerOnly?: boolean;
  askedAt: number;
  /** The signed-in person may answer this question (canDecide). */
  mayAnswer: boolean;
  attemptIds: string[];
  at: number;
}

/**
 * Other things that need a person. "escalation": the work could not merge, or a course check asks for a
 * person. "pick": work that is ready but has no question (the Worker did not ask one), so the person opens
 * the task and merges from there.
 */
export interface OtherJudgmentItem {
  key: string;
  kind: "pick" | "escalation";
  intentId: string;
  title: string;
  detail: string;
  attemptIds: string[];
  at: number;
}

/**
 * A question for a person (contract C4): an escalated conflict check asks which work adapts, or work that did
 * not merge asks for a redo or a pause. The answers are the options of the question.
 */
export interface QuestionItem {
  key: string;
  kind: "question";
  intentId: string;
  title: string;
  /** What the person decides, in a few words. */
  detail: string;
  question: Question;
  /** The signed-in person may answer this question (canAnswerQuestion). */
  mayAnswer: boolean;
  attemptIds: string[];
  at: number;
}

export type JudgmentItem = ApprovalItem | OtherJudgmentItem | QuestionItem;

/** The person who looks at the queue: the account id and the role on this project. */
export interface Who {
  id?: string | null;
  role?: Role | null;
}

/* ───────────── the queue ───────────── */

const NO_QUESTIONS: Question[] = [];

const queueMemo = memo(
  (intents: Intent[], attempts: Attempt[], checks: CourseCheck[], agents: AgentInfo[], questions: Question[], rule: "sender" | "owner", userId: string, role: string): JudgmentItem[] => {
    const out: JudgmentItem[] = [];
    const agentById = byId(agents);
    const intentById = byId(intents);
    const attemptsById = byId(attempts);
    const who = { id: userId || null, role: (role || null) as Role | null };

    // One item for each open question. A question names its work copies: the older items for them do not show,
    // also after a person answered it (the check that asked stays the latest check of the work copy).
    const asked = new Set<string>();
    const askedTasks = new Set<string>();
    for (const q of questions) {
      for (const id of q.attemptIds) asked.add(id);
      if (q.status !== "open") continue;
      if (q.kind === "redo") askedTasks.add(q.intentId);
      out.push({
        key: `q:${q.id}`,
        kind: "question",
        intentId: q.intentId,
        title: intentById.get(q.intentId)?.title ?? "A decision needs a person",
        detail: questionDetail(q.kind),
        question: q,
        mayAnswer: canAnswerQuestion(
          q.attemptIds.map((id) => attemptsById.get(id)?.sender),
          who,
          rule,
        ),
        attemptIds: q.attemptIds,
        at: q.askedAt,
      });
    }

    // One question for each ready work copy that waits for a yes.
    for (const a of attempts) {
      const ap = a.approval;
      if (a.status !== "ready" || !ap || ap.status !== "waiting") continue;
      const agent = agentById.get(a.agentId);
      out.push({
        key: `ap:${ap.id}`,
        kind: "approval",
        intentId: a.intentId,
        title: intentById.get(a.intentId)?.title ?? "Unknown task",
        attemptId: a.id,
        approvalId: ap.id,
        callsign: agent?.callsign ?? a.agentId.toUpperCase(),
        color: agent?.color ?? 0,
        line: approvalLine(a),
        why: ap.why,
        reason: ap.reason,
        approver: ap.approver,
        ...(ap.ownerOnly ? { ownerOnly: true } : {}),
        askedAt: ap.askedAt,
        mayAnswer: canDecide(ap, who, rule),
        attemptIds: [a.id],
        at: ap.askedAt,
      });
    }

    for (const i of intents) {
      if (i.status !== "judging") continue;
      const ready = attempts.filter((a) => a.intentId === i.id && a.status === "ready");
      if (!ready.length) {
        // A redo question asks this already.
        if (askedTasks.has(i.id)) continue;
        // No work copy is ready: the work could not merge, or its agent did not answer.
        const open = attempts.filter((a) => a.intentId === i.id && isActiveAttempt(a));
        out.push({
          key: `stuck:${i.id}`,
          kind: "escalation",
          intentId: i.id,
          title: i.title,
          detail: "The work could not merge. Redo it on the new main, or pause the task",
          attemptIds: open.map((a) => a.id),
          at: i.updatedAt,
        });
        continue;
      }
      // A work copy with a question (or an answer) has its own item. Work without any question is old
      // work: a person opens the task and merges from there.
      if (ready.some((a) => a.approval)) continue;
      // No test ran for any of them: nothing is verified, and a person must decide.
      const untested = ready.every((a) => noTestRan(a.composedChecks ?? a.checks));
      const n = ready.length;
      out.push({
        key: `pick:${i.id}`,
        kind: "pick",
        intentId: i.id,
        title: i.title,
        detail: untested
          ? `No test ran. A person must decide to merge${n > 1 ? `. ${n} work copies are ready` : ""}`
          : n > 1
            ? `${n} work copies are ready. A person must merge one`
            : "The work is ready. A person must merge it",
        attemptIds: ready.map((a) => a.id),
        at: i.updatedAt,
      });
    }

    const latest = new Map<string, CourseCheck>();
    for (const c of checks) {
      const p = latest.get(c.attemptId);
      if (!p || p.at <= c.at) latest.set(c.attemptId, c);
    }
    for (const c of latest.values()) {
      if (c.verdict !== "escalate") continue;
      const a = attemptsById.get(c.attemptId);
      if (!a || !isActiveAttempt(a) || asked.has(a.id)) continue;
      out.push({
        key: `esc:${c.id}`,
        kind: "escalation",
        intentId: a.intentId,
        title: intentById.get(a.intentId)?.title ?? "A decision needs a person",
        detail: `Decide on the work of ${agentById.get(a.agentId)?.callsign ?? a.agentId}`,
        attemptIds: [a.id],
        at: c.at,
      });
    }
    return out.sort((x, y) => x.at - y.at);
  },
);

/**
 * What needs a person, oldest first: one question for each merge that waits for a yes, the open questions
 * (which work adapts, a redo or a pause), tasks that could not merge, and course checks that ask for a person
 * (from before questions existed). `who` is the signed-in person: it decides `mayAnswer`.
 */
export function selectJudgmentQueue(st: ProjectState, who: Who = {}): JudgmentItem[] {
  return queueMemo(st.intents, st.attempts, st.checks, st.agents, st.questions ?? NO_QUESTIONS, st.project?.settings?.approver === "owner" ? "owner" : "sender", who.id ?? "", who.role ?? "");
}
