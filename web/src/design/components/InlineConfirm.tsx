import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "./Button";
import type { IconName } from "../icons";

interface InlineConfirmProps {
  /** Text of the first button, for example "Revoke". */
  label: string;
  icon?: IconName;
  /** One short sentence that says what happens, shown while the person decides. */
  consequence?: ReactNode;
  /** Text of the confirm button (default: the label). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Runs the action. A thrown error shows next to the buttons; the row stays open. */
  onConfirm: () => Promise<unknown> | unknown;
  size?: "sm" | "md";
  /** Accessible name of the first button when the label alone is not clear, for example "Revoke the key ci". */
  ariaLabel?: string;
  /** Seconds before the row goes back by itself (default 8). */
  timeout?: number;
  className?: string;
}

/**
 * Destructive actions confirm in place: the button becomes "Revoke? [Revoke] [Keep]" at the same spot.
 * The confirm button takes the place (and the focus) of the first button, so a second click confirms.
 * It arms after 300 ms, so a double click does not confirm by accident. The row goes back after a
 * short countdown, or on Escape or Keep.
 */
export function InlineConfirm({ label, icon, consequence, confirmLabel, cancelLabel = "Keep", onConfirm, size = "sm", ariaLabel, timeout = 8, className }: InlineConfirmProps) {
  const [state, setState] = useState<"idle" | "ask" | "busy">("idle");
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);
  const yes = useRef<HTMLButtonElement | null>(null);
  const msgId = useId();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    if (state !== "ask") return;
    yes.current?.focus();
    const arm = setTimeout(() => setArmed(true), 300);
    const back = setTimeout(() => {
      setState("idle");
      setError(null);
    }, timeout * 1000);
    return () => {
      clearTimeout(arm);
      clearTimeout(back);
    };
  }, [state, timeout]);

  const cancel = () => {
    setState("idle");
    setArmed(false);
    setError(null);
    requestAnimationFrame(() => first.current?.focus());
  };

  const confirm = async () => {
    if (!armed) return;
    setState("busy");
    setError(null);
    try {
      await onConfirm();
      if (mounted.current) setState("idle");
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message || "It did not work. Try again.");
      setState("ask");
    }
  };

  if (state === "idle") {
    return (
      <Button ref={first} size={size} variant="ghost" icon={icon} className={className} aria-label={ariaLabel} onClick={() => setState("ask")}>
        {label}
      </Button>
    );
  }
  return (
    <span
      className={["b-confirm", className].filter(Boolean).join(" ")}
      role="group"
      aria-label={ariaLabel ?? label}
      aria-describedby={consequence || error ? msgId : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      }}
      style={{ "--confirm-s": `${timeout}s` } as CSSProperties}
    >
      {(consequence || error) && (
        <span id={msgId} className={error ? "b-confirm__msg is-error" : "b-confirm__msg"} role={error ? "alert" : undefined}>
          {error ?? consequence}
        </span>
      )}
      <Button ref={yes} size={size} variant="danger" busy={state === "busy"} onClick={() => void confirm()}>
        {confirmLabel ?? label}
      </Button>
      <Button size={size} variant="ghost" onClick={cancel}>
        {cancelLabel}
      </Button>
      <span className="b-confirm__timer" aria-hidden="true" />
    </span>
  );
}
