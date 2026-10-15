# The screens of gitring

This file lists every screen that a person can open. It comes from the real app: the shots of 14 Oct 2026 (`node scripts/shots.mjs`, a local gitring with a project that has real agents at work). For each screen it gives the route, the one purpose, the one main action, what a person must see first, and the states. A state that the shots did not show is marked "not seen". Do not guess a state: make it appear, shoot it, and then update this file.

The picture names are `<screen id>-<theme>-<size>.png` in `tmp/shots/` (themes `day`, `dusk`, `night`; sizes `desktop`, `phone`). The screen id of each row is the first word in code font.

## How to read the state lists

- **Empty**: the project or the list has nothing yet.
- **Loading**: the content is on its way.
- **Error**: the content cannot come, or the person may not open it.
- **Long text**: a very long name or goal.
- **Many rows**: dozens of rows.

The shots show the states `tasks-loading` (loading), `overview-offline` (error), `tasks-many` (80 rows), `task-long` (a long goal) and `overview-new-project` (a long project name and no activity). The seed has only 3 merges, so the history with many rows is not seen.

## Before a person has a project

### Start page

`landing` · route `/` (signed out). A signed-in person goes to the open project instead; `/?home` shows the page again.

- **Purpose:** say what gitring is, so that a stranger can decide in one look.
- **Main action:** Sign in. The second action is "Add gitring to your agent".
- **See first:** the headline "Many agents. One codebase. No merge fights." and the drawing of two agents that merge into main.
- **States:** the page has no loading or error state of its own (it shows at once). It is 1,880 px tall on a desktop: "How it works", "Add gitring to your agent", "Where your code goes". Not seen: the waitlist form of a gitring with a waitlist gate.

### Landing with the waitlist gate

`landing-story-000` to `landing-story-100` · route `/` (signed out, a gitring with the waitlist gate on). Shot with `node scripts/shots.mjs --waitlist`, which starts the local gitring with the gate on and allows motion. The plan is `landing-story.md`.

- **Purpose:** show how work moves through gitring, in the order a person meets it: start a project, connect agents, send plans, check plans, merge tested work, ask a person only when it matters, record why. The page keeps the hero and the product video, and the story follows the video.
- **Main action:** Join the waitlist. It stands in the hero and in the closing. "Skip the story" is the first stop inside the story and leads to the closing.
- **See first:** the heading "Three agents change one shop at the same time" and one thin line, main, that agents leave and rejoin. On a wide screen the stage is pinned while native scroll draws the line (four screens of scroll at most). On a phone, in a narrow or short window, and with reduced motion, the same chapters stack on a spine.
- **States:** wide and pinned (1440 by 900, seen at eight scroll positions); stacked with a growing spine (phone, seen); stacked and still (reduced motion, seen by hand); before the story code loads, the plain text of the story (seen by hand). The pictures are named `landing-story-<percent>-<theme>-<size>`. Not seen: a slow network that keeps the plain text on screen, and a failed load of the story chunk.
- **Real material:** every quoted string in a drawing is real output of the shop run of `npm run meet` (`test/web/story-example.test.ts` checks them). The agents in the example are scripts, and the page says so.

### Sign-in panel

`sign-in`, `sign-in-create` · a panel that grows from "Sign in" in the top bar, on every page.

- **Purpose:** let a person in without another service: a passkey.
- **Main action:** "Sign in with a passkey". The other choice is "Create an account with a passkey" (one field: your name).
- **See first:** the two passkey choices, and the reason that the page gave ("Sign in to make projects, write tasks and connect your agents.").
- **States:** choices and the name field are seen. Not seen: the answer when a person stops the passkey, "This browser cannot use passkeys", and the buttons for GitHub or Google (the local run has no outside sign-in).

### Projects

`projects`, `projects-empty`, `projects-new` · route `/projects`.

- **Purpose:** choose a project, or start one.
- **Main action:** "New project". A person without a project sees the start list on the page, with no extra click.
- **See first:** with projects, the list "Your projects". Without, the card "Start your first project".
- **States:** empty is seen (`projects-empty`). Long name is seen: the card name is cut with "…". Many rows: not seen (3 projects). Loading and error: not seen.

### New project

`new-project-describe`, `new-project-template`, `new-project-empty`, `new-project-git`, `new-project-push`, `new-project-upload` · inside Projects (`/projects`, or `/projects?new=1` as a panel).

- **Purpose:** make a project in one minute, with no account at another service.
- **Main action:** "Create project". The first step is one field: "Describe what you want to build", then "Next".
- **See first:** the description field, and under it the five ways to start: Template, Empty project, Upload a folder, Push with git, Import from a git URL.
- **States:** all six steps are seen on desktop and phone. Not seen: a GitHub repository step (needs GitHub), an error when the URL is wrong, the wait while a large import runs.

## Inside a project

All project screens show the top bar (project name, the five views, search, live state, decisions, inbox, account, theme) and a strip of project numbers. On a phone the five views are in a bar at the bottom. A merge question that waits for the person shows as a card at the bottom right (at the bottom on a phone), on every page.

### Overview

`overview`, `overview-new-project`, `overview-offline`, `overview-no-project` · route `/overview` (old path `/chart`).

- **Purpose:** see what the agents do now, on one map.
- **Main action:** select an agent to read its plan and change requests. When something waits, answer the card at the bottom right.
- **See first:** the map: folders and files as land, agents as flags, a line and a magenta label where two plans are close.
- **States:** busy is seen (4 agents, 1 change request). Empty is seen: a card on the map says "No agents work now" and offers "New task" and "Start agents". Error is seen (`overview-offline`: "The server is not reachable. gitring tries again in 4 s."). A new person with no project is sent to Projects. Long name is seen: it cuts the top bar (see the review). Not seen: 20 or more agents.

