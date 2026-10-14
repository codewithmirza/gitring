/**
 * Small pickers that grow from their button: the ref switcher, the file finder and "go to line".
 * None is modal. The lists follow the WAI-ARIA combobox pattern: focus stays in the text field, ↑/↓ move the active option,
 * Enter chooses it, Escape closes the panel and focus goes back to the button.
 */
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Popover } from "../../design/components";
import { findFiles, hitRuns, baseName, dirName } from "./tree";
import { parseLineHash } from "./links";
import type { LineRange } from "../../../../src/core/types";

export interface ComboItem {
  id: string;
  /** Text for filtering and for screen readers. */
  text: string;
  label: ReactNode;
  hint?: ReactNode;
  group?: string;
  current?: boolean;
}

interface ComboProps {
  items: ComboItem[];
  query: string;
  onQuery: (q: string) => void;
  onChoose: (item: ComboItem, newTab: boolean) => void;
  inputLabel: string;
  placeholder: string;
  listLabel: string;
  empty: ReactNode;
  footer?: ReactNode;
}

/** A text field with a list of options under it (APG combobox with a listbox). */
export function ComboList({ items, query, onQuery, onChoose, inputLabel, placeholder, listLabel, empty, footer }: ComboProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const idx = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = items.length;
    if (!n && e.key !== "Escape") return;
    switch (e.key) {
      case "ArrowDown":
        setActive((idx + 1) % n);
        break;
      case "ArrowUp":
        setActive((idx - 1 + n) % n);
        break;
      case "PageDown":
        setActive(Math.min(n - 1, idx + 8));
        break;
      case "PageUp":
        setActive(Math.max(0, idx - 8));
        break;
      case "Enter":
        if (items[idx]) onChoose(items[idx], e.metaKey || e.ctrlKey);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Groups in their order of first use.
  const groups: { name: string; items: { item: ComboItem; i: number }[] }[] = [];
  items.forEach((item, i) => {
    const name = item.group ?? "";
    let g = groups.find((x) => x.name === name);
    if (!g) {
      g = { name, items: [] };
      groups.push(g);
    }
    g.items.push({ item, i });
  });

  const option = ({ item, i }: { item: ComboItem; i: number }) => (
    <div
      key={item.id}
      id={`${uid}-o${i}`}
      data-i={i}
      role="option"
      aria-selected={i === idx}
      aria-label={item.text}
      className={["cv-opt", i === idx && "is-active", item.current && "is-current"].filter(Boolean).join(" ")}
      onMouseMove={() => i !== idx && setActive(i)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onChoose(item, e.metaKey || e.ctrlKey)}
    >
      <span className="cv-opt__label">{item.label}</span>
      {item.hint && <span className="cv-opt__hint">{item.hint}</span>}
    </div>
  );

  return (
    <div className="cv-pick">
      <input
        className="cv-pick__input b-input"
        role="combobox"
        aria-label={inputLabel}
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={items.length ? `${uid}-o${idx}` : undefined}
        placeholder={placeholder}
        value={query}
        data-autofocus
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="cv-pick__list" id={listId} role="listbox" aria-label={listLabel} ref={listRef}>
        {groups.map((g) =>
          g.name ? (
            <div key={g.name} role="group" aria-labelledby={`${uid}-g-${g.name.replace(/\W+/g, "")}`}>
              <div className="cv-pick__group" id={`${uid}-g-${g.name.replace(/\W+/g, "")}`} role="presentation">
                {g.name}
              </div>
              {g.items.map(option)}
            </div>
          ) : (
            g.items.map(option)
          ),
        )}
      </div>
      {items.length === 0 && (
        <p className="cv-pick__empty" role="status">
          {empty}
        </p>
      )}
      {footer && <div className="cv-pick__foot">{footer}</div>}
    </div>
  );
}

/* ───────────── ref switcher ───────────── */

export interface RefOption {
  id: string;
  ref: string;
  name: string;
  group?: string;
  color?: number;
  hint?: ReactNode;
  current?: boolean;
}

export function RefPicker({
  anchor,
  open,
  onClose,
  options,
  onChoose,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  options: RefOption[];
  onChoose: (ref: string) => void;
}) {
  const [q, setQ] = useState("");
  useEffect(() => {
    if (open) setQ("");
  }, [open]);
  const items = useMemo<ComboItem[]>(() => {
    const needle = q.trim().toLowerCase();
    return options
      .filter((o) => !needle || `${o.name} ${o.ref} ${typeof o.hint === "string" ? o.hint : ""}`.toLowerCase().includes(needle))
      .map((o) => ({
        id: o.id,
        text: `${o.name}${o.current ? ", open now" : ""}`,
        group: o.group,
        current: o.current,
        label: (
          <>
            {o.color !== undefined ? (
              <span className="cv-dot" style={{ "--vc": `var(--v${((o.color % 12) + 12) % 12})` } as CSSProperties} aria-hidden="true" />
            ) : (
              <span className="cv-dot cv-dot--main" aria-hidden="true" />
            )}
            <span className="cv-opt__name">{o.name}</span>
            {o.current && <span className="cv-opt__tag">open</span>}
          </>
        ),
        hint: o.hint,
      }));
  }, [options, q]);
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label="Switch the code to main or a work copy" align="start">
      <ComboList
        items={items}
        query={q}
        onQuery={setQ}
        onChoose={(item) => {
          const o = options.find((x) => x.id === item.id);
          if (o) onChoose(o.ref);
        }}
        inputLabel="Filter main and the work copies"
        placeholder="Filter by agent or task"
        listLabel="Refs"
        empty={`No ref matches “${q}”.`}
      />
    </Popover>
  );
}

