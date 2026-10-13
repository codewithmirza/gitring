/**
 * Answer a question that asks for a yes. A chip, the decisions list and the approve page all use this
 * one function, so every screen sends the same request and says the same words.
 */
import { useSyncExternalStore } from "react";
import { toast } from "../design/components";
import { harbor, harborOrNull, LiveHarbor, type ApprovalResult } from "../state/api";
import { answerKind, type AnswerKind } from "../state/approvals";
import { shortSha } from "../state/format";
import { store } from "../state/store";
import { navigate } from "./router";

export type Answer = "approve" | "send-back";

export interface AnswerInput {
  attemptId: string;
  approvalId: string;
  answer: Answer;
  /** For "send-back": what the agent must change. Optional. */
  note?: string;
  /** The title of the task, for the toast. */
  title: string;
  /** The screen shows the result in place: no toast. */
  quiet?: boolean;
  /** The project of the question, when it is not the open project (the inbox shows all projects). */
  projectId?: string;
}

export type AnswerResult = { ok: true; kind: AnswerKind; result: ApprovalResult } | { ok: false; error: string };

/** Answers on their way, by approval id. Every card for the same question shows the busy state. */
const sending = new Map<string, Answer>();
const listeners = new Set<() => void>();

function setSending(id: string, answer: Answer | null) {
  if (answer) sending.set(id, answer);
  else sending.delete(id);
  listeners.forEach((l) => l());
}

/** The answer that is on its way for this question (null: none). */
export function useAnswering(approvalId: string): Answer | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => sending.get(approvalId) ?? null,
    () => null,
  );
}

const FALLBACK: Record<AnswerKind, string> = {
  merged: "The work is in main.",
  waits: "The merge waits for the hourly test budget.",
  "not-merged": "The work did not merge. gitring does the task again on the new main.",
  "sent-back": "The work went back to the agent.",
  already: "Somebody answered this before.",
  old: "This question is old. The work changed, and gitring asked again.",
  refused: "You cannot answer this.",
};

function report(input: AnswerInput, kind: AnswerKind, r: ApprovalResult) {
  const text = `“${input.title}”. ${r.message || FALLBACK[kind]}`;
  switch (kind) {
    case "merged": {
      const landing = r.landing!;
      toast({
        tone: "clear",
        title: `Merged into main ${shortSha(landing.mainAfter)}`,
        text,
        action: { label: "Read the merge record", onClick: () => navigate(`/history/${landing.id}`) },
      });
      return;
    }
    case "waits":
      toast({ tone: "info", title: "The merge waits", text });
      return;
    case "not-merged":
      toast({ tone: "info", title: "The work did not merge yet", text });
      return;
    case "sent-back":
      toast({ tone: "info", title: "Sent back to the agent", text });
      return;
    case "already":
      toast({ tone: "info", title: "Answered before", text });
      return;
    case "old":
      toast({ tone: "info", title: "This question is old", text });
      return;
    default:
      toast({ tone: "danger", title: "You cannot answer this", text });
  }
}

/**
 * The live connection brings the whole change of the work copy. Until it comes, the answer moves the card:
 * only while the state still shows the question that waited, so that a newer state is never overwritten.
 */
function applyAnswer(r: ApprovalResult) {
  const a = store.get().state?.attempts.find((x) => x.id === r.attemptId);
  if (!a || a.approval?.id !== r.approval.id || a.approval.status !== "waiting" || r.approval.status === "waiting") return;
  store.dispatch({ type: "attempt", attempt: { ...a, status: r.status, approval: r.approval } });
}

/** The client of the project of a question: the open project, or another one (the inbox shows all projects). */
function clientFor(projectId: string | undefined) {
  if (!projectId) return harbor();
  const open = harborOrNull();
  return open?.projectId === projectId ? open : new LiveHarbor(projectId);
}

/**
 * Send a person's answer. A refusal, an answer that came too late and a request that failed all come back
 * as a result with a plain sentence: this function does not throw. A second answer for the same question
 * waits until the first one is done.
 */
export async function answerApproval(input: AnswerInput): Promise<AnswerResult> {
  if (sending.has(input.approvalId)) return { ok: false, error: "gitring is sending your answer." };
  setSending(input.approvalId, input.answer);
  try {
    const note = input.answer === "send-back" ? input.note?.trim() || undefined : undefined;
    const result = await clientFor(input.projectId).decide(input.attemptId, { approvalId: input.approvalId, answer: input.answer, note });
    const kind = answerKind(result);
    applyAnswer(result);
    if (!input.quiet) report(input, kind, result);
    return { ok: true, kind, result };
  } catch (e) {
    const error = (e as Error).message || "gitring did not answer. Try again.";
    if (!input.quiet) toast({ tone: "danger", title: "The answer did not send", text: error });
    return { ok: false, error };
  } finally {
    setSending(input.approvalId, null);
  }
}
