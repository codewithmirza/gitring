/**
 * Confirm a destructive action in place: the button turns into "Question? [Do it] [Keep]".
 * Focus goes to the safe choice; Escape or "Keep" returns focus to the button. No modal dialog.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../../design/components";
import type { IconName } from "../../design/icons";

interface InlineConfirmProps {
  /** The button text before the question, for example "Archive project". */
  label: string;
  /** Accessible name of the button when the label is short (for example "Remove Ada"). */
  ariaLabel?: string;
  /** One or two short sentences: what happens. */
  question: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => Promise<unknown> | void;
  icon?: IconName;
  size?: "sm" | "md";
  variant?: "danger" | "ghost" | "secondary";
  disabled?: boolean;
  className?: string;
}

export function InlineConfirm({ label, ariaLabel, question, confirmLabel, cancelLabel = "Keep", onConfirm, icon, size = "md", variant = "danger", disabled, className }: InlineConfirmProps) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const keep = useRef<HTMLButtonElement | null>(null);
  const qid = useId();

  useEffect(() => {
    if (asking) keep.current?.focus();
  }, [asking]);
  useEffect(() => {
    if (!asking && refocus) {
      trigger.current?.focus();
      setRefocus(false);
    }
  }, [asking, refocus]);

  const cancel = () => {
    setAsking(false);
    setRefocus(true);
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };

  if (!asking) {
    return (
      <Button ref={trigger} variant={variant} size={size} icon={icon} disabled={disabled} aria-label={ariaLabel} className={className} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span
      className={["np-confirm", className].filter(Boolean).join(" ")}
      role="group"
      aria-labelledby={qid}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <span id={qid} className="np-confirm__q">
        {question}
      </span>
      <span className="np-confirm__acts">
        <Button variant="danger" size={size} busy={busy} onClick={() => void confirm()}>
          {confirmLabel}
        </Button>
        <Button ref={keep} variant="ghost" size={size} onClick={cancel} aria-describedby={qid}>
          {cancelLabel}
        </Button>
      </span>
    </span>
  );
}
