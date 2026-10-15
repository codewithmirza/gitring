/**
 * The three layouts of the story and the media queries that choose between them.
 * Used by engine/frame.ts. The CSS reads the same names from data-mode on the section, so CSS and engine always agree.
 */

/** horizontal: pinned stage on a wide screen. vertical: stacked, with a growing spine. static: stacked, nothing moves. */
export type StoryMode = "horizontal" | "vertical" | "static";

/** A wide, tall enough window with motion allowed. Our scenes carry more text than a portfolio, so the floor is 640 px. */
export const HORIZONTAL_QUERY = "(min-width: 901px) and (min-height: 640px) and (min-aspect-ratio: 5/4) and (prefers-reduced-motion: no-preference)";
export const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

export function readMode(): StoryMode {
  if (matchMedia(REDUCED_QUERY).matches) return "static";
  return matchMedia(HORIZONTAL_QUERY).matches ? "horizontal" : "vertical";
}

/**
 * Calls `onChange` when the window changes size or a media query changes (zoom, a turned phone, the motion setting).
 * The calls come at most once for each animation frame. Returns the function that stops the watch.
 */
export function watchMode(onChange: () => void): () => void {
  let pending = 0;
  const schedule = () => {
    if (!pending) {
      pending = requestAnimationFrame(() => {
        pending = 0;
        onChange();
      });
    }
  };
  const queries = [matchMedia(HORIZONTAL_QUERY), matchMedia(REDUCED_QUERY)];
  for (const query of queries) query.addEventListener("change", schedule);
  window.addEventListener("resize", schedule);
  return () => {
    cancelAnimationFrame(pending);
    for (const query of queries) query.removeEventListener("change", schedule);
    window.removeEventListener("resize", schedule);
  };
}
