/**
 * The tray: one chip for every merge that waits for a yes from the person who looks.
 * It shows on every project page, so that a question does not wait behind a page that the person does not look at.
 * At most three chips show, the newest at the bottom; "+N more" opens the decisions list.
 * A small window shows fewer chips: the tray must not cover the page.
 * On the approve page the tray is one line, because the answer of that page is in the same corner.
 */
import { useEffect, useRef, useState } from "react";
import { announceText, useMyQuestions } from "../state/approvals";
import { useStore } from "../state/store";
import { ApprovalCard } from "./ApprovalCard";
import { isProjectRoute, type Route } from "./router";
import { openDecisions, useUi } from "./ui";
import { useMedia } from "./useMedia";

const MAX_CHIPS = 3;

/** How many chips fit: three on a wide screen, one on a phone (the tray sits in the page there), fewer where the window is low. */
export function useMaxChips(): number {
  const wide = useMedia("(min-width: 761px)");
  const high = useMedia("(min-height: 640px)");
  const low = useMedia("(min-height: 480px)");
  if (wide) return high ? MAX_CHIPS : low ? 2 : 1;
  return 1;
}

/**
 * Tell the page how much room the tray takes (CSS: --tray-h and --tray-room).
 * --tray-h is the height of the tray: the toasts sit above it.
 * --tray-room is the part of the page that the tray covers: the panes that scroll keep that much free at their end,
 * so that the tray never hides the last rows or a control. It is 0 where the tray is a row of the page (narrow screens).
 * --tray-edge is the width that the tray takes at the right edge. The activity log of the map keeps that much free
 * where the right rail is closed and the tray floats over the log (761 to 1180 px).
 */
function useTrayHeight(el: HTMLElement | null) {
  useEffect(() => {
    const root = document.documentElement;
    const clear = () => {
      root.style.removeProperty("--tray-h");
      root.style.removeProperty("--tray-room");
      root.style.removeProperty("--tray-edge");
    };
    if (!el) {
      clear();
      return;
    }
    const page = document.getElementById("main");
    const set = () => {
      const box = el.getBoundingClientRect();
      // A tray that the page hides (display: none) has no height: the toasts and the page need no room.
      if (Math.ceil(box.height) <= 0) return clear();
      root.style.setProperty("--tray-h", `${Math.ceil(box.height) + 8}px`);
      const covered = page ? Math.ceil(page.getBoundingClientRect().bottom - box.top) : 0;
      if (covered > 0) root.style.setProperty("--tray-room", `${covered + 8}px`);
      else root.style.removeProperty("--tray-room");
      if (getComputedStyle(el).position === "fixed") root.style.setProperty("--tray-edge", `${Math.ceil(window.innerWidth - box.left) + 8}px`);
      else root.style.removeProperty("--tray-edge");
    };
    set();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(set) : null;
    ro?.observe(el);
    if (page) ro?.observe(page);
    return () => {
      ro?.disconnect();
      clear();
    };
  }, [el]);
}

/** A polite message for screen readers when a new question arrives. */
function useArrivals(all: { key: string; title: string }[], ready: boolean): string {
  const [text, setText] = useState("");
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const keys = new Set(all.map((x) => x.key));
    // The first state is not news: the tab title and the decisions button already tell the count.
    if (seen.current === null) {
      seen.current = keys;
      return;
    }
    const fresh = all.filter((x) => !seen.current!.has(x.key));
    seen.current = keys;
    if (fresh.length) setText(announceText(all.length, fresh.map((x) => x.title)));
    else if (!all.length) setText("");
  }, [all, ready]);
  return text;
}

export function ApprovalTray({ route }: { route: Route }) {
  const mine = useMyQuestions();
  const ready = useStore((s) => s.state !== null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const onProject = isProjectRoute(route);
  const announcement = useArrivals(mine, ready);
  const max = useMaxChips();

  // The approve page of a work copy has its answer. Its chip would say the same twice. The other questions
  // shrink to one line there: chips would cover the answer.
  const here = route.name === "approve" ? route.id : null;
  // The replay has its speed buttons at the bottom right: the tray would cover them. The Decisions button stays in the top bar.
  const list = onProject && route.name !== "replay" ? mine.filter((x) => x.attemptId !== here) : [];
  const compact = route.name === "approve";
  const shown = compact ? [] : list.slice(-max);
  const more = list.length - shown.length;
  // The decisions list shows the same questions: while it is open, the tray waits.
  const waits = useUi().decisionsOpen;
  const visible = list.length > 0 && !waits;
  useTrayHeight(visible ? el : null);

  return (
    <>
      <div className="vh" role="status" aria-live="polite" aria-atomic="true">
        {onProject ? announcement : ""}
      </div>
      {visible && (
        <section ref={setEl} className={["aptray", compact && "aptray--line"].filter(Boolean).join(" ")} role="region" aria-label="Merges that wait for you" data-route={route.name}>
          {compact ? (
            <button type="button" className="aptray__morebtn" aria-haspopup="dialog" onClick={openDecisions}>
              {list.length} other {list.length === 1 ? "merge waits" : "merges wait"} for you
            </button>
          ) : (
            <ul className="aptray__list">
              {more > 0 && (
                <li className="aptray__more">
                  <button type="button" className="aptray__morebtn" aria-haspopup="dialog" aria-label={`+${more} more. Show all decisions.`} onClick={openDecisions}>
                    +{more} more
                  </button>
                </li>
              )}
              {shown.map((item) => (
                <li key={item.key} className="aptray__item">
                  <ApprovalCard item={item} variant="chip" />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
