# First review: the whole app, 14 Oct 2026

Written by the design agent, following `docs/design/CRITIQUE.md`. This review changes no code. The fixes are for a later wave.

## Verdict

The three acts of the editor work, also on a phone. The map shows what the agents do. The approve page and the inbox put a merge question on one screen. The merge record says why a change is in main.

The biggest problem is the edge of the product. A stranger, or a person with a link, meets jargon, dead ends and a card that covers the page. The strong idea of the product (the map) is not on the first screens.

There is no S1 finding. There are 11 S2 findings and 15 S3 findings.

## How it was made

- **Commit:** branch `ws/design`, on top of `main` at `048bd93`. The app is the code of that commit (the build of the web app is the pre-refactor code).
- **Command:** `node scripts/shots.mjs --full`. It started a local gitring on a free port. It signed up a test person with a virtual passkey. It made the project `corner-shop` through the real API and the real MCP tools: three merges, three change requests, one merge question that waits for a person, and three more agents at work. A second project has 80 tasks. A third has a very long name and no activity.
- **Result:** 246 pictures: 41 screens, 3 themes (day, dusk, night), 2 sizes (desktop 1440x900, phone 390x844). All 246 rendered. The names are `<screen>-<theme>-<size>.png` in `tmp/shots/`. A picture that is named in a finding shows the problem in the day theme unless the finding says another theme. `-full.png` is the whole page.
- **Measures used:** `tmp/shots/details/<name>.json` (contrast, small controls, sideways scroll, type sizes, words, focus rings). I read each number against the picture.
- **What the shots cannot show:** motion (the tool runs with reduced motion) and a screen reader. They also cannot show the states that `SCREENS.md` marks "not seen". Those are a history with 200 merges, the pages of a viewer and a member, an empty inbox, a failed passkey, a GitHub step, and a merge that somebody else answered. They are not reviewed.
- **Limits of the measures:** the contrast test skips text on pictures. The focus test looks at the first 12 stops of the Tab key, and on a page that holds a row or a drawing it compares two pictures of the area.

## Score table

0 broken, 1 weak, 2 good, - cannot be judged from what was seen. Columns: 1 purpose, 2 hierarchy, 3 real material, 4 states, 5 phone, 6 keyboard and screen reader, 7 themes, 8 motion, 9 words, 10 point of view, 11 raise the ceiling.

| Screen | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Start page | 2 | 2 | 1 | 2 | 2 | 2 | 2 | - | 1 | 1 | 1 |
| Sign-in panel | 2 | 2 | 2 | 1 | 2 | 2 | 2 | - | 2 | 1 | - |
| Projects | 1 | 1 | 1 | 1 | 1 | 2 | 2 | - | 1 | 1 | 1 |
| New project | 2 | 1 | 2 | 1 | 1 | 2 | 2 | - | 1 | 2 | - |
| Overview | 2 | 2 | 2 | 1 | 1 | 2 | 2 | - | 2 | 2 | 2 |
| Tasks and task | 2 | 1 | 2 | 2 | 1 | 2 | 2 | - | 1 | 1 | 1 |
| History and merge record | 2 | 2 | 2 | 1 | 1 | 2 | 2 | - | 1 | 2 | 1 |
| Approve | 2 | 2 | 2 | 1 | 2 | 2 | 2 | - | 2 | 2 | 1 |
| Code | 1 | 2 | 2 | 1 | 1 | 2 | 2 | - | 2 | 2 | 2 |
| Connect | 1 | 1 | 2 | 1 | 1 | 2 | 2 | - | 1 | 1 | 1 |
| Replay | 2 | 1 | 2 | 1 | 1 | 2 | 2 | - | 1 | 2 | 2 |
| Settings | 1 | 1 | 2 | 1 | 1 | 2 | 2 | - | 1 | 1 | - |
| Inbox | 2 | 2 | 1 | 1 | 2 | 2 | 2 | - | 2 | 2 | 2 |
| Account | 2 | 2 | 2 | 1 | 2 | 2 | 2 | - | 2 | 2 | 2 |
| Command palette | 2 | 2 | 2 | 1 | 2 | 2 | 2 | - | 2 | 2 | - |
| Pages that fail | 1 | 1 | 1 | 1 | 2 | 2 | 2 | - | 0 | 1 | - |

Notes on the scores:

