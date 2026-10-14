/**
 * Plain words for people and agents: activity feed, tool results, wait events and Slack messages.
 * Imported by the layers in ../master/. One word for one thing: change a word here and it changes everywhere.
 */
import type * as T from "../../core/types";

export function slackText(event: string, p: Record<string, unknown>): string {
  if (event === "landing") {
    const l = p.landing as T.Landing;
    const i = p.intent as { title: string };
    return `:white_check_mark: *${i.title}* merged into main by ${METHOD_WORD[l.method]} (\`${String(p.mainSha).slice(0, 7)}\`) · ${p.callsign} · tests ${l.checks.passed}/${l.checks.passed + l.checks.failed}`;
  }
  if (event === "correction") {
    const c = p.correction as T.Correction;
    return `:large_purple_diamond: Change request for ${p.callsign} (${KIND_WORD[c.kind] ?? c.kind}): ${c.message}`;
  }
  if (event === "decision") {
    const d = p.decision as T.Decision;
    return `:scales: ${d.by.name} decided (${DECISION_WORD[d.kind] ?? d.kind}): ${d.rationale}`;
  }
  if (event === "approval") {
    const ap = p.approval as T.Approval;
    const who = ap.approver?.name ?? "A person of the project";
    if (ap.status === "waiting") return `:raised_hand: ${who}, say yes or send back: *${p.task}* by ${p.agent}. ${p.line} ${ap.why[0] ?? ""} ${p.link}`.trim();
    if (ap.status === "approved") return `:white_check_mark: ${ap.answer?.by.name ?? "A person"} said yes to *${p.task}* (${p.agent}).`;
    return `:leftwards_arrow_with_hook: ${ap.answer?.by.name ?? "A person"} sent *${p.task}* back to ${p.agent}${ap.answer?.note ? `: ${ap.answer.note}` : "."}`;
  }
  if (event === "question") {
    const q = p.question as T.Question;
    if (q.status === "answered") return `:scales: ${q.answer?.by.name ?? "A person"} answered about *${p.task}*: ${q.options.find((o) => o.id === q.answer?.option)?.label ?? q.answer?.option}.`;
    if (q.status === "closed") return `:heavy_minus_sign: The question about *${p.task}* closed. ${q.closed ?? ""}`.trim();
    return `:raised_hand: A person decides on *${p.task}*: ${q.facts[0] ?? ""} ${q.options.map((o) => o.label).join(" / ")}. ${p.link}`.trim();
  }
  if (event === "intent") return `:memo: New task: *${(p.intent as { title: string }).title}*`;
  return `${event}: ${JSON.stringify(p).slice(0, 300)}`;
}

/* Plain words for people and agents (activity feed, tool results, Slack). */
export const METHOD_WORD: Record<T.LandingMethod, string> = { "fast-forward": "fast-forward", merge: "3-way merge", rederive: "redo", revert: "revert" };
export const VERDICT_WORD: Record<T.Verdict, string> = { clear: "clear", correct: "change request", "merge-intents": "same task as other work", escalate: "a person decides" };
export const KIND_WORD: Record<T.CorrectionKind, string> = { interface: "function change", region: "same lines", duplicate: "same task", upstream: "main moved", "intent-amended": "task changed", review: "a person sent it back", reverted: "merge reverted" };
export const TRIGGER_WORD: Record<T.CourseCheck["trigger"], string> = { declare: "plan", log: "report", write: "write", push: "push", "main-advanced": "main moved", "intent-amended": "task changed" };
export const DECISION_WORD: Record<T.DecisionKind, string> = { pick: "chose a work copy", "send-back": "sent work back", rederive: "redo", amend: "changed the goal", park: "paused the task", "approve-checks": "approved the tests", "resolve-escalation": "decided" };

export function taskStatusWord(s: T.IntentStatus): string {
  const words: Partial<Record<T.IntentStatus, string>> = { landed: "merged", parked: "paused", "merged-into": "joined to another task", judging: "needs a person", underway: "in work", landing: "merging", draft: "a draft" };
  return words[s] ?? s;
}

export function copyStatusWord(s: T.AttemptStatus): string {
  const words: Partial<Record<T.AttemptStatus, string>> = { landed: "merged", landing: "merging", stale: "out of date", rederiving: "in a redo", alternate: "an alternative", abandoned: "stopped", declared: "new", underway: "in work", ready: "ready to merge" };
  return words[s] ?? s;
}

/** gitring_wait: how long an agent waits, in seconds (contract C1). */
export const WAIT_SECONDS = { default: 25, max: 50 };
/** Events that come within this time of the first one go into the same answer of gitring_wait. */
export const WAIT_GATHER_MS = 50;

/** The status of a work copy in the words of gitring_wait (no "-ing" forms). */
export function waitStatusWord(s: T.AttemptStatus): string {
  const words: Partial<Record<T.AttemptStatus, string>> = { landing: "in the merge", checking: "in the tests", submitted: "sent for a merge" };
  return words[s] ?? copyStatusWord(s);
}

export function requestEvent(id: string, kind: T.CorrectionKind): T.WaitEvent {
  return { kind: "change-request", at: Date.now(), correctionId: id, message: `gitring sent the change request ${id} (${KIND_WORD[kind] ?? kind}).` };
}

export function statusEvent(status: T.AttemptStatus): T.WaitEvent {
  return { kind: "status", at: Date.now(), status, message: `The work copy is ${waitStatusWord(status)}.` };
}

/** The answer of a person (or the state of the question), in one sentence for the agent. */
export function approvalWord(a: T.Attempt): string {
  const ap = a.approval;
  const who = ap?.answer?.by.name ?? "A person";
  if (ap?.status === "approved") return `${who} said yes to the merge.`;
  if (ap?.status === "sent-back") return `${who} sent the work back.`;
  if (ap?.status === "withdrawn") return "The question to the person closed. Submit again to ask again.";
  return "A person must say yes before the merge.";
}
