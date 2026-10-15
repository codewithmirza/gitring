# Landing story: the plan

Status: plan only (15 October 2026, branch `ws/story`). No product code exists yet. This file is the contract for the build. The design agent reviews the finished page against it.

The landing page for signed-out visitors (the waitlist version, `web/src/views/waitlist/Landing.tsx`) keeps its hero and its product video. Everything after the video becomes one scroll-driven story. A pinned stage shows one line, main. Agents leave the line, work on their own lines, and rejoin it as merged work. The story ends in the join button and the footer. The grid of five cards and the numbered list of three steps go away: the story tells their content.

## Words and units in this file

- **Stage**: the pinned screen. **Canvas**: the wide drawing that slides left behind the stage while the page scrolls.
- **u**: 1 u is 1% of the stage width. A **y** value is a percent of the stage height. Mirza's engine counts in `vw`. We count in `u`, because the stage is the width of `.wl` (the scroll box of the waitlist pages) and the scrollbar of `.wl` would skew `vw`.
- **The example**: the small shop of `examples/shop`, with the three agents of `scripts/meet.mjs`. Agent A is HERON-2 (Claude Code), agent B is PETREL-9 (Cursor), agent C is TERN-7 (Codex). These are the callsigns that gitring gives the first agents of a project (`callsignFor` in `src/harbor/ids.ts`).
- Plain names only: task, work copy, plan, change request, merge, merge record.

## 1. Purpose, and the one thing a visitor must understand

**Purpose.** Show how work moves through gitring, in the order a person meets it, with the real material of the product. A visitor who watched the video sees the same ideas again, slowly. A visitor who skipped the video learns them here.

**The one thing.** gitring warns the agent that would collide before any code exists, and only tested work reaches main, with a record of why.

**The 5-second test** (check 1 of `CRITIQUE.md`). After the story a stranger can say: "Agents send plans first. gitring warns one of two that collide. Only tested work merges, and every merge says why."

**The one action.** Join the waitlist. The hero button, the closing button and the skip link all lead there. The `onJoin` flow does not change.

**What the story is not.** It is not a feature list. It has no number about agents, users, speed or uptime, no customer, no quote, no price, and no claim about the future. It has no fake screenshot. Every drawing uses the visual words of the real map (lines, parcels, hulls, the magenta diamond of a change request). Every string in a drawing is a real string of the product (appendix A).

**The one bold thing.** The thread and its scenes. The page around it stays quiet: sans text, hairlines, no card shadow, no gradient, no stock art.

## 2. What I looked at

**Mirza's live site** (https://codewithmirza.github.io/, pictures at 9 scroll positions at 1440 by 900 and at 6 positions at 390 by 844). What I took from it:

- The wide story is one section about 4.7 screens tall (4,271 px at 900 px). One screen of it stays pinned while the page scrolls.
- A thin line with a dot at its tip is drawn from the left. The tip stays at 55% of the screen width and the canvas slides under it. Text appears when the line gets near. Labels hang from the line on hairline stems.
- A rail of chapter buttons sits at the bottom. A hairline above each label fills while the line crosses that chapter. The last item skips the story.
- The last chapter splits the line into three agents and merges them into "main". This is almost gitring's picture already. We make it the spine of the whole story.
- On a phone the same chapters stack on a vertical line with ring nodes, and the line grows with the scroll.
- What we do not take: the dot paper, the handwritten notes, the tracked all-caps labels, the arrow glyphs, the arrowhead at the end, and every word and drawing of his.

**Today's landing** (a local app with the waitlist gate on, signed out, 1440 by 900 and 390 by 844, Day and Night). The hero title is 44 px. The video sits in a 1040 px column with a 1 px border and a 10 px radius. Then come "What gitring solves" (five cards with one radius and one fill) and "How it works" (three cards). The page is 1,802 px tall on a desktop and 1,984 px on a phone. The cards are the generic kit that `INTENT.md` refuses. The video poster shows the real map with parcels and magenta diamonds, so the scenes below echo it.

**The real run.** I started a local gitring (no Workers AI binding, no call to the live site) and ran the shop story of `scripts/meet.mjs` twice. Once with `--approval --wait 0`. Once with a signed-in test person who answered "Yes, merge". I read the real output and the real "why" answers of the lines of `src/price.js`. The strings in this plan come from those runs. Appendix A lists each string and its source. The build adds a test that runs the story in process and fails when a string drifts.

**Baseline of the bundle** (`npx vite build` on this branch before any change). The landing loads four scripts first:

| File | Size | Gzip |
|---|---|---|
| `index-*.js` (holds the waitlist pages) | 114.22 kB | 36.42 kB |
| `router-*.js` | 330.23 kB | 102.29 kB |
| `react-*.js` | 218.76 kB | 68.27 kB |
| `rolldown-runtime-*.js` | 0.71 kB | 0.42 kB |
| Total | 663.92 kB | 207.40 kB |

The budget: these four files grow by at most 2.0 kB gzip (to 209.40 kB). The story code and its two big stylesheets load later, in their own chunks.

## 3. The chapters

Seven chapters. The flow is a real sequence, so the numbers 01 to 07 are honest. The numbers are page furniture: a screen reader reads the heading, not the number.

