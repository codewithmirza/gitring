/**
 * The history page: every merge into main, newest first, with its reasons.
 *
 * Dense rows are grouped by day. A filter (task, agent or file) narrows them; j and k move between rows; each row links
 * to the files it changed in the code view. A merge opens its merge record (logbook/WhyTrail.tsx): task, plan, change requests,
 * conflict checks, tests, decision, diff and commit. Merge records never change, so they load once and stay in memory; a
 * record also starts to load when the pointer or the focus rests on its row.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, EmptyState } from "../design/components";
import { Icon } from "../design/icons";
import { navigate } from "../app/router";
import { openNewIntent } from "../app/ui";
import { useNow } from "../app/useNow";
import { useCanAct } from "../state/account";
import { ago, METHOD_TEXT } from "../state/format";
import { useStore } from "../state/store";
import { selectLogbook, type LogbookRow } from "../state/selectors";
import { dayLabel } from "./labels";
import { changedFiles, Row } from "./logbook/Row";
import { WhyTrail } from "./logbook/WhyTrail";
import "./logbook.css";

const EMPTY: LogbookRow[] = [];

/** Search text of a row: task, agent, files, method and the commit. */
function searchText(r: LogbookRow): string {
  return [r.intent?.title ?? r.landing.intentId, r.agent?.callsign ?? "", r.agent?.model ?? "", METHOD_TEXT[r.landing.method] ?? "", r.landing.mainAfter, ...changedFiles(r)].join(" ").toLowerCase();
}

export function LogbookView({ id }: { id?: string }) {
  const rows = useStore((s) => (s.state ? selectLogbook(s.state) : EMPTY));
  const createdAt = useStore((s) => s.state?.project.createdAt ?? 0);
  const canAct = useCanAct();
  const now = useNow(15_000);
  const compact = Boolean(id);
  const [filter, setFilter] = useState("");
  const q = useDeferredValue(filter.trim().toLowerCase());
  const index = useMemo(() => rows.map((r) => ({ r, text: searchText(r) })), [rows]);
  const shown = useMemo(() => (q ? index.filter((x) => q.split(/\s+/).every((w) => x.text.includes(w))).map((x) => x.r) : rows), [index, q, rows]);
  const listRef = useRef<HTMLOListElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const groups = useMemo(() => {
    const out: { day: string; rows: LogbookRow[] }[] = [];
    for (const r of shown) {
      const day = dayLabel(r.landing.at, now);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(r);
      else out.push({ day, rows: [r] });
    }
    return out;
  }, [shown, now]);

  const rowLinks = () => [...(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-lrow]") ?? [])];
  const moveFocus = useCallback((from: HTMLElement | null, d: 1 | -1) => {
    const links = rowLinks();
    if (!links.length) return;
    const i = from ? links.indexOf(from as HTMLAnchorElement) : -1;
    const next = links[Math.max(0, Math.min(links.length - 1, i === -1 ? (d === 1 ? 0 : links.length - 1) : i + d))];
    next?.focus();
    next?.closest(".lrow")?.scrollIntoView({ block: "nearest" });
  }, []);
  const onRowKey = useCallback(
    (e: KeyboardEvent<HTMLAnchorElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveFocus(e.currentTarget, 1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (rowLinks()[0] === e.currentTarget) filterRef.current?.focus();
        else moveFocus(e.currentTarget, -1);
      }
    },
    [moveFocus],
  );

  // j / k from anywhere on the page start at the first or last row; Escape closes an open record.
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog'], .b-pop, .b-popover")) return;
      // A row handles its own j / k; Escape works from anywhere.
      if (t?.closest?.("a[data-lrow]") && e.key !== "Escape") return;
      if (e.key === "g") {
        gAt = Date.now();
        return;
      }
      if (Date.now() - gAt < 1200) {
        gAt = 0;
        return;
      }
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const cur = rowLinks().find((a) => a.getAttribute("aria-current") === "page") ?? null;
        moveFocus(cur, e.key === "j" ? 1 : -1);
      } else if (e.key === "Escape" && id) {
        e.preventDefault();
        navigate("/history");
        // Focus goes back to the row of the record that was open.
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`a[data-lrow][href^="/history/${CSS.escape(id)}"]`)?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, moveFocus]);

  return (
    <div className={["logbook", compact ? "has-detail" : "no-detail"].join(" ")}>
      <section className="logbook__list" aria-labelledby="logbook-title">
        <div className="logbook__head">
          {compact ? (
            <h2 className="logbook__title" id="logbook-title">
              History <span className="voice-agent ink-3">{rows.length}</span>
            </h2>
          ) : (
            <>
              <h1 className="page__title" id="logbook-title" tabIndex={-1}>
                History
              </h1>
              <p className="page__lede">Every merge into main, with its reasons: task, plan, change requests, tests and decision. Open a merge to read its merge record.</p>
            </>
          )}
          {rows.length > 0 && (
            <div className="logbook__tools">
              <label className="vh" htmlFor="lb-filter">
                Filter the merges
              </label>
              <input
                ref={filterRef}
                id="lb-filter"
                className="b-input logbook__filter"
                type="search"
                placeholder="Filter by task, agent or file"
                autoComplete="off"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    moveFocus(null, 1);
                  } else if (e.key === "Escape" && filter) {
                    e.stopPropagation();
                    setFilter("");
                  }
                }}
              />
              {!compact && (
                <span className="logbook__keys ink-3" aria-hidden="true">
                  <span>
                    <kbd className="b-kbd">j</kbd>
                    <kbd className="b-kbd">k</kbd> move
                  </span>
                  <span>
                    <kbd className="b-kbd">Enter</kbd> open
                  </span>
                </span>
              )}
              {q && (
                <span className="logbook__count ink-3" role="status">
                  {shown.length} of {rows.length}
                </span>
              )}
            </div>
          )}
        </div>
        {!compact && shown.length > 0 && (
          <div className="lrow lrow--header" aria-hidden="true">
            <span>main</span>
            <span>Task</span>
            <span>Method</span>
            <span>Agent</span>
            <span>Change requests</span>
            <span>Tests</span>
            <span>When</span>
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyState
            text={canAct ? "No merges yet. Write a task: agents send plans, gitring checks them and merges work when its tests pass." : "No merges yet. gitring writes a merge record here for each merge."}
            action={
              canAct ? (
                <Button variant="primary" icon="plus" onClick={() => openNewIntent()}>
                  Write a task
                </Button>
              ) : undefined
            }
          />
        ) : shown.length === 0 ? (
          <p className="logbook__none" role="status">
            No merge matches “{filter.trim()}”.{" "}
            <button type="button" className="logbook__clear" onClick={() => setFilter("")}>
              Clear the filter
            </button>
          </p>
        ) : (
          <ol className="lrows" role="list" ref={listRef}>
            {groups.map((g) => (
              <li key={g.day} className="lday">
                {compact ? <h3 className="lday__label">{g.day}</h3> : <h2 className="lday__label">{g.day}</h2>}
                <ol className="lday__rows" role="list">
                  {g.rows.map((r) => (
                    <Row key={r.landing.id} r={r} compact={compact} selected={r.landing.id === id} now={now} onKey={onRowKey} />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
        <p className="logbook__origin">
          <Icon name="commit" size={12} /> The history starts with the import of the first code{createdAt ? `, ${ago(createdAt, now)}` : ""}.
        </p>
      </section>
      {id && (
        <div className="logbook__detail">
          <WhyTrail id={id} />
        </div>
      )}
    </div>
  );
}