/* ───────────── file finder ───────────── */

export function FileFinder({
  anchor,
  open,
  onClose,
  paths,
  marks,
  onChoose,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  paths: readonly string[];
  /** Agent colors per path (files where agents work show dots). */
  marks: (path: string) => number[];
  onChoose: (path: string, newTab: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q);
  useEffect(() => {
    if (open) setQ("");
  }, [open]);
  const hits = useMemo(() => (open ? findFiles(paths, dq, 40) : []), [paths, dq, open]);
  const items = useMemo<ComboItem[]>(
    () =>
      hits.map((h) => {
        const base = baseName(h.path);
        const dir = dirName(h.path);
        const offset = h.path.length - base.length;
        const colors = marks(h.path);
        return {
          id: h.path,
          text: h.path,
          label: (
            <>
              <span className="cv-opt__name voice-agent">
                {hitRuns(base, h.hits.filter((i) => i >= offset), offset).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}
              </span>
              {colors.length > 0 && (
                <span className="cv-opt__dots" aria-hidden="true">
                  {colors.slice(0, 3).map((c, i) => (
                    <span key={i} className="cv-dot" style={{ "--vc": `var(--v${((c % 12) + 12) % 12})` } as CSSProperties} />
                  ))}
                </span>
              )}
            </>
          ),
          hint: dir ? (
            <span className="voice-agent">
              {hitRuns(dir, h.hits.filter((i) => i < dir.length)).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}
            </span>
          ) : undefined,
        };
      }),
    [hits, marks],
  );
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label="Find a file" align="start">
      <ComboList
        items={items}
        query={q}
        onQuery={setQ}
        onChoose={(item, newTab) => onChoose(item.id, newTab)}
        inputLabel="File name or path"
        placeholder="Type a file name"
        listLabel="Files"
        empty={paths.length ? `No file matches “${q}”.` : "This ref has no files."}
        footer={
          <span>
            <kbd className="b-kbd">↑</kbd>
            <kbd className="b-kbd">↓</kbd> move · <kbd className="b-kbd">Enter</kbd> open · <kbd className="b-kbd">Ctrl</kbd>+<kbd className="b-kbd">Enter</kbd> new tab
          </span>
        }
      />
    </Popover>
  );
}