| # | Heading | The beat, in one sentence | What the picture shows | Real source in the repo |
|---|---|---|---|---|
| 01 | Start a project | Anything can start a project, and GitHub is never first. | Three boxes feed the first point of main: a typed sentence (serif), a template name (sans), one tool call (mono). | `web/src/views/newproject/StartList.tsx` and `start-text.ts` (the describe field, the order of the sources, GitHub last); `src/worker/mcp-projects.ts` (`gitring_create_project`, start kinds `empty`, `template`, `files`, `git`); `src/core/templates.ts` (the templates); `src/core/types/settings-defaults.ts` (`github.mode` is `"off"`). |
| 02 | Connect your agents | One URL connects an agent, and the agent signs in. | A URL plate over main. Three agent hulls sit on main, named by their apps: Claude Code, Cursor, Codex. | `web/src/views/ConnectView.tsx` and `connect/clients.ts` (the apps it names); `src/worker/mcp.ts` (the tool list); `src/directory/oauth.ts` (sign-in of agents); `src/harbor/ids.ts` (callsigns); `scripts/meet.mjs` (the URL shape). |
| 03 | Each agent sends a plan first | A plan names files and functions before any code exists. | HERON-2 and PETREL-9 leave main on dashed plan lines. A note shows the real plan: `gitring_declare`, the files, the function. | `src/worker/mcp.ts` (`gitring_declare`: "Send your plan BEFORE you write code"); `scripts/meet-steps.mjs` (the real plans of the shop story). |
| 04 | gitring checks plans before code exists | Two plans on one function collide. One agent gets a change request. The other continues. | Both plan lines end on the parcel `src/price.js`. A magenta dashed line between them carries the distance, 0. A magenta diamond sits on PETREL-9. The real request is beside it. A scale bar runs from 0 to 5. | `src/core/analysis/range.ts` (distance 0 to 5); `src/core/coord/facts.ts` (`MAX_CANDIDATES = 20`); `src/core/coord/corrections.ts` (the words of a request); the real run; `test/load/meet-run.test.ts` (pins the same sentences). |
| 05 | Tested work merges into main | Tests run in the work copy and again on main plus the work. Merges happen one at a time. | Test gates on both agent lines. HERON-2 joins main. A "main moved" mark appears on PETREL-9. PETREL-9 joins after it. | `src/harbor/master/checks.ts` and `merge.ts` (tests before the merge, scope `composed`); `src/harbor/master/queue.ts` (one merge at a time); `src/core/land/compose.ts`; `src/core/types/settings-defaults.ts` (`testsWhen: "before"`). |
| 06 | A person answers only when it matters | By default gitring asks when work looks risky or no test ran. The person picks where to answer. | TERN-7 stops at a gate. The real question sits under it. Three real answer places. TERN-7 joins main after the yes. | `src/core/approvals.ts` (the rules, the wording); `src/core/types/settings-defaults.ts` (`landing: "risky"`); `web/src/state/inbox.ts` (`APPROVALS_IN_TEXT`); `web/src/views/ApproveView.tsx` ("Yes, merge"); `web/src/views/InboxView.tsx`. |
| 07 | Every merge keeps its record of why | Each merge keeps task, plan, change requests, tests and decision. A click on a line number shows them. | Seven real lines of `src/price.js`. Line 4 is chosen. A plate shows its real merge record. Main ends in a ring. | `src/core/history.ts` (`WhyRecord`); `web/src/views/code/LineHistory.tsx` ("Why line N?" and the labels); `src/harbor/master/merge-record.ts`; `examples/shop/src/price.js` and `scripts/meet-files.mjs` (the code). |

**Claims I leave out on purpose.**

- Sign-up with a passkey. The waitlist asks for Google or GitHub, so the story would contradict the join step. Passkeys belong to the open product.
- Push notices on a phone. They need keys on the deployment (`src/worker/push.ts`: "Push is off when a key is absent"). The story says only that the inbox collects the questions of all projects. That is true everywhere (`InboxView.tsx`).
- Built-in agents. They need Workers AI, whose credits are used up.
- The words MCP, OAuth, "3-way merge", Artifacts and Durable Objects. `INTENT.md` keeps host names and protocols out of the first minute. The only trace is the URL ending `/mcp` and tool names in agent voice.
- "Fast-forward" and "redo" as labels. The picture shows the effect (the line moves onto the new main), not the name.
- Any number that is not a real output: no count of agents, users, merges or seconds.

## 4. The final copy

Every sentence below passed `steViolations` of `test/coord/ste.ts` (at most 20 words, no `-ing` form) and a list of banned words (the hype words, the intensifiers, the code names, em dashes, emoji). Each chapter text has two sentences or fewer. The build puts these strings in one file, `web/src/views/story/copy.ts`, and a test (`test/web/story-copy.test.ts`) keeps the rules.

**Opening** (the heading of the story section)

- Heading: `How work moves through gitring`
- Text: `Main is the line that runs through the whole story. Agents leave it to work on their own lines, and tested work merges back.`
- Cue (small, ink-3, under the text): `The example is a small shop with three scripted agents. Scroll to follow the line.`

**Chapters** (heading, then the rail label, then the text)

| # | Heading | Rail label | Text |
|---|---|---|---|
| 01 | Start a project | Start | `Describe the project, pick a template, or let your agent make it with one call. GitHub is optional and never the first step.` |
| 02 | Connect your agents | Connect | `Each agent connects with one URL and signs in. gitring gives each agent a callsign when it sends its first plan.` |
| 03 | Each agent sends a plan first | Send plans | `A plan names the files and functions the agent will change. The agent sends it before it writes any code.` |
| 04 | gitring checks plans before code exists | Check plans | `gitring compares each plan with the 20 nearest plans and gives each pair a distance from 0 to 5. When two plans collide, one agent gets a change request, and the other agent continues.` |
| 05 | Tested work merges into main | Merge | `Tests run in each agent's own copy of main, and again on main plus the work. Work that passes merges into main, one merge at a time.` |
| 06 | A person answers only when it matters | Ask a person | `By default, gitring asks a person when the work looks risky or no test ran. You choose where to answer: in the agent's chat, in the app, or in both.` |
| 07 | Every merge keeps its record of why | Ask why | `The merge record keeps the task, the plan, the change requests, the tests and any decision. In the Code view, a click on a line number answers why the line is there.` |

**Closing** (after the story, before the footer)

- Heading: `Join the waitlist`
- Text: `gitring is not open to the public yet. Sign in, then tell us which pack you would use.`
- Button: `Join the waitlist` (the existing `LANDING.join`, the existing `onJoin`).
- Note (small, ink-3): `The example comes from npm run meet in the gitring repository.`

**Small words**

- Skip link and last rail item: `Skip the story`. Rail name for screen readers: `Story chapters`.
- Rail buttons show the number and the label: `01 Start`, `02 Connect`, and so on.

**Strings inside the pictures** are real strings, not copy. They keep the voice of their owner: serif for words of people (the typed sentence, the task titles), mono for agents and machines (tool names, plans, requests, code), sans for the interface (answer places, button names). Appendix A lists all of them.

## 5. The geometry

### 5.1 Numbers

