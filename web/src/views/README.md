# views

One file for each page of the app, with the folders that hold the parts of the big pages. `app/views.ts` loads the pages lazily by their path, so the file names here must stay.

Pages:

- `HomeView.tsx`: the start page ("/").
- `ProjectsView.tsx`: the projects of the person, and the new-project panel.
- `ChartView.tsx`: the overview (the map, the rails and the activity log).
- `IntentsView.tsx`: the tasks page; its parts are in `intents/`.
- `LogbookView.tsx`: the history of merges; its parts are in `logbook/`.
- `ApproveView.tsx`: one work copy that asks for a yes.
- `InboxView.tsx`: everything that waits for the person, in all projects.
- `CodeView.tsx`: the code page; its parts are in `code/view/`.
- `ConnectView.tsx`: add gitring to an agent; its parts are in `connect/`.
- `SettingsView.tsx`: the settings of a project; its sections are in `settings/`.
- `AccountView.tsx`: the account of the person; its sections are in `account/`.
- `ReplayView.tsx`: the replay of a project; its parts are in `replay/`.
- `DesignView.tsx`: the style guide (development only); its parts are in `design/`.

Shared parts and words:

- `ChoiceList.tsx`: a radio group with a help text under each choice.
- `labels.ts`: labels that only the lazy views use.
- `approval-copy.ts`: the words of "when does a person say yes before a merge".
- `connect-text.ts`: the words and the data of the connect page.
- `steward-copy.ts`: the words of the steward setting.
- `trains-copy.ts`: the words for trains, the test mode and reverts.
- `webhook-copy.ts`: the words of the webhook part of the settings.

Folders:

- `account/`, `connect/`, `design/`, `intents/`, `logbook/`, `settings/`: the parts of one big page each.
- `code/`: the code page: the tree, the lines, the diff, the highlighter and `view/`.
- `newproject/`: the new-project picker and its steps.
- `replay/`: the replay page.
- `waitlist/`: the pages for people that the waitlist gate keeps out.

Styles (one file for each page): `account.css`, `approve.css`, `chartview.css`, `connect.css`, `design.css`, `home.css`, `inbox.css`, `intents.css`, `logbook.css`, `projects.css`.
