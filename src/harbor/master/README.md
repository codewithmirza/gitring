# src/harbor/master: the layers of the project coordinator

`HarborMaster` is one class with about 230 methods. It is cut into a chain of abstract classes, called layers. Each layer extends the one before it and adds the methods of one job. `../harbor.ts` holds the last class, `HarborMaster`.

Rules for the chain:

1. A layer may call the methods of the layers below it. It must not call a method of a layer above it. If it must, declare the method in the lower layer as `protected abstract` (`wakeQueue` in `state.ts` is the one case today).
2. A new method goes in the layer that has its job. Do not make a new layer for one method.
3. A member that tests read by name (for example `attempts`, `corrections`, `stats`, `putAttempt`, `trimRadar`, `loadMain`) keeps its name and stays reachable on the same object.
4. All fields that more than one layer uses are in `state.ts`. A field that only one layer uses is in that layer.
5. Methods are `protected` and not `private`, because the next layer must reach them. The public methods are the API that the Worker, the MCP tools and the agent runner call.

The layers, from the bottom to the top:

1. `state.ts`: the fields, the constructor, the load at start-up, and small lookups.
2. `records.ts`: saves each kind of record, and tells people, webhooks and waiting agents.
3. `files.ts`: reads blobs, text, trees and the view of main from the repository.
4. `work-views.ts`: the view of one work copy, its real changes and the approval hash.
5. `live.ts`: the whole state for the app, and live connections.
6. `tasks.ts`: tasks, built-in agents, the AI budget and the steward.
7. `import.ts`: starts a project from a source and finishes the import.
8. `clearance.ts`: what an agent sees about other work: traffic and the check result.
9. `corrections.ts`: makes change requests and asks a person about a pair.
10. `course-check.ts`: the conflict check of one plan against the nearest plans.
11. `protocol.ts`: the agent protocol: declare, write, read, list, log, give up, confirm, brief.
12. `approvals.ts`: when a person must say yes, and how gitring asks.
13. `reads.ts`: read-only answers: status, diff, events, trees, files and history.
14. `checks.ts`: runs the tests of a tree and records the result.
15. `rebase.ts`: moves work copies onto a new main, sends work back, and redo.
16. `github.ts`: the optional GitHub link: send main, pull changes, rights of a person.
17. `merge-record.ts`: records a merge after main moved.
18. `main-tests.ts`: tests main after merges and reverts a merge that broke it.
19. `merge.ts`: merges one work copy onto main.
20. `trains.ts`: merges several independent work copies tested once.
21. `queue.ts`: the merge queue: puts work in line and starts a merge or a train.
22. `submit.ts`: takes the submit of an agent and puts the work in the queue.
23. `decisions.ts`: what people decide: merge, send back, answer, change the goal.
24. `settings.ts`: reads and changes the settings, and keeps the webhook secrets.
25. `agent-channel.ts`: new change requests, the wait tool and the Claude Code hook.