- **Keyboard (6):** the tool presses Tab up to 12 times on each of the 246 pictures and compares the picture of the focused area with and without the focus. Every stop that was in the window showed a ring: no stop without a ring. A skip link exists, and the focus moves to the heading when the page changes. On 69 pictures the page has fewer than 12 stops. The labels are read from the code. No screen reader ran.
- **Themes (7):** Day, Dusk and Night all pass the contrast test, with two exceptions that fail in all three themes (finding 18 and finding 9: a disabled button and a disabled-looking tool). Night is not Day turned upside down: the map keeps its colors and the diff keeps its meaning (see "Not changed"). In Day only, two more marks miss 4.5 to 1 by 0.02: the plus sign and the minus sign of the diff on the Approve page (4.49 and 4.48 to 1).
- **Motion (8):** the pictures are still. The CSS has ten `infinite` animations (spinners, the shimmer of skeletons, and the pulse `cx-breathe` on the Connect page). The tokens say "no loops". I did not score the check.
- **States (4):** a 2 needs a seen empty state, a seen error state and a seen long or many-row state. Few screens have all three. A 1 does not say that the state is bad. It says that the state was not seen or is only half there.

## Findings

### 1. S2. Approve, signed out. A person who opens the link of a merge question without a session reaches a dead end

- **What is wrong:** the page says "Sign in to open this project." There is no word about the merge question. The top bar shows a project switcher with the placeholder "gitring main -------", the badge "Offline" and the text "No decisions", as if the project had loaded and nothing waited. The link "Open the projects" and the button "Sign in" touch each other with no space.
- **Why a person cares:** the link in a message on a phone is the quickest way to answer. The person must work out that the problem is only a missing sign-in, and that a merge waits.
- **Fix:** when the route is `/approve/…` and nobody is signed in, show "Sign in to answer a merge question." and one primary button "Sign in". Hide the project switcher, "Offline" and "No decisions" until a project has loaded. Put a gap in the row of actions.
- **File:** `web/src/app/App.tsx` (`Booting`), `web/src/app/TopBar.tsx` (the connection badge at line 109, the decisions button at line 272, the project switcher), `web/src/chart/chart.css` (the only file that styles `.c-empty__actions`: the chunk of the map does not load on this page, so the row has no gap; move the rule to `components.css`).
- **Evidence:** `approve-signed-out-day-desktop.png`, `approve-signed-out-day-phone.png`. The same "No decisions" while nothing is known shows in `tasks-loading-day-desktop.png`.

### 2. S2. A link to a project that does not exist or is not valid shows a sentence for a developer, and says "Offline"

- **What is wrong:** the page says "Use a project id of lowercase letters, digits and dashes (at most 40)." The badge says "Offline" and the bar says "No decisions", while the connection is fine and the Inbox shows 1 question.
- **Why a person cares:** the person did nothing wrong. A broken or old link gives a rule about identifiers and a false state.
- **Fix:** for the answers 400, 403 and 404, show "This project does not exist, or you cannot open it." with the link "Open the projects", and do not set the state "offline". Keep the server text only for people who look at the console. The text comes from `src/worker/index.ts` line 67: do not change it there.
- **File:** `web/src/state/api.ts` (the `catch` of `boot()`, lines 620 to 627: `store.setConn("offline", (e as Error).message)`).
- **Evidence:** `project-missing-day-desktop.png`, `project-missing-night-phone.png`.

### 3. S2. The card of the merge question covers the page

- **What is wrong:** the tray is `position: fixed` at the bottom right (at the bottom on a phone). Nothing reserves its space (`--tray-h` only lifts the toasts). On a phone the card is about 150 px tall, the page ends 48 px above the bottom, so about 100 px of the last rows are hidden. On a desktop it cuts the end of the activity rows on the Overview and sits on the "Add" button of the members form in Settings.
- **Why a person cares:** the question must come to the person, and it must not hide the work. Today it hides the end of every list.
- **Fix:** add `padding-bottom: var(--tray-h)` to the scrolling panes (`.page`, the task list, the activity log). The tray already measures its height. On a phone, let the card show the question and "Yes, merge" in two lines, and open the rest on tap.
- **File:** `web/src/app/approvals.css` (`.aptray`), `web/src/app/ApprovalTray.tsx` (`useTrayHeight`), `web/src/app/app.css` (`.page`, line 788).
- **Evidence:** `tasks-day-phone.png` (the merged rows disappear under the card), `overview-night-desktop.png` (the activity text is cut at the right), `settings-day-desktop.png` (the member form).

