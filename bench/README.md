# bench: the coordination benchmark

`npm run bench` runs the pure coordination code of `src/core` on synthetic plans: no network, no Artifacts, no Durable Object and no AI model. It shows how many merge conflicts the plan check avoids and how long the check takes. It needs Node 22.7 or later and no extra package.

- `coordination.ts`: the benchmark. Options: `--agents`, `--sectors`, `--seed`. The test is `test/bench/coordination.test.ts`.
- `register.mjs`: registers the module hook below. `npm run bench` loads it with `--import`.
- `ts-resolve.mjs`: the module hook that lets Node find imports that have no file extension. The source of gitring writes them that way.

## The model of the run

A sector is one part of a large code base. Each agent makes one change: it sends a plan (declare), writes (grow), and lands. All agents work at the same time. A few files get most of the work. Some changes edit a function signature, and some changes use a function that others edit. Two runs use the same work.

- Without the plan check: landing conflicts count when a landed change overlaps the lines of an agent, or changes a signature that the agent uses, and the agent did not know.
- With the plan check: the check runs when an agent declares and when it has written. The agent that must give way gets the change request and moves its edits. When a task lands, the agents near it move onto the new main (re-plot). An agent applies a change request correctly in `ADAPT_P` of the cases. The rest is a mistake of the agent.

## Run it

- `npm run bench`: 100000 agents, 100 sectors, seed 1.
- `npm run bench -- --agents 20000 --sectors 20 --seed 7`.

The script runs with plain Node 22.7 or later. `node --experimental-transform-types` reads the TypeScript files, and `register.mjs` lets Node find the imports that have no file extension.
