/**
 * A dialog on the native dialog element, as a centered window or as a side sheet.
 * The browser holds the focus inside and Escape closes it. Focus returns to the control that opened it.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./Button";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
  /** Side sheet (drawer) instead of a centered dialog. */
  drawer?: boolean;
  /** Close when the scrim is clicked. Off for forms, so input is not lost. */
  dismissOnScrim?: boolean;
  className?: string;
}

/**
 * Dialog on the native <dialog>: modal focus containment, Escape closes, focus
 * returns to the element that opened it.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = "md", drawer, dismissOnScrim = !!drawer, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", "");
      }
      const auto = d.querySelector<HTMLElement>("[autofocus], [data-autofocus]");
      (auto ?? d.querySelector<HTMLElement>(".b-dialog__body input, .b-dialog__body textarea, .b-dialog__body select, .b-dialog__body button"))?.focus();
    } else if (!open && d.open) {
      d.close();
      returnTo.current?.focus?.();
    }
  }, [open]);

  useEffect(
    () => () => {
      if (ref.current?.open) {
        ref.current.close();
        returnTo.current?.focus?.();
      }
    },
    [],
  );

  return (
    <dialog
      ref={ref}
      className={[drawer ? "b-drawer" : "b-dialog", size === "lg" && !drawer && "b-dialog--lg", className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (dismissOnScrim && e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="b-dialog__head">
            <div className="b-dialog__titles">
              <h2 className="b-dialog__title" id={titleId}>
                {title}
              </h2>
              {description && (
                <p className="b-dialog__desc" id={descId}>
                  {description}
                </p>
              )}
            </div>
            <IconButton icon="close" label="Close" shortcut="Esc" onClick={onClose} />
          </div>
          <div className="b-dialog__body">{children}</div>
          {footer && <div className="b-dialog__foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
