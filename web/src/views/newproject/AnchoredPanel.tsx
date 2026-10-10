/**
 * A non-modal panel that grows from the button that opened it, with a tail that points at that button.
 * Under 600 px it is a full-width sheet directly under the button (the tail still points at it).
 *
 * - The panel follows the trigger in the DOM, so Tab moves from the trigger into the panel and on to the page.
 * - Focus moves into the panel when it opens ([data-autofocus] first).
 * - Escape closes it and returns focus to the trigger. An inner control that uses Escape itself calls
 *   preventDefault() on the key event, and the panel stays open.
 * - A click outside, or Tab past the end, closes it. The parent keeps the draft, so nothing typed is lost.
 * - The trigger sets aria-expanded and aria-controls={id}; the panel is role="dialog" (not modal).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";

export type CloseReason = "escape" | "outside";

interface AnchoredPanelProps {
  id: string;
  open: boolean;
  anchor: HTMLElement | null;
  onClose: (reason: CloseReason) => void;
  /** id of the visible heading that names the panel. */
  labelledBy?: string;
  label?: string;
  /** Width at desktop sizes (px). */
  width?: number;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}

interface Place {
  left: number;
  width: number;
  top: number | null;
  bottom: number | null;
  maxHeight: number;
  tail: number;
  side: "below" | "above";
  sheet: boolean;
}

const GAP = 10;
const EDGE = 8;
const SHEET_UNDER = 600;
const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), button:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AnchoredPanel({ id, open, anchor, onClose, labelledBy, label, width = 460, align = "start", className, children }: AnchoredPanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  const measure = useCallback(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const sheet = vw < SHEET_UNDER;
    const w = sheet ? vw - EDGE * 2 : Math.min(width, vw - EDGE * 2);
    let left = sheet ? EDGE : align === "end" ? r.right - w : r.left;
    left = Math.max(EDGE, Math.min(vw - EDGE - w, left));
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const side: Place["side"] = below >= 320 || below >= above ? "below" : "above";
    const tail = Math.max(18, Math.min(w - 18, r.left + r.width / 2 - left));
    setPlace({
      left,
      width: w,
      top: side === "below" ? r.bottom + GAP : null,
      bottom: side === "above" ? vh - r.top + GAP : null,
      maxHeight: Math.max(180, side === "below" ? below : above),
      tail,
      side,
      sheet,
    });
  }, [anchor, width, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    measure();
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", later);
    window.addEventListener("scroll", later, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", later);
      window.removeEventListener("scroll", later, true);
    };
  }, [open, measure]);

  // Focus moves in when the panel opens: after the first placement, because a hidden element takes no focus.
  const focused = useRef(false);
  const placed = place !== null;
  useEffect(() => {
    if (!open) {
      focused.current = false;
      return;
    }
    if (!placed || focused.current) return;
    focused.current = true;
    const el = ref.current;
    if (el?.contains(document.activeElement)) return;
    const target = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: true });
  }, [open, placed]);

  // A press outside closes the panel (the trigger toggles it itself).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || anchor?.contains(t)) return;
      close.current("outside");
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, anchor]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    close.current("escape");
    anchor?.focus();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    // null: a click on a non-focusable spot or another window (the outside press handles clicks).
    if (!next || ref.current?.contains(next) || anchor?.contains(next)) return;
    close.current("outside");
  };

  const style: CSSProperties & Record<"--tail" | "--pop-max", string> = place
    ? {
        left: place.left,
        width: place.width,
        top: place.top ?? undefined,
        bottom: place.bottom ?? undefined,
        maxHeight: place.maxHeight,
        "--tail": `${place.tail}px`,
        "--pop-max": `${place.maxHeight}px`,
      }
    : { left: -9999, top: -9999, visibility: "hidden", "--tail": "24px", "--pop-max": "100vh" };

  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={["np-pop", place?.side === "above" ? "is-above" : "is-below", place?.sheet && "is-sheet", className].filter(Boolean).join(" ")}
      style={style}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <span className="np-pop__tail" aria-hidden="true" />
      <div className="np-pop__body">{children}</div>
    </div>
  );
}
