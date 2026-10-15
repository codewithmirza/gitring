# views/story

The scroll story of the landing page: one pinned stage, one line called main, and seven chapters. Agents leave the line, work on their own lines and come back as merged work. The plan and the reasons are in `docs/design/landing-story.md`. `../waitlist/Landing.tsx` is the only caller.

Units: 1 u is 1% of the stage width. A y value is a percent of the stage height.

- `thread.ts`: pure maths of the thread (waypoints, path, tip, progress, rail parts). Adapted from the portfolio of the founder, with its MIT notice.
- `geometry.ts`: the numbers and tables of the story (canvas, main, the lines of the agents, the rail).
- `place.ts`: puts a part of a scene on the canvas and tells the engine when to show it.
- `copy.ts`: every word of the story, so a test can check each sentence.
