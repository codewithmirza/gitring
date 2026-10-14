# views/replay

The replay page: the history of a project played back on the map, with the inside of gitring visible. `../ReplayView.tsx` puts it together.

- `data.ts`: loads every page of the project timeline.
- `model.ts`: the pure model (front door of `model/`).
- `model/`: steps, the world after a step, the schedule and the effects (see its README).
- `captions.ts`: one plain caption for each step, and the names of the stages.
- `clock.ts`: the replay clock (one animation frame loop).
- `Controls.tsx`: play, pause, step, speed and the scrub bar.
- `Pipeline.tsx`: the "Inside gitring" panel: one station for each stage.
- `ReplayMap.tsx`: the map with the world of the current step.
- `Effects.tsx`: the effects above the map (plans, checks, requests, the merge).
- `replay.css`: the styles; it imports `styles/` in order.
- `styles/`: the parts of `replay.css` (see its README).
