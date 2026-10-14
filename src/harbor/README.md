# src/harbor: the project coordinator

`HarborMaster` is the Durable Object of one project. It is the single writer of main, the conflict-check authority, the merge queue and the live event source for the app. Its code is a chain of layers in `master/`. Pure helpers are in `support/`.

- `harbor.ts`: the front door. The class `HarborMaster` (the last layer of the chain) with the entry points that Cloudflare calls, and the re-exports that other folders import.
- `master/`: the chain of layers. Each layer holds the methods of one job. Start with `master/README.md`.
- `support/`: pure functions, constants and types that the layers share. Start with `support/README.md`.
- `derived.ts`: the front door of the derived data of main (path history, blame, search) and the history questions.
- `derived/`: the parts of the derived data: tables, tree diff, updates, answers and compare. Start with `derived/README.md`.
- `ack-check.ts`: checks the code of a work copy when an agent confirms a change request.
- `ids.ts`: short ids, callsigns and identity colors.
- `steward.ts`: the steward: counts the facts of a project and finds real anomalies.
- `store.ts`: the SQLite storage of the project object, with JSON documents.
- `timeline.ts`: reads the timeline of a project from its records.
- `views.ts`: pure helpers that build tree texts, real changes, agent views and traffic from the state.
- `webhooks.ts`: outbound webhooks: the signing secret, the signature and the delivery with retries.
