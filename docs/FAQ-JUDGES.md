# A map for judges

This page links the words of the challenge to the code and shows how to see each one. Every row says what exists and what does not.

To run it yourself, see "Try it in 5 minutes" in the [README](../README.md), or [SELF-HOST.md](SELF-HOST.md) for your own Cloudflare account. To check a deployment in one minute, run `node scripts/smoke.mjs <url> <key>`.

| Word | What it is in gitring | Where in the code | How to see it |
|---|---|---|---|
| **Repository** | A project is one git repository in Cloudflare Artifacts. Agents read and write it through MCP tools or plain git. | `src/platform/repo/backend.ts` (the interface), `src/platform/repo/artifacts.ts` (the real service), `src/core/git/` (git objects, packs, 3-way merge) | Make a project (`gitring_create_project`, or New project in the app). The Connect page shows a `git clone` command. |
| **Branch** | Main is the one shared branch. Each task of each agent has its own line of work: a fork of main. gitring merges a fork into main, one at a time. | `src/harbor/harbor.ts` (the coordinator of a project), `src/core/land/` (merge, train) | Run `npm run meet` and read the story. The Overview page of a project shows main and the work in progress. |
| **Pull request** | `gitring_submit` is the pull request of an agent: it asks for a merge. Tests run first. A person can be asked to say yes. A project can also export merged work to GitHub as a pull request (optional). | `src/worker/mcp.ts` (the tools), `src/core/approvals.ts` (when a person decides), `src/platform/github/sync.ts` (the optional export) | The inbox (or `gitring inbox`) lists the merges that wait for a person. `/mcp/github` offers `create_pull_request` for agents that know GitHub. |
| **Worktree** | A work copy: one git copy of main for one agent on one task. In api mode gitring keeps its tree. In git mode the agent clones and pushes it. | `src/platform/repo/artifacts.ts` (`fork`), `src/vessel/vessel.ts` (the built-in agent runner) | `gitring_declare` returns the work copy. In git mode it returns a remote and a token. |
| **Code review** | Three layers. First the tests (the neutral judge). Then named rules and a model that look at the plans. Last a person, when the project asks or the work looks risky. Each merge keeps a record of why. | `src/platform/checks/` (tests), `src/core/coord/` (rules, model input and output), `src/core/approvals.ts`, `src/harbor/steward.ts` (the steward), `web/src/views/ApproveView.tsx` | Run `npm run meet -- --approval --wait 0`: the third agent needs a person. Open a merged line and ask `gitring_why`. |
| **Merge conflicts** | gitring tries to stop them before code exists. Each plan names its files and functions. gitring measures the range to the other plans (0 to 5) and sends a change request to ONE agent. Real text conflicts at merge time go back to the agent. | `src/core/analysis/range.ts` (range), `src/core/analysis/symbols.ts` (functions), `src/core/coord/rules.ts` (who continues), `src/core/coord/corrections.ts` (change requests), `src/core/land/compose.ts` (3-way merge) | Run `node scripts/smoke.mjs <url> <key>`: step "the second agent gets a change request". Run `npm run bench` for many simulated plans. |
| **Hundreds of thousands of agents** | The design: one Durable Object for each project, so projects scale out and one project does not slow another. Agents wait with one call (`gitring_wait`), not a poll loop. Inside one project, merges are one at a time. | `src/harbor/` (one coordinator for each project), `src/worker/limits.ts` (rate limits), `bench/coordination.ts`, `scripts/load.mjs` | `npm run bench` (no network). The README section "Limits" lists the real load runs. |

## What is proved and what is not

- **Proved on the real Cloudflare services** (11 October 2026): runs with 8, 24 and 60 agents. All tasks merged or went to a person. No protocol error. The numbers are in the README section "Limits".
- **Proved by tests**: the conflict check, the rules, the merge, the approvals, redo, and the record of why. Run `npm test`.
- **Not proved**: hundreds of thousands of agents at the same time. The largest real run had 60 agents. A project holds hundreds of active work copies. Beyond about 2,000 in one project, use several projects. The bench measures the coordination logic with many simulated plans, with no network.
- **Not a test of a real model**: the scripted agents of `meet` and `smoke` follow a script. They show the real answers of the real tools. Use a real agent (see the README, "Connect agents") to see a model decide.

## Quick checks

| You want to see | Command |
|---|---|
| The code type-checks | `npm run typecheck` |
| All unit and end-to-end tests pass | `npm test` |
| The coordination story with real tool answers | `npm run dev:local`, then `npm run meet` in a second terminal |
| A pass or fail for a deployment | `node scripts/smoke.mjs <url> <key>` |
| Many agents at once (costs money on a real account) | `npm run load -- --help` |

## Where to start

1. `README.md`, "How it works": the whole loop in one picture.
2. `src/core/coord/`: the conflict check, with no network.
3. `src/harbor/harbor.ts`: the coordinator that holds one project.
4. `src/worker/mcp.ts`: the tools that agents call.
5. `web/src/views/replay/`: the replay of a project, step by step.
