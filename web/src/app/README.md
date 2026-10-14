# app

The app shell: the frame around every page, the router and the parts that more than one page uses.

- `App.tsx`: the shell (top bar, the page of each route, shortcuts, toasts, the first load of a project).
- `router.tsx`: a small path router on the History API.
- `views.ts`: the lazy views, each in its own chunk, and the preload on hover.
- `ui.ts`: UI-only state that views share (the sign-in panel, the composer and its pending tasks).
- `actions.ts`: project actions that more than one view starts; each shows its result in a toast.
- `TopBar.tsx`: view tabs, search, connection state, decisions, the inbox button, stats and theme.
- `Account.tsx`: the project switcher, the person menu, the sign-in panel and the "you can only view" banner.
- `CommandPalette.tsx`: the command palette (Ctrl+K or Cmd+K): jump to projects, tasks, agents, files and pages.
- `palette.ts`: the logic of the palette without the DOM (fuzzy match, prefixes, ranking).
- `Shortcuts.tsx`: the list of keyboard shortcuts.
- `keys.ts`: key names for hints (Cmd on Apple devices, Ctrl elsewhere).
- `IntentsRail.tsx`: the task rail (composer and tasks by status).
- `Composer.tsx`: the task composer at the top of the task rail.
- `taskText.ts`: task text helpers (split a title and a goal).
- `LaunchControl.tsx`: how many built-in agents work on a task, which models, and the start button.
- `TrafficRail.tsx`: one row for each active agent, and the detail of the selected agent.
- `RadioLog.tsx`: the activity log of all agents.
- `ImportPanel.tsx`: what the overview shows while main is empty (a first task or an import in progress).
- `ApprovalTray.tsx`: the tray of chips for merges that wait for a yes.
- `ApprovalCard.tsx`: one question that asks for a yes, with the facts and the answers.
- `approvalActions.ts`: answers a question that asks for a yes (chip, list and approve page share it).
- `QuestionCard.tsx`: one question for a person (which work adapts, a redo or a pause).
- `lineRequest.ts`: who may ask an agent to change lines, and the request itself.
- `wait-copy.ts`: plain words for the moments when the page waits.
- `useMedia.ts`: a hook for a media query.
- `useNow.ts`: a hook for the current time.
- `app.css`: the styles of the shell; it imports `styles/` in order.
- `approvals.css`: the styles of the tray and the cards.
- `styles/`: the parts of `app.css` (see its README).
