# Design intent of gitring

This is the first file the design agent reads. It says what we make, for whom, and what we refuse to look like. Everything else in `docs/design/` serves it. The look is in `web/src/design/` (tokens and components). The live style guide is the `/design` page of a development build. `SCREENS.md` lists the real screens, and `README.md` says how to use the agent.

## What we make

gitring is the home of code when agents write most of it. Many agents change one project at the same time. A person sets the direction, answers the few questions that need a person, and can always see why anything happened.

The person is an **editor**, not a typist and not a referee. The screen must make the editor's three acts fast: **see** what the agents do now, **decide** what needs a person, **understand** why a change is in the code.

## Who uses it, and the jobs

| Person | Job | The test of a good screen |
|---|---|---|
| A founder or lead with several agents | Start a project and see work move. | A project exists and shows life in under one minute, with no account at another service. |
| The same person, on a phone, away from the desk | Answer a merge question. | The question, the evidence and the two answers are on one screen. It takes less than 10 seconds. |
| A teammate who joins | Know what happened while they were away. | History and the merge record answer "what changed and why" without a meeting. |
| An agent's owner | Connect an agent. | One command to copy. Done. |
| A judge or visitor | Understand the idea in one look. | The first screen shows the idea, not a list of features. |

## The point of view

**A chart room.** A chart room is calm and exact. People read instruments there and ships are never lost. The chart (the map of the work) is the memorable thing in gitring. Spend the boldness there. Keep everything around it quiet.

- **Show the real material.** A real diff, a real test result, a real live preview. No screenshot of a result. No summary that has no source.
- **Quiet by default.** Only a person's question interrupts a person. Everything else waits on a page.
- **A question never hides the page.** The card of a merge question comes to the person on every page. It must not cover a control or the last rows of a list. The first review found that it does (`reviews/2026-10-14-first-pass.md`, finding 3).
- **Every number can be checked.** A number shows where it comes from on hover or focus. No vanity numbers, such as how much the agents wrote.
- **One state for people and agents.** What an agent sees in its chat and what a person sees in the app is the same fact in the same words.
- **Keep the road not taken.** Work that did not merge stays visible as an alternate with its reason.
- **An empty screen is an invitation.** It says what to do in one sentence and gives one action.
- **No second home.** GitHub is never the center. It appears only inside "import from" and "keep a copy on". Never as a first step, a default or a required account.

## What we refuse to look like

The talk "How to scale intent, quality, and artistry with AI" (Katie Dill, Stripe) names the risk: when building is easy, products turn into generic "zombie UI". A tool for agents is at the greatest risk. These are the signs of it. A review lists each one that it finds.

- Identical rounded cards with the same soft shadow on every block. We use hairlines and space.
- A gradient hero with a big number, a small label and a gradient accent.
- Sparkle icons, "AI" badges, a chat bubble as the main screen.
- A tracked all-caps label above each heading. We use sentence case.
- A middle-dot string of facts ("A · B · C") or an arrow on every link.
- Stock illustration, emoji as icons, or a mascot.
- Welcome text that says nothing ("Welcome back!"). Say what changed since the person left.
- A list of identical cards with no live fact on them. A project card must say what moves in the project and what waits for the person.
- A screen that looks finished but has no empty, loading, error or long-text state.

## Done is not good

"The code runs" is not "the screen is good". Each screen passes these questions before it is done. They are the ones of the review (`docs/design/CRITIQUE.md`):

1. What is the one thing this screen is for? Can a stranger say it in 5 seconds?
2. What is the one thing a person does here? Is it the most visible action?
3. What does the screen look like empty, loading, failing, with a very long name, and with 200 rows?
4. Does it work on a phone, with a keyboard only, in all three themes, with reduced motion?
5. Is every word one the person already knows? (See "Voice".)
6. What would a generic tool show here? What do we show instead?

## Raise the ceiling

Do not only polish old patterns. gitring has interface ideas that no other tool has. Push these further.

- **The map of work.** Agents, their plans and their distances on one chart. The replay plays the inside of the project back (`/replay`).
- **A change request is a conversation between agents**, and the person can read it as one.
- **The answer goes where the person is.** In the agent's chat, in the app, or in both. The choice is the person's.
- **Why, on any line.** Select a line of code and ask why it is there.
- **The inbox across projects** for people who are away from the desk.

When a screen can show one of these instead of a table, show it.

## Voice

All words in the product follow ASD-STE100 Simplified Technical English (see `docs/CODE-STYLE.md` for the plain names).

- One instruction in one sentence. At most 20 words for an instruction, 25 for a description.
- Active voice. Buttons are verb and noun: "Merge work", "Copy command", "Answer".
- Sentence case. No all-caps labels, except an identifier such as a callsign.
- One word for one thing. Use the plain names: task, work copy, plan, change request, merge, merge record. The page that lists merges is "History". Do not show the code names (intent, attempt, course, correction, landing, logbook, vessel, harbor) to a person. The words "why-record" and "merge record" mean the same thing: the app says "merge record" (9 places) and only the replay says "why-record" (5 places). Use "merge record".
- A product word that a stranger does not know ("train", "steward", "compose") is a code name until the screen explains it in its first sentence. Prefer the plain phrase: "Merge up to 8 work copies in one test run" and not "Largest train".
- Host names and protocols do not belong in the first minute: "Cloudflare Artifacts", "MCP", "OAuth", "3-way merge". Put them in Settings or in the page that needs them, with the plain meaning first.
- Name an action the same way in the button, the toast and the history. The button "Merge work" gives the toast "Work merged".
- An error says what happened and what to do. It does not say sorry and it does not blame.
- Nautical words may stay in the picture (map, rings, chart). They are never a name the person must learn.

## The look in one page

- **Themes:** Day, Dusk, Night. The default follows the system. Night is not an inverted Day.
- **Three voices:** people's words in a serif (Source Serif 4), agents and machines in a mono (Atkinson Hyperlegible Mono), the interface in a sans (Atkinson Hyperlegible Next). Never mix them up.
- **Colors** are OKLCH tokens in `web/src/design/tokens.css`. Use tokens only, never a raw color. Magenta is for change requests only. Color is never the only signal: pair it with an icon and a word.
- **Type scale:** at most four sizes in one view. Weights 400 and 500. The smallest text is 11 px on a desktop and 12 px on a phone: 10 px is for nothing that a person must read.
- **Space and shape:** the spacing tokens `--s-*`, the radii `--r-*`. Hairlines, not shadows. Only overlays have a shadow.
- **Motion:** 120, 200, 320 ms. One pulse when two plans get close. No loops. With reduced motion: fades only.
- **Accessibility floor:** text contrast 4.5 to 1, controls 3 to 1, a visible focus ring, every control on the keyboard, hit areas of at least 32 px (24 px at the least, also for a link in a line of text on a phone), the layout works at 320 px width.
- **One page column.** The title of a page starts at the same left edge on every page. The first review found five different edges on seven pages.
