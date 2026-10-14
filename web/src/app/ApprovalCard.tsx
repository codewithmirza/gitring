/**
 * One question that asks for a yes: the task, the agent, the facts, the first reason and the answers.
 * The chips of the tray and the rows of the decisions list show this same card, so they say the same words.
 */
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { approvalPath } from "../../../src/core/approvals";
import { Button, Callsign, Textarea } from "../design/components";
import { useApproverRule, waitsFor } from "../state/approvals";
import type { ApprovalItem } from "../state/selectors";
import { useStore } from "../state/store";
import { answerApproval, useAnswering } from "./approvalActions";
import { Link } from "./router";
import "./approvals.css";

interface ApprovalCardProps {
  item: ApprovalItem;
  variant: "chip" | "row";
  /** A link in the card opens another page (the decisions list closes). */
  onOpen?: () => void;
  /** "Review" takes focus when the card opens in the decisions list. It is the safe first control: Enter only opens the page. */
  focusReview?: boolean;
}

export function ApprovalCard({ item, variant, onOpen, focusReview }: ApprovalCardProps) {
  const projectId = useStore((s) => s.state?.project.id ?? "");
  const rule = useApproverRule();
  const sending = useAnswering(item.approvalId);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const uid = useId();
  const titleId = `${uid}-title`;
  const noteId = `${uid}-note`;
  const toggle = useRef<HTMLButtonElement | null>(null);
  const busy = sending !== null;

  const yes = () => void answerApproval({ attemptId: item.attemptId, approvalId: item.approvalId, answer: "approve", title: item.title });
  const sendBack = async () => {
    const r = await answerApproval({ attemptId: item.attemptId, approvalId: item.approvalId, answer: "send-back", note, title: item.title });
    if (r.ok) {
      setNote("");
      setNoteOpen(false);
    }
  };
  const closeNote = () => {
    setNoteOpen(false);
    // The "Send back…" button comes back in the same frame; focus goes to it.
    requestAnimationFrame(() => toggle.current?.focus());
  };
  // Escape closes the note field only. The chip, the decisions list and the toasts keep what they show.
  const onNoteKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeNote();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!busy) void sendBack();
    }
  };

  const to = approvalPath(projectId, item.attemptId);
  return (
    <div className={`apcard apcard--${variant}`} role="group" aria-labelledby={titleId} data-attempt={item.attemptId}>
      <p className="apcard__title voice-human" id={titleId}>
        {item.title}
      </p>
      <p className="apcard__meta">
        <Callsign callsign={item.callsign} color={item.color} />
        <span className="apcard__line">{item.line}</span>
      </p>
      {item.why[0] && <p className="apcard__why">{item.why[0]}</p>}
      <div className="apcard__acts">
        <Link to={to} className="apcard__review" aria-describedby={titleId} onClick={onOpen} data-row-first="" data-autofocus={focusReview ? "" : undefined}>
          Review
        </Link>
        {item.mayAnswer ? (
          <>
            <Button size="sm" variant="primary" icon="merge" busy={sending === "approve"} disabled={busy && sending !== "approve"} aria-describedby={titleId} onClick={yes}>
              Yes, merge
            </Button>
            <Button
              ref={toggle}
              size="sm"
              aria-describedby={titleId}
              aria-expanded={noteOpen}
              aria-controls={noteOpen ? noteId : undefined}
              onClick={() => (noteOpen ? closeNote() : setNoteOpen(true))}
            >
              Send back…
            </Button>
          </>
        ) : (
          <span className="apcard__waits">Waits for {waitsFor(item.approver, item.ownerOnly ? "owner" : rule)}</span>
        )}
      </div>
      {noteOpen && item.mayAnswer && (
        <div className="apcard__note" onKeyDown={onNoteKey}>
          <label className="apcard__notelabel" htmlFor={noteId}>
            Tell the agent what to change <span className="apcard__opt">(optional)</span>
          </label>
          <Textarea id={noteId} voice="human" rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="For example: keep the old name of the function." />
          <div className="apcard__noteacts">
            <Button size="sm" busy={sending === "send-back"} disabled={busy && sending !== "send-back"} onClick={() => void sendBack()}>
              Send back
            </Button>
            <Button size="sm" variant="ghost" onClick={closeNote}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
