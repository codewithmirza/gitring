# How the design agent reviews a screen

A review has two parts: what the agent **sees** (real screenshots of the running app) and what it **checks** against `docs/design/INTENT.md`. A review never works from the code alone, because "the code is right" is not "the screen is good". The code tells where to fix a problem. The picture tells that the problem exists.

## Get the real screens

Run `node scripts/shots.mjs`. It starts a local gitring, signs in with a test passkey, makes a project with real agents at work, and saves one PNG for each screen, theme and size in `tmp/shots/` (the folder is not in git). Read the PNGs with an image viewer. Then run the same script after each change and compare.

- A full run takes about 25 minutes. For one screen use `--only tasks`, for one theme `--themes night`, for one size `--sizes phone`. `--full` adds a tall picture of the whole page.
- The ids of the screens, and the states that each one shows, are in `SCREENS.md`. The tool also makes the states: empty (`tasks-new-project`), loading (`tasks-loading`), lost connection (`overview-offline`), a long name, a long goal (`task-long`) and 80 rows (`tasks-many`).
- `tmp/shots/index.json` has one record for each picture, with its summary. `tmp/shots/details/<name>.json` has the measurements. Use them to find where to look: the contrast of text, controls smaller than 24 px, sideways scroll, type sizes, code names, long sentences, all-caps text, and focus rings (the first 12 stops of the Tab key; the tool says a ring shows when the picture of the area changes with the focus).

## What the shots cannot show

Say so in the review. Do not guess.

- **Motion.** The tool runs with reduced motion, so the pictures are still. Read the CSS for loops (`infinite`) and score the check "Motion" with a dash if you only have the CSS.
- **Screen reader.** The tool measures focus rings and reads names from the page, but it does not run a screen reader. Score the labels and live regions from the code, and say so.
- **States that were not made.** A state that `SCREENS.md` marks "not seen" is not reviewed. Do not score it as good.
- **Contrast on pictures.** The measure skips text on an image or a gradient.

## The checks

For each screen, in this order. Give each a score of 0 (broken), 1 (weak), 2 (good). A dash (-) means that the check cannot be judged from what the agent saw.

| # | Check | What to look at |
|---|---|---|
| 1 | One purpose | A stranger can say what the screen is for in 5 seconds. One title, one main action. |
| 2 | Hierarchy | The eye lands on the main thing first. At most four type sizes. Quiet things look quiet. |
| 3 | Real material | A real diff, test result, preview or number, with its source. No filler, no fake data. |
| 4 | States | Empty, loading, error, very long names, 200 rows, a slow network. Each state has a design and one action. |
| 5 | Phone | 320 px and 390 px wide. Touch targets, no sideways scroll, the main action in reach of the thumb, no card that covers the page. |
| 6 | Keyboard and screen reader | Tab order, visible focus, labels, live regions for changes that arrive by themselves. |
| 7 | Themes | Day, Dusk, Night. Contrast, borders and shadows that survive in each. |
| 8 | Motion | Moves only to show what changed. Nothing loops. Reduced motion is calm. |
| 9 | Words | STE. Plain names. The same word for the same thing in button, toast and history. No code name shown to a person. No host name or protocol in the first minute. |
| 10 | Point of view | Not a zombie UI (see the list in INTENT.md). A clear choice that only gitring would make. |
| 11 | Raise the ceiling | Does the screen use one of gitring's own ideas (map, replay, why on a line, the answer where the person is)? |

## The report

Save a review as `docs/design/reviews/YYYY-MM-DD-<topic>.md` with these parts:

1. **Verdict** in two sentences: what is strong, what is the biggest problem.
2. **How it was made**: the commit, the command, what the shots could and could not show.
3. **Score table**: one row for each screen, one column for each check.
4. **Findings**, most severe first, each with a number. Each has: the screen and the state, a severity, what is wrong in one sentence, why a person cares, the fix in one sentence, the file in `web/src` to change, and the picture that shows it. A finding that no picture shows names the line of code that shows it, and says so.
   - **S1 blocks**: a person cannot finish the job, or the screen lies, or it breaks on a phone.
   - **S2 hurts**: slow, confusing, or inaccessible, but the job can be done.
   - **S3 polish**: a rough edge that a careful person sees.
5. **Opportunities**: up to three places where a gitring idea can replace a generic pattern.
6. **Not changed**: what looks good, so nobody breaks it.
7. **After** (added when the findings are fixed): what changed, with the picture names before and after.

## Edit after the build

The agent does not stop at the report. The loop is:

1. Review and write the report. A review changes no code.
2. When the request says "fix", fix the S1 and S2 findings, one small change at a time. Use design tokens and components that exist. Add a component only when two screens need it.
3. Run `node scripts/shots.mjs --only <the screens you changed>` again and look at the new PNGs. A fix that is not seen is not done.
4. Run `npm run typecheck` and the web tests. Fix what the change broke.
5. Write what changed at the end of the report ("After"), with the before and after PNG names.

Do not change behavior, API fields or stored data to fix a look. If a finding needs a behavior change (for example, a new field in an API answer), write it as a task for a person.
