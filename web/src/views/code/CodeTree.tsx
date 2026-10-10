/**
 * The file tree: a virtual list (only the rows on screen exist in the page), so thousands of files stay
 * fast. WAI-ARIA tree pattern: one tab stop; ↑/↓ move, → opens a folder or moves into it, ← closes a
 * folder or moves to its parent, Home/End, Enter or Space opens a file or toggles a folder.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import type { FileTouch } from "../../../../src/core/types";
import type { FileMarks, FolderMarks } from "./annotations";
import { hitRuns, type TreeRow } from "./tree";

export interface RowMarks {
  /** Agent colors of work copies that change the file (filled dots). */
  changed: number[];
  /** Agent colors of work copies that plan the file (rings). */
  planned: number[];
  keepOut: number;
  /** The open work copy's own change of this file. */
  own?: FileTouch["status"];
  ownStat?: { additions: number; deletions: number };
}

interface Props {
  rows: TreeRow[];
  selectedPath: string | null;
  /** Marks of files (main) or the open work copy's changes. */
  fileMarks: (path: string) => RowMarks | null;
  folderMarks: Map<string, FolderMarks>;
  onToggle: (dirPath: string, open?: boolean) => void;
  onOpen: (path: string, e?: MouseEvent | KeyboardEvent) => void;
  hrefOf: (path: string) => string;
  /** Prefetch a file's text (hover or focus). */
  onPrefetch?: (path: string) => void;
  label: string;
  /** Changes when the tree should scroll the selected file into view. */
  revealKey?: string;
  emptyText: string;
}

