import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { place, type Align, type Side } from "./placement";

export type PopoverCloseReason = "escape" | "outside" | "blur" | "tab" | "anchor-gone";

/** Open popovers, bottom to top. Escape and outside clicks act on the top one only. */
const stack: HTMLElement[] = [];

/** True while any anchored popover is open (global shortcuts stay quiet then). */
export function popoverOpen(): boolean {
  return stack.length > 0;
}

const FOCUSABLE =
  'a[href], area[href], button, input:not([type="hidden"]), select, textarea, iframe, [tabindex], [contenteditable="true"], summary';

/** Elements that Tab reaches inside `root`, in document order. */
export function tabbables(root: Document | HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.matches(":disabled") || el.tabIndex < 0) return false;
    if (el.closest("[hidden], [inert]")) return false;
    return el.getClientRects().length > 0;
  });
}

/** The tabbable element after (1) or before (-1) `from` in the document, skipping everything inside `skip`. */
export function nextTabbable(from: Element, dir: 1 | -1, skip?: Element | null): HTMLElement | null {
  const all = tabbables(document).filter((el) => !skip?.contains(el));
  if (dir === 1) return all.find((el) => from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !from.contains(el)) ?? null;
  for (let i = all.length - 1; i >= 0; i--) if (from.compareDocumentPosition(all[i]) & Node.DOCUMENT_POSITION_PRECEDING) return all[i];
  return null;
}

export interface PopoverProps {
  /** The trigger. The tail points at it, and focus goes back to it on Escape. */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: (reason: PopoverCloseReason) => void;
  children: ReactNode;
  /** Accessible name (or use labelledBy). */
  label?: string;
  labelledBy?: string;
  /** dialog: a panel with controls. menu: the content is a role="menu" element of its own (see Menu). */
  role?: "dialog" | "none";
  id?: string;
  side?: Side;
  align?: Align;
  /** A small arrow that points at the trigger (default on). */
  tail?: boolean;
  /** Preferred width in px on wide screens. */
  width?: number;
  className?: string;
  /** What gets focus on open: "auto" ([data-autofocus], else the first control), "container", "none", or a ref. */
  initialFocus?: "auto" | "container" | "none" | RefObject<HTMLElement | null>;
  /** Close when focus moves to an element outside the popover and its trigger (default on). */
  closeOnBlur?: boolean;
  /** Close on a click outside (default on). Drafts stay: the caller keeps its state. */
  closeOnOutside?: boolean;
  /** Under this viewport width the popover is a full-width sheet under its trigger. */
  sheetBelow?: number;
}

