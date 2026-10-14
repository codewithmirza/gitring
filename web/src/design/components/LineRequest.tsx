/**
 * The line request: pick lines in a diff, then ask the agent to change them in a form.
 * The agent gets the request as a change request in the answer of its next call.
 */
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Icon } from "../icons";
import { Button } from "./Button";
import { Input, Textarea } from "./Field";

/** The lines a person selected in a diff: new line numbers of one file. `anchor` is the first line they picked. */
export interface LineSelection {
  path: string;
  from: number;
  to: number;
  anchor: number;
}

/** What a line request sends: the lines of the work copy's version of the file, and the words for the agent. */
export interface LineRequestInput {
  path: string;
  from: number;
  to: number;
  text: string;
}

/**
 * Pick a line. A plain pick selects that one line. With `extend` (Shift, or a second pick in the same file
 * while the form is open and empty), the range goes from the first line to this one.
 */
export function pickLine(sel: LineSelection | null, path: string, line: number, extend: boolean): LineSelection {
  if (!extend || !sel || sel.path !== path) return { path, from: line, to: line, anchor: line };
  return { path, from: Math.min(sel.anchor, line), to: Math.max(sel.anchor, line), anchor: sel.anchor };
}

export function inSelection(sel: LineSelection | null, path: string, line: number | undefined): boolean {
  return Boolean(sel && line !== undefined && sel.path === path && line >= sel.from && line <= sel.to);
}

/** "line 4" or "lines 4–7". */
export function linesText(from: number, to: number): string {
  return from === to ? `line ${from}` : `lines ${from}–${to}`;
}

/** A plain sentence when the request cannot go out, or null when it can. */
export function lineRequestProblem(input: LineRequestInput): string | null {
  if (!Number.isInteger(input.from) || !Number.isInteger(input.to) || input.from < 1 || input.to < input.from) return "Give the lines: from 1 or more, and to not before from.";
  if (!input.text.trim()) return "Write what the agent must change.";
  return null;
}

/**
 * The form under the selected lines: "Ask the agent to change this". The agent gets a change request in the
 * answer of its next call. Enter with Ctrl or ⌘ sends; Escape closes.
 */
export function LineRequestForm({ sel, onSend, onCancel }: { sel: LineSelection; onSend: (input: LineRequestInput) => Promise<void>; onCancel: () => void }) {
  const [from, setFrom] = useState(sel.from);
  const [to, setTo] = useState(sel.to);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  useEffect(() => {
    setFrom(sel.from);
    setTo(sel.to);
  }, [sel.from, sel.to]);
  const send = async () => {
    const input = { path: sel.path, from, to, text: text.trim() };
    const problem = lineRequestProblem(input);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await onSend(input);
      setText("");
    } catch (e) {
      setError((e as Error).message || "gitring did not answer. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!busy) void send();
    }
  };
  return (
    <div className="b-linereq" role="group" aria-labelledby={`${uid}-t`} onKeyDown={onKey}>
      <p className="b-linereq__title" id={`${uid}-t`}>
        Ask the agent to change this
      </p>
      <p className="b-linereq__where">
        <span className="voice-agent">{sel.path}</span>
        <label htmlFor={`${uid}-from`}>lines</label>
        <Input id={`${uid}-from`} className="b-linereq__num" type="number" min={1} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
        <label htmlFor={`${uid}-to`}>to</label>
        <Input id={`${uid}-to`} className="b-linereq__num" type="number" min={1} value={to} onChange={(e) => setTo(Number(e.target.value))} />
      </p>
      <Textarea voice="human" rows={2} aria-label="What must the agent change?" value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder="What must change? For example: use the name person." />
      <div className="b-linereq__acts">
        <Button size="sm" variant="primary" icon="send" busy={busy} onClick={() => void send()}>
          Send to the agent
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && (
        <p className="b-linereq__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
    </div>
  );
}
