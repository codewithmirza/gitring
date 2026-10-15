/**
 * The story section of the landing page: plain text first, then the pinned story when it is near.
 * Used by waitlist/Landing.tsx. It must stay small: it is part of the first script of the page.
 * The section element and the skip link stay when the story replaces the plain text, so keyboard focus is not lost.
 */
import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SMALL } from "./copy";
import { readScrollRoot } from "./engine/scroll-root";
import { StaticStory } from "./StaticStory";
import "./story-base.css";

const Story = lazy(() => import("./Story"));

/** How early the story code loads: when the section is this far (of the box height) below the visible part. */
const LOAD_MARGIN = "150% 0px";

/** The page keeps its place only if the story code arrives within this time (ms) of the request. */
const KEEP_PLACE_MS = 2500;

/** Shows the fallback when the story code fails to load (for example offline). The plain story stays readable. */
class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * True once the section is near the visible part of its scroll box. It never turns false again.
 * `onNear` runs just before it turns true, while the section still shows the plain text.
 */
function useNearViewport(ref: React.RefObject<HTMLElement | null>, onNear: () => void): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const section = ref.current;
    if (!section || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const watch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        onNear();
        setNear(true);
      },
      { root: readScrollRoot(section).element, rootMargin: LOAD_MARGIN },
    );
    watch.observe(section);
    return () => watch.disconnect();
  }, [ref, near, onNear]);
  return near;
}

export function StorySection() {
  const section = useRef<HTMLElement>(null);
  const endBefore = useRef<{ end: number; at: number } | null>(null);
  /** Where the end of the section stands in the scroll box, when the reader can see that end or the page below it. */
  const rememberEnd = useCallback(() => {
    const element = section.current;
    if (!element) return;
    const root = readScrollRoot(element);
    const end = element.getBoundingClientRect().bottom - root.top();
    endBefore.current = end <= root.height() ? { end, at: performance.now() } : null;
  }, []);
  /**
   * The story is much taller than the plain text. A reader at the end of the page (a link to the end, or "Skip the story"
   * before the code arrived) stays at the same place: the page moves so that the end of the section is where it was.
   * A reader above the section does not move. A reader who had time to scroll is not moved back.
   */
  const keepPlace = useCallback(() => {
    const element = section.current;
    const before = endBefore.current;
    endBefore.current = null;
    if (!element || !before || performance.now() - before.at > KEEP_PLACE_MS) return;
    const root = readScrollRoot(element);
    const moved = element.getBoundingClientRect().bottom - root.top() - before.end;
    if (moved) root.scrollTo(root.scrollTop() + moved, "auto");
  }, []);
  const near = useNearViewport(section, rememberEnd);
  const plain = <StaticStory />;
  return (
    <section id="story" className="story" ref={section} aria-labelledby="story-h">
      <div className="story-skip-row">
        <a className="skip-link story-skip" href="#wl-closing">
          {SMALL.skip}
        </a>
      </div>
      {near ? (
        <Boundary fallback={plain}>
          <Suspense fallback={plain}>
            <Story section={section} onReady={keepPlace} />
          </Suspense>
        </Boundary>
      ) : (
        plain
      )}
    </section>
  );
}
