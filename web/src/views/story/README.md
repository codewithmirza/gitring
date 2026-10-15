# views/story

The scroll story of the landing page: one pinned stage, one line called main, and seven chapters. Agents leave the line, work on their own lines and come back as merged work. The plan and the reasons are in `docs/design/landing-story.md`. `../waitlist/Landing.tsx` is the only caller.

Units: 1 u is 1% of the stage width. A y value is a percent of the stage height.

- `thread.ts`: pure maths of the thread (waypoints, path, tip, progress, rail parts). Adapted from the portfolio of the founder, with its MIT notice.
- `geometry.ts`: the numbers and tables of the story (canvas, main, the lines of the agents, the rail).
- `place.ts`: puts a part of a scene on the canvas and tells the engine when to show it.
- `copy.ts`: every word of the story, so a test can check each sentence.
- `Story.tsx`: the pinned story (stage, canvas, thread, chapters with scenes, rail). A separate chunk.
- `StorySection.tsx`: the section of the landing. It shows the plain story, and loads `Story` when the section is near.
- `StaticStory.tsx`: the story as plain stacked text, with no drawing.
- `Chapter.tsx`: the opening and one chapter (number, heading, text). The same markup in every layout.
- `index.ts`: the public surface of the folder.
- `story-base.css`: the stacked layout (spine, nodes, text), which is also the layout before the story loads.
- `story-wide.css`: the pinned layout (stage, canvas, thread, rail, reveals, print).
- `story-scenes.css`: the look of the parts of the scenes (plates, gates, parcel, diamond, record).
- `example.ts`: the real strings of the shop example, each with its source.
- `engine/`: the motion (see its README).
- `scenes/`: one drawing for each chapter (see its README).