### 4. S2. A long project name pushes the theme control out of the window

- **What is wrong:** with a project name of 55 characters, the top bar is wider than a 1440 px window. "Night" is cut at the right edge and the page scrolls sideways. The name box is limited to 220 px, but the five views, the search and the state text do not shrink (`.topbar__nav { flex: none }`). The rules that save room start at 1320 px and below.
- **Why a person cares:** a team that names projects after services (`storefront-and-checkout-service-for-the-european-market`) loses a control on the most common desktop width. Four screens and three themes show it.
- **Fix:** limit `.topbar__projname` to `clamp(120px, 14vw, 220px)` and let `.topbar__right` shrink: hide the text of "No decisions" and "Live" before the theme control leaves the window.
- **File:** `web/src/app/app.css` (line 69 and the media rules at lines 706 to 745).
- **Evidence:** `overview-new-project-day-desktop.png`, `tasks-new-project-day-desktop.png`, `history-new-project-day-desktop.png`, `code-new-project-day-desktop.png` (the measure `sidewaysScroll` is true in all of them).

### 5. S2. The task page puts empty sections before the work

- **What is wrong:** below the title and three buttons, the first screen shows "Constraints 0", "Tests 0" and "Versions v1". The agent, its tests, its change requests and its diff start below them (about 440 px from the top on a desktop, and about 570 px on a phone, where the card of the tray covers them). "Start agents" is still the first button of a task whose agent already works (it is a quiet button, but it comes first).
- **Why a person cares:** "see what the agents do now" is the first act of the editor. On this page the answer is below the fold, and the first things are empty.
- **Fix:** put the work copies above Constraints, Tests and Versions. When a section is empty, show one quiet line ("No constraints yet. Add one.") and not a heading with a zero. Move "Start agents" after the other two buttons when an agent works.
- **File:** `web/src/views/IntentsView.tsx` (the sections at lines 684 to 739: constraints, checks, the versions column, then the work copies at line 739; the buttons at lines 668 to 677, `LaunchButton` is in `web/src/app/LaunchControl.tsx`).
- **Evidence:** `task-day-desktop.png`, `task-day-phone.png`, `task-long-day-desktop.png`.

### 6. S2. Projects is a list of identical cards with no live fact

- **What is wrong:** three equal cards say "Started empty" or "From the Worker API template", "Private · Owner · created 7 min ago". None says that one question waits (the Inbox badge says 1), how many agents work, or when the last merge was. The card of a project with five files and three merges says "Started empty".
- **Why a person cares:** this is the screen where a person with several projects decides where to look. It is the "card soup" that INTENT refuses, and it hides the one fact that is the point of gitring.
- **Fix:** begin each card with the live fact: "1 question waits", "2 agents at work", "last merge 8 min ago". Put the source (empty, template, upload) in the project settings. The list of projects needs these numbers: that is a new field in `GET /api/projects` (`src/directory`). It is a task for a person, not a change of the look.
- **File:** `web/src/views/ProjectsView.tsx` (`sourceLine` at line 25, the card at lines 218 to 246), `web/src/views/projects.css`.
- **Evidence:** `projects-day-desktop.png`, `projects-day-phone.png`.

### 7. S2. The first minute speaks about hosts and protocols

- **What is wrong:** the Projects page opens with five sentences: "A project is one git repository. gitring holds it in Cloudflare Artifacts. … through MCP. GitHub sync is optional." On a phone the lede takes six lines, and the card that starts the project begins 307 px down, 36% of the screen. "Cloudflare Artifacts" returns in the git step ("Cloudflare Artifacts imports the repository with its history."), in Settings ("main is in Cloudflare Artifacts (corner-shop-…-g1-…, branch main)") and on the start page. The start page also says "MCP connector", "OAuth" and "3-way merge".
- **Why a person cares:** the person came to start a project in a minute. A product name of a host, a protocol and a merge method are not needed to press "Next". The first sentence should say what the person gets.
- **Fix:** one sentence under the title: "A project is the code that your agents change together." Move the storage and the host names to Settings, "Repository". On the start page, say "Your agent adds one URL" and keep "MCP" and "OAuth" in the Connect page.
- **File:** `web/src/views/ProjectsView.tsx` (the `page__lede` at line 129), `web/src/views/newproject/steps.tsx` (the sentence about Artifacts), `web/src/views/SettingsView.tsx` (the lede), `web/src/views/HomeView.tsx` ("Where your code goes", the steps).
- **Evidence:** `projects-empty-day-phone.png`, `new-project-git-day-phone.png`, `settings-day-desktop-full.png`, `landing-day-desktop-full.png`.

