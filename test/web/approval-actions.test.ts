/** Sending an answer: one request, the words of the toast, and the card that moves when the answer came. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, Attempt, ProjectState } from "../../src/core/types";

const decide = vi.fn();
const toast = vi.fn();
vi.mock("../../web/src/state/api", () => ({ harbor: () => ({ decide }) }));
vi.mock("../../web/src/design/components", () => ({ toast: (t: unknown) => toast(t) }));

const waiting: Approval = { id: "ap_1", status: "waiting", reason: "project-asks", why: ["This project asks a person before every merge."], digest: "d", askedAt: 5 };

function stateWith(approval: Approval, status: Attempt["status"] = "ready"): ProjectState {
  const attempt = { id: "at_1", intentId: "i1", agentId: "g1", status, approval, stats: { filesChanged: 1, additions: 1, deletions: 0, steps: 1 }, createdAt: 1, updatedAt: 1 } as Attempt;
  return { project: { id: "shop", settings: {} }, intents: [], attempts: [attempt], agents: [], corrections: [], checks: [], landings: [], decisions: [], logs: [], radar: [], files: [], imports: [], stats: {} } as unknown as ProjectState;
}

const input = { attemptId: "at_1", approvalId: "ap_1", title: "Add a search box" } as const;

describe("answerApproval", async () => {
  const { answerApproval } = await import("../../web/src/app/approvalActions");
  const { store } = await import("../../web/src/state/store");
  const attemptNow = () => store.get().state!.attempts[0];

  beforeEach(() => {
    decide.mockReset();
    toast.mockReset();
    // A snapshot of another project starts the store clean.
    store.dispatch({ type: "snapshot", state: { ...stateWith(waiting), project: { id: `shop-${Math.random()}`, settings: {} } } as unknown as ProjectState });
    store.dispatch({ type: "snapshot", state: stateWith(waiting) });
  });

  it("sends the question that the person saw, and shows the merge in a toast with the record", async () => {
    decide.mockResolvedValue({
      attemptId: "at_1",
      outcome: "approved",
      approval: { ...waiting, status: "approved" },
      status: "landed",
      message: "Merged by fast-forward at abcdef1.",
      landing: { id: "l1", mainAfter: "abcdef1234567" },
    });
    const r = await answerApproval({ ...input, answer: "approve", note: "ignored for a yes" });
    expect(decide).toHaveBeenCalledWith("at_1", { approvalId: "ap_1", answer: "approve", note: undefined });
    expect(r).toMatchObject({ ok: true, kind: "merged" });
    expect(toast).toHaveBeenCalledTimes(1);
    const t = toast.mock.calls[0][0];
    expect(t).toMatchObject({ tone: "clear", title: "Merged into main abcdef1", text: "“Add a search box”. Merged by fast-forward at abcdef1." });
    expect(t.action.label).toBe("Read the merge record");
    // The card leaves at once: the state shows the answer before the live connection brings it.
    expect(attemptNow().approval?.status).toBe("approved");
    expect(attemptNow().status).toBe("landed");
  });

  it("sends the note of a send-back without the spaces around it", async () => {
    decide.mockResolvedValue({ attemptId: "at_1", outcome: "sent-back", approval: { ...waiting, status: "sent-back" }, status: "underway", message: "The work went back to the agent with your note. The agent changes it and submits again." });
    await answerApproval({ ...input, answer: "send-back", note: "  Keep the old name.  " });
    expect(decide).toHaveBeenCalledWith("at_1", { approvalId: "ap_1", answer: "send-back", note: "Keep the old name." });
    expect(toast.mock.calls[0][0]).toMatchObject({ tone: "info", title: "Sent back to the agent" });
    expect(attemptNow().approval?.status).toBe("sent-back");
    // An empty note is no note.
    decide.mockResolvedValue({ attemptId: "at_1", outcome: "already", approval: { ...waiting, status: "sent-back" }, status: "underway", message: "Robin sent back this work already." });
    await answerApproval({ ...input, answer: "send-back", note: "   " });
    expect(decide).toHaveBeenLastCalledWith("at_1", { approvalId: "ap_1", answer: "send-back", note: undefined });
  });

  it("says that the merge waits for the test budget", async () => {
    decide.mockResolvedValue({ attemptId: "at_1", outcome: "approved", approval: { ...waiting, status: "approved" }, status: "ready", message: "The test budget for this hour is used.", waits: { until: 9 } });
    const r = await answerApproval({ ...input, answer: "approve" });
    expect(r).toMatchObject({ ok: true, kind: "waits" });
    expect(toast.mock.calls[0][0]).toMatchObject({ tone: "info", title: "The merge waits" });
  });

  it("shows a refusal as a sentence and leaves the question where it is", async () => {
    decide.mockResolvedValue({ attemptId: "at_1", outcome: "refused", approval: waiting, status: "ready", message: "Only an owner of the project can answer this." });
    const r = await answerApproval({ ...input, answer: "approve" });
    expect(r).toMatchObject({ ok: true, kind: "refused" });
    expect(toast.mock.calls[0][0]).toMatchObject({ tone: "danger", title: "You cannot answer this", text: "“Add a search box”. Only an owner of the project can answer this." });
    expect(attemptNow().approval?.status).toBe("waiting");
  });

  it("does not move a newer question when the answer was for an old one", async () => {
    const again: Approval = { ...waiting, id: "ap_2" };
    store.dispatch({ type: "snapshot", state: stateWith(again) });
    decide.mockResolvedValue({ attemptId: "at_1", outcome: "withdrawn", approval: again, status: "ready", message: "This question is old. The work changed, and gitring asked again. Open the new question." });
    const r = await answerApproval({ ...input, answer: "approve" });
    expect(r).toMatchObject({ ok: true, kind: "old" });
    expect(attemptNow().approval?.id).toBe("ap_2");
    expect(attemptNow().approval?.status).toBe("waiting");
  });

  it("does not overwrite a state that is newer than the answer", async () => {
    // The live connection brought the merge before the answer came back.
    store.dispatch({ type: "snapshot", state: stateWith({ ...waiting, status: "approved" }, "landed") });
    decide.mockResolvedValue({ attemptId: "at_1", outcome: "approved", approval: { ...waiting, status: "approved" }, status: "landing", message: "x", landing: { id: "l1", mainAfter: "abcdef1234567" } });
    await answerApproval({ ...input, answer: "approve" });
    expect(attemptNow().status).toBe("landed");
  });

  it("turns a failed request into a result and a danger toast", async () => {
    decide.mockRejectedValue(new Error("gitring did not answer. Check the connection and try again."));
    const r = await answerApproval({ ...input, answer: "approve" });
    expect(r).toEqual({ ok: false, error: "gitring did not answer. Check the connection and try again." });
    expect(toast.mock.calls[0][0]).toMatchObject({ tone: "danger", title: "The answer did not send" });
  });

  it("shows no toast when the screen shows the result by itself", async () => {
    decide.mockResolvedValue({ attemptId: "at_1", outcome: "sent-back", approval: { ...waiting, status: "sent-back" }, status: "underway", message: "ok" });
    await answerApproval({ ...input, answer: "send-back", quiet: true });
    decide.mockRejectedValue(new Error("no"));
    await answerApproval({ ...input, answer: "approve", quiet: true });
    expect(toast).not.toHaveBeenCalled();
  });

  it("sends one answer at a time for the same question", async () => {
    let release!: () => void;
    decide.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ attemptId: "at_1", outcome: "approved", approval: { ...waiting, status: "approved" }, status: "ready", message: "ok", waits: { until: 9 } }))));
    const first = answerApproval({ ...input, answer: "approve" });
    const second = await answerApproval({ ...input, answer: "approve" });
    expect(second.ok).toBe(false);
    expect(decide).toHaveBeenCalledTimes(1);
    release();
    expect((await first).ok).toBe(true);
    // The question is free again.
    decide.mockResolvedValue({ attemptId: "at_1", outcome: "already", approval: { ...waiting, status: "approved" }, status: "ready", message: "Robin said yes to this work already." });
    expect((await answerApproval({ ...input, answer: "approve" })).ok).toBe(true);
  });
});
