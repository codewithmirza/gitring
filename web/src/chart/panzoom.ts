/**
 * Pan and zoom for the chart: pointer drag, two-finger pinch, wheel, double click and keyboard.
 * The mouse wheel zooms, the trackpad scroll pans and the trackpad pinch zooms.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from "react";
import type { Rect } from "./layout";

export interface Transform {
  x: number;
  y: number;
  k: number;
}

export const MIN_K = 0.2;
export const MAX_K = 5;
const clamp = (k: number) => Math.max(MIN_K, Math.min(MAX_K, k));

export function fitTransform(b: Rect, w: number, h: number, pad = 0.94): Transform {
  const bw = Math.max(1, b.x1 - b.x0);
  const bh = Math.max(1, b.y1 - b.y0);
  const k = clamp(Math.min(w / bw, h / bh) * pad);
  return { k, x: w / 2 - ((b.x0 + b.x1) / 2) * k, y: h / 2 - ((b.y0 + b.y1) / 2) * k };
}

/**
 * The first view frames the traffic: the islands with vessels, zoomed in at most 1.7×
 * past the full chart, so neighbouring islands still show at the edges.
 */
export function focusTransform(all: Rect, focus: Rect | null, w: number, h: number): Transform {
  const overview = fitTransform(all, w, h);
  if (!focus) return overview;
  const pad = { x: (focus.x1 - focus.x0) * 0.18 + 40, y: (focus.y1 - focus.y0) * 0.18 + 40 };
  const f = fitTransform({ x0: focus.x0 - pad.x, y0: focus.y0 - pad.y, x1: focus.x1 + pad.x, y1: focus.y1 + pad.y }, w, h, 1);
  const k = Math.max(overview.k, Math.min(f.k, overview.k * 1.7));
  const cx = (focus.x0 + focus.x1) / 2;
  const cy = (focus.y0 + focus.y1) / 2;
  return { k, x: w / 2 - cx * k, y: h / 2 - cy * k };
}

/**
 * Gestures preview on a composited layer (`live`): the browser moves the painted chart on the
 * GPU while the pointer moves, and React re-renders once when the gesture ends. With hundreds of
 * vessels this keeps panning smooth.
 */