### 8. S2. Links and checkboxes are too small for a finger

- **What is wrong:** every one of the 41 screens has a control under 24 px on a phone (the logo link is on all of them). Examples at 390 px: the logo link is 22 by 22; "Open in code" is 64 by 14 (Approve); "Show the change" and "Work copy" are 16 px high (Code); "Open the task" is 14 px high (History); "Open the inbox" is 17 px high (Account); "See the change" is 20 px high (Inbox card); the checkbox "Start agents now" is 16 by 16 (Composer); the buttons 1 to 4 for the number of agents are 21 by 26 (New project). INTENT asks for 32 px, and 24 px at the least.
- **Why a person cares:** the next action after reading a merge question is often one of these links. A missed tap on a phone costs more than a missed click.
- **Fix:** one rule for touch screens in `base.css`: links that stand alone, checkboxes and small segment buttons get a hit area of 32 px (with padding or `::after`), without a change of the look. Raise the logo link to 32 by 32.
- **File:** `web/src/design/base.css` (add the rule), `web/src/app/app.css` (`.topbar__brand`, the rules for `pointer: coarse` at line 829), `web/src/views/ApproveView.tsx`, `web/src/views/CodeView.tsx` (`.cv-ctx__act`), `web/src/views/LogbookView.tsx`, `web/src/views/AccountView.tsx`, `web/src/views/InboxView.tsx` (`.inbox-card__link`), `web/src/app/Composer.tsx`, `web/src/views/newproject/steps.tsx`.
- **Evidence:** `approve-day-phone.png`, `code-file-day-phone.png`, `history-entry-day-phone.png`, `account-day-phone.png`, `inbox-day-phone.png`, `composer-day-phone.png`, `new-project-describe-day-phone.png`. The sizes are in `details/<name>.json`, key `targets.samples`.

### 9. S2. "Why this line?" is the idea of the product, and it looks disabled

- **What is wrong:** in a file, the button "Why?" is grey text at 2.5 to 1 contrast in Day (3.4 to 1 in Dusk and Night) and 11 px (`aria-disabled` until a line is selected). Only a tooltip says "Select a line number first". The answer, once a line is selected, is very good: the merge, the task, the plan and the tests of that line.
- **Why a person cares:** "understand why a change is in the code" is the third act of the editor, and this is how a person does it. Nobody finds it.
- **Fix:** let a click on a line number open the answer at once. Keep "Why?" always enabled: with no line selected it selects the line under the caret, or the first line that an agent changed.
- **File:** `web/src/views/code/LineHistory.tsx` (the button at lines 200 to 213), `web/src/views/CodeView.tsx` (the toolbar), `web/src/views/code/code.css` (`.cv-tool`).
- **Evidence:** `code-file-day-desktop.png` (the button), `code-why-day-desktop.png` (the answer that nobody finds).

### 10. S2. On a phone the "Why" panel covers the line that it explains

- **What is wrong:** the panel opens under the toolbar and covers lines 1 to 4. The question was about line 4, which is half hidden under the panel and the tray.
- **Why a person cares:** the person must close the panel to see the line, then open it again to read.
- **Fix:** on a phone, show the answer as a sheet from the bottom and scroll the selected line into the strip above the sheet.
- **File:** `web/src/views/code/LineHistory.tsx`, `web/src/design/components/Popover.tsx` and `placement.ts` (a sheet placement for narrow windows).
- **Evidence:** `code-why-day-phone.png`.

### 11. S2. On a phone the map labels cover each other

- **What is wrong:** the flags SKUA-5, GANNET-3 and ALBATROSS-1 overlap; "lines" and "same lines" are cut. On a desktop it happens in a smaller way: the flag GANNET-3 sits on the label "/ root" (`overview-day-desktop.png`). The map is the one bold thing of gitring, and it is the first screen of a project.
- **Why a person cares:** the map answers "who works near whom". On a phone it shows a pile of flags, and the person cannot read the one that matters.
- **Fix:** at 600 px and below, show a callsign flag only for the selected agent and for each agent that has a change request. Show the others as dots with a tap target. Move the legend card out of the first screen.
- **File:** `web/src/chart/layout.ts` (the placement of flags and labels), `web/src/chart/Chart.tsx`, `web/src/chart/chart.css`.
- **Evidence:** `overview-day-phone.png`.