### Tasks

`tasks`, `task`, `task-long`, `tasks-many`, `tasks-loading`, `tasks-new-project`, `composer` · routes `/tasks` and `/tasks/:id` (old path `/intents`).

- **Purpose:** write what must change, and see the work copies of each task side by side.
- **Main action:** "Write a task…" (key `n`). On a task: "Start agents", or "Yes, merge" for work that waits.
- **See first:** the task list grouped as Needs a yes, At work, Open, Merged; and the open task with its goal.
- **States:** all five are seen. Empty: the composer opens by itself and the page explains a task. Loading: a skeleton in the shape of the list and the task. Long text: an 87-character title and a 312-character goal wrap well. Many rows: 80 open tasks in one flat list. Error: the offline state of the project (see Overview).

### History

`history`, `history-entry`, `history-new-project` · routes `/history` and `/history/:id` (old path `/logbook`).

- **Purpose:** read why each merge into main happened.
- **Main action:** open a merge. The record shows the task, the plan, the change requests, the tests and the decision.
- **See first:** the list of merges, newest first, with method, agent, change requests, tests and time. In a record: the task title and one sentence that says who merged it and how.
- **States:** empty is seen ("No merges yet. Write a task: …"). A record with 3 change requests is seen. Not seen: 200 merges, an alternate work copy that did not merge.

### Approve

`approve`, `approve-signed-out` · route `/approve/:workCopyId`.

- **Purpose:** answer one merge question: yes, or send back.
- **Main action:** "Yes, merge it". The second action is "Send back…" with a note for the agent.
- **See first:** the task title, who asks ("TERN-7 asks to merge this into main"), then why a person must say yes, the tests, the diff. The answer is in a panel at the right on a desktop and at the bottom on a phone.
- **States:** waiting is seen. Signed out is seen: a dead end (see the review). Not seen: already answered by somebody else, the "Send back" note panel, a merge that cannot merge cleanly.

### Code

`code`, `code-file`, `code-why`, `code-new-project` · routes `/code`, `/code/:ref` and `/code/:ref/<path>`.

- **Purpose:** read the code of main or of a work copy, and see which agents work on which file.
- **Main action:** open a file. In a file: ask "Why line N?".
- **See first:** the file tree with dots for the agents on each file, and the list "Where agents work".
- **States:** tree and a file are seen. The Why panel is seen (merge, task, plan and tests of the line). Empty project is seen (one file). Not seen: a large file, the diff view of a work copy (`?view=diff`), a binary file.

### Connect

`connect` · route `/connect`.

- **Purpose:** connect an agent.
- **Main action:** "Copy URL", then follow the steps for the agent of the person.
- **See first:** the connector URL and its copy button. Under it: tabs for Claude, Claude Code, Cursor, Codex and Other.
- **States:** the page is seen with three agents that worked on the project. Not seen: the page for a viewer, the key that a person creates, a project with no agent yet. The page is 4,050 px tall on a desktop: the URL, then an API key, a drawing, git mode, a hook, hooks, events and GitHub.

### Replay

`replay`, `replay-playing` · route `/replay` (add `?kiosk=1` to show the map alone, for a recording: not shot).

- **Purpose:** play the history of the project back on the map, and show what gitring does inside.
- **Main action:** "Play". The speeds go from 1x to 120x.
- **See first:** the map at the start, the line "Press play to see the history of this project.", and the list "Inside gitring".
- **States:** before play and in the middle of the play are seen. Not seen: a project with no history, the end of the play.

### Settings

`settings` · route `/settings`.

- **Purpose:** decide who is in the project, when a person says yes, how tests run, and what goes out.
- **Main action:** none for the page. Each section has its own save button.
- **See first:** the project name, then General, Members, Merging, Tests, GitHub, Webhooks, Archive in one long page (3,390 px).
- **States:** the owner view is seen. Not seen: the view of a member or a viewer, a saved or failed save, a webhook error.

## For the person, in all projects

### Inbox

`inbox` · route `/inbox`.

- **Purpose:** answer what waits for the person, across projects. This is the screen for a phone, away from the desk.
- **Main action:** "Yes, merge". The second action is "Send back…".
- **See first:** "1 thing waits for you", then a card with the project, the task, the question, the evidence and the two answers.
- **States:** one question is seen. Not seen: the empty inbox, five or more questions.

### Account

`account` · route `/account`.

- **Purpose:** manage the person's sign-in and keys, and choose where merge questions come.
- **Main action:** none for the page. The first block is "Merge questions": In the agent's chat, In the gitring app, In both.
- **See first:** the name, "Sign out", and the three choices for merge questions.
- **States:** one passkey, no connected apps and no key are seen. Not seen: a failed passkey, several keys, a connected app.

## Everywhere

### Command palette

`palette` · `Ctrl K` or `/` on every page.

- **Purpose:** go to any page, task, agent or file, or run a command, from the keyboard.
- **Main action:** type, then Enter.
- **See first:** the field and the commands "New task", "New project", "Connect an agent".
- **States:** the open palette with no text is seen. Not seen: a search with no result.

### Pages that fail

`notfound`, `project-missing`, `approve-signed-out`, `overview-offline` · any path.

- **Purpose:** say what happened and what to do next.
- **Main action:** one link ("Open the overview", "Open the projects") or one button ("Sign in").
- **See first:** one sentence under a small drawing.
- **States:** a path that does not exist, a project id that is not valid, a link that needs a sign-in, and a lost connection are seen. Their words are in the review.