| Name | Value | Meaning |
|---|---|---|
| `CANVAS_U` | 478 | Width of the canvas in u. |
| `TRAVEL_U` | 378 | How far the canvas slides left (`CANVAS_U` minus 100). |
| `ANCHOR` | 55 | The tip of the line stays at 55 u on the stage. |
| `START` | (48, 60) | First point of main. |
| `END` | (470, 62) | Last point of main. A ring marks it. |
| `CATCH_UP` | 0.2 | The last 20% of the scroll lets the tip run ahead to the end (Mirza's value). |
| `SPEED` | 1.5 | The canvas moves about 1.5 px for each px of scroll (up to 1.7 where the cap below decides). |
| Pinned scroll | `min(TRAVEL_U / SPEED, 400dvh)` | 252 u of scroll, capped at four screens. |

Bands of the stage (y in %): text 9 to 34, scenes 38 to 89, rail 91 to 100. Lanes (y): agent A and agent C at 45, main at 59, agent B at 73. A column of the wireframes below is 2 u wide. A row is 5% high.

### 5.2 The wide layout (stage at least 901 px wide and 640 px tall, aspect at least 5 to 4, motion allowed)

Boxes have their true size. `T1` to `T7` are the heading and text of the chapters (25 u wide, at most 38 characters of measure). `=` is main, `a`, `b`, `c` are the agent lines, `.` is a plan (dashed in the real drawing), `#` is a gate, `^` is a hull, `O` is the start and the end of main, `<>` is the diamond.

```
--- x 0 to 160 ---
0         20        40        60        80        100       120       140

   +------------------+   +-----------+              +-----------+
   |h2 + lede         |   |T1 head + 2|              |T2 head + 2|
   |                  |   |           |              |           |
   +------------------+   |           |              |           |
   cue: scroll            |           |              |           |
                          +-----------+              +-----------+
   +---------------+                                    +url /mcp------+
   |describe       |                                    +--------------+
   +---------------+                                       |    |    |
   |template       |                                       |    |    |
   +---------------+    O==================================^====^====^==========
   +---------------+                                      A    B    C
   |one call       |
   +---------------+

--- x 160 to 320 ---
160       180       200       220       240       260       280       300

 +-----------+               +-----------+                  +-----------+
 |T3 head + 2|               |T4 head + 2|                  |T5 head + 2|
 |           |               |           |                  |           |
 |           |               |           |                  |           |
 |           |               |           |                  |           |
 +-----------++plan note---+ +-----------+                  +-----------+
              +------------+                                  3/3
              ..................aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#aaaaa
     A^    ....                 :     same lines                       aaa
       .....               +--------+                                     aa  A in
======...==================|price.js|======================================aa===
     B^  ....              +----:---+
            ........            :                                         bbbbbb
                   .............bbbbbbbbbbb<>bbbbbbbbbbbbbbbbbb
                                           +-----------+                    main moved
                                           |request    |
                             0 1 2 3 4 5   +-----------+

--- x 320 to 480 ---
320       340       360       380       400       420       440       460

             +-----------+                  +-----------+
             |T6 head + 2|                  |T7 head + 2|  +------------+
             |           |                  |           |  |code 7 lines|
             |           |                  |           |  |            |
             |           |                  |           |  |            |
             +-----------+                  +-----------+  +---4--------+
                           H                                   :
                      ..ccccc#....cccc                         :
                   ....       waits  cc                        :
         B in  ....                  ccC in                    :
======bbbb=====..======================c=======================:===========O
  b#bbb             +-----------+  +chat--+            +----------------+
b4/4                |question   |  +------+            |record of why   |
                    |           |  +app---+            |                |
                    |           |  +both--+            |                |
                    |           |  +------+            |                |
                    +-----------+                      +----------------+
```

Each chapter has a bay. The text sits at the top of its bay. The scene sits under it, around main. The bays are not walls: the text of chapter N is above the scene of chapter N, and the scene of N may reach under the text of N+1.

| Bay | Text x | Scene x | What fills it |
|---|---|---|---|
| Opening | 6 | 6 to 46 | Heading, text and cue at the top left. |
| 01 | 52 | 6 to 104 | Three inputs at the left (y 38 to 73) converge on the start of main at (48, 60). |
| 02 | 106 | 106 to 160 | URL plate at (112, 40), 32 u by 6%. Hulls on main at x 118, 128, 138. Short stems join plate and hulls. App names under the hulls. |
| 03 | 162 | 162 to 218 | Departure of agent A and agent B at x 172. Callsign tags. A plan note at (188, 36), 28 u by 6%. Plan lines end at x 224. |
| 04 | 218 | 214 to 278 | Parcel `src/price.js` on main at x 214 to 234. Distance line at x 224 from y 45 to y 73. Diamond at (250, 73). Request plate at (246, 77), 26 u by 11%. Scale bar at y 83. |
| 05 | 280 | 280 to 344 | Gate of A at (291, 45). A joins at (312, 59). "main moved" at (296, 78). Gate of B at (325, 66). B joins at (338, 59). |
| 06 | 346 | 346 to 406 | Agent C leaves at (350, 59). Gate at (378, 45). Question plate at (360, 64), 26 u by 24%. Three answer places at x 390 to 406. C joins at (398, 59). |
| 07 | 408 | 406 to 470 | Code block at (438, 14), 28 u by 22%. Record plate at (430, 64), 36 u by 24%. A hairline leads from line 4 down to the plate. End ring at (470, 62). |

### 5.3 The thread

Main is almost straight on purpose. It is the datum line of the chart. The bends belong to the agents. The waypoints are in the units of Mirza's `threadSegments` (x in u, y in %):

```
MAIN = [48,60] [72,58.5] [96,59.5] [120,59] [150,59] [170,59] [200,59] [240,59]
       [280,59] [320,59] [360,59] [400,59] [430,59] [452,60.5] [470,62]
```

x only grows (a unit test checks it, as in Mirza's test). I ran the waypoints through his functions to get the numbers in 5.5 and 5.6.

**Where main splits into agents and where agents merge.** The engine keeps Mirza's idea of strands: extra lines that draw while the tip crosses an x range (`from` to `to`, the x extent of the strand, so the head of a strand follows the tip). An agent line has a plan strand (before the code) and a work strand (the code).

| Strand | Agent and colour | Style | Waypoints (x, y) | from to |
|---|---|---|---|---|
| A plan | HERON-2, `--v1` | dashed, 1 px | (172,59) (180,53.5) (190,47) (204,45) (224,45) | 172 to 224 |
| A work | HERON-2, `--v1` | solid, 1.5 px | (224,45) (262,45) (292,45) (302,47.5) (312,59) | 224 to 312 |
| B plan | PETREL-9, `--v2` | dashed, 1 px | (172,59) (180,64.5) (190,71) (204,73) (224,73) | 172 to 224 |
| B work | PETREL-9, `--v2` | solid, 1.5 px | (224,73) (246,73) (292,73) (310,72) (326,66) (338,59) | 224 to 338 |
| C plan | TERN-7, `--v3` | dashed, 1 px | (350,59) (358,53) (364,47) (368,45) | 350 to 368 |
| C work | TERN-7, `--v3` | solid, 1.5 px | (368,45) (378,45) | 368 to 378 |
| C wait | TERN-7, `--v3` | dashed, 1 px | (378,45) (388,45) | 378 to 388 |
| C after the yes | TERN-7, `--v3` | solid, 1.5 px | (388,45) (393,46.5) (398,59) | 388 to 398 |

- **Splits.** Two agents leave main together at x 172. The third leaves at x 350.
- **Merges.** HERON-2 joins at x 312. PETREL-9 joins at x 338. TERN-7 joins at x 398. They never join together: gitring merges one work copy at a time.
- **Dashed strands.** The engine draws a line with a dash offset, so a visibly dashed line cannot use the dash itself. A dashed strand is a dashed path seen through a mask. A solid mask path inside the mask is the strand that the engine draws. The engine needs no change for this. If a browser fails the mask, the fallback is a thin grey line (weight and colour still differ from the work strand).
- **The diamond.** One magenta diamond sits on PETREL-9 at (250, 73), the path of the map's change-request buoy (`M0 -7 L7 0 L0 7 L-7 0 Z`). The distance line is the vertical dashed magenta line at x 224 from the end of the plan of A (y 45) to the end of the plan of B (y 73), with the chip `0` where it crosses main. This is the `c-range--correction` look of the map.
- **Gates.** A gate is a short hairline across a lane with a check mark (tests) or a person icon (a question). Gates stand at (291, 45), (325, 66) and (378, 45).
- **The tip.** A 9 px dot in `--accent`, ringed in `--bg`. It stays at 55 u. Main shows only up to the tip.

### 5.4 What appears when

Two kinds of reveal, as in Mirza's engine. **Edge** reveals show when the item enters the right edge of the stage. **Thread** reveals wait for the tip (`at` is the x of the tip). All fades last `--dur-3` (320 ms) with `--ease-out`. A fade moves the item 8 px.

| Item | Reveal | `at` or x |
|---|---|---|
| Opening text, cue | thread | 48 (visible from the start) |
| Three inputs, converging hairlines | thread | 48 |
| Text of chapters 01 to 07 | edge | their text x (52, 106, 162, 218, 280, 346, 408) |
| URL plate | thread | 110 |
| Hull A, hull B, hull C and their names | thread | 116, 126, 136 |
| Tags HERON-2 and PETREL-9, plan note | thread | 172, 172, 186 |
| Plan strands A and B | strand | 172 to 224 |
| Parcel `src/price.js` | thread | 212 |
| Distance line, chip `0`, `same lines` | thread | 224, 224, 228 |
| Scale bar | thread | 216 |
| Diamond, request plate | thread | 248, 250 |
| Work strands A and B | strand | 224 to 312, 224 to 338 |
| Gate and `3/3 tests pass` (A) | thread | 290 |
| A joins, `HERON-2 merged` | thread | 312 |
| `main moved` | thread | 300 |
| Gate and `4/4 tests pass` (B) | thread | 324 |
| B joins, `PETREL-9 merged` | thread | 338 |
| Tag TERN-7, plan strand C | strand | 350 to 368 |
| Question plate, three answer places | thread | 372, 386 |
| Gate, person icon, `waits for a person` | thread | 377, 377, 380 |
| Strands C work, wait, after the yes | strand | 368 to 378, 378 to 388, 388 to 398 |
| TERN-7 joins, `TERN-7 merged` | thread | 398 |
| Code block, line 4 mark | edge, thread | 438, 440 |
| Leader line, record plate | thread | 442, 444 |
| End ring | thread | 470 |

### 5.5 Rail ranges (computed with Mirza's `railChapters`)

`chapterX` is `[52, 106, 162, 218, 280, 346, 408]`. A chapter fills its rail part while the tip crosses it. `go` is where its button scrolls to (a progress from 0 to 1 of the pinned scroll).

| Chapter | from | to | go |
|---|---|---|---|
| 01 Start | 0.0000 | 0.1349 | 0.1164 |
| 02 Connect | 0.1349 | 0.2831 | 0.2593 |
| 03 Send plans | 0.2831 | 0.4312 | 0.4074 |
| 04 Check plans | 0.4312 | 0.5952 | 0.5556 |
| 05 Merge | 0.5952 | 0.7698 | 0.7196 |
| 06 Ask a person | 0.7698 | 0.8910 | 0.8890 |
| 07 Ask why | 0.8910 | 1.0000 | 1.0000 |

The two last parts are short (0.12 and 0.11) because of the catch-up at the end. The build may change `CATCH_UP` to 0.15 if the pictures show the end too fast.

### 5.6 Length of the scroll

| Window | Pinned scroll without cap | Cap (400dvh) | Used | Section height |
|---|---|---|---|---|
| 1280 by 720 | 3,226 px | 2,880 px | 2,880 px | 3,600 px |
| 1440 by 900 | 3,629 px | 3,600 px | 3,600 px | 4,500 px |
| 1920 by 1080 | 4,838 px | 4,320 px | 4,320 px | 5,400 px |
| 1024 by 640 | 2,580 px | 2,560 px | 2,560 px | 3,200 px |
| 2560 by 1440 | 6,451 px | 5,760 px | 5,760 px | 7,200 px |

The cap decides on every common window, so the pinned part always lasts four screens. That is about 515 px of scroll for each chapter at 900 px tall.

### 5.7 Short, tall, wide and zoomed windows

- The wide layout needs `(min-width: 901px) and (min-height: 640px) and (min-aspect-ratio: 5/4) and (prefers-reduced-motion: no-preference)`. Mirza uses 600 px of height. Our scenes carry more text, so the floor is 640 px.
- Type steps with the stage height, with tokens only:

  | Stage height | Heading | Text |
  |---|---|---|
  | 820 px and more | `--t-xl` | `--t-md` |
  | 700 to 819 px | `--t-lg` | `--t-md` |
  | below 700 px | `--t-lg` | `--t-sm` |

  A real 1440 by 900 screen has a window about 780 px tall, so the middle row is the common one.
- Below 700 px the build hides the buttons row of the question plate and the end labels of the scale bar. Stems get shorter.
- Text blocks have `max-width: min(25u, 38ch)`, so a 3440 px wide screen does not make long lines.
- A very tall window (aspect below 5 to 4) uses the vertical layout. A tall but wide window (1920 by 1200) keeps the wide layout, and the scenes use y in %, so they stretch with it.
- Zoom changes the CSS size of the window. At 150% on 1440 by 900 the window is 960 by 600, so the vertical layout starts. A `matchMedia` change and the `resize` event run `applyMode` and `measure` again.

### 5.8 The vertical layout (a phone, a narrow window, a short window)

No pin, no canvas, no travel. The chapters stack in the page column of the landing (the same left edge as the hero). A spine runs down the left. The spine is main. It grows with the scroll, drawn by one custom property on the spine element. Each chapter has a node on the spine. The pictures become their real-material block, set as text: the three inputs, the URL and the app names, the plan, the request, the test lines, the question, the code and the record. The wide-only parts (hulls on lanes, parcel, distance line, diamond on a lane, gates, scale bar, end ring) are not drawn. The node of a chapter carries one small glyph from `design/icons.tsx`: a dot (01), a hull (02, 03), a magenta diamond (04), a check (05), a person (06), a logbook (07).

One chapter at 390 px, chapter 04:

```
  390 px wide, page padding 16
  |
  |    04
  <>   gitring checks plans before code exists        (node: magenta diamond)
  |    gitring compares each plan with the 20
  |    nearest plans and gives each pair a distance
  |    from 0 to 5. When two plans collide, one
  |    agent gets a change request, and the other
  |    agent continues.
  |
  |    +----------------------------------------+
  |    | change request to PETREL-9             |   magenta label, mono
  |    | (same lines; HERON-2 continues)        |   muted, mono
  |    | HERON-2 also changes formatPrice in    |
  |    | src/price.js. Do not rewrite           |   mono 12 px
  |    | formatPrice. Keep your change to       |
  |    | formatPrice small and in a separate    |
  |    | block. ...                             |
  |    +----------------------------------------+
  |    distance   0 same lines ------- 5 no link      hairline scale, 6 ticks
  |
  o    05
```

The plate is HTML, so the real text wraps at any width. At 320 px the plate keeps 12 px mono, the floor for a phone. The phone gets the same words in the same order as the wide layout.

**The static layout** (reduced motion) is the vertical layout on every screen size. The spine is a full hairline, nothing grows, nothing fades, and nothing waits for a scroll position. The content and its order are the same.

**Before the story loads** (or if its chunk fails) the page shows the opening and the seven headings and texts with the spine and numbers (`StaticStory`). Without the real-material blocks, which load with the story.

### 5.9 The look

- **Plate.** The stage uses `--bg`. A hairline in `--line-strong` runs along its top and bottom edge, like the frame of a chart. A graticule of hairlines in `--graticule` (a line every 20 u and every 20%) is one SVG path with `vector-effect: non-scaling-stroke`. No gradient, no mask, no dot paper.
- **Lines.** Main in `--accent`, 1.5 px. Agents in `--v1`, `--v2`, `--v3` (the colours the real map gives the second to fourth agent of a project; `colorFor(n)` is `n % 12`). Plans dashed at 1 px, work solid at 1.5 px. Neutral lines in `--line-strong`.
- **Magenta** (`--magenta`) only for change requests: the diamond, the distance line and its chip, the label of the request plate, and the diamond glyph beside "2 change requests" in chapter 07. Nowhere else.
- **Parcel.** `--land` fill and `--land-edge` outline, as the map draws land. It is the one warm patch of the page. Its name is mono, `--ink-1`.
- **Hulls and tags.** `HULL_PATHS` of `design/icons.tsx` and the `Callsign` component of `design/components`, so the tag of HERON-2 is the same object that the map shows. The shapes are the real ones: chevron for A, dart for B, kite for C.
- **Plates** (the request, the question, the record, the code, the three inputs): a 1 px hairline in `--line-strong`, a 2 px radius (`--r-1`), `--bg` fill, no shadow. They differ in content and size on purpose.
- **Text.** Headings in sans, weight 600, like the page. Chapter text in sans 400, `--ink-2`. Real strings in mono 13 px (`--t-sm`) and 11 px (`--t-xs`) in plates and labels, serif for words of people. At most four sizes in one view: the opening view has 28, 15, 13 and 11. A chapter view has 20 or 28, 15 or 13, 13 and 11.
- **Numbers.** `01` to `07` sit in the left margin of the heading, in `--ink-3`, tabular. They are not a label above the heading.
- **No** tracked all-caps label, no middle-dot string, no arrow on a link, no emoji, no card shadow, no gradient, no stock art, no handwritten type.
- **Motion.** The scroll draws the line. Items fade in once, 320 ms. Nothing loops. One optional pulse (the map's closing pulse, 1,200 ms, once) may mark the chip `0` when two plans come close; the build decides after looking at pictures. Reduced motion: no draw, no travel, no fade.
- **Themes.** Colours are tokens only, so Day, Dusk and Night work without a rule of their own. The contrast of text is checked in the three themes by `scripts/shots` (ink-2 and ink-3 on `--bg`). Lines and hulls need 3 to 1. Text blocks have a `--bg` fill, so a grid line never strikes through a letter.

## 6. What I take from Mirza's engine, and what I change

I read `src_components_storyThread.ts`, `StoryFrame.tsx`, `Story.tsx`, `InterestsStory.tsx`, `src_styles_story.css`, the responsive rules, `test_story.test.ts`, the two Playwright specs and his README. The thread geometry in his file is adapted from SomehowLiving/portfolio-template (MIT License, Copyright (c) 2026 Nidhi Prajapati). **The build keeps that notice in the header of `thread.ts`.** The rest is his own code, which the task lets us adapt. We copy none of his content, artwork or words.

**Reused, with small changes**

| His function or idea | Our use |
|---|---|
| `threadSegments`, `threadPath`, `sampleThread` | Same maths, in `thread.ts`. Catmull-Rom waypoints to Bézier segments, a path string that the server and the browser write the same way, and points sampled once. |
| `tipX`, `progressAtTip`, `sampleAt` | Same. The tip stays at `ANCHOR`, and the last part catches up to the end. |
| `railChapters` | Same. One rail part per chapter, in order, ending at 1. It throws if titles and x values differ in count. |
| `place`, `reveal` (`--x`, `--y`, `data-at`, `data-reveal`) | Same placing and reveal contract. |
| Strands (`Strand`, `from`, `to`) | Same. Eight strands instead of two. |
| Modes (`horizontal`, `vertical`, `static`), `applyMode`, `reset` | Same three modes. The wide query changes (640 px). |
| `measure`, `target`, `render`, `tick`, `wake` | Same loop: one animation frame loop, easing with a time constant of 110 ms, direct DOM writes, no React render while scrolling. |
| `scrollToProgress`, rail click, `followBrowser` | Same. A click scrolls smoothly (instantly with reduced motion). Find-in-page that scrolls the clipped window sideways becomes progress. |
| `data-ready` | Same. Before it, everything is visible. After it, reveals hide what the line has not reached. |

**Changed**

1. **The scroll box.** In gitring the page does not scroll: `.wl` does (`height: 100dvh; overflow-y: auto`). Every `window.scrollY`, `window.scrollTo`, `window.innerHeight`, `window` scroll listener and `IntersectionObserver` of his code moves to a scroll root found once by `scroll-root.ts` (the first ancestor with `overflow-y` auto or scroll, else the window). The observers use `root: scrollRoot`. With the implicit root, the box of `.wl` would clip the section and `rootMargin` would not reach it.
2. **Units.** `u` and a matching height unit come from the stage (`--u` and `--v` in px, set on the section in `measure()`). CSS places things with `calc(var(--x) * var(--u))`. The `vw` and `svh` of his CSS go away.
3. **No arrow, no handwritten notes, no cue arrow.** The end of main is a ring. The tip is a dot.
4. **Hash links.** `#story` and `#story-<chapter>` work: the engine scrolls to the progress of the chapter on mount and on `hashchange`.
5. **`aria-current="step"`** on the rail button of the current chapter, next to `data-current`.
6. **Dead code out.** The canvas holds no link or button, so his `focusIn` centring and the pointer guards go. His page has links in its chapters. Ours has none.
7. **The hook becomes small functions.** His `useStoryEngine` is one function of about 330 lines. `docs/CODE-STYLE.md` rule 4 asks for at most 60 lines and 3 levels. The engine splits into `engine/` files by job (section 7).
8. **Phone work.** In the vertical mode the loop writes one custom property on the spine element, not on the section, so the style of the whole section is not recalculated on each frame. Wide-only parts are not rendered when the wide query does not match.
9. **The first-paint order.** The words are in the initial bundle and the drawings are lazy (section 7). His story is part of his page bundle.

## 7. The file plan

All paths are under `web/src/views/story/` unless a path says more. Each file starts with a header comment: line 1 is one sentence of at most 20 words. TypeScript files stay at 600 lines or fewer, CSS at 500 or fewer. A function has at most 60 lines and 3 levels of nesting. Folders with four or more source files get a `README.md` with one line per file (`story/`, `story/engine/`, `story/scenes/`).

**Loads with the landing (the initial bundle)**

| File | Job | Lines |
|---|---|---|
| `index.ts` | The public surface: `StorySection` and the copy types. | 15 |
| `copy.ts` | Every word of the story: opening, chapters, rail labels, closing, small words. | 110 |
| `Chapter.tsx` | The number, heading and text of one chapter. The same markup in every mode. | 50 |
| `StaticStory.tsx` | The readable story without drawings: skip link, opening, spine, seven chapters. | 80 |
| `StorySection.tsx` | Waits until the section is near the viewport, loads `Story` with `React.lazy`, shows `StaticStory` until then and when the load fails. | 90 |
| `story-base.css` | The stacked layout: spine, node, chapter, print. | 150 |

**Loads when the section is near (own chunk)**

| File | Job | Lines |
|---|---|---|
| `Story.tsx` | The frame, the chapters and their scenes in reading order. | 170 |
| `StoryFrame.tsx` | The pinned frame: stage, canvas, graticule, thread SVG, tip, rail, skip link. | 140 |
| `thread.ts` | Pure maths: waypoints to thread, tip, progress, rail chapters. Adapted from Mirza's `storyThread.ts` with the MIT notice. | 230 |
| `geometry.ts` | The numbers and tables of section 5: canvas, main, strands, chapter x, scene x. Builds the geometry object. | 170 |
| `example.ts` | The real strings of the shop example, each with its source in a comment. | 140 |
| `engine/README.md` | One line per engine file. | 12 |
| `engine/scroll-root.ts` | Finds the scroll box and reads its box and height. | 50 |
| `engine/mode.ts` | The three modes and their media queries. | 80 |
| `engine/measure.ts` | Units, path in px, lengths, and the size of the stage. | 110 |
| `engine/frame.ts` | The animation frame loop: target, render, reveals, strands, rail fill. | 170 |
| `engine/input.ts` | Rail clicks, hash links, find-in-page, resize. | 100 |
| `engine/useStoryEngine.ts` | The React hook that starts and stops the engine. | 45 |
| `scenes/README.md` | One line per scene. | 12 |
| `scenes/art.tsx` | Small drawings: hull, diamond, gate, parcel, chip. | 110 |
| `scenes/Start.tsx` | Chapter 01: the three inputs and the start of main. | 100 |
| `scenes/Connect.tsx` | Chapter 02: the URL plate and the three hulls. | 90 |
| `scenes/Plans.tsx` | Chapter 03: the departures, the tags and the plan note. | 100 |
| `scenes/Compare.tsx` | Chapter 04: parcel, distance line, diamond, request plate, scale bar. | 140 |
| `scenes/Merge.tsx` | Chapter 05: gates, joins, "main moved". | 110 |
| `scenes/Ask.tsx` | Chapter 06: gate, question plate, answer places. | 120 |
| `scenes/Why.tsx` | Chapter 07: the code, line 4, the record plate, the end ring. | 130 |
| `story-wide.css` | The wide mode: sticky stage, canvas, thread, rail, reveals. | 420 |
| `story-scenes.css` | The look of the parts of the scenes. | 420 |
| `README.md` | One line per file of the folder. | 30 |

**Other files that change**

| File | Change |
|---|---|
| `web/src/views/waitlist/Landing.tsx` | Keeps the hero and `ProductVideo`. Drops the grid and the numbered list. Adds `StorySection` and the closing section (`id="wl-closing"`, heading with `tabIndex={-1}`). Wraps the hero and the video in a column element. Scrolls to the hash target on mount. |
| `web/src/views/waitlist/Waitlist.tsx` | The `main` of the landing gets a modifier so the story can run full width. Nothing else. |
| `web/src/views/waitlist/copy.ts` | Removes `solvesTitle`, `solves`, `howTitle` and `how`. Keeps the rest of `LANDING`. |
| `web/src/views/waitlist/waitlist.css` | Removes the rules of `.wl-grid`, `.wl-card` and `.wl-step`. Adds the column and the closing. |
| `web/src/views/waitlist/README.md`, `web/src/views/README.md` | One line for the story folder. |
| `docs/design/SCREENS.md` | A `landing-story` entry: its purpose, its states, what is not seen. |
| `scripts/shots.mjs` and `scripts/shots/*` | A `--waitlist` flag (starts the local app with `WAITLIST_ENABLED:true`) and a `landing-story` screen that scrolls `.wl` in steps of 8% of the story. It stays small, and the existing screens keep working. |

**Tests**

| File | What it checks |
|---|---|
| `test/web/story-thread.test.ts` (new, adapted from Mirza's) | `threadSegments` (count, ends), `threadPath` (stable string), `sampleThread` (reach never falls), `tipX` and `progressAtTip` (start, anchor, end, inverse), `railChapters` (contiguous, ends at 1, `go` inside 0 to 1, throws on a count mismatch). |
| `test/web/story-geometry.test.ts` (new) | Seven chapters, titles equal to the copy. Main x grows. Every strand starts and ends on main (within 0.5%) and has `from` and `to` equal to its x extent. Merges are in order (312, 338, 398). Every `at` is inside the canvas. The pinned scroll at 1440 by 900 is at most four screens. The rail has seven parts and its numbers match 5.5. |
| `test/web/story-copy.test.ts` (new) | `steViolations` on every string. At most two sentences in a chapter text. Heading in sentence case. The banned words, em dashes, emoji. No code name. The files of the initial bundle import only `story-base.css`. |
| `test/web/story-example.test.ts` (new) | The truth test. It runs the shop story in process (the setup of `test/load/meet-run.test.ts`, with `approval: true` and `waitSec: 0`) and checks that each string of `example.ts` is in the real report or in the real answer of `/why`. It also checks the callsigns against `callsignFor`, the tool names against `toolNames()` of `connect-text.ts`, and the code lines against `EUROS` of `scripts/meet-files.mjs`. |
| `test/web/waitlist-copy.test.ts` (changed) | The last test names the five points and the three steps that I remove on purpose. It now checks the seven chapters and the closing. The list of views it scans gains the story `.tsx` files. |
| `test/structure.test.ts` | Not edited. It must pass. |
| `test/web/story-e2e.mjs` (new, run by hand like `shell-e2e.mjs`) | Ported from Mirza's specs: the stage pins and the tip stays at 55%; the rail fills in order; the last rail button shows the end; find-in-page moves the story; nothing overlaps at 1280 by 720, 1440 by 900, 1920 by 1080, 901 by 720, 1024 by 640 and 901 by 640; the phone and the reduced-motion layouts show every chapter with no sideways scroll. |

**The budget of the initial bundle.** The estimate: `copy.ts` about 1.0 kB gzip, `StorySection`, `StaticStory` and `Chapter` about 0.7 kB, the Landing changes 0.1 kB. The old cards and steps (copy and markup) free about 0.9 kB. The net growth is about 0.9 kB, under the 2.0 kB limit. The build measures it with `npx vite build` and compares with the table in section 2. The change is not done above 209.40 kB. The lazy chunk targets 14 kB gzip of script and 7 kB gzip of CSS, without a hard limit.

## 8. Risks and how I handle them

| Risk | What happens | How the build handles it |
|---|---|---|
| **A short window.** | Pinned text and scenes would not fit in 600 px. | The wide layout needs 640 px of height. The type steps down below 820 px and 700 px. Parts that carry least are hidden below 700 px. The overlap test runs at 640 px. Below that the vertical layout starts. |
| **A very tall window.** | A portrait window has little width for a wide canvas. | An aspect below 5 to 4 uses the vertical layout. A tall wide window stretches the scenes in y. A very wide window keeps text lines short (`38ch`). |
| **Browser zoom.** | Zoom shrinks the CSS size of the window. A text-only zoom could grow the text. | The tokens are in px, so a text-only setting does not move them. Zoom triggers `matchMedia` and `resize`: the mode changes, `measure` runs again, `current` is reset. At 150% on a 1440 by 900 window the vertical layout starts. |
| **A slow phone.** | Scroll work on a weak CPU. | No pin and no canvas on a phone. One passive listener on the scroll box. One animation frame loop that runs only near the section and only writes one custom property on the spine. Reveals use one `IntersectionObserver` and fire once. Wide-only parts are not rendered. |
| **A slow network.** | The story chunk arrives late. | The page shows `StaticStory` first. The chunk starts to load when the section is one screen away. If it fails, `StaticStory` stays. The words are readable at every step. |
| **The page opens at a link with an anchor.** | The target does not exist when the browser looks for it (the page is made by script). The target in the wide layout sits on a moving canvas. | `Landing` scrolls to the target after the first paint (`#story`, `#wl-closing`, `#story-<chapter>`). The engine scrolls to the progress of a chapter on mount and on `hashchange`. The skip link is a plain `href` to `#wl-closing`. |
| **Print.** | A pinned canvas prints as one screen. | `@media print` shows the stacked layout, all items visible, no rail, no skip link, no graticule, no motion. The real-material blocks print. |
| **Reduced motion switched on or off while the page is open.** | The mode must change at once. | The engine listens to the media query and calls `applyMode`. It resets every style it wrote. |
| **The story chunk fails, or scripts are off.** | `index.html` already says the app needs JavaScript, so the page does not run without it. | "Without scripting" here means before the chunk loads or when it fails. `StaticStory` covers both. |
| **Layout shift when the chunk replaces `StaticStory`.** | The section gets much taller in the wide layout. | The load starts one screen early, so the change happens below the screen. The section is below the reader, so the page does not move. A jump to an anchor re-applies after the load. |
| **Sticky in a scroll box.** | A parent with `overflow` other than `.wl` breaks `position: sticky`. | The story section and its parents set no `overflow`. A check in the e2e script reads the sticky top. |
| **A scrollbar in `.wl`.** | 15 to 17 px of width on Windows. | The stage measures its own width and sets `--u` from it, so nothing is clipped at the right edge. |
| **Real strings drift** (a change in the product words changes the output). | The story would say something false. | `story-example.test.ts` fails when a string is not in the real output. The fix is to update `example.ts` and the picture. |
| **A claim becomes false** (push, passkeys, built-in agents). | A visitor reads a promise that a deployment cannot keep. | The story leaves those claims out (section 3). |
| **The licence of the adapted maths.** | The thread geometry carries an MIT notice. | The notice stays in the header of `thread.ts`. |
| **Text over lines.** | A grid line or the thread runs through text and hurts reading. | Text blocks have a `--bg` fill. The e2e overlap test samples the main thread and fails if it enters a text box (Mirza's S-06 check). |
| **Too much on the page.** | Four screens of pinned scroll tire a reader. | The cap is four screens. The rail jumps to any chapter. The skip link is the first control. The closing is one scroll away. |

## 9. Checks before the build is done

The design agent scores the finished page with `CRITIQUE.md` and writes `docs/design/reviews/2026-10-xx-landing-story.md`.

- **Pictures** (never from the code alone): `node scripts/shots.mjs --waitlist --only landing-story` at 1440 by 900 and 390 by 844, in Day and Night, every 8% of the story, and once with reduced motion. By hand with Playwright at 320, 768, 1024 and 1920 px wide.
- **Numbers**: no sideways scroll at 320, 390, 768, 1024, 1440 and 1920 px. Contrast of text 4.5 to 1 in three themes. Every control at least 24 px, the rail buttons 44 px.
- **Bundle**: `npx vite build` before and after. The four first scripts grow by at most 2.0 kB gzip.
- **Commands**: `npm run typecheck`, `npx vitest run test/web`, `npx vitest run test/structure.test.ts`, `npx vitest run test/worker`.
- **Keyboard**: the skip link is the first stop. The rail buttons work with Enter and Space. The focus ring shows everywhere.

**Build order, one commit each, typecheck green before each**

1. The words and the static story: `copy.ts`, `Chapter.tsx`, `StaticStory.tsx`, `StorySection.tsx` without the lazy part, the Landing change, the copy test change, the CSS. The page already works, with no drawing.
2. The pure maths: `thread.ts`, `geometry.ts` and their tests.
3. The engine and the frame with main only: wide, vertical and static modes, the rail, the skip link, the lazy load. Measure the bundle.
4. Scenes 01 to 03. Then scenes 04 and 05 with the strands. Then scenes 06 and 07.
5. The shots screen, the e2e script, the truth test, the polish, the docs.
6. The review file.

I push `ws/story` by name after each commit.

## 10. Questions for a person

1. The cue says "three scripted agents", and the app names in chapter 02 are the labels that the scripts give themselves. Is that enough, or does Mirza want the same note as the video ("The agents in it are scripts, and the run is local")?
2. Is it right that the story leaves out passkeys and push notices, because the waitlist uses Google or GitHub and the live deployment may have no push keys?
3. Four screens of pinned scroll: is that the pace he wants? It is the cap, and it is a one-line change.
4. The closing note names `npm run meet` and the repository, without a link. Does he want a link to the repository?
5. A small "Join the waitlist" button in a corner of the pinned stage is not planned. The page has three ways to the join step. Does he want a fourth?

## Appendix A. The real strings, and where they come from

Callsigns (`callsignFor(1)`, `(2)`, `(3)` in `src/harbor/ids.ts`): HERON-2, PETREL-9, TERN-7. The first agent of a project, KESTREL-4, starts the shop and is not drawn.

| Chapter | String | Source |
|---|---|---|
| 01 | `A JSON API for my shop, with tests` | The placeholder of the describe field, `web/src/views/newproject/StartList.tsx`. |
| 01 | `Worker API` | A template title, `src/core/templates.ts`. |
| 01 | `gitring_create_project` | Tool name, `src/worker/mcp-projects.ts`. |
| 02 | `https://your-gitring.example.com/mcp` | The address shape of `MEET_USAGE`, `scripts/meet.mjs`. |
| 02 | Claude Code, Cursor, Codex | The apps the connect page names (`web/src/views/connect/clients.ts`) and the labels of the shop story (`scripts/meet-steps.mjs`). |
| 03 | `gitring_declare`, `files: src/price.js, tests/price.test.js`, `symbols: src/price.js#formatPrice` | The real plan of agent A, `scripts/meet-steps.mjs`. |
| 04 | `0`, `same lines`, `5`, `no link` | The distance scale, `src/core/analysis/range.ts`; the real run prints "same lines". |
| 04 | `(same lines; HERON-2 continues)` and `HERON-2 also changes formatPrice in src/price.js. Do not rewrite formatPrice. Keep your change to formatPrice small and in a separate block. ...` | The first change request that PETREL-9 got in the real run. The dots mark a cut: the real text goes on. Built by `src/core/coord/corrections.ts`. |
| 05 | `3/3 tests pass`, `4/4 tests pass` | The answers of `gitring_check` for HERON-2 and PETREL-9 in the real run. |
| 05 | `main moved` | The real label of the second request of PETREL-9: "(main moved; HERON-2 continues)". |
| 06 | `Show euros in the EU` | The task title of agent C. |
| 06 | `3 files, +7 -4. 5 of 5 tests pass. The code logic changes.` | The real question text, `src/core/approvals.ts` (`approvalLine`), as the real run prints it. |
| 06 | `The parameters of cartTotal, formatPrice change. Other code can call them.` | `riskSigns` in `src/core/approvals.ts`, as the real run prints it. |
| 06 | `waits for a person`, `Yes, merge`, `Send back…` | `APPROVAL_WORD` and `ApproveView.tsx`. |
| 06 | `In the agent's chat`, `In the gitring app`, `In both` | `APPROVALS_IN_TEXT`, `web/src/state/inbox.ts`. |
| 07 | The seven lines of `src/price.js` | The file on main after the three merges of the real run (`EUROS` in `scripts/meet-files.mjs`). |
| 07 | `Why line 4?` | The button label of `web/src/views/code/LineHistory.tsx`. |
| 07 | `Show Free for a price of zero`, `Merged by PETREL-9`, `Add a check at the top of formatPrice.`, `2 change requests`, `The agent applied it`, `4 of 4 tests pass` | The real answer of `GET /api/projects/:p/why?path=src/price.js&line=4` after the real run, and the labels of `LineHistory.tsx` and `history.ts`. |

The change requests that PETREL-9 got in the real run are three; the record counts the two that were not replaced. The story shows the first request in chapter 04 and the count of the record in chapter 07. It does not claim that they are the same ones.

## Appendix B. How this plan was checked

- The copy ran through `steViolations` (a copy of `test/coord/ste.ts`) and the banned-word list: all 22 strings pass.
- The waypoints ran through Mirza's `threadSegments`, `sampleThread`, `tipX`, `progressAtTip` and `railChapters` (his file, cut to the pure part). Main is monotone. The rail and scroll numbers above are the output.
- The wireframes are drawn by a script from the same waypoints and box sizes, so the sketch and the numbers agree.
- Every file path in the chapter table exists in this branch.
