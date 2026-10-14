# state/selectors

Derived views of the project state. Each file holds one kind of view. Import from `../selectors` (the front door), not from this folder.

- `memo.ts`: `memo` (a memo on argument identity) and `byId` (a cached id map).
- `indexes.ts`: the active statuses and the lookup maps of one project.
- `vessels.ts`: one vessel on the map for each active work copy.
- `range-lines.ts`: the distance lines between vessels and the change-request markers.
- `queue.ts`: the queue of things that need a person.
- `intent-groups.ts`: the tasks grouped by status for the task rail.
- `logbook.ts`: the rows of the why-record, one for each merge.
- `check-lookups.ts`: small lookups into conflict checks.
