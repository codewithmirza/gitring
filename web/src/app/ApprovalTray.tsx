/**
 * The tray: one chip for every merge that waits for a yes from the person who looks. It shows on every
 * project page, so that a question does not wait behind a page that the person does not look at. At most
 * three chips show, the newest at the bottom; "+N more" opens the decisions list.
 */
import { useEffect, useRef, useState } from "react";
import { announceText, useMyQuestions } from "../state/approvals";
import { useStore } from "../state/store";
import { ApprovalCard } from "./ApprovalCard";
import { isProjectRoute, type Route } from "./router";
import { openDecisions } from "./ui";

const MAX_CHIPS = 3;

/** Tell the toasts how tall the tray is, so that they sit above it (CSS: --tray-h). */
function useTrayHeight(el: HTMLElement | null) {
  useEffect(() => {
    const root = document.documentElement;
    if (!el) {
      root.style.removeProperty("--tray-h");
      return;
    }
    const set = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      // A tray that the page hides (display: none) has no height: the toasts need no room.
      if (h > 0) root.style.setProperty("--tray-h", `${h + 8}px`);
      else root.style.removeProperty("--tray-h");
    };
    set();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty("--tray-h");
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

  // The approve page of a work copy has its answer. Its chip would say the same twice.
  const here = route.name === "approve" ? route.id : null;
  const list = onProject ? mine.filter((x) => x.attemptId !== here) : [];
  const shown = list.slice(-MAX_CHIPS);
  const more = list.length - shown.length;
  useTrayHeight(shown.length ? el : null);

  return (
    <>
      <div className="vh" role="status" aria-live="polite" aria-atomic="true">
        {onProject ? announcement : ""}
      </div>
      {shown.length > 0 && (
        <section ref={setEl} className="aptray" role="region" aria-label="Merges that wait for you" data-route={route.name}>
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
        </section>
      )}
    </>
  );
}
