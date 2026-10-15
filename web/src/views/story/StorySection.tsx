/**
 * The story section of the landing page: plain text first, then the pinned story when it is near.
 * Used by waitlist/Landing.tsx. It must stay small: it is part of the first script of the page.
 * The section element and the skip link stay when the story replaces the plain text, so keyboard focus is not lost.
 */
import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
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

/** True once the section is near the visible part of its scroll box. It never turns false again. */
function useNearViewport(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const section = ref.current;
    if (!section || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const watch = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setNear(true), {
      root: readScrollRoot(section).element,
      rootMargin: LOAD_MARGIN,
    });
    watch.observe(section);
    return () => watch.disconnect();
  }, [ref, near]);
  return near;
}

export function StorySection() {
  const section = useRef<HTMLElement>(null);
  const near = useNearViewport(section);
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
            <Story section={section} />
          </Suspense>
        </Boundary>
      ) : (
        plain
      )}
    </section>
  );
}