/* ───────────── a short action menu ───────────── */

export interface MenuAction {
  key: string;
  label: string;
  /** Key hint shown at the end of the row. */
  keys?: string;
  onSelect?: () => void;
  href?: string;
  external?: boolean;
  disabled?: boolean;
}

/** "More": a menu that grows from its button. ↑/↓ move, Enter chooses, Escape closes (WAI-ARIA menu button). */
export function MoreMenu({ label = "More", actions, className }: { label?: string; actions: MenuAction[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
  const close = (focusBack = true) => {
    setOpen(false);
    if (focusBack) requestAnimationFrame(() => btn.current?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") {
      close(false);
      return;
    } else return;
    e.preventDefault();
    list[next]?.focus();
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={["cv-tool", className].filter(Boolean).join(" ")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label}
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className="cv-tool__caret">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} label={`${label} actions`} align="end">
        <div className="cv-menu" role="menu" aria-label={`${label} actions`} ref={menu} onKeyDown={onKey}>
          {actions.map((a, i) => {
            const body = (
              <>
                <span className="cv-menu__label">{a.label}</span>
                {a.keys && <kbd className="b-kbd">{a.keys}</kbd>}
              </>
            );
            const common = {
              role: "menuitem",
              tabIndex: -1,
              className: "cv-menu__item",
              "aria-disabled": a.disabled || undefined,
              ...(i === actions.findIndex((x) => !x.disabled) ? { "data-autofocus": true } : {}),
            } as const;
            return a.href ? (
              <a
                key={a.key}
                {...common}
                href={a.disabled ? undefined : a.href}
                target={a.external ? "_blank" : undefined}
                rel={a.external ? "noopener noreferrer" : undefined}
                onClick={() => close(false)}
              >
                {body}
              </a>
            ) : (
              <button
                key={a.key}
                type="button"
                {...common}
                onClick={() => {
                  if (a.disabled) return;
                  close();
                  a.onSelect?.();
                }}
              >
                {body}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

/* ───────────── go to line ───────────── */

/** "12", "10-20", "L10-L20", "10:20" → a range within 1…max. */
export function parseLineInput(text: string, max: number): LineRange | null {
  const t = text.trim().replace(/\s+/g, "").replace(/:/g, "-");
  const r = parseLineHash(t.startsWith("L") || t.startsWith("l") ? t : `L${t.replace(/-L?/i, "-L")}`);
  if (!r) return null;
  return [Math.min(max, r[0]), Math.min(max, r[1])];
}

export function LinePicker({ anchor, open, onClose, max, onGo }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; max: number; onGo: (r: LineRange) => void }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const uid = useId();
  useEffect(() => {
    if (open) {
      setV("");
      setErr(null);
    }
  }, [open]);
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label="Go to a line" align="end">
      <form
        className="cv-goline"
        onSubmit={(e) => {
          e.preventDefault();
          const r = parseLineInput(v, max);
          if (!r) {
            setErr(`Write a line number from 1 to ${max}, or a range such as 10-20.`);
            return;
          }
          onGo(r);
        }}
      >
        <label className="cv-goline__label" htmlFor={`${uid}-line`}>
          Line or range (1–{max})
        </label>
        <div className="cv-goline__row">
          <input
            id={`${uid}-line`}
            className="b-input voice-agent"
            inputMode="numeric"
            autoComplete="off"
            placeholder="12 or 10-20"
            value={v}
            data-autofocus
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `${uid}-err` : undefined}
            onChange={(e) => {
              setV(e.target.value);
              setErr(null);
            }}
          />
          <button type="submit" className="b-btn b-btn--primary b-btn--sm">
            Go
          </button>
        </div>
        {err && (
          <p className="cv-goline__err" id={`${uid}-err`} role="alert">
            {err}
          </p>
        )}
      </form>
    </Popover>
  );
}