export function usePanZoom(
  container: RefObject<HTMLElement | null>,
  bounds: Rect | null,
  focus: Rect | null = null,
  live: RefObject<Element | null> | null = null,
) {
  const [t, setT] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const tRef = useRef(t);
  const userMoved = useRef(false);
  const dragged = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; t: Transform; dist?: number; mx?: number; my?: number } | null>(null);

  const pending = useRef<Transform | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback((nt: Transform) => {
    const v = { x: nt.x, y: nt.y, k: clamp(nt.k) };
    pending.current = null;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = null;
    tRef.current = v;
    setT(v);
  }, []);

  /** The transform the viewer sees now (a gesture preview or the committed one). */
  const current = useCallback(() => pending.current ?? tRef.current, []);

  const preview = useCallback(
    (nt: Transform) => {
      const v = { x: nt.x, y: nt.y, k: clamp(nt.k) };
      const el = live?.current as (HTMLElement | SVGElement) | null | undefined;
      if (!el) {
        apply(v);
        return;
      }
      pending.current = v;
      const c = tRef.current;
      const f = v.k / c.k;
      el.style.transform = `translate(${v.x - f * c.x}px, ${v.y - f * c.y}px) scale(${f})`;
    },
    [apply, live],
  );

  const commit = useCallback(() => {
    if (pending.current) apply(pending.current);
  }, [apply]);

  const commitSoon = useCallback(
    (ms = 140) => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = setTimeout(commit, ms);
    },
    [commit],
  );

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [container]);

  const fit = useCallback(() => {
    if (!bounds || !size.w || !size.h) return;
    // The viewer asked for the overview: keep it, do not refocus on traffic.
    userMoved.current = true;
    apply(fitTransform(bounds, size.w, size.h));
  }, [bounds, size.w, size.h, apply]);

  const focusKey = focus ? `${Math.round(focus.x0)},${Math.round(focus.y0)},${Math.round(focus.x1)},${Math.round(focus.y1)}` : "";
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    if (!bounds || !size.w || !size.h) return;
    if (!userMoved.current) apply(focusTransform(bounds, focusRef.current, size.w, size.h));
    // Refocus when the active area changes only while the viewer has not moved the chart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, size.w, size.h, apply, focusKey]);

  const zoomAt = useCallback(
    (factor: number, sx?: number, sy?: number) => {
      const cur = current();
      const cx = sx ?? size.w / 2;
      const cy = sy ?? size.h / 2;
      const k = clamp(cur.k * factor);
      const f = k / cur.k;
      userMoved.current = true;
      apply({ k, x: cx - (cx - cur.x) * f, y: cy - (cy - cur.y) * f });
    },
    [apply, current, size.w, size.h],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const cur = current();
      userMoved.current = true;
      apply({ ...cur, x: cur.x + dx, y: cur.y + dy });
    },
    [apply, current],
  );

  /** Center a world point (used to bring a selected vessel into view). */
  const centerOn = useCallback(
    (wx: number, wy: number) => {
      const cur = current();
      userMoved.current = true;
      apply({ ...cur, x: size.w / 2 - wx * cur.k, y: size.h / 2 - wy * cur.k });
    },
    [apply, current, size.w, size.h],
  );

  // Wheel: needs a non-passive listener to stop page zoom/scroll.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const lineMode = e.deltaMode === 1;
      const mouseWheel = lineMode || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && Number.isInteger(e.deltaY));
      const cur = current();
      userMoved.current = true;
      if (e.ctrlKey || e.metaKey || mouseWheel) {
        const dy = lineMode ? e.deltaY * 16 : e.deltaY;
        const k = clamp(cur.k * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
        const f = k / cur.k;
        preview({ k, x: sx - (sx - cur.x) * f, y: sy - (sy - cur.y) * f });
      } else {
        preview({ ...cur, x: cur.x - e.deltaX, y: cur.y - e.deltaY });
      }
      commitSoon();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [container, current, preview, commitSoon]);

  const onPointerDown = useCallback((e: RPointerEvent<Element>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged.current = false;
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      const [a, b] = pts;
      gesture.current = { x: 0, y: 0, t: current(), dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    } else {
      gesture.current = { x: e.clientX, y: e.clientY, t: current() };
    }
  }, [current]);

  const onPointerMove = useCallback(
    (e: RPointerEvent<Element>) => {
      if (!pointers.current.has(e.pointerId) || !gesture.current) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture.current;
      const pts = [...pointers.current.values()];
      const el = container.current;
      if (pts.length >= 2 && g.dist) {
        const [a, b] = pts;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const r = el?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const k = clamp(g.t.k * (dist / g.dist));
        const f = k / g.t.k;
        const cx = g.mx! - r.left;
        const cy = g.my! - r.top;
        dragged.current = true;
        userMoved.current = true;
        preview({ k, x: cx - (cx - g.t.x) * f + (mx - g.mx!), y: cy - (cy - g.t.y) * f + (my - g.my!) });
        return;
      }
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!dragged.current && Math.hypot(dx, dy) < 4) return;
      if (!dragged.current) {
        dragged.current = true;
        try {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      userMoved.current = true;
      preview({ ...g.t, x: g.t.x + dx, y: g.t.y + dy });
    },
    [preview, container],
  );

  const onPointerUp = useCallback(
    (e: RPointerEvent<Element>) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size === 0) {
        gesture.current = null;
        commit();
      } else {
        const [p] = [...pointers.current.values()];
        gesture.current = { x: p.x, y: p.y, t: current() };
      }
    },
    [commit, current],
  );

  useEffect(
    () => () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    },
    [],
  );

  /** True right after a drag: click handlers ignore that click. Stable identity for memoized layers. */
  const wasDrag = useCallback(() => dragged.current, []);
  const handlers = useMemo(
    () => ({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }),
    [onPointerDown, onPointerMove, onPointerUp],
  );
  return { t, size, fit, zoomAt, panBy, centerOn, wasDrag, handlers };
}
