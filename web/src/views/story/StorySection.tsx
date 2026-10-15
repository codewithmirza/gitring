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
  const plainHeight = useRef(0);
  const rememberHeight = useCallback(() => {
    plainHeight.current = section.current?.offsetHeight ?? 0;
  }, []);
  /**
   * The story is much taller than the plain text. A reader who is below the section (a link to the end of the page,
   * or "Skip the story" before the code arrived) must stay at the same place, so the page moves by the growth.
   */
  const keepPlace = useCallback(() => {
    const element = section.current;
    const before = plainHeight.current;
    plainHeight.current = 0;
    if (!element || !before) return;
    const root = readScrollRoot(element);
    const growth = element.offsetHeight - before;
    if (growth && element.getBoundingClientRect().bottom - growth <= root.top()) root.scrollTo(root.scrollTop() + growth, "auto");
  }, []);
  const near = useNearViewport(section, rememberHeight);
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
