# replay/model

The pure model of the replay: no React, no DOM. Import from `../model` (the front door), not from this folder.

- `steps.ts`: the kinds of step, the stage of each kind and the shape of a step.
- `build-script.ts`: timeline records to replay steps.
- `world.ts`: the world (tasks, vessels, lines, buoys, queue, commits) after a step.
- `schedule.ts`: when each step starts on the wall clock.
- `effects.ts`: the short map effects of each step.
- `easing.ts`: two easing curves for the effects.