### 12. S3. Replay: all-caps labels, many type sizes, words that need a guide

- **What is wrong:** "REPLAY", "INSIDE GITRING", "COMPOSE", "TESTS ON MAIN + WORK" and "PASS" are all capitals with letter spacing from .06 to .18 em. The view uses 8 type sizes before play and 11 while it plays (INTENT: at most four). The list "Inside gitring" has stage names that a person does not know: "Compose", "Commit + why-record", "Other work moves", "Merge queue".
- **Why a person cares:** the replay is the demo screen. It is the one place that shows a stranger how gitring thinks, and its labels read like an instrument panel of another product.
- **Fix:** sentence case, no letter spacing, four sizes. Rename the stages in plain words: "Combine", "Commit and record", "Other work moves to the new main", "Waiting to merge".
- **File:** `web/src/views/replay/replay.css` (lines 101, 183, 280, 370, 375, 425, 442, 456: `text-transform: uppercase`), `web/src/views/replay/captions.ts` (`STAGE_NAME`, lines 19 to 35).
- **Evidence:** `replay-playing-day-desktop.png`, `replay-day-phone.png`.

### 13. S3. Strings of facts joined with middle dots

- **What is wrong:** INTENT calls this a sign of zombie UI. It appears in more than 30 files of `web/src`. Examples: the project card ("Private · Owner · created 7 min ago"), the head of a task ("v1 · from MCP · SKUA-5 · 7 min ago"), the line of a passkey ("Added Oct 14, 2026 · last used 5 min ago · your only way to sign in"), the Settings lede ("Project id … · main is in …").
- **Why a person cares:** a person must split the string to find the one fact. The facts have different weight and different action.
- **Fix:** one fact for each line, or a two-column definition list. Keep one dot only inside a single fact such as "main 332e3fc".
- **File:** `web/src/views/ProjectsView.tsx` (line 239), `web/src/views/IntentsView.tsx` (the task head), `web/src/views/AccountView.tsx` (the passkey row), `web/src/views/SettingsView.tsx`.
- **Evidence:** `projects-day-desktop.png`, `task-day-phone.png`, `account-day-desktop.png`, `settings-day-desktop.png`.

### 14. S3. Five or six type sizes in a view, and text of 10 and 11 px

- **What is wrong:** 30 of the 41 screens show more than four sizes on a desktop: 15 show five (10, 11, 13, 15 and 28), 11 show six, two show seven, the Replay shows 8 and 11. The Overview, the Code view and the palette keep to four. The bottom bar on a phone uses 10 px labels (`--t-2xs`).
- **Why a person cares:** small labels are the hardest to read in a dim room, on a phone, with a tired eye. Too many sizes make a flat page that has no first thing.
- **Fix:** keep 11 px for captions only (the new floor in INTENT.md) and 12 px on a phone. Merge 10 px into 11 px. Check each view against four sizes.
- **File:** `web/src/design/tokens.css` (`--t-2xs`), `web/src/app/app.css` (the bottom bar, line 810: `font-size: var(--t-2xs)`).
- **Evidence:** `tasks-day-phone.png` (bottom bar), `connect-day-desktop.png`, `account-day-desktop.png`; the sizes are in `details/<name>.json`, key `sizes`.

### 15. S3. One question is shown three times

- **What is wrong:** the card of the tray, the button "1 decision" and the badge "Inbox 1" all say that one thing waits. On a phone, two brown buttons in a row ("1" with a lighthouse, "1" with an inbox) look the same.
- **Why a person cares:** three marks for one question make the person look for the second question. A count that is the same twice is noise.
- **Fix:** keep the card (it answers) and one count. Let the Inbox badge count all projects and remove the decisions button of the top bar, or fold it into the Inbox badge with the text "1 here".
- **File:** `web/src/app/TopBar.tsx` (the queue button, line 272, and the inbox button).
- **Evidence:** `overview-day-desktop.png`, `task-day-phone.png`.

### 16. S3. The tab title loses the page name when a question waits