/**
 * Popover: a non-modal panel that grows from its trigger, with a tail that points at the trigger.
 * It flips above the trigger when there is no room below, and becomes a full-width sheet on phones.
 * Keyboard: focus moves in; Escape closes it and returns focus to the trigger; Tab past the last
 * control closes it and continues after the trigger. A click outside closes it.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  label,
  labelledBy,
  role = "dialog",
  id,
  side = "bottom",
  align = "start",
  tail = true,
  width,
  className,
  initialFocus = "auto",
  closeOnBlur = true,
  closeOnOutside = true,
  sheetBelow = 560,
}: PopoverProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const inside = useRef(false);
  const frame = useRef(0);

  const reposition = useCallback(() => {
    const wrap = wrapRef.current;
    const box = boxRef.current;
    if (!wrap || !box || !anchor) return;
    if (!anchor.isConnected) {
      onCloseRef.current("anchor-gone");
      return;
    }
    // Measure the natural size: clear the sizes of the last placement first.
    wrap.style.width = "";
    box.style.maxHeight = "";
    box.style.width = width ? `${width}px` : "";
    const r = anchor.getBoundingClientRect();
    const vv = window.visualViewport;
    const p = place({
      anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
      pop: { width: box.offsetWidth, height: box.offsetHeight },
      viewport: { width: document.documentElement.clientWidth, height: vv ? vv.height : window.innerHeight },
      side,
      align,
      gap: tail ? 10 : 6,
      sheetBelow,
    });
    wrap.style.left = `${Math.round(p.left)}px`;
    wrap.style.top = `${Math.round(p.top)}px`;
    if (p.width !== undefined) {
      wrap.style.width = `${Math.round(p.width)}px`;
      box.style.width = "100%";
    }
    box.style.maxHeight = `${Math.floor(p.maxHeight)}px`;
    wrap.style.setProperty("--tail-x", `${Math.round(p.tailX)}px`);
    wrap.dataset.side = p.side;
    if (p.sheet) wrap.dataset.sheet = "";
    else delete wrap.dataset.sheet;
    wrap.dataset.placed = "";
  }, [anchor, side, align, tail, width, sheetBelow]);

  const schedule = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(reposition);
  }, [reposition]);

  // Place before the first paint, then follow scrolling, resizing and content changes.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (boxRef.current) ro?.observe(boxRef.current);
    if (anchor) ro?.observe(anchor);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame.current);
      ro?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [open, anchor, reposition, schedule]);

  // Once per opening, in the same frame: join the stack (an open parent popover must see this one as
  // "above" it before focus moves), then move focus in, so that keys typed at once land in the popover.
  useLayoutEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    const box = boxRef.current;
    if (wrap) stack.push(wrap);
    if (initialFocus !== "none" && box) {
      let target: HTMLElement | null = null;
      if (initialFocus === "auto") target = box.querySelector<HTMLElement>("[data-autofocus]") ?? box.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? tabbables(box)[0] ?? box;
      else if (initialFocus === "container") target = box;
      else target = initialFocus.current;
      (target ?? box).focus({ preventScroll: true });
      inside.current = true;
    }
    return () => {
      if (!wrap) return;
      const i = stack.indexOf(wrap);
      if (i >= 0) stack.splice(i, 1);
    };
    // initialFocus is read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Stack, Escape, outside clicks, focus in and focus back.
  useEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    if (!wrap) return;

    const above = (node: Node) => {
      const i = stack.indexOf(wrap);
      return stack.slice(i + 1).some((el) => el.contains(node));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || stack[stack.length - 1] !== wrap || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current("escape");
    };
    const onDown = (e: PointerEvent) => {
      if (!closeOnOutside || stack[stack.length - 1] !== wrap) return;
      const t = e.target as Node;
      if (wrap.contains(t) || anchor?.contains(t) || above(t)) return;
      // Tooltips and toasts live in their own layers; a click there is not "outside".
      if ((t as Element).closest?.(".b-tooltip, .b-toasts")) return;
      onCloseRef.current("outside");
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Node;
      if (wrap.contains(t)) {
        inside.current = true;
        return;
      }
      inside.current = false;
      if (closeOnBlur && !anchor?.contains(t) && !above(t) && stack.includes(wrap)) onCloseRef.current("blur");
    };
    // Bubble phase: a control inside the popover can use Escape first (and call preventDefault).
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onFocusIn);
      // Focus goes back to the trigger when it was inside the popover (Escape, an action in the popover).
      const active = document.activeElement;
      if (anchor?.isConnected && (inside.current || !active || active === document.body || wrap.contains(active))) anchor.focus({ preventScroll: true });
      inside.current = false;
    };
  }, [open, anchor, closeOnBlur, closeOnOutside]);

  if (!open || typeof document === "undefined") return null;

  const guard = (dir: 1 | -1) => () => {
    onCloseRef.current("tab");
    inside.current = false;
    if (!anchor) return;
    if (dir === -1) anchor.focus({ preventScroll: true });
    else (nextTabbable(anchor, 1, wrapRef.current) ?? anchor).focus({ preventScroll: true });
  };

  return createPortal(
    <div ref={wrapRef} className={["b-pop", className].filter(Boolean).join(" ")}>
      <span className="b-pop__guard" tabIndex={0} onFocus={guard(-1)} />
      <div
        ref={boxRef}
        id={id}
        className="b-popover"
        role={role === "none" ? undefined : role}
        aria-label={role === "none" ? undefined : label}
        aria-labelledby={role === "none" ? undefined : labelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
      <span className="b-pop__guard" tabIndex={0} onFocus={guard(1)} />
      {tail && <span className="b-pop__tail" aria-hidden="true" />}
    </div>,
    document.body,
  );
}

/** Trigger + popover wiring: aria-expanded, aria-controls, aria-haspopup and the open state. */
export function usePopover<T extends HTMLElement = HTMLButtonElement>(haspopup: "dialog" | "menu" | "listbox" = "dialog") {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<T | null>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return {
    open,
    setOpen,
    close,
    toggle,
    anchor,
    id,
    triggerProps: {
      ref: setAnchor,
      "aria-expanded": open,
      "aria-haspopup": haspopup,
      "aria-controls": open ? id : undefined,
      onClick: toggle,
    },
    popoverProps: { id, anchor, open, onClose: close },
  };
}

/** Arrow keys, Home and End move focus between the items that match `selector` inside a container. */
export function rovingKeys(e: ReactKeyboardEvent<HTMLElement>, selector: string, opts: { up?: string[]; down?: string[] } = {}) {
  const down = opts.down ?? ["ArrowDown"];
  const up = opts.up ?? ["ArrowUp"];
  const key = e.key;
  if (![...down, ...up, "Home", "End"].includes(key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)].filter((el) => el.getClientRects().length > 0 && !el.matches(":disabled"));
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  let n = i;
  if (key === "Home") n = 0;
  else if (key === "End") n = items.length - 1;
  else if (down.includes(key)) n = i < 0 ? 0 : (i + 1) % items.length;
  else n = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  items[n]?.focus();
}
