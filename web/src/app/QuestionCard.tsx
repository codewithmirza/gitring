/**
 * One question for a person (contract C4): which work adapts after an escalated conflict check, or what
 * happens with work that did not merge. The decisions list and the inbox show this same card, with the
 * answers in place (no modal). A note is optional; it goes to the agent with the change request.
 */
import { useId, useState } from "react";
import type { QuestionResult } from "../../../src/core/types";
import { Button, Textarea, toast } from "../design/components";
import { answerQuestion } from "../state/inbox";
import { Link } from "./router";
import "./approvals.css";

export interface QuestionOptionView {
  id: string;
  label: string;
  primary?: boolean;
  /** This answer can carry a note for the agent. */
  note?: boolean;
}

interface QuestionCardProps {
  projectId: string;
  questionId: string;
  title: string;
  headline: string;
  facts: string[];
  options: QuestionOptionView[];
  mayAnswer: boolean;
  /** The task in the app, where the person reads more. */
  to?: string;
  variant: "row" | "card";
  /** The first control takes focus when the list opens. */
  first?: boolean;
  onOpen?: () => void;
  onDone?: (r: QuestionResult) => void;
}

/** The toast after an answer: the server's sentence. */
function report(title: string, r: QuestionResult) {
  if (r.outcome === "answered") toast({ tone: "clear", title: "Answer sent", text: `“${title}”. ${r.message}` });
  else if (r.outcome === "refused") toast({ tone: "danger", title: "You cannot answer this", text: r.message });
  else toast({ tone: "info", title: r.outcome === "already" ? "Answered before" : "This question is closed", text: r.message });
}

export function QuestionCard({ projectId, questionId, title, headline, facts, options, mayAnswer, to, variant, first, onOpen, onDone }: QuestionCardProps) {
  const [sending, setSending] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const uid = useId();
  const titleId = `${uid}-title`;
  const noteId = `${uid}-note`;
  const takesNote = options.some((o) => o.note);
  const [shown, more] = [facts.slice(0, variant === "row" ? 2 : 4), facts.slice(variant === "row" ? 2 : 4)];

  const send = async (option: string) => {
    if (sending) return;
    setSending(option);
    try {
      const withNote = options.find((o) => o.id === option)?.note ? note : undefined;
      const r = await answerQuestion(projectId, questionId, option, withNote);
      report(title, r);
      if (r.outcome !== "refused") {
        setNote("");
        setNoteOpen(false);
      }
      onDone?.(r);
    } catch (e) {
      toast({ tone: "danger", title: "The answer did not send", text: (e as Error).message || "gitring did not answer. Try again." });
    } finally {
      setSending(null);
    }
  };

  return (
    <div className={`apcard apcard--${variant} qcard`} role="group" aria-labelledby={titleId} data-question={questionId}>
      <p className="apcard__title voice-human" id={titleId}>
        {title}
      </p>
      <p className="apcard__why qcard__headline">{headline}</p>
      <ul className="qcard__facts">
        {shown.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
      {more.length > 0 && (
        <details className="qcard__more">
          <summary>More facts</summary>
          <ul className="qcard__facts">
            {more.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </details>
      )}
      {mayAnswer ? (
        <>
          <div className="apcard__acts qcard__acts">
            {options.map((o, i) => (
              <Button
                key={o.id}
                size="sm"
                variant={o.primary ? "primary" : "secondary"}
                busy={sending === o.id}
                disabled={sending !== null && sending !== o.id}
                aria-describedby={titleId}
                data-row-first={i === 0 ? "" : undefined}
                data-autofocus={i === 0 && first ? "" : undefined}
                onClick={() => void send(o.id)}
              >
                {o.label}
              </Button>
            ))}
            {takesNote && !noteOpen && (
              <Button size="sm" variant="ghost" aria-expanded={false} onClick={() => setNoteOpen(true)}>
                Add a note
              </Button>
            )}
            {to && (
              <Link to={to} className="apcard__review" onClick={onOpen}>
                Open the task
              </Link>
            )}
          </div>
          {noteOpen && (
            <div className="apcard__note">
              <label className="apcard__notelabel" htmlFor={noteId}>
                A note for the agent that adapts <span className="apcard__opt">(optional)</span>
              </label>
              <Textarea id={noteId} voice="human" rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="For example: keep the old parameters of price." />
            </div>
          )}
        </>
      ) : (
        <div className="apcard__acts">
          <span className="apcard__waits">Waits for a person who sent one of the agents, or an owner</span>
          {to && (
            <Link to={to} className="apcard__review" onClick={onOpen}>
              Open the task
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
