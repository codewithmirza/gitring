/**
 * A sheet from the bottom of a phone screen. It holds the "Why line N?" answer or the history of a file.
 * It does not cover the line that it explains: the code gets room above it, and the line scrolls into that strip.
 * Tapping the code does not close it, so a person can tap another line number and read the next answer.
 * Close with the button or Escape. The sheet is not modal. Used by LineHistory.tsx. Styles: styles/sheet.css.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { popoverOpen } from "../../design/components";
import { Icon } from "../../design/icons";
import { revealLine } from "./view/whyLine";

export function BottomSheet({ open, onClose, label, title, returnTo, keepInView, children }: {
  open: boolean;
  onClose: () => void;
  /** The name that a screen reader says for the sheet. */
  label: string;
  /** The words at the top of the sheet. */
  title: string;
  /** The button that gets the focus back when the sheet closes. */
  returnTo: HTMLElement | null;
  /** The line that must stay in the strip above the sheet. */
  keepInView?: number | null;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus goes into the sheet, and back to the button when it closes.
  useLayoutEffect(() => {
    if (!open) return;
    const sheet = box.current;
    sheet?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (returnTo?.isConnected && (!active || active === document.body || sheet?.contains(active))) returnTo.focus({ preventScroll: true });
    };
    // The button is read once for each opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || popoverOpen()) return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // The page keeps room for the sheet (CSS: --why-sheet-h), and the line stays in the strip above it.
  useEffect(() => {
    const sheet = box.current;
    if (!open || !sheet) return;
    const root = document.documentElement;
    const settle = () => {
      root.style.setProperty("--why-sheet-h", `${Math.round(sheet.getBoundingClientRect().height)}px`);
      if (keepInView) requestAnimationFrame(() => revealLine(keepInView, sheet.getBoundingClientRect().top));
    };
    settle();
    const watch = typeof ResizeObserver !== "undefined" ? new ResizeObserver(settle) : null;
    watch?.observe(sheet);
    return () => {
      watch?.disconnect();
      root.style.removeProperty("--why-sheet-h");
    };
  }, [open, keepInView]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div ref={box} className="cv-sheet" role="dialog" aria-label={label} tabIndex={-1}>
      <div className="cv-sheet__head">
        <h2 className="cv-sheet__title">{title}</h2>
        <button type="button" className="cv-iconbtn cv-sheet__close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="cv-sheet__body">{children}</div>
    </div>,
    document.body,
  );
}