- **What is wrong:** with one question waiting, the title of every project page is "(1) gitring". Five open tabs look the same.
- **Why a person cares:** the person who works with several tabs cannot find the Tasks tab or the Approve tab.
- **Fix:** keep the count and the name: "(1) Tasks · corner-shop · gitring".
- **File:** `web/src/state/approvals.ts` (`tabTitle`, line 70).
- **Evidence:** no picture shows a tab title. I read `document.title` with the tool on six project pages (Overview, Tasks, History, Code, Connect, Replay): all said "(1) gitring". The code is `tabTitle`.

### 17. S3. A phone cannot choose a theme

- **What is wrong:** below 761 px the three-way theme control is replaced by one cycle button, and at 600 px and below that button is hidden too ("the theme follows the system"). The account menu has no theme. A person on a phone gets Day or Night from the system and never Dusk.
- **Why a person cares:** the phone is the device of the late-evening merge question. Dusk exists for that light.
- **Fix:** add the three themes to the account menu, and keep the cycle button out of the bar.
- **File:** `web/src/app/app.css` (line 820, inside `@media (max-width: 600px)`: `.topbar .topbar__themecycle { display: none }`), `web/src/app/Account.tsx` (`UserMenu`).
- **Evidence:** `tasks-day-phone.png` (no theme control in the bar).

### 18. S3. The first action of the first minute looks disabled

- **What is wrong:** "Next" in "Describe what you want to build" is a pale blue with white text at 2.4 to 1. The same happens to "Add" and "Save name" in Settings. A disabled control does not need contrast by the rule, but this is the first thing a new person must press.
- **Why a person cares:** the button looks broken, and nothing says what is missing.
- **Fix:** keep the disabled look at 3 to 1 or better, and put one line under the field that says what enables it: "Describe the project to continue."
- **File:** `web/src/design/components/components.css` (`.b-btn:disabled`), `web/src/views/newproject/StartList.tsx`.
- **Evidence:** `projects-empty-day-desktop.png` (the contrast is 2.43 in day, 2.56 in dusk, 2.57 in night), `settings-day-desktop.png`.

### 19. S3. 80 tasks are one flat list with 80 "Start" buttons

- **What is wrong:** a project with 80 open tasks shows "Open 80" and 80 rows, each with a "Start" button. The list has no filter. The first task is open and says "No work copies yet" with a big empty area.
- **Why a person cares:** the person cannot find a task or see which ones matter. "Start" on each row asks to start by mistake.
- **Fix:** a filter field at the top of the list (the palette has one, but it is not here). Show "Start" on hover and focus only, with the name "Start agents". Group by day when there are more than 20.
- **File:** `web/src/app/IntentsRail.tsx`, `web/src/views/intents.css`.
- **Evidence:** `tasks-many-day-desktop.png`, `tasks-many-day-phone.png`.

### 20. S3. Connect is 4,050 px long and starts with four steps in the app of another company

- **What is wrong:** the first screen has the URL and a copy button, which is good. Under it, the default tab is Claude with four steps. The one command of Claude Code is behind a tab. Then come an API key, a drawing, git mode, a hook, hooks, events and GitHub. The page is for the person who connects one agent, and for the developer who reads the reference. One page serves both.
- **Why a person cares:** INTENT sets the test "one command to copy, done". The way to it is longer than the way to the whole reference.
- **Fix:** ask "Which agent?" first and show one command or one URL for that agent. Move git mode, the hook, events and GitHub to a "More ways" page or fold them.
- **File:** `web/src/views/ConnectView.tsx`, `web/src/views/connect-text.ts`.
- **Evidence:** `connect-day-desktop-full.png`, `connect-day-phone.png`.

### 21. S3. The inbox card says "The code logic changes."

- **What is wrong:** the evidence of the question is "3 files, +7 -4. 5 of 5 tests pass. The code logic changes." and "The parameters of cartTotal, formatPrice change." The second sentence is concrete. The first has no source, and the diff is one tap away ("See the change").
- **Why a person cares:** the person says yes after reading it. A sentence without a source is the "summary with no source" that INTENT refuses.
- **Fix:** show the changed signatures under the reason: `cartTotal(items, currency)` and `formatPrice(cents, currency)`. Do not show "The code logic changes." when a concrete reason is on the card.
- **File:** `web/src/app/QuestionCard.tsx`, `web/src/app/ApprovalCard.tsx`, `web/src/views/InboxView.tsx`. The sentence is made in `src/core/analysis/meaning.ts` line 136, and an agent may read it: hide it on the card when a concrete reason shows, and do not change the text there for a look.
- **Evidence:** `inbox-day-phone.png`, `inbox-day-desktop.png`.

