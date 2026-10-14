# views/intents

The parts of the tasks page. `../IntentsView.tsx` composes them. The styles are in `../intents.css`.

- `helpers.ts`: where a task came from, the shared diff loader, the merge button words, a suggested reason.
- `TaskPanels.tsx`: change the goal, pause the task, and the versions of the goal.
- `Lane.tsx`: one lane for each work copy.
- `MergePanels.tsx`: merge into main, or ask for a redo.
- `Spec.tsx`: the constraints and the test files of a task, under the work copies. An empty list is one quiet line.
- `rail.css`: the styles of the task rail that `../../app/styles/rails.css` does not hold (filter, day labels, row action).
