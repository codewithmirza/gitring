/**
 * The inputs of the story: rail clicks, scroll, links to a chapter, and find-in-page.
 * Used by engine/useStoryEngine.ts. Scroll and touch stay native: no listener here stops them or moves the page against the person.
 */
import type { StoryGeometry } from "../thread";
import type { Frame } from "./frame";
import type { StoryParts } from "./paint";
import type { ScrollRoot } from "./scroll-root";

/** The part of the page that the address names: "#story" or "#story-<chapter>". Null for any other address. */
function storyHash(): string | null {
  const hash = decodeURIComponent(location.hash.slice(1));
  return hash === "story" || hash.startsWith("story-") ? hash : null;
}

/** Starts the listeners. Returns the function that stops them. */
export function bindInput(parts: StoryParts, frame: Frame, root: ScrollRoot, geometry: StoryGeometry): () => void {
  const { section, window: viewport } = parts;

  // A rail button scrolls the page to its chapter. The page moves smoothly because the person asked for it.
  function click(event: MouseEvent): void {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-go]") : null;
    if (button && frame.mode() === "horizontal") frame.scrollToProgress(Number(button.dataset.go), "smooth");
  }

  // The window is clipped, so people cannot scroll it. The browser does, to show a find-in-page match: turn that into progress.
  function followBrowser(): void {
    const layout = frame.layout();
    if (!layout || frame.mode() !== "horizontal") return;
    const dx = viewport.scrollLeft - layout.rest;
    if (Math.abs(dx) < 1) return;
    viewport.scrollLeft = layout.rest;
    frame.jumpTo((frame.shift() + dx / layout.unit) / geometry.travel);
  }

  // The page is made by script, so the browser cannot find the target of an address by itself.
  function goToHash(): void {
    const hash = storyHash();
    if (!hash) return;
    const chapter = section.querySelector<HTMLElement>(`.story-rail [data-chapter="${hash.slice("story-".length)}"]`);
    if (frame.mode() === "horizontal" && chapter) frame.scrollToProgress(Number(chapter.dataset.go), "auto");
    else document.getElementById(hash)?.scrollIntoView();
  }

  const nearby = new IntersectionObserver(([entry]) => frame.setNearby(entry.isIntersecting), { root: root.element, rootMargin: "100% 0px" });
  nearby.observe(section);
  root.target.addEventListener("scroll", frame.wake, { passive: true });
  viewport.addEventListener("scroll", followBrowser, { passive: true });
  section.addEventListener("click", click);
  window.addEventListener("hashchange", goToHash);
  // The first frame needs the layout of the section, so the address is read after it.
  const first = requestAnimationFrame(goToHash);
  return () => {
    cancelAnimationFrame(first);
    nearby.disconnect();
    root.target.removeEventListener("scroll", frame.wake);
    viewport.removeEventListener("scroll", followBrowser);
    section.removeEventListener("click", click);
    window.removeEventListener("hashchange", goToHash);
  };
}