/** Row height in px: 28 with a mouse, 40 with touch (larger targets). */
function useRowHeight(): number {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia(query);
    const on = () => setCoarse(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return coarse ? 40 : 28;
}

const OVERSCAN = 10;

function Dots({ colors, ring, max = 3 }: { colors: number[]; ring?: boolean; max?: number }) {
  if (!colors.length) return null;
  return (
    <>
      {colors.slice(0, max).map((c, i) => (
        <span key={i} className={ring ? "cv-dot cv-dot--ring" : "cv-dot"} style={{ "--vc": `var(--v${((c % 12) + 12) % 12})` } as CSSProperties} />
      ))}
    </>
  );
}

const STATUS_WORD = { A: "added", M: "changed", D: "deleted" } as const;

function marksLabel(m: RowMarks | null, f: FolderMarks | undefined): string {
  const parts: string[] = [];
  if (m?.own) parts.push(`${STATUS_WORD[m.own]} in this work copy`);
  if (m && m.changed.length) parts.push(`${m.changed.length} ${m.changed.length === 1 ? "agent changes it" : "agents change it"}`);
  if (m && m.planned.length) parts.push(`${m.planned.length} ${m.planned.length === 1 ? "agent plans to change it" : "agents plan to change it"}`);
  if (m && m.keepOut) parts.push(`${m.keepOut} ${m.keepOut === 1 ? "change request" : "change requests"}`);
  if (f && f.work) parts.push(`${f.work} ${f.work === 1 ? "agent works" : "agents work"} here`);
  if (f && f.keepOut) parts.push(`${f.keepOut} ${f.keepOut === 1 ? "change request" : "change requests"}`);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

const Row = memo(function Row({
  row,
  index,
  top,
  height,
  active,
  selected,
  marks,
  fmarks,
  href,
  onRowClick,
  onFocusRow,
  onHover,
}: {
  row: TreeRow;
  index: number;
  top: number;
  height: number;
  active: boolean;
  selected: boolean;
  marks: RowMarks | null;
  fmarks: FolderMarks | undefined;
  href: string;
  onRowClick: (i: number, e: MouseEvent) => void;
  onFocusRow: (i: number) => void;
  onHover?: (path: string) => void;
}) {
  const style = { top, height, "--lvl": row.level - 1 } as CSSProperties;
  const common = {
    role: "treeitem",
    "aria-level": row.level,
    "aria-setsize": row.setsize,
    "aria-posinset": row.posinset,
    tabIndex: active ? 0 : -1,
    "data-index": index,
    style,
    onFocus: () => onFocusRow(index),
  } as const;
  if (row.kind === "dir") {
    return (
      <div
        {...common}
        className={["cv-row", "cv-row--dir", marks?.own && `is-${marks.own}`].filter(Boolean).join(" ")}
        aria-expanded={row.expanded}
        aria-label={`${row.name}, folder, ${row.count} ${row.count === 1 ? "file" : "files"}${marksLabel(null, fmarks)}`}
        onClick={(e) => onRowClick(index, e)}
      >
        <span className="cv-row__twisty" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path d={row.expanded ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"} />
          </svg>
        </span>
        <span className="cv-row__icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d={row.expanded ? "M1.75 4.25h4.5l1.5 1.5h6.5v7H1.75Z M1.75 7.25h12.5" : "M1.75 3.25h4.5l1.5 1.75h6.5v7.75H1.75Z"} />
          </svg>
        </span>
        <span className="cv-row__name">{row.name}</span>
        {fmarks && (fmarks.work > 0 || fmarks.keepOut > 0) && (
          <span className="cv-row__marks" aria-hidden="true">
            <Dots colors={fmarks.colors} />
            {fmarks.work > 3 && <span className="cv-row__more">+{fmarks.work - 3}</span>}
            {fmarks.keepOut > 0 && <span className="cv-keep" />}
          </span>
        )}
      </div>
    );
  }
  return (
    <a
      {...common}
      href={href}
      className={["cv-row", "cv-row--file", selected && "is-selected", marks?.own && `is-${marks.own}`].filter(Boolean).join(" ")}
      aria-selected={selected}
      aria-current={selected ? "page" : undefined}
      aria-label={`${row.name}${marksLabel(marks, undefined)}`}
      onClick={(e) => onRowClick(index, e)}
      onMouseEnter={onHover ? () => onHover(row.path) : undefined}
    >
      <span className="cv-row__twisty" aria-hidden="true" />
      <span className="cv-row__icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14">
          <path d="M3.25 1.75h6l3.5 3.5v9h-9.5Z M9.25 1.75v3.5h3.5" />
        </svg>
      </span>
      <span className="cv-row__name">
        {hitRuns(row.name, row.hits).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}
      </span>
      {marks && (
        <span className="cv-row__marks" aria-hidden="true">
          {marks.own && <span className={`cv-own cv-own--${marks.own}`}>{marks.own}</span>}
          {marks.ownStat && (
            <span className="cv-row__stat">
              <span className="cv-plus">+{marks.ownStat.additions}</span> <span className="cv-minus">−{marks.ownStat.deletions}</span>
            </span>
          )}
          <Dots colors={marks.changed} />
          <Dots colors={marks.planned} ring max={Math.max(0, 3 - marks.changed.length)} />
          {marks.keepOut > 0 && <span className="cv-keep" />}
        </span>
      )}
    </a>
  );
});

export function CodeTree({ rows, selectedPath, fileMarks, folderMarks, onToggle, onOpen, hrefOf, onPrefetch, label, revealKey, emptyText }: Props) {
  const rowH = useRowHeight();
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  // The tab stop follows a row (by path), not a position: rows move when folders above open or close.
  const [activePath, setActivePath] = useState<string | null>(null);
  const focusNext = useRef<number | null>(null);

  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.path + (r.kind === "dir" ? "/" : ""), i])), [rows]);
  const rowIndex = useCallback((path: string | null, dir = false) => (path === null ? -1 : indexOf.get(path + (dir ? "/" : "")) ?? -1), [indexOf]);
  const selectedIndex = rowIndex(selectedPath);
  const activeIndex = (() => {
    const a = activePath === null ? -1 : indexOf.get(activePath) ?? -1;
    if (a !== -1) return a;
    return selectedIndex !== -1 ? selectedIndex : 0;
  })();
  const keyOf = (r: TreeRow) => r.path + (r.kind === "dir" ? "/" : "");

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 600));
    ro.observe(el);
    setViewH(el.clientHeight || 600);
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

  const ensureVisible = useCallback(
    (i: number, center = false) => {
      const el = scroller.current;
      if (!el) return;
      const top = i * rowH;
      const h = el.clientHeight;
      if (center && (top < el.scrollTop || top + rowH > el.scrollTop + h)) el.scrollTop = Math.max(0, top - h / 2 + rowH / 2);
      else if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowH > el.scrollTop + h) el.scrollTop = top + rowH - h;
      setScrollTop(el.scrollTop);
    },
    [rowH],
  );

  // The selected file shows in the tree: it becomes the active row and scrolls into view.
  useEffect(() => {
    if (selectedIndex < 0 || !selectedPath) return;
    setActivePath(selectedPath);
    ensureVisible(selectedIndex, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey, selectedIndex >= 0 ? selectedPath : null]);

  useLayoutEffect(() => {
    if (focusNext.current === null) return;
    const i = focusNext.current;
    focusNext.current = null;
    scroller.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus({ preventScroll: true });
  });

  const moveTo = useCallback(
    (i: number) => {
      if (!rows.length) return;
      const n = Math.max(0, Math.min(rows.length - 1, i));
      setActivePath(keyOf(rows[n]));
      ensureVisible(n);
      focusNext.current = n;
    },
    [rows, ensureVisible],
  );

  const onRowClick = useCallback(
    (i: number, e: MouseEvent) => {
      const r = rows[i];
      if (!r) return;
      setActivePath(keyOf(r));
      if (r.kind === "dir") {
        onToggle(r.path);
        return;
      }
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onOpen(r.path, e);
    },
    [rows, onToggle, onOpen],
  );

  const onFocusRow = useCallback((i: number) => {
    const r = rows[i];
    if (r) setActivePath(r.path + (r.kind === "dir" ? "/" : ""));
  }, [rows]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const r = rows[activeIndex];
    if (!r) return;
    switch (e.key) {
      case "ArrowDown":
        moveTo(activeIndex + 1);
        break;
      case "ArrowUp":
        moveTo(activeIndex - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "PageDown":
        moveTo(activeIndex + Math.max(1, Math.floor(viewH / rowH) - 1));
        break;
      case "PageUp":
        moveTo(activeIndex - Math.max(1, Math.floor(viewH / rowH) - 1));
        break;
      case "ArrowRight":
        if (r.kind === "dir") {
          if (!r.expanded) onToggle(r.path, true);
          else if (rows[activeIndex + 1]?.parent === r.path) moveTo(activeIndex + 1);
        }
        break;
      case "ArrowLeft":
        if (r.kind === "dir" && r.expanded) onToggle(r.path, false);
        else if (r.parent) {
          const p = rowIndex(r.parent, true);
          if (p !== -1) moveTo(p);
        }
        break;
      case "Enter":
      case " ":
        if (r.kind === "dir") onToggle(r.path);
        else onOpen(r.path, e);
        break;
      case "*": {
        // Open all folders next to the active row (APG).
        for (const s of rows) if (s.kind === "dir" && s.parent === r.parent && !s.expanded) onToggle(s.path, true);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHover = useMemo(() => {
    if (!onPrefetch) return undefined;
    return (path: string) => {
      if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
      prefetchTimer.current = setTimeout(() => onPrefetch(path), 120);
    };
  }, [onPrefetch]);
  useEffect(() => () => {
    if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
  }, []);

  if (!rows.length) {
    return (
      <div className="cv-tree__empty" role="status">
        {emptyText}
      </div>
    );
  }

  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowH) + OVERSCAN);
  const indexes: number[] = [];
  for (let i = first; i < last; i++) indexes.push(i);
  // The active row always exists in the page, so Tab can reach the tree after a scroll.
  if (activeIndex < first || activeIndex >= last) indexes.push(activeIndex);

  return (
    <div className="cv-tree__scroll" ref={scroller} onScroll={onScroll}>
      <div
        className="cv-tree__list"
        role="tree"
        aria-label={label}
        style={{ height: rows.length * rowH }}
        onKeyDown={onKey}
        onMouseLeave={() => {
          if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
        }}
      >
        {indexes.map((i) => {
          const r = rows[i];
          return (
            <Row
              key={r.path + (r.kind === "dir" ? "/" : "")}
              row={r}
              index={i}
              top={i * rowH}
              height={rowH}
              active={i === activeIndex}
              selected={r.kind === "file" && r.path === selectedPath}
              marks={r.kind === "file" ? fileMarks(r.path) : null}
              fmarks={r.kind === "dir" ? folderMarks.get(r.path) : undefined}
              href={r.kind === "file" ? hrefOf(r.path) : ""}
              onRowClick={onRowClick}
              onFocusRow={onFocusRow}
              onHover={onHover}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Marks of a file on main from the live marks (agents that change or plan it, change requests). */
export function rowMarksOf(fm: FileMarks | undefined): RowMarks | null {
  if (!fm || (!fm.work.length && !fm.keepOut.length)) return null;
  return {
    changed: fm.work.filter((w) => w.touch).map((w) => w.wc.color),
    planned: fm.work.filter((w) => !w.touch).map((w) => w.wc.color),
    keepOut: fm.keepOut.length,
  };
}