### 22. S3. On a phone the code toolbar and the replay waste the first screen

- **What is wrong:** the Code view has four buttons (Files, the branch, Find file, Clone) that wrap into two rows (about 107 px of the first screen). On the replay, a gap of about 90 px lies between the map and the caption, and the list "Inside gitring" is cut by the controls.
- **Why a person cares:** the first screen of a phone shows tools and not the code or the map.
- **Fix:** one row: Files, branch, and a menu with "Find file" and "Clone". On the replay, give the map the free height.
- **File:** `web/src/views/code/code.css` (the toolbar), `web/src/views/replay/replay.css` (the phone layout).
- **Evidence:** `code-day-phone.png`, `replay-day-phone.png`.

### 23. S3. Settings: one page of 3,390 px, and words from inside the engine

- **What is wrong:** eight sections in one scroll; the links at the top are anchors. The words include "Largest train (work copies)", "A steward watches the agents", "A Dynamic Worker runs tests/*.test.js", "HMAC-SHA256", "Artifacts remote", "Write a task file into the repository on each merge (`.gitring/intents/…`)". The help of "When a change looks risky" is five sentences.
- **Why a person cares:** the settings decide when a person says yes. A person who cannot read them leaves the default.
- **Fix:** show one section at a time (the links at the top become tabs). Rename: "Merge up to 8 work copies in one test run", "A helper agent watches for stuck work", "The test runner of gitring". Keep the protocol words in the webhook section only.
- **File:** `web/src/views/SettingsView.tsx`, `web/src/views/trains-copy.ts`, `web/src/views/steward-copy.ts`, `web/src/views/webhook-copy.ts`, `web/src/views/approval-copy.ts` (the help of the three choices).
- **Evidence:** `settings-day-desktop-full.png`.

### 24. S3. Seven pages, seven left edges

- **What is wrong:** at 1440 px the title of a page starts at x = 132 (History, Not found), 152 (Connect), 202 (Projects, Settings), 292 (Account) and 432 (Inbox). The Overview, Tasks and Code views use the whole width.
- **Why a person cares:** the title jumps when the person moves between pages. It feels like seven small apps.
- **Fix:** one column width and one left edge for the pages that are documents, and the full width only for the map, the task list and the code.
- **File:** `web/src/app/app.css` (`.page`, line 694), `web/src/views/projects.css`, `web/src/views/account.css`, `web/src/views/inbox.css`, `web/src/views/connect.css`, `web/src/views/logbook.css`.
- **Evidence:** `projects-day-desktop.png`, `account-day-desktop.png`, `inbox-day-desktop.png`, `history-day-desktop.png`, `connect-day-desktop.png`, `settings-day-desktop.png`, `notfound-day-desktop.png`.

### 25. S3. The same thing has three names, and some words are not plain

- **What is wrong:** the record of a merge is "merge record" in 9 places, "why-record" in 5 places (all in the replay), and "History" as the page. The answer button says "Yes, merge" in the tray and the inbox, and "Yes, merge it" on the Approve page. The tests say "Alone" on the Approve and Task pages; only the History explains it ("Alone, in the work copy"). The History shows internal ids next to people's names ("HERON-2 continues → PETREL-9 adapts cr_xl3k2j"), and the commit message shows the trailers `Gitring-Intent`, `Gitring-Attempt`, `Gitring-Corrections`.
- **Why a person cares:** a person learns a name once. A second name makes the person think that there is a second thing.
- **Fix:** use "merge record" everywhere (INTENT.md now says so). Use "Yes, merge" on both pages. Write "Tests in the work copy" for "Alone". Show the ids only when a person opens "Show the raw record".
- **File:** `web/src/views/replay/captions.ts` (lines 29, 45, 153, 181), `web/src/views/replay/Pipeline.tsx` (line 363), `web/src/views/ApproveView.tsx`, `web/src/design/components/EvidenceBar.tsx`, `web/src/views/LogbookView.tsx`.
- **Evidence:** `replay-playing-day-desktop.png`, `approve-day-desktop.png`, `history-entry-day-desktop-full.png`.

### 26. S3. The start page shows a drawing of the idea, and "Sign in" for a person who has no account

