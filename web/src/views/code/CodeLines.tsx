/**
 * The lines of one file: line numbers, the marks of agents in the gutter, syntax colors and soft wrap.
 * The gutter also shows the lines that change requests keep agents out of.
 * Without wrap, only the lines on screen exist in the page (fast for large files). With wrap, the lines render in blocks
 * that the browser skips while they are off screen.
 * Highlighting runs in small steps when the browser is idle, so a large file never blocks the page.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { LineRange } from "../../../../src/core/types";
import { CLASS_NAMES, highlighterFor, LineHighlighter, type LangInfo } from "./highlight";
import type { HeadChanges, LineMark } from "./annotations";

export const LINE_H = 20;
/** Soft wrap renders every line; above this many lines it is off. */
export const WRAP_MAX = 3000;
/** Above this size the file shows without colors. */
const HIGHLIGHT_MAX_CHARS = 2_000_000;
const OVERSCAN = 30;
const BLOCK = 100;

export interface GutterLane {
  key: string;
  color: number;
  kind: "change" | "keepout";
  approx: boolean;
}

interface Props {
  text: string;
  info: LangInfo | null;
  label: string;
  wrap: boolean;
  lanes: GutterLane[];
  byLine: Map<number, LineMark[]>;
  /** The open work copy's own changes, in the lines of this version. */
  head: HeadChanges | null;
  selected: LineRange | null;
  /** Lines that show a short highlight (the range that j/k moved to). */
  flash: LineRange | null;
  onLines: (lines: LineRange, extend: boolean) => void;
  /** A click or Enter on a marked line in the gutter. */
  onMark: (line: number, anchor: HTMLElement) => void;
  /** Scroll this line into view when `jump.n` changes. */
  jump: { line: number; n: number } | null;
  /** First lines of the marked ranges, for keyboard focus in the gutter. */
  markStarts: number[];
  focusMark: { line: number; n: number } | null;
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Widest line in columns (a tab counts 4), for the width of the scroll area. */
function widest(lines: string[]): number {
  let w = 0;
  for (const l of lines) {
    let n = l.length;
    for (let i = 0; i < l.length; i++) if (l.charCodeAt(i) === 9) n += 3;
    if (n > w) w = n;
  }
  return w;
}

type Idle = (cb: () => void) => number;
const idle: Idle = (cb) =>
  typeof (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback === "function"
    ? (window as unknown as { requestIdleCallback: (cb: () => void, o: { timeout: number }) => number }).requestIdleCallback(cb, { timeout: 120 })
    : (setTimeout(cb, 16) as unknown as number);
const cancelIdle = (id: number) => {
  const w = window as unknown as { cancelIdleCallback?: (id: number) => void };
  if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(id);
  else clearTimeout(id);
};

function Code({ text, tokens }: { text: string; tokens: number[] | undefined }): ReactNode {
  if (!text) return "​";
  if (!tokens || !tokens.length) return text;
  const out: ReactNode[] = [];
  let p = 0;
  for (let k = 0; k < tokens.length; k += 2) {
    const end = tokens[k];
    const cls = tokens[k + 1];
    if (end <= p) continue;
    const part = text.slice(p, end);
    out.push(cls ? (
      <span key={k} className={CLASS_NAMES[cls]}>
        {part}
      </span>
    ) : (
      part
    ));
    p = end;
  }
  if (p < text.length) out.push(text.slice(p));
  return out;
}

const Line = memo(function Line({
  n,
  text,
  tokens,
  top,
  sel,
  flash,
  marks,
  lanes,
  addLine,
  cut,
  markTab,
  onNum,
  onMark,
}: {
  n: number;
  text: string;
  tokens: number[] | undefined;
  top: number | null;
  sel: boolean;
  flash: boolean;
  marks: LineMark[] | undefined;
  lanes: GutterLane[];
  addLine: boolean;
  /** Old lines were removed right after (or, on line 1, before) this line. */
  cut: "after" | "before" | null;
  /** -1: no tab stop; 0: the gutter's tab stop; null: no button on this line. */
  markTab: number | null;
  onNum: (n: number, e: MouseEvent) => void;
  onMark: (n: number, el: HTMLElement) => void;
}) {
  const style = top === null ? undefined : ({ top } as CSSProperties);
  const hasMarks = Boolean(marks?.length) || addLine || cut !== null;
  const bars = (
    <>
      {marks?.map((m) => {
        const lane = lanes[m.lane];
        if (!lane) return null;
        return (
          <span
            key={m.lane}
            className={["cv-lane", `cv-lane--${lane.kind}`, lane.approx && "is-approx", m.first && "is-first", m.last && "is-last"].filter(Boolean).join(" ")}
            style={{ "--lane": m.lane, "--vc": `var(--v${((lane.color % 12) + 12) % 12})` } as CSSProperties}
          />
        );
      })}
      {addLine && <span className="cv-lane cv-lane--own" />}
      {cut && <span className={`cv-cut cv-cut--${cut}`} />}
    </>
  );
  return (
    <div className={["cv-line", sel && "is-sel", flash && "is-flash"].filter(Boolean).join(" ")} style={style} data-line={n}>
      {markTab !== null ? (
        <button
          type="button"
          className="cv-gut cv-gut--btn"
          tabIndex={markTab}
          data-mark={n}
          aria-label={`Line ${n}: show who works here`}
          onClick={(e) => onMark(n, e.currentTarget)}
        >
          {bars}
        </button>
      ) : (
        <span className={hasMarks ? "cv-gut is-marked" : "cv-gut"} aria-hidden="true" onClick={hasMarks && marks?.length ? (e) => onMark(n, e.currentTarget as HTMLElement) : undefined}>
          {bars}
        </span>
      )}
      <span className="cv-ln" data-n={n} aria-hidden="true" onClick={(e) => onNum(n, e)} />
      <span className="cv-code">
        <Code text={text} tokens={tokens} />
      </span>
    </div>
  );
});

/** A short text with colors and no line numbers (a README under the file list). At most `max` lines. */
export function StaticCode({ text, info, max = 300 }: { text: string; info: LangInfo | null; max?: number }) {
  const lines = useMemo(() => splitLines(text), [text]);
  const shown = useMemo(() => (lines.length > max ? lines.slice(0, max) : lines), [lines, max]);
  const tokens = useMemo(() => {
    const h = highlighterFor(info);
    if (!h) return [];
    const lh = new LineHighlighter(shown, h);
    lh.run(Infinity);
    return lh.tokens;
  }, [shown, info]);
  return (
    <pre className="cv-static">
      {shown.map((l, i) => (
        <span key={i} className="cv-static__line">
          <Code text={l} tokens={tokens[i]} />
          {"\n"}
        </span>
      ))}
      {lines.length > max && <span className="cv-static__more">… {lines.length - max} more lines</span>}
    </pre>
  );
}

export function CodeLines({ text, info, label, wrap, lanes, byLine, head, selected, flash, onLines, onMark, jump, markStarts, focusMark }: Props) {
  const lines = useMemo(() => splitLines(text), [text]);
  const canWrap = lines.length <= WRAP_MAX;
  const wrapped = wrap && canWrap;
  const digits = String(lines.length).length;
  const cols = useMemo(() => (wrapped ? 0 : widest(lines)), [lines, wrapped]);
  const laneCount = Math.max(lanes.length, head ? 1 : 0);

  /* highlighting, in idle steps */
  const hl = useMemo(() => {
    const h = text.length <= HIGHLIGHT_MAX_CHARS ? highlighterFor(info) : null;
    return h ? new LineHighlighter(lines, h) : null;
  }, [lines, info, text.length]);
  const [, setTick] = useState(0);

  /* scrolling */
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 800));
    ro.observe(el);
    setViewH(el.clientHeight || 800);
    return () => ro.disconnect();
  }, []);
  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (scroller.current) setScrollTop(scroller.current.scrollTop);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const first = wrapped ? 0 : Math.max(0, Math.floor(scrollTop / LINE_H) - OVERSCAN);
  const last = wrapped ? lines.length : Math.min(lines.length, Math.ceil((scrollTop + viewH) / LINE_H) + OVERSCAN);

  // Lines on screen get colors first (a short burst); the rest of the file when the browser is idle.
  const lastRef = useRef(last);
  lastRef.current = last;
  useLayoutEffect(() => {
    if (!hl || hl.done >= last) return;
    hl.run(24, last);
    setTick((t) => t + 1);
  }, [hl, last]);
  useEffect(() => {
    if (!hl || hl.finished) return;
    let id = 0;
    let stopped = false;
    const step = () => {
      if (stopped) return;
      const before = hl.done;
      const more = hl.run(8);
      // Re-render only when lines on screen got their colors.
      if (before < lastRef.current) setTick((t) => t + 1);
      if (more) id = idle(step);
    };
    id = idle(step);
    return () => {
      stopped = true;
      cancelIdle(id);
    };
  }, [hl]);

  /* jumps: a line from the address, j/k, go to line */
  useEffect(() => {
    if (!jump) return;
    const el = scroller.current;
    if (!el) return;
    const n = Math.max(1, Math.min(lines.length, jump.line));
    if (wrapped) {
      requestAnimationFrame(() => el.querySelector<HTMLElement>(`[data-line="${n}"]`)?.scrollIntoView({ block: "center" }));
      return;
    }
    const top = (n - 1) * LINE_H;
    if (top < el.scrollTop + LINE_H || top > el.scrollTop + el.clientHeight - 2 * LINE_H) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
      setScrollTop(el.scrollTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.n, lines.length, wrapped]);

  /* gutter focus (roving: one tab stop for all marked ranges) */
  const [markIdx, setMarkIdx] = useState(0);
  const focusAfter = useRef<number | null>(null);
  useEffect(() => {
    if (!focusMark) return;
    const i = markStarts.indexOf(focusMark.line);
    if (i === -1) return;
    setMarkIdx(i);
    focusAfter.current = focusMark.line;
    // The mark may be on screen already (no new render then): focus it in the next frame.
    const id = requestAnimationFrame(() => {
      const btn = scroller.current?.querySelector<HTMLElement>(`[data-mark="${focusMark.line}"]`);
      if (btn && focusAfter.current === focusMark.line) {
        focusAfter.current = null;
        btn.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMark?.n]);
  useLayoutEffect(() => {
    if (focusAfter.current === null) return;
    const line = focusAfter.current;
    const btn = scroller.current?.querySelector<HTMLElement>(`[data-mark="${line}"]`);
    if (btn) {
      focusAfter.current = null;
      btn.focus({ preventScroll: true });
    }
  });
  const tabLine = markStarts[Math.min(markIdx, markStarts.length - 1)] ?? -1;
  const startSet = useMemo(() => new Set(markStarts), [markStarts]);

  const onGutterKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!t.dataset.mark || !markStarts.length) return;
    let d = 0;
    if (e.key === "ArrowDown") d = 1;
    else if (e.key === "ArrowUp") d = -1;
    else if (e.key === "Home") d = -markStarts.length;
    else if (e.key === "End") d = markStarts.length;
    if (!d) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(markStarts.length - 1, markStarts.indexOf(Number(t.dataset.mark)) + d));
    setMarkIdx(i);
    const line = markStarts[i];
    focusAfter.current = line;
    const el = scroller.current;
    if (el && !wrapped) {
      const top = (line - 1) * LINE_H;
      if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - LINE_H) {
        el.scrollTop = Math.max(0, top - el.clientHeight / 3);
        setScrollTop(el.scrollTop);
      }
    }
  };

  const anchor = useRef<number | null>(null);
  const onNum = useCallback(
    (n: number, e: MouseEvent) => {
      if (e.shiftKey && anchor.current !== null) {
        const a = anchor.current;
        onLines(a <= n ? [a, n] : [n, a], true);
        return;
      }
      anchor.current = n;
      onLines([n, n], false);
    },
    [onLines],
  );

  const addSet = useMemo(() => {
    const s = new Set<number>();
    for (const r of head?.added ?? []) for (let n = r[0]; n <= r[1]; n++) s.add(n);
    return s;
  }, [head]);
  const cutSet = useMemo(() => new Set(head?.removedAfter ?? []), [head]);

  const style = {
    "--digits": digits,
    "--lanes": laneCount,
    "--cols": cols,
  } as CSSProperties;

  const row = (i: number, top: number | null) => {
    const n = i + 1;
    const inSel = Boolean(selected && n >= selected[0] && n <= selected[1]);
    const inFlash = Boolean(flash && n >= flash[0] && n <= flash[1]);
    return (
      <Line
        key={n}
        n={n}
        text={lines[i]}
        tokens={hl?.tokens[i]}
        top={top}
        sel={inSel}
        flash={inFlash}
        marks={byLine.get(n)}
        lanes={lanes}
        addLine={addSet.has(n)}
        cut={cutSet.has(n) ? "after" : n === 1 && cutSet.has(0) ? "before" : null}
        markTab={startSet.has(n) ? (n === tabLine ? 0 : -1) : null}
        onNum={onNum}
        onMark={onMark}
      />
    );
  };

  const body: ReactNode[] = [];
  if (wrapped) {
    for (let b = 0; b < lines.length; b += BLOCK) {
      const rows: ReactNode[] = [];
      for (let i = b; i < Math.min(lines.length, b + BLOCK); i++) rows.push(row(i, null));
      body.push(
        <div key={b} className="cv-block" style={{ containIntrinsicSize: `auto ${Math.min(BLOCK, lines.length - b) * LINE_H}px` } as CSSProperties}>
          {rows}
        </div>,
      );
    }
  } else {
    for (let i = first; i < last; i++) body.push(row(i, i * LINE_H));
    // The gutter's tab stop stays in the page also when it is off screen.
    if (tabLine > 0 && (tabLine - 1 < first || tabLine - 1 >= last)) body.push(row(tabLine - 1, (tabLine - 1) * LINE_H));
  }

  return (
    <div
      ref={scroller}
      className={["cv-lines", wrapped ? "is-wrap" : "is-nowrap"].join(" ")}
      style={style}
      onScroll={onScroll}
      onKeyDown={onGutterKey}
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <div className="cv-lines__inner" style={wrapped ? undefined : { height: lines.length * LINE_H }}>
        {body}
      </div>
    </div>
  );
}
