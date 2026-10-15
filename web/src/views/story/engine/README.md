# views/story/engine

The motion of the pinned story. One animation frame loop eases toward the scroll position and writes to the DOM, so React does not render while you scroll. Native scroll only: nothing here stops or moves the page against the person.

- `useStoryEngine.ts`: the React hook that starts and stops the engine with the story.
- `frame.ts`: the loop. It chooses the layout, reads the scroll position, eases, and paints.
- `paint.ts`: the DOM writes of one frame (canvas, tip, thread clip, reveals, rail) and the reset.
- `measure.ts`: the size of the stage as units (u in px), and the height of the section.
- `mode.ts`: the three layouts (horizontal, vertical, static) and the media queries that choose.
- `input.ts`: rail clicks, links to a chapter, and the browser scrolling the clipped window.
- `scroll-root.ts`: finds the box that scrolls (`.wl` on the waitlist pages). The landing loads it first.
