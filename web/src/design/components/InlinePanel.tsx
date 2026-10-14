/**
 * A short form that opens in place under the control that asked for it, instead of a modal dialog.
 * Escape closes it and the focus goes back to the control.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { tabbables } from "./Popover";

interface InlinePanelProps {
  /** Accessible name of the panel, for example "Merge the work of PETREL-2". */
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** Focus goes back here when the panel closes while it has focus (usually the button that opened it). */
  returnFocus?: RefObject<HTMLElement | null>;
  className?: string;
  /** Render as a form: Enter in a field submits. */
  onSubmit?: () => void;
}

/**
 * A short form that opens in place, under the control that asked for it (instead of a modal dialog).
 * Focus moves to [data-autofocus] or the first control; Escape closes it; focus goes back to the trigger.
 */
export function InlinePanel({ label, onClose, children, returnFocus, className, onSubmit }: InlinePanelProps) {
  const ref = useRef<HTMLElement | null>(null);
  const inside = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>("[data-autofocus]") ?? tabbables(el)[0];
    target?.focus({ preventScroll: true });
    inside.current = Boolean(target);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    const onIn = (e: FocusEvent) => {
      inside.current = el.contains(e.target as Node);
    };
    document.addEventListener("focusin", onIn);
    return () => {
      document.removeEventListener("focusin", onIn);
      const back = returnFocus?.current;
      const active = document.activeElement;
      if (back?.isConnected && (inside.current || !active || active === document.body)) requestAnimationFrame(() => back.focus({ preventScroll: true }));
    };
    // Runs once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || !e.currentTarget.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  const cls = ["b-inline", className].filter(Boolean).join(" ");
  if (onSubmit) {
    return (
      <form
        ref={(el) => {
          ref.current = el;
        }}
        className={cls}
        aria-label={label}
        onKeyDown={onKeyDown}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        noValidate
      >
        {children}
      </form>
    );
  }
  return (
    <div
      ref={(el) => {
        ref.current = el;
      }}
      className={cls}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
