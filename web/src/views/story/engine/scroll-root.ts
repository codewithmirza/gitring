/**
 * Finds the box that scrolls the story (on the waitlist pages it is .wl, not the window) and reads its size.
 * Used by StorySection (the near-viewport watch) and by the engine. It must stay small: the landing loads it first.
 */

/** The scroll box of a story. `element` is null when the window scrolls. */
export interface ScrollRoot {
  element: HTMLElement | null;
  /** How far the box has scrolled (px). */
  scrollTop(): number;
  /** The height of the visible part of the box (px). */
  height(): number;
  /** The top edge of the visible part, in window coordinates (0 for the window). */
  top(): number;
  scrollTo(top: number, behavior: ScrollBehavior): void;
  /** The target for scroll listeners. */
  target: HTMLElement | Window;
}

const SCROLLS = /auto|scroll|overlay/;

/** The nearest ancestor with a scrolling y overflow, or null for the window. */
export function findScrollParent(from: HTMLElement): HTMLElement | null {
  for (let node = from.parentElement; node && node !== document.body; node = node.parentElement) {
    if (SCROLLS.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

export function readScrollRoot(from: HTMLElement): ScrollRoot {
  const element = findScrollParent(from);
  if (!element) {
    return {
      element,
      scrollTop: () => window.scrollY,
      height: () => window.innerHeight,
      top: () => 0,
      scrollTo: (top, behavior) => window.scrollTo({ top, behavior }),
      target: window,
    };
  }
  return {
    element,
    scrollTop: () => element.scrollTop,
    height: () => element.clientHeight,
    top: () => element.getBoundingClientRect().top,
    scrollTo: (top, behavior) => element.scrollTo({ top, behavior }),
    target: element,
  };
}