- **What is wrong:** the first screen has a strong headline ("Many agents. One codebase. No merge fights.") and a small drawing of two lanes and a diamond. It is not the map of gitring. The hero button says "Sign in", and so does the panel's first button; "Create an account with a passkey" is second and looks the same.
- **Why a person cares:** a stranger has no account. The first word of the page asks for one. The one thing that is only gitring's, the map, is not on the first screen.
- **Fix:** hero buttons "Start a project" (opens the panel with "Create an account" first when this browser has no passkey) and "Add gitring to your agent". See opportunity 1 for the drawing.
- **File:** `web/src/views/HomeView.tsx` (the hero buttons, `HeroArt`), `web/src/app/Account.tsx` (`SignInChoices`: the order uses `lastProvider()`), `web/src/views/home.css`.
- **Evidence:** `landing-day-desktop.png`, `sign-in-day-desktop.png`, `sign-in-create-day-phone.png`.

## Opportunities

1. **Put the real map on the start page.** The replay can run alone (`/replay?kiosk=1`). A muted replay of a small public project, or a still of its map with two flags and one change request, tells the idea in one look and is the one thing that no other tool has. It replaces the drawing (finding 26). The map is the bold thing of the chart room: spend the boldness there, and keep the rest of the first screen as quiet as it is.
2. **Make "why" the way to read code.** Today it is a disabled button (finding 9). Let a click on any line, in the code view, in the diff of the Approve page and in a merge record, answer "why is this line here?" with the plan step and the merge. On the Approve page, show the plan step next to each part of the diff, so that the person who must say yes sees the reason of each change where the change is.
3. **Let the project card answer.** The inbox across projects exists, and the card of a question can say "Yes, merge" in place. Put that card on the project it belongs to (finding 6): a person on a phone opens Projects, sees "1 question waits in corner-shop" with the question and the two answers, and never opens a second page.

## Not changed

Leave these as they are. They are the reasons that the app does not look generic.

- **The map in all three themes.** Night is not an inverted Day: the land, the water and the callsign colors keep their meaning (`overview-night-desktop.png`, `overview-day-desktop.png`).
- **The three voices.** Serif italic for what people write, mono for agents and machines, sans for the interface, used the same way on every screen.
- **The Approve page.** Why a person must say yes, then size and tests, then the real diff, with the answer in a fixed panel (at the right on a desktop, at the bottom on a phone) (`approve-day-phone.png`, `approve-night-phone.png`).
- **The inbox card on a phone.** The question, the evidence and two answers on one screen, with a primary and a secondary button of 44 px (`inbox-day-phone.png`).
- **The Why panel after a line is selected.** Merge, task, plan, tests, and a link to the record (`code-why-day-desktop.png`).
- **The merge record.** A timeline: task, plan, change requests (the replaced one stays, struck through), conflict checks, tests, decision, diff, commit. It keeps the road not taken (`history-entry-day-desktop-full.png`).
- **Empty states with one sentence and one action:** History, Overview, Code and Tasks of a new project (`history-new-project-day-desktop.png`, `overview-new-project-day-desktop.png`).
- **The lost-connection state:** "The server is not reachable. gitring tries again in 4 s." says what happened and what happens next (`overview-offline-day-desktop.png`).
- **Loading skeletons in the shape of the page** (`tasks-loading-day-desktop.png`).
- **The numbers of the strip carry a source** (the `Stat` component with `source`), and the page shows no vanity number.
- **Focus.** A visible ring on every stop of all 246 pictures (the map, the history rows and the buttons too), a skip link, and the focus moves to the heading of a new page.
- **The words.** The measure found no code name (intent, attempt, vessel, harbor, landing, logbook, course, correction) in the running text of any screen, apart from the webhook reference of Connect, the path `.gitring/intents/` in Settings, and the raw record and ids of finding 25. GitHub never comes first: the git step names it last in a list of hosts, its Settings section comes after Merging and Tests, and the sign-in panel puts passkeys first and outside accounts after "or" (read in `SignInChoices`; the local run has no outside account).
- **Hairlines, not shadows,** on the cards and the panels, and no gradient, no sparkle icon, no emoji.

## Not seen, for the next pass

A history with 200 merges; the pages for a member and a viewer; an empty inbox; five or more questions at the same time; a failed or stopped passkey; the GitHub steps of a new project; the diff view of a work copy in the Code view; the answer when somebody else already answered; the "Send back" note panel. Make each appear in `scripts/shots/screens.mjs`, shoot it, and review it.
