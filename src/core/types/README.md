# src/core/types

The domain types of gitring, one file for each domain. The file `src/core/types.ts` is the front door: it re-exports every file here. Import from `../core/types`, not from a file in this folder.

These files hold types and a few small constants and functions. They have no dependency on the Worker, so the web app can use them too. The code names (intent, attempt, course) are in the stored data and the API. Comments use the plain names (task, work copy, plan). See `docs/CODE-STYLE.md`.

| File | What it is for |
|---|---|
| `basics.ts` | Time, actors, people and agents: the small types that every other file uses. |
| `projects.ts` | The project record, its repository, where its code came from, and the Connect page data. |
| `settings.ts` | The settings of one project: approvals, models, webhooks, check runner, rules by folder. |
| `settings-defaults.ts` | The default settings and `withDefaults`, which fills the fields that an old project lacks. |
| `github.ts` | The optional GitHub link: sync settings, sync status and pull status. |
| `tasks.ts` | A task (intent): its goal, its checks, its status and its amendments. |
| `plan-and-changes.ts` | A plan (course) and the real changes (footprint) of a work copy. |
| `work-copies.ts` | A work copy (attempt): one agent's work on one task, with every field gitring keeps. |
| `checks.ts` | The result of one test run, and `noTestRan`, the rule for a run that tested nothing. |
| `approvals.ts` | An approval: a merge that waits for a person to say yes. |
| `conflict-check.ts` | The conflict check: distance 0 to 5, facts about a pair, assessments, the verdict. |
| `change-requests.ts` | A change request (correction): what gitring tells one agent so that two plans do not collide. |
| `records.ts` | Log lines, merges (landings) and the decisions of people. |
| `questions.ts` | Questions for a person that are not approvals: conflict, redo, steward note, revert. |
| `traffic.ts` | What an agent sees about the other work copies near it. |
| `state.ts` | The whole project state and the live events that the web app and the webhooks receive. |
| `agent-protocol.ts` | The inputs and answers of the agent tools (MCP and built-in agents). |

## Rules for this folder

- Add a type to the file of its domain. Do not add a declaration to `src/core/types.ts`.
- Never rename a field. The API, the events, the stored data and the agents depend on the names.
- A file imports another file of this folder directly (`./settings`). A cycle of `import type` is fine.
