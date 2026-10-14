# src/worker/routes

The REST routes of the Worker, one file for each area. `src/worker/app.ts` mounts them in the order of this list. Hono tries the routes in the order that they are mounted.

| File | What it is for |
|---|---|
| `person.ts` | API keys, preferences, the inbox across projects and push notifications of the signed-in person. |
| `projects.ts` | The project list, one project (create, rename, archive) and its members. |
| `tasks.ts` | Project state, tasks, and the actions on a work copy: launch, park, merge, answer, ask for a change, redo, diff. |
| `code-and-history.ts` | The read side of a project: timeline, one merge, file tree, one file, history questions, agent runner status. |
| `settings.ts` | Project setup: tokens, import check, launch all, GitHub link, connect info, usage and settings. |
| `live.ts` | The WebSocket of a project and the live preview of main or a work copy. |
| `hooks.ts` | Inbound hooks: a key, GitHub, Slack and Claude Code open tasks from outside. |

The sign-in, OAuth, device, GitHub App and waitlist routes are older files in `src/worker/` (`auth.ts`, `oauth.ts`, `device.ts`, `github.ts`, `waitlist.ts`, `history-routes.ts`).
