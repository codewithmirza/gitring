/**
 * A tooltip: it shows on hover and on focus after 400 ms and repeats a label.
 * It never holds the only copy of key information.
 */
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  label: ReactNode;
  children: ReactElement;
  /** ms before the tooltip shows (default 400). */
  delay?: number;
  placement?: "top" | "bottom";
}

type AnyProps = Record<string, unknown> & {
  onMouseEnter?: (e: unknown) => void;
  onMouseLeave?: (e: unknown) => void;
  onFocus?: (e: unknown) => void;
  onBlur?: (e: unknown) => void;
  "aria-describedby"?: string;
};

/**
 * Tooltip: shows on hover and on focus after 400ms. It never holds the only copy
 * of key information; it repeats a label or adds a keyboard hint.
 */
export function Tooltip({ label, children, delay = 400, placement = "top" }: TooltipProps) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  const show = (el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAnchor(el), delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setAnchor(null);
    setPos(null);
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const tip = tipRef.current;
    const w = tip?.offsetWidth ?? 120;
    const h = tip?.offsetHeight ?? 24;
    const below = placement === "bottom" || r.top < h + 12;
    const x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const y = below ? r.bottom + 8 : r.top - h - 8;
    setPos({ x, y, below });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, [anchor, placement]);

  if (!isValidElement(children)) return children;
  const p = children.props as AnyProps;
  const child = cloneElement(children as ReactElement<AnyProps>, {
    "aria-describedby": anchor ? [p["aria-describedby"], id].filter(Boolean).join(" ") : p["aria-describedby"],
    onMouseEnter: (e: unknown) => {
      p.onMouseEnter?.(e);
      show((e as { currentTarget: HTMLElement }).currentTarget);
    },
    onMouseLeave: (e: unknown) => {
      p.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: unknown) => {
      p.onFocus?.(e);
      const t = (e as { currentTarget: HTMLElement }).currentTarget;
      if (t.matches(":focus-visible")) show(t);
    },
    onBlur: (e: unknown) => {
      p.onBlur?.(e);
      hide();
    },
  });

  return (
    <>
      {child}
      {anchor &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="b-tooltip"
            style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
